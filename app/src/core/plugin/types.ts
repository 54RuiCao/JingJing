/**
 * 插件加载层的契约（P3.1）。
 *
 * 一条主线索（照 DSH，内部设计笔记 §2.2）：
 *   **加载器是一条条目树，不是拓扑排序的依赖图** —— 顺序 = 树里的排列顺序（对我们就是
 *   "内置在前、用户目录按目录名"，两者都确定性），**依赖靠 fiber 的 inject 等待**。
 *   所以这里没有任何"依赖解析"，只有"扫描 → 校验 → 顺序挂载 → 收集失败"。
 */

import type { ContainerDiagnostics, Disposer, FiberShape, PluginObject } from "../service";
import type { JsonSchemaNode } from "../jsonSchema";
import type { CapabilityId, ManifestIssue, PluginManifest } from "./manifest";
import type { PermissionRecord } from "./permissions";
import type { DefineInput, DefineResult, PluginPackage } from "./definitions";
import type { PluginLogEntry } from "./logs";

/** 插件来源：内置（代码里带的 manifest + 实现）与用户（插件目录里的包） */
export type PluginSource = "builtin" | "user";

/** 插件在宿主里的状态 */
export type PluginState =
  /** 已挂载且在跑 */
  | "ACTIVE"
  /** 已挂载但在等依赖（inject 的服务还没出现）—— 这是正常状态，不是错误 */
  | "PENDING"
  /** 挂载过但启动失败（实现抛错）；不再自动重试，恢复走 reload/remount */
  | "FAILED"
  /** manifest 合法但配置不合法：不挂载，也不影响别人 */
  | "INVALID"
  /** manifest 声明的能力还没被用户授权：先别挂，等授权（授权后重挂即可） */
  | "PENDING_PERMISSION"
  /** 用户把它关掉了 */
  | "DISABLED"
  /** 没有可用的实现（P3.1 只有内置实现；带 main 的用户包要等 P3.3 的 quickjs 运行时） */
  | "UNAVAILABLE"
  /** 挂载过又被卸下（保留记录用于诊断） */
  | "UNMOUNTED";

/** 一个通过校验的插件条目 */
export type PluginEntry = {
  id: string;
  manifest: PluginManifest;
  source: PluginSource;
  /** 目录（内置是 "<builtin>"） */
  dir: string;
  /** 相对插件根目录的名字（内置是 "<builtin>"）；动态实现按它拼 main 的相对路径 */
  relDir: string;
  /** 包内文件清单（相对包根） */
  files: string[];
};

export type PluginStatus = {
  id: string;
  name: string;
  version: string;
  purpose: string;
  source: PluginSource;
  dir: string;
  state: PluginState;
  /** 人类可读的原因（FAILED/UNAVAILABLE/INVALID/DISABLED 时给） */
  detail?: string;
  capabilities: string[];
  /** 挂载后的 fiber uid（诊断用） */
  fiberUid?: number;
  /** 这个包贡献了什么（fiber 上的 effect 标签：dynamic-tool:<名字> / dynamic-ui:<槽位> …） */
  contributions?: string[];
  /**
   * 这个包是**内存里的动态包**（AI 写的，重启即失）还是磁盘上的。
   * UI 据此显示"保留到插件目录"按钮 —— 面板不该自己去认 `aireader://dynamic/` 这个前缀。
   */
  dynamic?: boolean;
};

export type PluginScanReport = {
  entries: PluginEntry[];
  /** manifest 不合法的目录（**不静默跳过**：写坏的包要让用户看见） */
  rejected: { dir: string; issues: ManifestIssue[] }[];
  /** 同 id 冲突（内置优先；用户目录内先扫到的优先） */
  duplicates: { id: string; kept: string; dropped: string }[];
  /** 读取失败（目录不可读、文件太大…） */
  errors: { dir: string; message: string }[];
};

export type PluginLoadReport = {
  results: PluginStatus[];
  /** 挂载失败的 id（用于摘要与告警；不影响其他人） */
  failed: string[];
  /** 没找到实现的 id（P3.1 的常态：用户包要等 P3.3 的运行时） */
  unavailable: string[];
  ms: number;
};

/** 插件的用户级选项（**不放插件目录**，见 §5.5） */
export type PluginOptions = {
  disabled?: boolean;
  config?: unknown;
};

export type PluginOptionStore = {
  /** 首次读取完成（设置表是异步的；加载器在扫描前 await 它） */
  ready(): Promise<void>;
  get(id: string): PluginOptions | undefined;
  set(id: string, options: PluginOptions): Promise<void>;
  all(): Record<string, PluginOptions>;
  /** 外部改动之后重新读 */
  reload(): Promise<void>;
};

