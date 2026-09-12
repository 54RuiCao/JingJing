/**
 * 应用运行时（P3.0 容器 + P3.1 插件加载器）。
 *
 * 分层：
 *   服务（root fiber 上，ctx.provide）——底座能力，插件用 inject 声明依赖
 *     tools / reader / skills / db / theme / ai / paths
 *   插件（子 fiber，由 PluginLoader 挂载）——功能本身，**每一个都能单独卸载**
 *     app.aireader.reader-tools / app.aireader.skill-tools / app.aireader.reading-stats
 *
 * P3.1 起，插件不再写死在代码里：⟨PluginLoader⟩ 扫目录（内置 + 用户插件目录）→ 校验 manifest
 * → 顺序挂载 → 收集失败。所以"卸载内置插件"与"卸载用户插件"是同一条路径，
 * 而用户目录里那些宿主管不了的包会被如实标成 UNAVAILABLE（等 P3.3 的 quickjs 运行时）。
 */

import { SlotCore, createSlotsService, type SlotsService } from "../../ui/slots/index";
import { createThemeOverrideCore, type ThemeOverrideCore } from "../../ui/theme/overrides";
import { createContainer, contextBoundService, type Container, type ContainerDiagnostics } from "../service";
import { ToolRegistry } from "../../ai/tools/registry";
import { READ_TOOL_NAMES } from "../../ai/tools/index";
import type { ToolHost } from "../../ai/tools/host";
import type { SkillHost } from "../../skills/host";
import {
  HOST_IMPLEMENTED_CAPABILITIES,
  PermissionBroker,
  PluginDefinitionRegistry,
  PluginLoader,
  PluginLogStore,
  QuickJsRuntime,
  createDynamicPlugin,
  createDynamicPluginFs,
  createSettingsPermissionStore,
  createSettingsPluginStore,
  describeCapability,
  isDynamicDir,
} from "../plugin";
import type {
  CapabilityId,
  PermissionsService,
  PluginDevService,
  PluginDiagnosis,
  PluginBundle,
  PluginEntry,
  PluginLoadReport,
  PluginOptionStore,
  PluginInstallReport,
  PluginLogsService,
  PluginRunResult,
  PluginScanReport,
  PluginStatus,
  PluginsService,
} from "../plugin";
// P3.4 的 UI 桥：core 层不认识 React，所以"造一个宿主组件"这件事由 UI 层提供工厂
import { createDynamicSlotComponent } from "../../ui/dynamic/vdom";
import { BUILTIN_PLUGINS, builtinImplementation } from "./builtinPlugins";
import { pluginFetch } from "../plugin/netFetch";
import { capabilityRequests } from "../plugin/permissions";
import { createMemoryPluginFs, createPluginFs, type PluginInvoke } from "./pluginFs";
import { t } from "../../i18n";
import type {
  AiCredentialService,
  AiInfo,
  AiService,
  DbService,
  PathsService,
  ReadingActivityService,
  ThemeService,
} from "./services";

export type {
  AiCredentialService,
  AiInfo,
  AiService,
  DbService,
  PathsService,
  ReadingActivityService,
  ReadingStatsService,
  ThemeService,
} from "./services";

/** 只读工具名（给 UI 裁剪可见集用）。技能工具与书无关，所以没开书时也保留。 */
export const BOOK_INDEPENDENT_TOOLS = READ_TOOL_NAMES;

export type AppRuntimeOptions = {
  reader: ToolHost;
  skills: SkillHost;
  db: DbService;
  theme: ThemeService;
  paths: PathsService;
  /** 阅读活动（P3.7）：动态包用 ctx.reader.activity() 读它 */
  readingActivity?: ReadingActivityService;
  /** 宿主自己的 AI 凭据（P3.11）：net 门面用它代填 Authorization（Key 不进沙箱） */
  aiCredentials?: AiCredentialService;
  /** 插件目录 IO；不给就用内存实现（浏览器/测试里没有 Tauri 命令） */
  pluginIo?: PluginInvoke;
  log?: (level: "info" | "warn" | "error", message: string, error?: unknown) => void;
};

export type SyncReport = {
  removed: string[];
  failed: string[];
  unavailable: string[];
  entries: number;
  rejected: number;
};

