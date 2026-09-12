/**
 * 插件加载器（P3.1）：扫描 → 校验 → 顺序挂载 → 收集失败 → 热更与回滚。
 *
 * 照 DSH 的 loader（内部设计笔记 §2.2）：
 *   - **顺序 = 条目树的排列顺序**（内置在前、用户目录按目录名），依赖靠 fiber 的 inject 等待，
 *     所以这里没有依赖解析，也不需要拓扑排序；
 *   - **一个条目坏了不影响别人**：启动失败聚合进报告，不抛给调用方（P3.1 的验收就是这个）；
 *   - **回滚写在 update 路径上**：换配置失败 → 恢复旧配置并把旧插件启回来（entry.ts:232-245）。
 *
 * 与 DSH 的差异（P3.1 阶段的现实）：
 *   - DSH 从 npm 包 ⟨import()⟩ 取实现；P3.1 还没有 JS 运行时，实现只能由宿主提供
 *     （内置表）。用户目录里那些带 ⟨main⟩ 的包会被如实标成 UNAVAILABLE 并说明原因，
 *     等 P3.3 把 quickjs-ng 接上之后自动变成可挂载 —— 加载器本身不用改。
 *   - manifest 的 ⟨hash⟩ 写了就校验（内容被改过直接拒），并成为将来授权与回滚的凭据。
 */

import { packageHash } from "../hash";
import { jsonSchemaStandard } from "../jsonSchema";
import { manifestConfigSchema, parseManifest, validatePluginConfig } from "./manifest";
import { createMemoryPluginStore } from "./store";
import { isDynamicDir } from "./dynamicFs";
import { t } from "../../i18n";
import type { Context, FiberShape, PluginObject } from "../service";
import type {
  PluginEntry,
  PluginLoadReport,
  PluginLoaderOptions,
  PluginOptionStore,
  PluginScanReport,
  PluginState,
  PluginStatus,
} from "./types";

type Loaded = {
  entry: PluginEntry;
  impl: PluginObject | undefined;
  fiber: FiberShape | null;
  state: PluginState;
  detail?: string;
};

const byDir = (a: { relDir: string }, b: { relDir: string }) => (a.relDir < b.relDir ? -1 : a.relDir > b.relDir ? 1 : 0);

export class PluginLoader {
  private loaded = new Map<string, Loaded>();
  private scanReport: PluginScanReport | null = null;
  private mountReport: PluginLoadReport | null = null;
  private store: PluginOptionStore;
  /** 正在挂载中的条目（id → promise）：P3.4 起"授权→自动挂"与"手动重挂"可能撞在一起 */
  private mounting = new Map<string, Promise<PluginStatus>>();
  private log: (level: "info" | "warn" | "error", message: string, error?: unknown) => void;
  private disposed = false;

  constructor(
    private ctx: Context,
    private options: PluginLoaderOptions,
  ) {
    this.store = options.store ?? createMemoryPluginStore();
    this.log = options.log ?? (() => {});
  }

  // ---------- 扫描 ----------

  /**
   * 扫两个来源：内置（声明顺序）与用户插件目录（目录名排序）。
   * 写坏的包**不静默跳过**：进 rejected 并带上是哪个字段错了。
   */
  async scan(): Promise<PluginScanReport> {
    await this.store.ready();
    const entries: PluginEntry[] = [];
    const rejected: PluginScanReport["rejected"] = [];
    const duplicates: PluginScanReport["duplicates"] = [];
    const errors: PluginScanReport["errors"] = [];
    const seen = new Map<string, string>();

    const consider = (entry: PluginEntry): void => {
      const prev = seen.get(entry.id);
      if (prev) {
        duplicates.push({ id: entry.id, kept: prev, dropped: entry.dir });
        return;
      }
      seen.set(entry.id, entry.dir);
      entries.push(entry);
    };

    for (const builtin of this.options.builtins ?? []) {
      const check = parseManifest(JSON.stringify(builtin.manifest), "<builtin>");
      if (!check.ok) {
        rejected.push({ dir: "<builtin>", issues: check.issues });
        continue;
      }
      consider({
        id: check.manifest.id,
        manifest: check.manifest,
        source: "builtin",
        dir: "<builtin>",
        relDir: "<builtin>",
        files: [],
      });
    }

    let dirs: { relDir: string; absDir: string; files: string[] }[] = [];
    try {
      dirs = [...(await this.options.fs.scan())].sort(byDir);
    } catch (e) {
      errors.push({ dir: "<plugins>", message: String(e instanceof Error ? e.message : e) });
    }

    for (const dir of dirs) {
      const manifestRel = dir.relDir + "/manifest.json";
      try {
        const text = await this.options.fs.read(manifestRel);
        // 只有 manifest 声明了 hash 才把整包读进来核对（小包无所谓，大包别白读）
        const pkg = /"hash"\s*:/.test(text) ? await this.readPackage(dir) : undefined;
        const parsed = parseManifest(text, manifestRel, pkg);
        if (!parsed.ok) {
          rejected.push({ dir: dir.relDir, issues: parsed.issues });
          continue;
        }
        consider({
          id: parsed.manifest.id,
          manifest: parsed.manifest,
          source: "user",
          dir: dir.absDir,
          relDir: dir.relDir,
          files: dir.files,
        });
      } catch (e) {
        errors.push({ dir: dir.relDir, message: String(e instanceof Error ? e.message : e) });
      }
    }

    this.scanReport = { entries, rejected, duplicates, errors };
    return this.scanReport;
  }

