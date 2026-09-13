/**
 * 插件 manifest（P3.1）。字段照 内部设计笔记 §5.3，一个不多一个不少。
 *
 * 三条设计纪律（都来自 DSH）：
 *   1. **id 稳定、version 不可变**：新版 = 新目录（≈ DSH 的 pluginId / packageId）。
 *      id 是授权与回滚的键，所以它一旦定下就不能改。
 *   2. **capabilities 是权限声明的唯一真源**，必须写在 manifest 里（安装时一次性审批）。
 *      **不要**用 manifest 声明"允许挂哪些槽"：DSH 明确「下发行声明的是服务，不是目标槽位」
 *      （client-runner README:131），slots 只是运行时的只读投影。
 *   3. **config 用 JSON Schema**：宿主渲染表单 + **同步**校验（复用 core/jsonSchema 的适配器）。
 *
 * 校验刻意严格且**一次报全部问题**（issues 数组），因为写插件的可能是模型：
 * 一次只报一个错会让它来回试很多轮。
 */

import { packageHash } from "../hash";
import { normalizeOrigin } from "./netFetch";
import { validateArgs, type JsonSchemaNode } from "../jsonSchema";
import { t } from "../../i18n";

/** 宿主 API 版本：不匹配直接拒（manifest 的 apiVersion 必须等于它） */
export const HOST_API_VERSION = "aireader-plugin-1";

/** 已知能力（权限词表）。P3.3 的授权层按它来裁决，P3.1 只做声明与展示。 */
export type CapabilityId =
  | "reader.read"
  | "reader.annotate"
  | "reader.navigate"
  | "storage.plugin"
  | "llm.chat"
  | "ai.credentials"
  | "fs.read"
  | "fs.write"
  | "net.fetch"
  | "ui.slot"
  | "ui.theme"
  // P5「外观权限」：往界面/正文注入 CSS（ctx.styles.insert）。比 ui.theme 更进一步——
  // token 只能改预设的那几个变量，而样式表能改任何东西（所以它是 medium，不是 low）。
  | "ui.styles"
  | "log.write";

export const CAPABILITIES: { id: CapabilityId; risk: "low" | "medium" | "high"; description: string }[] = [
  // description 写成 getter：它在设置面板/授权弹窗里是**给人看**的，必须按取值那一刻的语言算。
  // 写成模块级常量会在 import 时就把语言定死（App 读到 ui.language 之后才切，时机比它晚）。
  { id: "reader.read", risk: "low", get description() { return t("core.capReaderRead"); } },
  { id: "reader.annotate", risk: "medium", get description() { return t("core.capReaderAnnotate"); } },
  { id: "reader.navigate", risk: "low", get description() { return t("core.capReaderNavigate"); } },
  { id: "storage.plugin", risk: "low", get description() { return t("core.capStoragePlugin"); } },
  { id: "llm.chat", risk: "high", get description() { return t("core.capLlmChat"); } },
  {
    id: "ai.credentials",
    risk: "high",
    get description() { return t("core.capAiCredentials"); },
  },
  { id: "fs.read", risk: "high", get description() { return t("core.capFsRead"); } },
  { id: "fs.write", risk: "high", get description() { return t("core.capFsWrite"); } },
  { id: "net.fetch", risk: "high", get description() { return t("core.capNetFetch"); } },
  { id: "ui.slot", risk: "medium", get description() { return t("core.capUiSlot"); } },
  { id: "ui.theme", risk: "low", get description() { return t("core.capUiTheme"); } },
  { id: "ui.styles", risk: "medium", get description() { return t("core.capUiStyles"); } },
  { id: "log.write", risk: "low", get description() { return t("core.capLogWrite"); } },
];

export type PluginUiSpec = {
  /** 浏览器半的入口文件（相对包根） */
  entry?: string;
  /** 运行时的**只读投影**：这份清单不构成授权（P3.2 的插槽注册表才是真源） */
  slots?: string[];
};

export type PluginManifest = {
  /** 稳定标识（≈ pluginId），升级不变；授权与回滚都绑它 */
  id: string;
  name: string;
  purpose: string;
  /** 不可变：新版 = 新目录（≈ packageId） */
  version: string;
  apiVersion: string;
  /** 宿主侧入口（P3.3 起在 quickjs-ng 里跑；P3.1 只校验文件存在） */
  main?: string;
  ui?: PluginUiSpec;
  config?: JsonSchemaNode;
  capabilities?: CapabilityId[];
  /**
   * 网络范围（P3.10）：声明了 `net.fetch` 就必须写清要访问哪些域名 ——
   * 授权面板把这份清单原样给用户看，运行时每次调用再按目标 origin 复核。
   * 写 `api.deepseek.com` 或 `https://api.deepseek.com` 都行；不支持通配符。
   */
  network?: { origins: string[] };
  /**
   * 前置服务（P5，照 DSH 的 inject 语义）：**声明依赖别的插件提供的服务**，
   * 名字形如 `plugin.stats`（插件用 ctx.provide('plugin.x', 纯数据) 提供）。
   *
   * 为什么只允许 `plugin.` 前缀：宿主自己的服务（reader / db / theme…）都已经有
   * 带能力门面的 `ctx.*` 入口，若这里也能取，等于给沙箱开了一条绕过能力检查的后门
   *（`db` / `pluginDev` 这种拿到手就是全权）。
   *
   * 语义与容器一致：**依赖没到就 park（等着，不算失败）**，提供方卸载后自动重新判定。
   */
  inject?: string[];
  /** 包内容哈希；写了就**校验**，不写则加载器算出来记在内存里 */
  hash?: string;
};

