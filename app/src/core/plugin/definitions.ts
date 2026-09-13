/**
 * 动态包定义注册表（P3.4）：AI 写的插件先变成**不可变的包**，再谈运行。
 *
 * 照 内部设计笔记 §4.3 的 ② 与 ⑥：
 *
 *   ② define —— 校验 name/purpose 非空、至少一半代码、对每一半做**语法预检**
 *      （new Function 编译，**不执行**）；铸 pluginId/packageId 存进内存 Map；
 *      **不运行、不审批、不碰 current 指针**。
 *   ⑥ 修复/回滚 —— **不覆盖失败的包**：向同一 pluginId **追加新包**再 run；
 *      回滚 = 对旧的 packageId 再 run 一次。所以"包不可变"不是洁癖，是这两条的前提。
 *
 * 三条刻意的边界：
 *   - **仅进程内**：重启即失。要活过重启就该走 P3.1 的插件目录（用户看得见、能删）。
 *   - **不属于任何 fiber**：它是宿主的账本（与 tools / slotCore 同类），插件卸载不影响它。
 *     AI 闭环要的正是"包还在、只是没挂"，所以它不能挂在任何会消失的 fiber 上。
 *   - **不写盘**：define 一个字节都不落盘，落盘发生在 P3.1 的"用户把包放进插件目录"那条路径。
 *     于是"AI 写的插件"与"用户装的插件"共用同一个加载器，区别只是包从哪来。
 */

import { fnv1a64, packageHash } from "../hash";
import type { JsonSchemaNode } from "../jsonSchema";
import { HOST_API_VERSION, parseManifest, type CapabilityId, type ManifestIssue, type PluginManifest } from "./manifest";
import { t } from "../../i18n";

/** 包内文件（相对包根）。manifest.json 也是其中之一 —— 加载器看到的就是一个普通插件包。 */
export type PackageFile = { path: string; content: string };

export type PluginPackage = {
  /** pluginId@version#hash8：**版本指针的单位**就是它（run/回滚都按它寻址） */
  packageId: string;
  pluginId: string;
  version: string;
  name: string;
  purpose: string;
  capabilities: CapabilityId[];
  /** 声明的前置服务（P5）：`plugin.xxx`，由别的插件提供 */
  inject?: string[];
  /** 声明的域名范围（net.fetch 用；授权与运行都按它） */
  network?: { origins: string[] };
  config?: JsonSchemaNode;
  /** manifest.json / main.js / ui.js —— 不可变，铸出来之后连 register 都不改它 */
  files: PackageFile[];
  hash: string;
  /**
   * 内容指纹（不含 version）：用来判断"这次 define 是不是和某一版一模一样"。
   * 同内容的重复 define 是**幂等**的（模型重试时不该被惩罚，也不该平白多出一版）。
   */
  signature: string;
  createdAt: number;
  /** 铸包序号（诊断里按它排序，时间戳相同也稳定） */
  seq: number;
};

export type DefineInput = {
  /** 稳定标识（≈ pluginId）：升级不变，授权与回滚都绑它 */
  pluginId: string;
  name: string;
  purpose: string;
  /** 不给就自动 +1（1.0.0 → 1.0.1）；给了就必须是新的（同版本换内容 = 改不可变的包） */
  version?: string;
  /** 宿主半：交出 apply(ctx, config) 的代码（函数体 / IIFE 均可） */
  main: string;
  /** UI 半：交出 apply(ctx, config) 的代码，用 ctx.slots.register 声明式地挂界面 */
  ui?: string;
  capabilities?: string[];
  /** 网络范围（P3.10）：声明 net.fetch 时必须给，例 { origins: ["api.deepseek.com"] } */
  network?: { origins?: string[] };
  /**
   * 前置服务（P5）：依赖别的插件提供的 `plugin.xxx` 服务（数据）。
   * 依赖没到容器会让插件 park（PENDING），提供方挂上后自动继续。
   */
  inject?: string[];
  config?: unknown;
};

export type DefineResult =
  | { ok: true; package: PluginPackage; created: boolean; previousPackageId: string | null }
  | { ok: false; issues: ManifestIssue[] };

const ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

/** 语法预检：**只编译，不执行**（DSH 的 sandbox.js:197-209 就是 new Function） */
export type SyntaxCheck = { ok: true } | { ok: false; message: string };

export function checkSyntax(code: string, what: string): SyntaxCheck {
  try {
    // eslint-disable-next-line no-new-func
    new Function(code);
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, message: t("core.defineSyntaxError", { what, message }) };
  }
}