  private async readPackage(dir: { relDir: string; files: string[] }): Promise<{ path: string; content: string }[]> {
    const files = dir.files.slice(0, 64);
    const out: { path: string; content: string }[] = [];
    for (const file of files) {
      out.push({ path: file, content: await this.options.fs.read(dir.relDir + "/" + file) });
    }
    return out;
  }

  // ---------- 挂载 ----------

  /** 顺序挂载扫描结果里的每个条目（**互不影响**：失败只进报告，不抛） */
  async mountAll(): Promise<PluginLoadReport> {
    const started = Date.now();
    const report = this.scanReport ?? (await this.scan());
    const results: PluginStatus[] = [];
    for (const entry of report.entries) {
      results.push(await this.mountEntry(entry));
    }
    const load: PluginLoadReport = {
      results,
      failed: results.filter((r) => r.state === "FAILED").map((r) => r.id),
      unavailable: results.filter((r) => r.state === "UNAVAILABLE").map((r) => r.id),
      ms: Math.round(Date.now() - started),
    };
    this.mountReport = load;
    if (load.failed.length) this.log("warn", "有插件挂载失败：" + load.failed.join(" / "));
    return load;
  }

  /**
   * 挂一个条目（幂等：已经活着就原样返回）。
   *
   * **同一个 id 的挂载不许并发**（P3.4 实测踩到）：授权变化会自动挂一次，
   * 而设置面板/探针可能紧接着再 remount 一次，两次 mountEntry 并发就会把同一个插件
   * 挂出两个 fiber —— 第二个 fiber 注册同名工具直接 "工具名重复" 而 FAILED。
   * 这里用一张 in-flight 表把并发调用收敛到同一个 Promise（unmount 也会先等它）。
   */
  async mountEntry(entry: PluginEntry): Promise<PluginStatus> {
    const inflight = this.mounting.get(entry.id);
    if (inflight) return inflight;
    const task = this.mountEntryOnce(entry).finally(() => {
      this.mounting.delete(entry.id);
    });
    this.mounting.set(entry.id, task);
    return task;
  }

  private async mountEntryOnce(entry: PluginEntry): Promise<PluginStatus> {
    const existing = this.loaded.get(entry.id);
    if (existing?.fiber && existing.fiber.state !== "DISPOSED") return this.statusOf(existing);

    const record: Loaded = {
      entry,
      impl: this.options.resolveImplementation(entry.id, entry),
      fiber: null,
      state: "UNAVAILABLE",
    };
    const options = this.store.get(entry.id) ?? {};

    if (options.disabled) {
      record.state = "DISABLED";
      record.detail = t("core.loaderDisabledDetail");
      this.loaded.set(entry.id, record);
      return this.statusOf(record);
    }
    // 配置校验放在实现查找**之前**：schema 来自 manifest，与实现无关，
    // 而且"配置写错了"比"宿主还没有运行时"更可操作，先说这个。
    const checked = validatePluginConfig(entry.manifest, options.config ?? {});
    if (!checked.ok) {
      record.state = "INVALID";
      record.detail = t("core.loaderInvalidConfig", { issues: checked.issues.join("；") });
      this.loaded.set(entry.id, record);
      return this.statusOf(record);
    }
    // 权限闸门：缺能力就先别挂（用户授权后 remount）—— "等授权"不是失败
    const gate = this.options.preflight?.(entry);
    if (gate && (gate.missing.length || gate.unimplemented.length)) {
      const parts: string[] = [];
      if (gate.missing.length) parts.push(t("core.loaderNeedsPermission", { list: gate.missing.join(" / ") }));
      if (gate.unimplemented.length) parts.push(t("core.loaderUnimplemented", { list: gate.unimplemented.join(" / ") }));
      record.state = "PENDING_PERMISSION";
      record.detail = t("core.loaderPendingPermission", { detail: parts.join("；") });
      this.loaded.set(entry.id, record);
      return this.statusOf(record);
    }
    if (!record.impl) {
      record.state = "UNAVAILABLE";
      record.detail =
        entry.source === "builtin"
          ? t("core.loaderNoBuiltinImpl")
          : entry.manifest.main || entry.manifest.ui?.entry
            ? t("core.loaderNoRuntime")
            : t("core.loaderDeclarativeOnly");
      this.loaded.set(entry.id, record);
      return this.statusOf(record);
    }

    // manifest 是 config schema 的**真源**：实现自带的 config 被覆盖掉
    const plugin: PluginObject = {
      ...record.impl,
      name: entry.manifest.id,
      config: jsonSchemaStandard(manifestConfigSchema(entry.manifest)),
    };
    const fiber = this.ctx.plugin(plugin, options.config ?? {});
    record.fiber = fiber;
    try {
      await fiber.ready;
    } catch (e) {
      record.detail = String(e instanceof Error ? e.message : e);
    }
    if (fiber.state === "FAILED") {
      record.state = "FAILED";
      record.detail = record.detail ?? String(fiber.error ?? t("core.loaderStartFailed"));
    } else {
      record.state = fiber.state as PluginState;
    }
    this.loaded.set(entry.id, record);
    return this.statusOf(record);
  }