export type AppRuntime = {
  /** 容器（React StrictMode 下会重建一次，所以是 getter） */
  readonly container: Container;
  readonly tools: ToolRegistry;
  /** 当前 AI 配置服务（ChatPanel 汇报，插件读） */
  ai: AiService;
  /** 插槽服务（root 绑定的那一份；界面渲染 SlotView 用它） */
  readonly slots: SlotsService;
  /** 权限服务（P3.3）：插件设置界面用它列出/授予/撤销能力 */
  readonly permissions: PermissionsService;
  /** P3.4 的 AI 闭环控制面（inspect/define/run/diagnose 四个工具背后的那一层） */
  readonly pluginDev: PluginDevService;
  /** P3.5 插件日志（面板读它；`ctx.log` 与渲染期失败都落到这里） */
  readonly pluginLogs: PluginLogsService;
  /** P3.6 主题覆盖层（App 把它叠加到 CSS 变量上；插件通过 ctx.theme.overrideTokens 加层） */
  readonly themeOverrides: ThemeOverrideCore;
  /** 插槽内核（诊断面板/探针用） */
  readonly slotCore: SlotCore;
  /** 插件状态（按扫描顺序） */
  plugins(): PluginStatus[];
  /** 最近一次扫描报告（含被拒的包与原因） */
  scanReport(): PluginScanReport | null;
  /** 最近一次挂载报告 */
  loadReport(): PluginLoadReport | null;
  /** 扫目录 + 顺序挂载（启动时一次） */
  mount(): Promise<void>;
  /** 重新扫描并对齐磁盘（装/删/换版本之后） */
  sync(): Promise<SyncReport>;
  unload(id: string): Promise<void>;
  remount(id: string): Promise<PluginStatus>;
  setPluginEnabled(id: string, enabled: boolean): Promise<PluginStatus>;
  reloadPlugin(id: string, config?: unknown): Promise<PluginStatus>;
  diagnostics(): ContainerDiagnostics;
  dispose(): Promise<void>;
};

