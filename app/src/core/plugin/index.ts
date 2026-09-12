/**
 * 插件加载层（P3.1）的出口。
 *
 *   const loader = new PluginLoader(container.ctx, { resolved: id => builtins.get(id), fs, store, builtins });
 *   const scan = await loader.scan();        // 目录 → 校验（写坏的包带原因进 rejected）
 *   const load = await loader.mountAll();    // 顺序挂载；失败只进报告，不影响别人
 *   await loader.reload(id, config);         // 热更；失败回滚到旧配置并重启
 *   await loader.sync();                     // 磁盘变了（装/删/换版本）之后重建到一致
 */

export { PluginLoader, verifyPackageHash } from "./loader";
export {
  HOST_IMPLEMENTED_CAPABILITIES,
  PERMISSIONS_KEY,
  PermissionBroker,
  createMemoryPermissionStore,
  createSettingsPermissionStore,
  scopeCovers,
} from "./permissions";
export type {
  GrantMode,
  PermissionAnswerer,
  PermissionDecision,
  PermissionRecord,
  PermissionRequest,
  PermissionScope,
  PermissionState,
  PermissionStore,
} from "./permissions";
export { ASYNC_OPS, OP_CAPABILITY, QUICKJS_PRELUDE, QuickJsRuntime, DynamicPluginInstance, createDynamicPlugin } from "./runtime-quickjs";
export type { DynamicHostServices, DynamicPluginSpec, DynamicUiBridge, QuickJsRuntimeOptions } from "./runtime-quickjs";
// P3.4：不可变包定义（AI 写的插件先变成包，再谈运行）与"虚拟插件目录"（接进 P3.1 的加载器路径）
export { PluginDefinitionRegistry, checkSyntax, sourceOf } from "./definitions";
export type { DefineInput, DefineResult, PackageFile, PluginPackage, SyntaxCheck } from "./definitions";
export { DYNAMIC_DIR_PREFIX, createDynamicPluginFs, dynamicDirOf, isDynamicDir } from "./dynamicFs";
// P3.5：插件日志的落点（面板与 plugin_diagnose 都读它）
export { PluginLogStore } from "./logs";
export type { PluginLogEntry, PluginLogLevel, PluginLogStoreOptions } from "./logs";
export {
  CAPABILITIES,
  HOST_API_VERSION,
  describeCapability,
  isSafeRelPath,
  manifestConfigSchema,
  parseManifest,
  validatePluginConfig,
} from "./manifest";
export type { CapabilityId, ManifestIssue, ManifestParseResult, PluginManifest, PluginUiSpec } from "./manifest";
export { PLUGIN_OPTIONS_KEY, createMemoryPluginStore, createSettingsPluginStore } from "./store";
export type { SettingsLike } from "./store";
export type {
  BuiltinPlugin,
  PermissionsService,
  PluginsService,
  PluginDirEntry,
  PluginEntry,
  PluginFs,
  PluginLoadReport,
  PluginLoaderOptions,
  PluginOptionStore,
  PluginOptions,
  PluginScanReport,
  PluginSource,
  PluginState,
  PluginStatus,
  PluginBundle,
  PluginDevService,
  PluginDiagnosis,
  PluginInstallReport,
  PluginLogsService,
  PluginPackageInfo,
  PluginRunResult,
} from "./types";