/** 插件目录里扫到的一个包 */
export type PluginDirEntry = {
  /** 相对插件根目录（例：com.example.reading-stats） */
  relDir: string;
  absDir: string;
  /** 包内文件（相对包根，例：manifest.json / index.js） */
  files: string[];
};

/** 文件 IO 缝（Rust 实现；测试里用内存实现） */
export type PluginFs = {
  /** 扫描插件根目录：只认"目录里有 manifest.json"的包 */
  scan(): Promise<PluginDirEntry[]>;
  /** 读包内文件（relPath 相对插件根，例：com.example.reading-stats/manifest.json） */
  read(relPath: string): Promise<string>;
};

/**
 * 插件控制面（P3.2 起作为 "plugins" 服务提供给插件与界面）：
 * 设置面板只读它 + 三个动作（开关、改配置、重新扫描），不再需要直接摸加载器。
 */
export type PluginsService = {
  list(): PluginStatus[];
  manifestOf(id: string): PluginManifest | undefined;
  scanReport(): PluginScanReport | null;
  setEnabled(id: string, enabled: boolean): Promise<PluginStatus>;
  reload(id: string, config?: unknown): Promise<PluginStatus>;
  /** 这个插件声明了哪些能力（含风险档与人话说明） */
  /** 这个包声明了哪些能力（含风险与说明）；net.fetch 额外带它声明的域名清单（P3.10） */
  capabilities(id: string): { id: string; risk: string; description: string; origins?: string[] }[];
  /** 当前配置值（设置面板渲染表单要用） */
  configOf(id: string): unknown;
  /** 重新扫描插件目录并与磁盘对齐（装/删/换版本之后） */
  sync(): Promise<{ removed: string[]; failed: string[]; unavailable: string[] }>;
  /** 插件目录（给人看：把包放这里就能装） */
  dir(): string;
  /** 容器健康度（诊断面板与 plugin_inspect 用它说清"有没有泄漏的 disposer"） */
  diagnostics(): ContainerDiagnostics;
  /**
   * 把内存里的动态包**落到插件目录**（P3.5）。这是给**用户**的按钮，不是给模型的工具：
   * 写文件系统是 Tauri capability 那一层的事，得由人点头。
   */
  install(pluginId: string, packageId?: string): Promise<PluginInstallReport>;
  /** 从插件目录删掉一个包（只允许删磁盘包；内存包用 pluginDev.undefine）。**同时撤销它的授权** */
  uninstall(pluginId: string): Promise<void>;
  /** 导出成一个可复制的 JSON 包（内存包与磁盘包都能导） */
  exportBundle(pluginId: string, packageId?: string): Promise<PluginBundle>;
  /** 从 JSON 包安装：define → run（缺能力会停在待授权）。返回运行回执 */
  importBundle(text: string): Promise<{ bundle: PluginBundle; run: PluginRunResult }>;
};

/**
 * 权限控制面（P3.3 起作为 "permissions" 服务提供给界面）：
 * 设置面板用它列出/授予/撤销能力；宿主用它判断"这个动态包还该不该活着"。
 */
export type PermissionsService = {
  list(pluginId?: string): PermissionRecord[];
  granted(pluginId: string, capability: string): boolean;
  missing(pluginId: string, version: string, capabilities: string[]): string[];
  unimplemented(capabilities: string[]): string[];
  grant(pluginId: string, version: string, capabilities: string[], mode?: "once" | "always"): Promise<PermissionRecord[]>;
  deny(pluginId: string, version: string, capabilities: string[]): Promise<void>;
  revoke(pluginId: string, capability?: string): Promise<void>;
  onChange(fn: () => void): Disposer;
};



/** 插件日志的只读面（面板与 plugin_diagnose 用；写入只走 runtime 的 log 缝） */
export type PluginLogsService = {
  /** 最近的在后；给 pluginId 就只看它；limit 取最后 N 条 */
  list(pluginId?: string, limit?: number): PluginLogEntry[];
  clear(pluginId?: string): number;
  /** kept = 现在还留着几条；dropped = 因为上限被丢掉的条数（面板要如实显示） */
  stats(): { kept: number; dropped: number; plugins: number };
  version(): number;
  onChange(fn: () => void): Disposer;
};

/**
 * 插件包的可移植形态（P3.6）：一份 JSON，能贴给别人、也能从别人那里贴进来。
 * 只装**包的字节**（manifest + 各半代码），不装授权 —— 授权永远由接收方自己点。
 */
export type PluginBundle = {
  kind: "jingjing.plugin";
  schema: 1;
  id: string;
  name: string;
  purpose: string;
  version: string;
  capabilities: string[];
  files: { path: string; content: string }[];
};

/** "把内存里的动态包落到插件目录"的回执（这是**用户的动作**，不给模型） */
export type PluginInstallReport = {
  pluginId: string;
  version: string;
  /** 写进磁盘的文件（相对包根） */
  files: string[];
  dir: string;
  state: PluginState;
  /** 落盘后版本指针让给了磁盘包：内存里的那份定义已经删掉，避免叠加层遮住磁盘 */
  detail: string;
};