function nextVersion(existing: PluginPackage[]): string {
  if (!existing.length) return "1.0.0";
  let best: number[] | null = null;
  for (const p of existing) {
    const m = VERSION_RE.exec(p.version);
    if (!m) continue;
    const nums = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!best || nums[0] > best[0] || (nums[0] === best[0] && (nums[1] > best[1] || (nums[1] === best[1] && nums[2] > best[2])))) {
      best = nums;
    }
  }
  if (!best) return "1.0.0";
  return best[0] + "." + best[1] + "." + (best[2] + 1);
}

export class PluginDefinitionRegistry {
  /** pluginId → 按铸包顺序排列的包（**追加**，从不覆盖） */
  private packages = new Map<string, PluginPackage[]>();
  /** pluginId → packageId（版本指针；run 改它，define 绝不改它） */
  private current = new Map<string, string>();
  private seq = 0;
  /** id 是否已被占用（内置插件与真目录里的插件）；由宿主注入，注册表自己不认识加载器 */
  private isIdTaken: (pluginId: string) => boolean;

  constructor(opts: { isIdTaken?: (pluginId: string) => boolean } = {}) {
    this.isIdTaken = opts.isIdTaken ?? (() => false);
  }

  /**
   * 铸一个包。**不运行、不审批、不改 current**（这三个"不"就是 DSH 的 define 语义）。
   * 同 (pluginId, version) 同内容 = 幂等返回老包；同版本不同内容 = 报错（包不可变）。
   */
  define(input: DefineInput): DefineResult {
    const issues: ManifestIssue[] = [];
    const push = (field: string, message: string) => issues.push({ field, message });

    const pluginId = String(input?.pluginId ?? "").trim();
    if (!pluginId) push("pluginId", t("core.defineIdRequired"));
    else if (!ID_RE.test(pluginId)) {
      push("pluginId", t("core.defineBadId", { id: pluginId }));
    } else if (this.isIdTaken(pluginId)) {
      push("pluginId", t("core.defineIdTaken", { id: pluginId }));
    }

    const name = String(input?.name ?? "").trim();
    if (!name) push("name", t("core.defineNameRequired"));
    else if (name.length > 40) push("name", t("core.defineNameTooLong"));

    const purpose = String(input?.purpose ?? "").trim();
    if (!purpose) push("purpose", t("core.definePurposeRequired"));
    else if (purpose.length > 200) push("purpose", t("core.definePurposeTooLong"));

    const main = typeof input?.main === "string" ? input.main : "";
    const ui = typeof input?.ui === "string" && input.ui.trim() ? input.ui : undefined;
    // DSH 的"至少一半代码"：纯宿主半、纯 UI 半都行，两半都空才算错
    if (!main.trim() && !ui) {
      push("main", t("core.defineEmptyPackage"));
    }

    let config: JsonSchemaNode | undefined;
    if (input?.config !== undefined) {
      const c = input.config as { type?: unknown; properties?: unknown };
      if (!c || typeof c !== "object" || Array.isArray(c) || c.type !== "object" || typeof c.properties !== "object" || c.properties === null) {
        push("config", t("core.defineBadConfig"));
      } else {
        config = input.config as JsonSchemaNode;
      }
    }

    if (issues.length) return { ok: false, issues };

    const existing = this.packages.get(pluginId) ?? [];
    const explicit = Boolean(input.version && String(input.version).trim());
    const version = explicit ? String(input.version).trim() : nextVersion(existing);
    if (!VERSION_RE.test(version)) {
      return { ok: false, issues: [{ field: "version", message: t("core.defineBadVersion", { version }) }] };
    }

    // 能力：先过词表（manifest 校验里也会再做一次，这里先报更直接的错）
    const capabilities = (input.capabilities ?? []).map((c) => String(c).trim()).filter(Boolean) as CapabilityId[];

    const manifest: Record<string, unknown> = {
      id: pluginId,
      name,
      purpose,
      version,
      apiVersion: HOST_API_VERSION,
    };
    if (main.trim()) manifest.main = "main.js";
    if (ui) manifest.ui = { entry: "ui.js" };
    if (config) manifest.config = config;
    if (capabilities.length) manifest.capabilities = capabilities;
    // 域名范围跟着能力一起进 manifest：授权面板看它、运行时按它复核（P3.10）
    if (input.network?.origins?.length) {
      manifest.network = { origins: input.network.origins.map((o) => String(o).trim()).filter(Boolean) };
    }
    // 前置服务（P5）：只放非空字符串，去重后交给 parseManifest 校验（只认 plugin.* 前缀）
    if (Array.isArray(input.inject)) {
      const names = [...new Set(input.inject.map((n) => String(n).trim()).filter(Boolean))];
      if (names.length) manifest.inject = names;
    }

    const files: PackageFile[] = [{ path: "manifest.json", content: JSON.stringify(manifest, null, 2) }];
    if (main.trim()) files.push({ path: "main.js", content: main });
    if (ui) files.push({ path: "ui.js", content: ui });

    // manifest 校验复用 P3.1 的那一份（**一次报全部问题**）：写插件的可能是模型，
    // 一次只报一个错会让它来回试很多轮
    const parsed = parseManifest(JSON.stringify(manifest), pluginId + "/manifest.json", files);
    if (!parsed.ok) return { ok: false, issues: parsed.issues };

    // 语法预检（只编译不执行）——放在最后，因为它依赖前面全部通过
    const checks: SyntaxCheck[] = [checkSyntax(main, "main"), ...(ui ? [checkSyntax(ui, "ui")] : [])];
    const bad = checks.filter((c): c is { ok: false; message: string } => !c.ok);
    if (bad.length) return { ok: false, issues: bad.map((b) => ({ field: "syntax", message: b.message })) };

    const hash = packageHash(files);
    const signature = fnv1a64(
      JSON.stringify([
        name,
        purpose,
        main,
        ui ?? "",
        capabilities.join(","),
        JSON.stringify(config ?? null),
        JSON.stringify(input.network ?? null),
        // 前置服务也要进签名：不然"只加了 inject"的改动会被当成幂等重发
        JSON.stringify(input.inject ?? null),
      ]),
    );
    // 幂等只对"没点名版本"的调用生效：内容一模一样就返回已有那一版，
    // 免得模型重试 define 时平白多出一版。**点名了版本就按它来**（那是显式的意图，
    // 也可能是"把某一版的代码原样再发一次"）。
    if (!explicit) {
      const identical = existing.find((p) => p.signature === signature);
      if (identical) {
        return { ok: true, package: identical, created: false, previousPackageId: this.current.get(pluginId) ?? null };
      }
    }
    const packageId = pluginId + "@" + version + "#" + hash.slice(0, 8);
    const same = existing.find((p) => p.version === version);
    if (same) {
      // 点名了版本、而这一版已经存在：内容一样就是幂等，不一样就是"改不可变的包"
      if (same.signature === signature) {
        return { ok: true, package: same, created: false, previousPackageId: this.current.get(pluginId) ?? null };
      }
      return {
        ok: false,
        issues: [
          {
            field: "version",
            message: t("core.defineImmutableVersion", { version, next: nextVersion(existing) }),
          },
        ],
      };
    }

    const pkg: PluginPackage = {
      packageId,
      pluginId,
      version,
      name,
      purpose,
      capabilities: (parsed.manifest.capabilities ?? []) as CapabilityId[],
      inject: parsed.manifest.inject,
      network: parsed.manifest.network,
      config: parsed.manifest.config,
      files,
      hash,
      signature,
      createdAt: Date.now(),
      seq: ++this.seq,
    };
    this.packages.set(pluginId, [...existing, pkg]);
    // **注意**：这里不动 current —— 新包定义出来了但还没运行（DSH：define 不改 current）
    return { ok: true, package: pkg, created: true, previousPackageId: this.current.get(pluginId) ?? null };
  }