  // ---------- 卸载 / 热更 ----------

  async unmount(id: string): Promise<void> {
    // 先把正在进行的挂载等完，否则"卸载 → 再挂载"会在半途插进去
    const inflight = this.mounting.get(id);
    if (inflight) {
      try {
        await inflight;
      } catch {
        /* 挂载自己的失败由调用者处理 */
      }
    }
    const record = this.loaded.get(id);
    if (!record?.fiber) return;
    const fiber = record.fiber;
    await fiber.dispose();
    record.state = "UNMOUNTED";
    if (fiber.pendingEffects() > 0) {
      // 卸载后还有挂着的 disposer = 有插件的清理没跑完，值得说出来（DSH 靠 logger 记这一类）
      this.log("warn", "插件 " + id + " 卸载后仍有 " + fiber.pendingEffects() + " 个残留 effect");
    }
  }

  /**
   * 热更配置：先校验 → ⟨fiber.update⟩（patch context）→ 失败则**恢复旧配置并把旧插件启回来**。
   * 与 DSH 的 entry.update 同构（entry.ts:232-245）：任一步失败都要回到能用的状态。
   */
  async reload(id: string, config?: unknown): Promise<PluginStatus> {
    const record = this.loaded.get(id);
    if (!record) throw new Error(t("core.loaderNotFound", { id }));

    const prev = this.store.get(id) ?? {};
    const next = { ...prev, config: config === undefined ? prev.config : config };
    const checked = validatePluginConfig(record.entry.manifest, next.config ?? {});
    if (!checked.ok) throw new Error(t("core.loaderInvalidConfig", { issues: checked.issues.join("；") }));

    /**
     * 还没挂上的（P3.10 修）：**配置不合法 → 不挂载（INVALID）→ 却只有"已挂载"才能改配置**，
     * 这是一个死路：用户按提示改好了配置，没有任何路径能让它生效。
     * 实测就是「DeepSeek 余额」那个插件：config 里 apiKey 必填，于是它永远停在 INVALID。
     * 现在：配置校验通过就把它挂起来（用户显式关掉的除外 —— 那不该被"改配置"偷偷打开）。
     */
    if (!record.fiber) {
      await this.store.set(id, next);
      if (record.state === "DISABLED") return this.statusOf(record);
      return await this.mountEntry(record.entry);
    }

    const fiber = record.fiber;
    try {
      await fiber.update(next.config ?? {});
      if (fiber.state === "FAILED") throw new Error(String(fiber.error ?? t("core.loaderReloadNotActive")));
    } catch (e) {
      this.log("error", "插件 " + id + " 换配置失败，正在回滚", e);
      // 回滚：把配置写回旧的，再用旧配置重启（restart 是 FAILED 的唯一恢复路径）
      await fiber.update(prev.config ?? {}).catch(() => {});
      await fiber.restart().catch(() => {});
      record.state = fiber.state as PluginState;
      record.detail = t("core.loaderRolledBack", { error: String(e instanceof Error ? e.message : e) });
      throw e;
    }
    await this.store.set(id, next);
    record.state = fiber.state as PluginState;
    record.detail = undefined;
    return this.statusOf(record);
  }