export function createAppRuntime(options: AppRuntimeOptions): AppRuntime {
  /** 工具注册表跨容器存活：它是服务，不是 fiber 的私有物（容器重建时重新注册进去） */
  const tools = new ToolRegistry();
  let aiInfo: AiInfo | null = null;
  const aiService: AiService = {
    current: () => aiInfo,
    set: (info) => {
      aiInfo = info;
    },
  };

  let container: Container;
  // 容器在 React StrictMode 下会重建，loader/permissions 也跟着重建；用明确赋值让闭包读到的
  // 永远是"当前那一份"（build() 之后才有值，所有使用点都在 build() 之后）
  let loader!: PluginLoader;
  let optionStore!: PluginOptionStore;
  let permissions!: PermissionBroker;
  /**
   * 动态包定义注册表（P3.4）：**跨容器存活** —— 它是宿主账本，不是 fiber 的私物。
   * 容器重建（StrictMode）不该让 AI 刚写的包消失。
   */
  /**
   * 插件日志（P3.5）：**跨容器存活**（与 tools / slotCore / definitions 同类）——
   * 它是运行现场，不该因为 React StrictMode 重建容器就清空。
   */
  const logStore = new PluginLogStore({ max: 500, perPlugin: 120 });
  const definitions = new PluginDefinitionRegistry({
    isIdTaken: (id) => {
      try {
        if (BUILTIN_PLUGINS.some((b) => b.manifest.id === id)) return true;
        return (loader?.lastScan()?.entries ?? []).some((e) => e.id === id && !isDynamicDir(e.dir));
      } catch {
        return false;
      }
    },
  });
  /** quickjs 运行时懒载入：没有动态包时一个字节的 wasm 都不载 */
  let quickjs: Promise<QuickJsRuntime> | null = null;
  let disposed = false;
  /**
   * 插件目录 IO（P3.1 的缝）+ P3.4 的动态包叠加层。
   * 加载器因此**只有一条路径**：AI 写的包与用户装的包在它眼里都是"目录里的一个包"。
   */
  const pluginFs = createDynamicPluginFs(
    options.pluginIo ? createPluginFs(options.pluginIo) : createMemoryPluginFs(),
    definitions,
  );

  const runtimeForPlugins = (): Promise<QuickJsRuntime> => {
    if (!quickjs) {
      quickjs = QuickJsRuntime.create({
        permissions,
        services: {
          reader: () => options.reader,
          activity: () => options.readingActivity ?? null,
          // P3.10：网络门面。域名范围已经在上游（runtime-quickjs 的 requireCapability）查过，
          // 这里把"该插件被授予的域名"再传进去，供 pluginFetch 复核重定向的每一跳。
          net: { fetch: (url, init, allowedOrigins) => pluginFetch({ url, init, allowedOrigins }) },
          aiCredentials: () => options.aiCredentials?.current() ?? null,
          storage: {
            get: (pluginId, key) => options.db.getSetting("plugin.storage." + pluginId + "." + key, null),
            set: async (pluginId, key, value) => {
              await options.db.setSetting("plugin.storage." + pluginId + "." + key, value ?? null);
            },
            remove: async (pluginId, key) => {
              await options.db.setSetting("plugin.storage." + pluginId + "." + key, null);
            },
            keys: async (pluginId) => {
              const table = await options.db.getSetting<Record<string, unknown>>("plugin.storage." + pluginId, {});
              return Object.keys(table ?? {});
            },
          },
          log: (pluginId, level, message) => {
            // ctx.log / 渲染期失败都走这里：一份进日志缓冲（面板与 diagnose 读），一份进控制台
            logStore.write(pluginId, level, message);
            if (options.log) options.log(level === "error" ? "error" : "info", "[" + pluginId + "] " + message);
            else console.info("[aireader/plugin:" + pluginId + "] " + message);
          },
          // P3.4 的 UI 桥：跨 realm 传不了 React 元素，插件交出来的是声明式 JSON VDOM，
          // 这里把"造一个宿主组件"的工厂递进去（core 不认识 React）
          ui: { createComponent: createDynamicSlotComponent },
        },
        log: options.log,
      });
    }
    return quickjs;
  };

  /** 动态包 → 插件实现（两半至少有一个；代码都在挂载时才读） */
  const dynamicImplementation = (entry: PluginEntry) => {
    const main = entry.manifest.main;
    const uiEntry = entry.manifest.ui?.entry;
    if (!main && !uiEntry) return undefined;
    return createDynamicPlugin({
      runtime: runtimeForPlugins,
      spec: {
        pluginId: entry.id,
        version: entry.manifest.version,
        capabilities: (entry.manifest.capabilities ?? []) as CapabilityId[],
      },
      // 走**同一个** pluginFs：动态包的代码来自内存里的定义，磁盘包来自磁盘
      readCode: () => (main ? pluginFs.read(entry.relDir + "/" + main) : Promise.resolve("")),
      readUiCode: uiEntry ? () => pluginFs.read(entry.relDir + "/" + uiEntry) : undefined,
      log: options.log,
    });
  };
  /** 插槽内核跨容器存活（与 tools 同理：它是数据，不是 fiber 的私有物） */
  const slotCore = new SlotCore();
  /** 主题覆盖层同理：它是"谁盖了什么"的账本，不该随容器重建丢掉 */
  const themeOverrides = createThemeOverrideCore();
  /** 当前容器的插槽服务（root 绑定的一份，给界面渲染用） */
  let slotsService: SlotsService;

  /**
   * 建容器 + 注册底座服务 + 建加载器。
   * 抽成函数是为了 React StrictMode：开发模式下 effect 会 mount → cleanup → mount，
   * 容器已经被 dispose 过，第二次 mount 必须能重建（fiber 是一次性的，这是设计）。
   * 注意：插件选项（启用/配置）存在设置表里，重建不会丢 —— 这正是"选项不放插件目录"的好处。
   */
  const build = (): void => {
    container = createContainer({ name: "aireader", log: options.log });
    const ctx = container.ctx;
    ctx.provide("reader", options.reader);
    ctx.provide("skills", options.skills);
    ctx.provide("db", options.db);
    // 主题：**按上下文绑定** —— 插件调 overrideTokens 时，disposer 要挂到它自己的 fiber 上，
    // source 也被强制成插件 id（防冒充、防驱逐别人的层）。与 slots 是同一个模式。
    ctx.provide(
      "theme",
      contextBoundService<ThemeService>((c) => ({
        current: () => options.theme.current(),
        set: (id) => options.theme.set(id),
        list: () => options.theme.list(),
        overrideTokens: (source, tokens) => {
          const fixed = typeof source === "string" && source.trim() ? source.trim() : "plugin";
          return c.effect(() => themeOverrides.override(fixed, tokens ?? {}), "theme-override:" + fixed);
        },
      })),
    );
    ctx.provide("paths", options.paths);
    ctx.provide("ai", aiService);
    ctx.provide("tools", tools);
    // 插槽：**按上下文绑定**的服务 —— 插件 ctx.get("slots") 拿到的是"以它自己的 fiber 为所有者"
    // 的 facade，于是它注册的 UI 会随它卸载而消失
    ctx.provide("slots", contextBoundService<SlotsService>((c) => createSlotsService(slotCore, c)));

    optionStore = createSettingsPluginStore({
      getSetting: (key, fallback) => options.db.getSetting(key, fallback),
      setSetting: (key, value) => options.db.setSetting(key, value),
    });
    permissions = new PermissionBroker({
      store: createSettingsPermissionStore({
        getSetting: (key, fallback) => options.db.getSetting(key, fallback),
        setSetting: (key, value) => options.db.setSetting(key, value),
      }),
      log: (level, message, error) => options.log?.(level, message, error),
    });
    loader = new PluginLoader(ctx, {
      builtins: BUILTIN_PLUGINS,
      resolveImplementation: (id, entry) => builtinImplementation(id) ?? dynamicImplementation(entry),
      // 权限闸门只对**动态包**生效：内置插件是产品自己的代码，声明能力只为展示与将来的审计
      preflight: (entry) => {
        const hasCode = Boolean(entry.manifest.main || entry.manifest.ui?.entry);
        if (entry.source !== "user" || !hasCode) return { missing: [], unimplemented: [] };
        const declared = (entry.manifest.capabilities ?? []) as CapabilityId[];
        // P3.10：判据从"能力名"升级成"申请" —— net.fetch 要连**域名范围**一起看，
        // 否则"授权过 net.fetch"就等于"整个互联网都能访问"。
        const wanted = capabilityRequests(entry.manifest, aiOrigin()).filter((r) =>
          HOST_IMPLEMENTED_CAPABILITIES.includes(r.capability),
        );
        return {
          missing: permissions.missingRequests(entry.id, entry.manifest.version, wanted).map((r) => r.capability),
          unimplemented: permissions.unimplemented(declared),
        };
      },
      fs: pluginFs,
      // 启用状态与配置值存在应用设置表里（绝不放插件目录，见 plugin/store.ts）
      store: optionStore,
      log: (level, message, error) => {
        if (options.log) options.log(level, message, error);
        else if (level === "error") console.error("[aireader/plugin] " + message, error ?? "");
        else console.info("[aireader/plugin] " + message);
      },
    });
    /**
     * 把内存里的动态包**落到插件目录**（P3.5）。
     *
     * 为什么是"用户按一下"而不是给模型一个工具：写文件系统是 Tauri capability 那一层的事，
     * 得有人负责。落盘之后它就是一个**普通的用户插件** —— 重启还在、能在设置里关掉、
     * 能删掉；而内存里的那份定义必须同时删掉，否则叠加层会一直遮住磁盘上的同一个 id。
     */
    const installPackage = async (pluginId: string, packageId?: string): Promise<PluginInstallReport> => {
      if (!options.pluginIo) throw new Error(t("core.runtimeNoPluginWrite"));
      const packages = definitions.packagesOf(pluginId);
      if (!packages.length) {
        throw new Error(t("core.runtimeNotInMemory", { id: pluginId }));
      }
      const pkg = packageId ? definitions.get(packageId) : definitions.currentOf(pluginId) ?? packages[packages.length - 1];
      if (!pkg || pkg.pluginId !== pluginId) throw new Error(t("core.runtimePackageNotFound", { id: String(packageId) }));
      const clash = (loader.lastScan()?.entries ?? []).find((e) => e.relDir === pluginId && !isDynamicDir(e.dir));
      if (clash) throw new Error(t("core.runtimeDirNameTaken", { id: pluginId }));

      for (const file of pkg.files) {
        await options.pluginIo.writePluginText(pluginId + "/" + file.path, file.content, true);
      }
      // 先删定义再 sync：否则叠加层里的虚拟目录会遮住刚落盘的包
      definitions.remove(pluginId);
      await loader.sync();
      const status = loader.statuses().find((s) => s.id === pluginId);
      return {
        pluginId,
        version: pkg.version,
        files: pkg.files.map((f) => f.path),
        dir: options.paths.pluginsDir() + "\\" + pluginId,
        state: status?.state ?? "UNMOUNTED",
        detail: t("core.runtimeInstalled"),
      };
    };

    /** 从插件目录删掉一个包（内存包不走这里 —— 那是 pluginDev.undefine） */
    const uninstallPackage = async (pluginId: string): Promise<void> => {
      if (!options.pluginIo) throw new Error(t("core.runtimeNoPluginDelete"));
      const entry = (loader.lastScan()?.entries ?? []).find((e) => e.id === pluginId);
      if (!entry) throw new Error(t("core.runtimePluginNotInDir", { id: pluginId }));
      if (isDynamicDir(entry.dir)) throw new Error(t("core.runtimeDynamicNotDeletable", { id: pluginId }));
      await loader.unmount(pluginId);
      await options.pluginIo.deletePlugin(entry.relDir);
      await loader.sync();
      // 删掉的插件不该再留着授权记录（否则重装同版本会"凭空已授权"，
      // 与"默认拒绝"的立场冲突）。用户明确拒绝的记录也一并清掉。
      await permissions.revoke(pluginId);
    };

    /**
     * 导出成一份可复制的 JSON 包（P3.6）：内存包与磁盘包都能导。
     * **只导包的字节，不导授权** —— 接收方要自己点授权，这是这套权限模型的底线。
     */
    const exportBundle = async (pluginId: string, packageId?: string): Promise<PluginBundle> => {
      const pkg = packageId ? definitions.get(packageId) : definitions.currentOf(pluginId) ?? definitions.packagesOf(pluginId).pop();
      if (pkg && pkg.pluginId === pluginId) {
        return {
          kind: "jingjing.plugin",
          schema: 1,
          id: pkg.pluginId,
          name: pkg.name,
          purpose: pkg.purpose,
          version: pkg.version,
          capabilities: pkg.capabilities,
          files: pkg.files.map((f) => ({ path: f.path, content: f.content })),
        };
      }
      // 磁盘包：按 manifest 声明的入口把文件读回来
      const entry = loader.entryOf(pluginId);
      if (!entry) throw new Error(t("core.runtimeNotFound", { id: pluginId }));
      const wanted = ["manifest.json", entry.manifest.main, entry.manifest.ui?.entry].filter((p): p is string => !!p);
      const files: { path: string; content: string }[] = [];
      for (const path of wanted) files.push({ path, content: await pluginFs.read(entry.relDir + "/" + path) });
      return {
        kind: "jingjing.plugin",
        schema: 1,
        id: entry.id,
        name: entry.manifest.name,
        purpose: entry.manifest.purpose,
        version: entry.manifest.version,
        capabilities: (entry.manifest.capabilities ?? []) as string[],
        files,
      };
    };

    /** 从 JSON 包安装：先 define（校验 + 语法预检），再 run（缺能力会停在待授权） */
    const importBundle = async (text: string): Promise<{ bundle: PluginBundle; run: PluginRunResult }> => {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (e) {
        throw new Error(t("core.runtimeBadJson", { error: String(e instanceof Error ? e.message : e) }));
      }
      const b = raw as Partial<PluginBundle>;
      if (!b || b.kind !== "jingjing.plugin" || !Array.isArray(b.files)) {
        throw new Error(t("core.runtimeNotABundle"));
      }
      const files: { path: string; content: string }[] = b.files as { path: string; content: string }[];
      const at = (p: string) => files.find((f) => f.path === p)?.content;
      const manifestText = at("manifest.json");
      if (!manifestText) throw new Error(t("core.runtimeBundleNoManifest"));
      let manifest: { main?: string; ui?: { entry?: string }; config?: unknown };
      try {
        manifest = JSON.parse(manifestText);
      } catch (e) {
        throw new Error(t("core.runtimeBundleBadManifestJson", { error: String(e instanceof Error ? e.message : e) }));
      }
      const defined = definitions.define({
        pluginId: String(b.id ?? ""),
        name: String(b.name ?? ""),
        purpose: String(b.purpose ?? ""),
        version: String(b.version ?? ""),
        main: manifest.main ? (at(manifest.main) ?? "") : "",
        ui: manifest.ui?.entry ? at(manifest.ui.entry) : undefined,
        capabilities: b.capabilities,
        config: manifest.config,
      });
      if (!defined.ok) {
        throw new Error(t("core.runtimeBundleDefineFailed", { issues: defined.issues.map((i) => i.field + ": " + i.message).join("；") }));
      }
      const run = await pluginDevService.run(String(b.id));
      return { bundle: b as PluginBundle, run };
    };

    const pluginsService: PluginsService = {
      list: () => loader.statuses(),
      manifestOf: (id) => loader.entryOf(id)?.manifest,
      scanReport: () => loader.lastScan(),
      setEnabled: (id, enabled) => loader.setEnabled(id, enabled),
      reload: (id, config) => loader.reload(id, config),
      configOf: (id) => optionStore.get(id)?.config ?? {},
      capabilities: (id) => {
        // P3.10：把"这个包声明的域名范围"一并带出去 —— 授权的那一刻，用户看到的应当是
        // 「net.fetch · 可访问 api.deepseek.com」，而不是一句"允许联网"。
        // P3.11：ai.credentials 同理，范围是**当前 AI 服务**的域名（授权时那一刻的）。
        const origins = loader.entryOf(id)?.manifest.network?.origins;
        const currentAiOrigin = aiOrigin();
        return (loader.entryOf(id)?.manifest.capabilities ?? []).map((c) => ({
          id: c,
          ...describeCapability(c),
          ...(c === "net.fetch" ? { origins: origins ?? [] } : {}),
          ...(c === "ai.credentials" && currentAiOrigin ? { origins: [currentAiOrigin] } : {}),
        }));
      },
      dir: () => options.paths.pluginsDir(),
      sync: async () => {
        const report = await loader.sync();
        return { removed: report.removed, failed: report.load.failed, unavailable: report.load.unavailable };
      },
      diagnostics: () => container.diagnostics(),
      install: installPackage,
      uninstall: uninstallPackage,
      exportBundle,
      importBundle,
    };
    ctx.provide("plugins", pluginsService);
    const pluginLogsService: PluginLogsService = {
      list: (pluginId, limit) => logStore.list(pluginId, limit),
      clear: (pluginId) => logStore.clear(pluginId),
      stats: () => logStore.stats(),
      version: () => logStore.version(),
      onChange: (fn) => logStore.onChange(fn),
    };
    ctx.provide("pluginLogs", pluginLogsService);
    // 授权变化（撤销/新增）时对账：不再满足条件的动态包**立刻停**
    permissions.onChange(() => {
      void (async () => {
        for (const status of loader.statuses()) {
          if (status.source !== "user") continue;
          if (status.state === "DISABLED" || status.state === "UNAVAILABLE" || status.state === "INVALID") continue;
          const entry = loader.entryOf(status.id);
          if (!entry?.manifest.main && !entry?.manifest.ui?.entry) continue;
          const declared = (entry.manifest.capabilities ?? []) as CapabilityId[];
          const stillOk = declared
            .filter((c) => HOST_IMPLEMENTED_CAPABILITIES.includes(c))
            .every((capability) => permissions.allows({ pluginId: status.id, version: entry.manifest.version, capability }));
          if (stillOk && status.state === "ACTIVE") continue;
          if (stillOk && status.state === "PENDING_PERMISSION") {
            // 用户刚点了"授权"：闸门现在满足了，立刻把它挂起来（不用再手动重挂）
            // —— 这就是 DSH 那条闭环：run 返回 waiting-for-approval → 人批准 → 插件自己活过来
            await loader.mountEntry(entry);
            continue;
          }
          if (!stillOk) {
            // 先卸载（插件的工具/服务/UI 一起消失），再让闸门把它标回"待授权"
            await loader.unmount(status.id);
            await loader.mountEntry(entry);
          }
        }
      })();
    });
    /** 某个插件声明的域名范围（授权时跟着一起落库，见 capabilityRequests） */
    const networkOf = (pluginId: string): { origins?: string[] } | undefined =>
      loader?.entryOf(pluginId)?.manifest.network;
    /** 当前 AI 服务的 origin（P3.11）：ai.credentials 的授权范围就是它 */
    const aiOrigin = (): string | null => options.aiCredentials?.current()?.origin ?? null;

    const permissionsService: PermissionsService = {
      list: (pluginId?: string) => permissions.list(pluginId),
      granted: (pluginId: string, capability: string) =>
        permissions.allows({ pluginId, version: "", capability: capability as CapabilityId }) ||
        permissions.list(pluginId).some((r) => r.capability === capability && r.state === "granted"),
      missing: (pluginId: string, version: string, capabilities: string[]) =>
        permissions.missingRequests(
          pluginId,
          version,
          capabilityRequests({ capabilities: capabilities as CapabilityId[], network: networkOf(pluginId) }, aiOrigin()),
        ).map((r) => r.capability),
      unimplemented: (capabilities: string[]) => permissions.unimplemented(capabilities as CapabilityId[]),
      grant: (pluginId: string, version: string, capabilities: string[], mode: "once" | "always") =>
        permissions.grantRequests(
          pluginId,
          version,
          capabilityRequests({ capabilities: capabilities as CapabilityId[], network: networkOf(pluginId) }, aiOrigin()),
          mode,
        ),
      deny: (pluginId: string, version: string, capabilities: string[]) =>
        permissions.denyAll(pluginId, version, capabilities as CapabilityId[]),
      revoke: (pluginId: string, capability?: string) =>
        permissions.revoke(pluginId, capability as CapabilityId | undefined),
      onChange: (fn: () => void) => permissions.onChange(fn),
    };
    ctx.provide("permissions", permissionsService);

    // ---------- P3.4：AI 写插件的闭环控制面 ----------
    const declaredOf = (entry: PluginEntry | undefined, fallback: CapabilityId[]): CapabilityId[] =>
      entry ? ((entry.manifest.capabilities ?? []) as CapabilityId[]) : fallback;
    const gateOf = (pluginId: string, version: string, declared: CapabilityId[]) => {
      const implemented = declared.filter((c) => HOST_IMPLEMENTED_CAPABILITIES.includes(c));
      return {
        missing: permissions
          .missingRequests(
            pluginId,
            version,
            capabilityRequests({ capabilities: implemented, network: networkOf(pluginId) }, aiOrigin()),
          )
          .map((r) => r.capability) as string[],
        unimplemented: permissions.unimplemented(declared) as string[],
        denied: implemented.filter(
          (c) => permissions.stateOf({ pluginId, version, capability: c }) === "denied",
        ) as string[],
      };
    };

    const pluginDevService: PluginDevService = {
      listPackages: () => definitions.list(),
      packagesOf: (pluginId) => definitions.packagesOf(pluginId),
      currentPackageOf: (pluginId) => definitions.currentOf(pluginId),
      define: (input) => definitions.define(input),
      async run(pluginId: string, packageId?: string): Promise<PluginRunResult> {
        const packages = definitions.packagesOf(pluginId);
        if (!packages.length) {
          throw new Error(
            "没有定义过动态插件 " + pluginId + "：先用 plugin_define 定义它（plugin_inspect 的 packages 查询能看到已定义的包）",
          );
        }
        // 不给 packageId = 运行**最新铸的那个包**（AI 的常态：define 一版新的再 run）；
        // 给了 packageId = 切到那一版（**回滚就是指定旧包再 run 一次**）
        const target = packageId ? definitions.get(packageId) : packages[packages.length - 1];
        if (!target || target.pluginId !== pluginId) {
          throw new Error(
            "找不到包 " + packageId + "（它不存在，或不属于插件 " + pluginId + "）。可用：" +
              packages.map((p) => p.packageId).join(" / "),
          );
        }
        // 版本指针先动（回滚 = 指定旧的 packageId 再 run 一次），再让加载器对齐
        definitions.setCurrent(pluginId, target.packageId);
        await permissions.ready();
        await loader.sync();
        const entry = loader.entryOf(pluginId);
        if (!entry) throw new Error("加载器扫描后没有这个条目：可能是包不合法（看 plugin_diagnose 的 detail）");
        if (!isDynamicDir(entry.dir)) {
          throw new Error('id "' + pluginId + '" 被一个磁盘上的插件包占用了：换一个 id');
        }
        let status = loader.statuses().find((s) => s.id === pluginId);
        if (!status || status.state === "UNMOUNTED") status = await loader.mountEntry(entry);
        const declared = declaredOf(entry, target.capabilities);
        const gate = gateOf(pluginId, entry.manifest.version, declared);
        return {
          pluginId,
          packageId: target.packageId,
          version: target.version,
          state: status.state,
          detail: status.detail,
          ...gate,
          contributions: status.contributions ?? [],
        };
      },
      async stop(pluginId: string): Promise<void> {
        await loader.unmount(pluginId);
      },
      async undefine(pluginId: string) {
        const had = definitions.packagesOf(pluginId).length;
        const mounted = loader.statuses().some(
          (s) => s.id === pluginId && s.state !== "UNMOUNTED" && s.state !== "DISABLED" && s.state !== "UNAVAILABLE",
        );
        if (mounted) await loader.unmount(pluginId);
        definitions.remove(pluginId);
        // 目录里那个虚拟包也要消失：sync 之后加载器才跟内存里的定义一致
        await loader.sync();
        return { removedDefinitions: had, unmounted: mounted };
      },
      async diagnose(pluginId: string, packageId?: string): Promise<PluginDiagnosis> {
        const packages = definitions.packagesOf(pluginId);
        const current = definitions.currentOf(pluginId);
        const status = loader.statuses().find((s) => s.id === pluginId);
        const entry = loader.entryOf(pluginId);
        const declared = declaredOf(entry, current?.capabilities ?? []);
        const version = entry?.manifest.version ?? current?.version ?? "";
        const gate = gateOf(pluginId, version, declared);
        // 只在运行时已经被载入过时才去读渲染失败（否则为了看一份空表把 WASM 拉起来不值得）
        const renderFailures = quickjs ? (await quickjs).renderFailuresOf(pluginId) : [];
        const source = packageId ? definitions.get(packageId) : current;
        return {
          pluginId,
          currentPackageId: current?.packageId ?? null,
          packages: packages.map((p) => ({
            packageId: p.packageId,
            version: p.version,
            hash: p.hash,
            createdAt: p.createdAt,
            isCurrent: p.packageId === current?.packageId,
            files: p.files.map((f) => f.path),
          })),
          state: status?.state ?? (packages.length ? "UNMOUNTED" : "NOT_DEFINED"),
          detail: status?.detail,
          ...gate,
          contributions: status?.contributions ?? [],
          renderFailures,
          // 它自己说过什么：ctx.log 与渲染期失败都在里面（P3.5）
          logs: logStore.list(pluginId, 20).map((e) => ({ at: e.at, level: e.level, message: e.message })),
          source: source ? { packageId: source.packageId, files: source.files } : null,
        };
      },
    };
    ctx.provide("pluginDev", pluginDevService);
    slotsService = ctx.get<SlotsService>("slots") as SlotsService;
    disposed = false;
  };
  build();

  return {
    get container() {
      return container;
    },
    tools,
    ai: aiService,
    get slots() {
      return slotsService;
    },
    get permissions() {
      return container.ctx.get<PermissionsService>("permissions") as PermissionsService;
    },
    get pluginDev() {
      return container.ctx.get<PluginDevService>("pluginDev") as PluginDevService;
    },
    get pluginLogs() {
      return container.ctx.get<PluginLogsService>("pluginLogs") as PluginLogsService;
    },
    slotCore,
    themeOverrides,
    plugins: () => loader.statuses(),
    scanReport: () => loader.lastScan(),
    loadReport: () => loader.lastMount(),
    async mount() {
      if (disposed) build();
      await permissions.ready();
      await loader.scan();
      await loader.mountAll();
    },
    async sync() {
      await permissions.ready();
      const { scan, load, removed } = await loader.sync();
      return {
        removed,
        failed: load.failed,
        unavailable: load.unavailable,
        entries: scan.entries.length,
        rejected: scan.rejected.length,
      };
    },
    async unload(id) {
      await loader.unmount(id);
    },
    async remount(id) {
      const entry = loader.entryOf(id);
      if (!entry) throw new Error(t("core.runtimePluginNotInDir", { id }));
      await loader.unmount(id);
      return loader.mountEntry(entry);
    },
    setPluginEnabled: (id, enabled) => loader.setEnabled(id, enabled),
    reloadPlugin: (id, config) => loader.reload(id, config),
    diagnostics: () => container.diagnostics(),
    async dispose() {
      if (disposed) return;
      disposed = true;
      await loader.dispose();
      await container.dispose();
    },
  };
}