  /** 全部包（按 pluginId + 铸包顺序） */
  list(): PluginPackage[] {
    return [...this.packages.values()].flat();
  }

  packagesOf(pluginId: string): PluginPackage[] {
    return [...(this.packages.get(pluginId) ?? [])];
  }

  get(packageId: string): PluginPackage | undefined {
    for (const list of this.packages.values()) {
      const found = list.find((p) => p.packageId === packageId);
      if (found) return found;
    }
    return undefined;
  }

  /** 版本指针：加载器当前该挂哪个包（run 改它，define 不改） */
  currentOf(pluginId: string): PluginPackage | undefined {
    const id = this.current.get(pluginId);
    if (id) {
      const found = this.get(id);
      if (found) return found;
    }
    return undefined;
  }

  /** 移动版本指针（run 用它；回滚就是把它移回旧的 packageId 再 run） */
  setCurrent(pluginId: string, packageId: string): boolean {
    const found = this.get(packageId);
    if (!found || found.pluginId !== pluginId) return false;
    this.current.set(pluginId, packageId);
    return true;
  }

  /** 删掉一个插件的全部包（≈ DSH 的 cordis_undefine） */
  remove(pluginId: string): boolean {
    const had = this.packages.delete(pluginId);
    this.current.delete(pluginId);
    return had;
  }

  ids(): string[] {
    return [...this.packages.keys()].sort();
  }
}

/** 宿主半的源码（诊断用：把出错的那一版原样给模型看） */
export function sourceOf(pkg: PluginPackage, path: string): string | undefined {
  return pkg.files.find((f) => f.path === path)?.content;
}

export type { PluginManifest };