  /** 用户开/关一个插件（disabled 存设置表） */
  async setEnabled(id: string, enabled: boolean): Promise<PluginStatus> {
    const record = this.loaded.get(id);
    const prev = this.store.get(id) ?? {};
    await this.store.set(id, { ...prev, disabled: !enabled });
    if (!record) {
      // 还没挂过：交给同步流程
      const report = this.scanReport ?? (await this.scan());
      const entry = report.entries.find((e) => e.id === id);
      if (!entry) throw new Error(t("core.loaderDirMissing", { id }));
      return this.mountEntry(entry);
    }
    if (!enabled) {
      await this.unmount(id);
      record.state = "DISABLED";
      record.detail = t("core.loaderDisabledByUser");
      return this.statusOf(record);
    }
    return this.mountEntry(record.entry);
  }

  /**
   * 重新扫描并让已挂载的东西与磁盘一致（用户装了/删了/换了版本的插件）。
   * 变的先卸载再挂，消失的卸载并清记录 —— 这就是 DSH 的"条目增删"那条路径。
   */
  async sync(): Promise<{ scan: PluginScanReport; load: PluginLoadReport; removed: string[] }> {
    await this.store.ready();
    const scan = await this.scan();
    const removed: string[] = [];
    for (const [id, record] of [...this.loaded]) {
      const next = scan.entries.find((e) => e.id === id);
      const changed =
        !next ||
        next.manifest.version !== record.entry.manifest.version ||
        (next.manifest.hash ?? "") !== (record.entry.manifest.hash ?? "");
      if (!changed) {
        // 内容没变但**来源**变了（P3.5：内存里的动态包被落到插件目录 → 同一个 id 从
        // aireader://dynamic/ 变成磁盘目录）。代码一样所以不用重挂，但条目指针必须跟着换，
        // 否则状态、贡献、面板上的"内存中"标签全是旧的（实测踩到）。
        if (next && next !== record.entry) record.entry = next;
        continue;
      }
      if (record.fiber) await this.unmount(id);
      removed.push(id);
      if (!next) this.loaded.delete(id);
    }
    const load = await this.mountAll();
    return { scan, load, removed };
  }

  // ---------- 诊断 ----------

  private statusOf(record: Loaded): PluginStatus {
    // fiber 还活着就以它为准；已经 DISPOSED 的 fiber 不代表插件状态（UNMOUNTED / DISABLED 才是）
    const fiberState = record.fiber?.state;
    const live = fiberState === "ACTIVE" || fiberState === "PENDING" || fiberState === "FAILED";
    return {
      id: record.entry.id,
      // name / purpose 用 getter：内置插件的文案是走 i18n 的，读的时候才取词，
      // 这样切语言后插件列表立刻跟着变（不然要等下一次 sync / 重启）
      get name() {
        return record.entry.manifest.name;
      },
      version: record.entry.manifest.version,
      get purpose() {
        return record.entry.manifest.purpose;
      },
      source: record.entry.source,
      dir: record.entry.dir,
      state: live ? (fiberState as PluginState) : record.state,
      detail: record.detail,
      capabilities: (record.entry.manifest.capabilities ?? []) as string[],
      fiberUid: record.fiber?.uid,
      dynamic: isDynamicDir(record.entry.dir),
      // 这个包贡献了什么：fiber 上的 effect 标签就是账本
      //（dynamic-tool:<名字> / dynamic-ui:<槽位> —— 诊断与 run 回执都用它说清"到底挂上了什么"）
      contributions: record.fiber?.effects().filter((e) => e.active).map((e) => e.label) ?? [],
    };
  }

  /** 按扫描顺序列出状态（没挂过的条目也会出现，状态取自上次扫描） */
  statuses(): PluginStatus[] {
    const order = this.scanReport?.entries ?? [];
    const out: PluginStatus[] = [];
    for (const entry of order) {
      const record = this.loaded.get(entry.id);
      out.push(
        record
          ? this.statusOf(record)
          : {
              id: entry.id,
              get name() {
                return entry.manifest.name;
              },
              version: entry.manifest.version,
              get purpose() {
                return entry.manifest.purpose;
              },
              source: entry.source,
              dir: entry.dir,
              state: "UNMOUNTED",
              capabilities: (entry.manifest.capabilities ?? []) as string[],
              dynamic: isDynamicDir(entry.dir),
            },
      );
    }
    return out;
  }

  lastScan(): PluginScanReport | null {
    return this.scanReport;
  }

  lastMount(): PluginLoadReport | null {
    return this.mountReport;
  }

  entryOf(id: string): PluginEntry | undefined {
    return this.loaded.get(id)?.entry ?? this.scanReport?.entries.find((e) => e.id === id);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const [id, record] of [...this.loaded]) {
      if (record.fiber) await this.unmount(id);
    }
    this.loaded.clear();
  }
}

/** 校验一个插件包的内容哈希（安装/更新时用；P3.3 的授权要绑它） */
export function verifyPackageHash(files: { path: string; content: string }[], expected: string): boolean {
  return packageHash(files) === expected;
}