/**
 * P3.4 的 AI 闭环控制面（inspect / define / run / diagnose 四个工具背后的那一层）。
 *
 * 它与 PluginsService 的分工：PluginsService 是**用户界面**用的（列表 / 开关 / 配置），
 * 这里给的是**写插件的人**（模型或开发者）要的：包定义、版本指针、运行回执、诊断。
 */
export type PluginRunResult = {
  pluginId: string;
  /** 版本指针现在指着的包 */
  packageId: string;
  version: string;
  state: PluginState;
  detail?: string;
  /** 还没被用户授权的能力（"待授权"不是失败：告诉模型去设置面板点头，或让用户知道） */
  missing: string[];
  /** 声明了但宿主还没接门面的能力（永远不会被授予） */
  unimplemented: string[];
  /** 用户明确拒绝过的能力（DSH：拒绝后不得自动重试） */
  denied: string[];
  /** 这个包实际挂上了什么 */
  contributions: string[];
};

export type PluginPackageInfo = {
  packageId: string;
  version: string;
  hash: string;
  createdAt: number;
  /** 版本指针是不是指着它 */
  isCurrent: boolean;
  files: string[];
};

export type PluginDiagnosis = {
  pluginId: string;
  /** 版本指针（重启即失：动态包只在进程内） */
  currentPackageId: string | null;
  packages: PluginPackageInfo[];
  /** NOT_DEFINED = 这个 id 没有动态包（可能写错名字，或它其实是内置/磁盘插件） */
  state: PluginState | "NOT_DEFINED";
  detail?: string;
  missing: string[];
  unimplemented: string[];
  denied: string[];
  contributions: string[];
  /** 渲染期失败（DSH 的 reportRenderFailure）：界面崩过几次、崩在哪一格、为什么（count = 同一个错误重复了几轮） */
  renderFailures: { slot: string; message: string; at: number; count?: number }[];
  /** 这个插件最近写过的日志（ctx.log 落到这里）：诊断时"它自己说了什么"往往比什么都直接 */
  logs: { at: number; level: string; message: string }[];
  /** 指定的包源码（默认当前包）—— 修 bug 要看的就是它 */
  source: { packageId: string; files: { path: string; content: string }[] } | null;
};

export type PluginDevService = {
  listPackages(): PluginPackage[];
  packagesOf(pluginId: string): PluginPackage[];
  currentPackageOf(pluginId: string): PluginPackage | undefined;
  define(input: DefineInput): DefineResult;
  /** 移动版本指针 → 对齐磁盘（sync）→ 挂载；返回运行回执（**不自动回滚：失败就如实报**） */
  run(pluginId: string, packageId?: string): Promise<PluginRunResult>;
  /** 停（保留定义与版本指针 —— DSH 的 cordis_stop） */
  stop(pluginId: string): Promise<void>;
  /** 删掉定义与全部包（≈ DSH 的 cordis_undefine） */
  undefine(pluginId: string): Promise<{ removedDefinitions: number; unmounted: boolean }>;
  diagnose(pluginId: string, packageId?: string): Promise<PluginDiagnosis>;
};

/** 内置插件：manifest 与实现放在一起（P3.1 还没有"从目录里取实现"的能力） */
export type BuiltinPlugin = {
  manifest: PluginManifest;
  /** 实现；config schema 由加载器用 manifest.config 覆盖（manifest 是真源） */
  plugin: PluginObject;
};

/** 加载器的依赖注入面 */
export type PluginLoaderOptions = {
  /**
   * id → 实现。P3.1 只查内置表；P3.3 起这里还会用 quickjs 运行时把 ⟨main⟩ 变成插件。
   * 传 entry 是因为动态实现需要 manifest（能力、main 路径）。
   */
  resolveImplementation(id: string, entry: PluginEntry): PluginObject | undefined;
  /**
   * 挂载前的权限闸门（P3.3）：缺能力就**不挂**，标成 PENDING_PERMISSION 等用户授权。
   * 授权之后调 remount 即可 —— 与"启动失败"区分开，用户看到的不是错误而是待办。
   */
  preflight?: (entry: PluginEntry) => { missing: CapabilityId[]; unimplemented: CapabilityId[] };
  fs: PluginFs;
  store?: PluginOptionStore;
  builtins?: BuiltinPlugin[];
  /** 挂载时用的容器 context 的 plugin()（默认用 root ctx） */
  log?: (level: "info" | "warn" | "error", message: string, error?: unknown) => void;
};

export type PluginMountContext = {
  plugin(plugin: PluginObject, config?: unknown): FiberShape;
};

export type { JsonSchemaNode };