export type ManifestIssue = { field: string; message: string };
export type ManifestParseResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; issues: ManifestIssue[] };

const ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
/** 前置服务名：只认 plugin.xxx（宿主服务有自己的门面，不走这条路） */
const INJECT_RE = /^plugin\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CAPABILITY_IDS = new Set(CAPABILITIES.map((c) => c.id));

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 相对路径安全检查：不许绝对路径、不许 ..、不许反斜杠 */
export function isSafeRelPath(p: string): boolean {
  if (typeof p !== "string" || !p) return false;
  const norm = p.replace(/\\/g, "/");
  return !norm.startsWith("/") && !norm.includes("..") && !norm.includes(":") && norm === p;
}

/**
 * 校验 manifest。
 * @param where 出错信息里的来源（通常是 "<relDir>/manifest.json"）
 * @param files 包内文件清单（相对路径）；给了就顺带校验 main/ui.entry 是否存在、hash 是否对得上
 */
export function parseManifest(
  text: string,
  where = "manifest.json",
  files?: { path: string; content: string }[],
): ManifestParseResult {
  const issues: ManifestIssue[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, issues: [{ field: where, message: t("core.manifestBadJson", { error: String(e instanceof Error ? e.message : e) }) }] };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, issues: [{ field: where, message: t("core.manifestNotObject") }] };
  }

  const req = (field: string): string => {
    const v = raw[field];
    if (typeof v !== "string" || !v.trim()) {
      issues.push({ field, message: t("core.manifestRequiredString") });
      return "";
    }
    return v.trim();
  };

  const id = req("id");
  if (id && !ID_RE.test(id)) {
    issues.push({ field: "id", message: t("core.manifestBadId", { id }) });
  }
  const name = req("name");
  if (name && name.length > 40) issues.push({ field: "name", message: t("core.manifestNameTooLong") });
  const purpose = req("purpose");
  if (purpose && purpose.length > 200) issues.push({ field: "purpose", message: t("core.manifestPurposeTooLong") });
  const version = req("version");
  if (version && !VERSION_RE.test(version)) {
    issues.push({ field: "version", message: t("core.manifestBadVersion", { version }) });
  }
  const apiVersion = req("apiVersion");
  if (apiVersion && apiVersion !== HOST_API_VERSION) {
    issues.push({
      field: "apiVersion",
      message: t("core.manifestApiVersionMismatch", { version: apiVersion, host: HOST_API_VERSION }),
    });
  }

  const main = raw.main;
  if (main !== undefined) {
    if (typeof main !== "string" || !isSafeRelPath(main)) {
      issues.push({ field: "main", message: t("core.manifestBadMainPath") });
    } else if (files && !files.some((f) => f.path === main)) {
      issues.push({ field: "main", message: t("core.manifestMissingFile", { path: main }) });
    }
  }

  let ui: PluginUiSpec | undefined;
  if (raw.ui !== undefined) {
    if (!isPlainObject(raw.ui)) {
      issues.push({ field: "ui", message: t("core.manifestUiNotObject") });
    } else {
      const entry = raw.ui.entry;
      const slots = raw.ui.slots;
      if (entry !== undefined) {
        if (typeof entry !== "string" || !isSafeRelPath(entry)) {
          issues.push({ field: "ui.entry", message: t("core.manifestBadUiEntryPath") });
        } else if (files && !files.some((f) => f.path === entry)) {
          issues.push({ field: "ui.entry", message: t("core.manifestMissingFile", { path: entry }) });
        }
      }
      if (slots !== undefined) {
        if (!Array.isArray(slots) || slots.some((s) => typeof s !== "string")) {
          issues.push({ field: "ui.slots", message: t("core.manifestStringArrayRequired") });
        }
      }
      ui = {
        entry: typeof entry === "string" ? entry : undefined,
        slots: Array.isArray(slots) ? (slots.filter((s) => typeof s === "string") as string[]) : undefined,
      };
    }
  }

  let config: JsonSchemaNode | undefined;
  if (raw.config !== undefined) {
    if (!isPlainObject(raw.config) || (raw.config as { type?: unknown }).type !== "object") {
      issues.push({ field: "config", message: t("core.manifestConfigNotObject") });
    } else if (!isPlainObject((raw.config as { properties?: unknown }).properties)) {
      issues.push({ field: "config.properties", message: t("core.manifestConfigPropsMissing") });
    } else {
      config = raw.config as unknown as JsonSchemaNode;
    }
  }

  let capabilities: CapabilityId[] | undefined;
  if (raw.capabilities !== undefined) {
    if (!Array.isArray(raw.capabilities) || raw.capabilities.some((c) => typeof c !== "string")) {
      issues.push({ field: "capabilities", message: t("core.manifestStringArrayRequired") });
    } else {
      const unknown = (raw.capabilities as string[]).filter((c) => !CAPABILITY_IDS.has(c as CapabilityId));
      if (unknown.length) {
        issues.push({
          field: "capabilities",
          message: t("core.manifestUnknownCapability", { list: unknown.join(" / "), available: [...CAPABILITY_IDS].join(" / ") }),
        });
      } else {
        capabilities = raw.capabilities as CapabilityId[];
      }
    }
  }

  // P5 前置服务（inject）：只认 plugin.* 前缀 —— 宿主服务有自己的能力门面
  let inject: string[] | undefined;
  if (raw.inject !== undefined) {
    if (!Array.isArray(raw.inject) || raw.inject.some((n) => typeof n !== "string")) {
      issues.push({ field: "inject", message: t("core.manifestStringArrayRequired") });
    } else {
      const bad = (raw.inject as string[]).filter((n) => !INJECT_RE.test(n));
      if (bad.length) {
        issues.push({ field: "inject", message: t("core.manifestBadInject", { list: bad.join(" / ") }) });
      } else if (raw.inject.length > 16) {
        issues.push({ field: "inject", message: t("core.manifestTooManyInject", { max: 16 }) });
      } else {
        inject = [...new Set(raw.inject as string[])];
      }
    }
  }

  let network: { origins: string[] } | undefined;
  if (raw.network !== undefined) {
    if (!isPlainObject(raw.network)) {
      issues.push({ field: "network", message: t("core.manifestNetworkNotObject") });
    } else {
      const origins = (raw.network as { origins?: unknown }).origins;
      if (!Array.isArray(origins) || origins.some((o) => typeof o !== "string")) {
        issues.push({ field: "network.origins", message: t("core.manifestOriginsNotArray") });
      } else if (origins.length > 10) {
        issues.push({ field: "network.origins", message: t("core.manifestTooManyOrigins") });
      } else {
        const normalized: string[] = [];
        for (const item of origins as string[]) {
          const r = normalizeOrigin(item);
          if (!r.ok) issues.push({ field: "network.origins", message: r.message });
          else normalized.push(r.origin);
        }
        if (normalized.length) network = { origins: [...new Set(normalized)] };
      }
    }
  }
  // 声明了网络能力却没有域名清单 = 想访问"整个互联网"：必须显式写出来，否则拒
  if (capabilities?.includes("net.fetch") && !network?.origins.length) {
    issues.push({
      field: "network",
      message: t("core.manifestNetFetchNeedsOrigins"),
    });
  }
  if (network && !capabilities?.includes("net.fetch")) {
    issues.push({ field: "capabilities", message: t("core.manifestOriginsWithoutNetFetch") });
  }
  // ai.credentials 是 net.fetch 的"加成"：没有 net.fetch 就没有可代填的请求
  if (capabilities?.includes("ai.credentials") && !capabilities?.includes("net.fetch")) {
    issues.push({
      field: "capabilities",
      message: t("core.manifestAiCredentialsPair"),
    });
  }

  if (files) {
    const actual = packageHash(files);
    if (raw.hash !== undefined) {
      if (typeof raw.hash !== "string" || raw.hash !== actual) {
        issues.push({
          field: "hash",
          message: t("core.manifestHashMismatch", { expected: String(raw.hash), actual }),
        });
      }
    }
  }

  if (issues.length) return { ok: false, issues };

  return {
    ok: true,
    manifest: {
      id,
      name,
      purpose,
      version,
      apiVersion,
      main: typeof main === "string" ? main : undefined,
      ui,
      config,
      capabilities,
      inject,
      network,
      hash: typeof raw.hash === "string" ? raw.hash : files ? packageHash(files) : undefined,
    },
  };
}

/** config 的同步校验器（StandardSchemaV1）；没写 config 就当"无配置" */
export function manifestConfigSchema(manifest: PluginManifest): JsonSchemaNode {
  return manifest.config ?? { type: "object", properties: {}, additionalProperties: true };
}

/** 用 manifest 的 config schema 校验一份配置（P3.3 的审批界面也会用同一个） */
export function validatePluginConfig(manifest: PluginManifest, config: unknown): { ok: true } | { ok: false; issues: string[] } {
  return validateArgs(manifestConfigSchema(manifest), config ?? {});
}

/** 能力 → 人话（设置界面与审批弹窗用） */
export function describeCapability(id: string): { risk: string; description: string } {
  const found = CAPABILITIES.find((c) => c.id === id);
  return found ? { risk: found.risk, description: found.description } : { risk: "unknown", description: t("core.capUnknown") };
}
