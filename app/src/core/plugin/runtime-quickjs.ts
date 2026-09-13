/**
 * quickjs 运行时（P3.3）：让**用户目录里的插件包**真正跑起来。
 *
 * 引擎：quickjs-ng（MIT，纯解释器、无 JIT）的 WASM 构建，跑在 webview/应用进程里 ——
 * 选型理由见内部设计笔记（许可宽松、将来上 iOS 也能用）。
 *
 * ## 这层到底是什么、不是什么
 *
 * DSH 对自己那套沙箱的评价是 **"API discipline, not a security boundary"**（client-runner:201-202）。
 * 我们照抄这个立场：
 *   - **是**：一个能力纪律层 —— 插件默认什么也拿不到（连 fetch/setTimeout/require 都不存在，
 *     因为宿主根本没往全局里放），要用什么必须①在 manifest 里声明、②被用户授予、③每次调用再校验一次；
 *   - **不是**：安全边界。真正的边界是 Tauri capability 那层。别指望它能挡住恶意代码。
 *
 * ## 执行模型（实测选出来的，写在最前面免得被当成 bug）
 *
 * 试过 quickjs-emscripten 的 **asyncify** 变体（宿主函数可以是 async，VM 里直接 await），
 * 结论是不可用：asyncify 要求"一次进入 VM 只能展开一次栈"，插件里**串行 await 两个宿主调用就会崩**
 *（程序挂起、句柄失效）。所以改成经典做法：
 *
 *   1. 宿主函数**全是同步的**（vm.newFunction）；
 *   2. 需要异步的 op 返回一个 **QuickJS promise**（deferred），宿主在自己的异步操作完成时 resolve 它；
 *   3. 宿主用一个**泵循环**驱动：executePendingJobs() → 让出事件循环 → 再看主 promise 的状态；
 *   4. 整个循环受**总时间预算**约束（不只是同步死循环），同步死循环另由 setInterruptHandler 兜住。
 *
 * 于是插件里可以随便 await（顺序、循环、并发都行），宿主侧也拿回了"总超时"这个能力。
 */

import variant from "@jitl/quickjs-ng-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import type { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle, QuickJSWASMModule } from "quickjs-emscripten-core";
import type { Context, Disposer } from "../service/types";
import type { ToolRegistry } from "../../ai/tools/registry";
import type { JsonSchemaNode, ToolDefinition, ToolOutcome } from "../../ai/tools/types";
import type { ToolHost } from "../../ai/tools/host";
import type { CapabilityId } from "./manifest";
import type { AiCredentials, ReadingActivityService } from "../app/services";
import { originOf, type NetRequestInit, type NetResponse as NetFetchResponse } from "./netFetch";
import type { PermissionBroker, PermissionScope } from "./permissions";
import type { SlotsService } from "../../ui/slots/types";
import { t } from "../../i18n";

/** 每个 op 需要的能力：**每次调用都查**，所以"撤销授权立刻生效"是结构性的，不是补丁 */
export const OP_CAPABILITY: Record<string, CapabilityId> = {
  "reader.progress": "reader.read",
  "reader.chapters": "reader.read",
  "reader.chapter": "reader.read",
  "reader.search": "reader.read",
  "reader.selection": "reader.read",
  "reader.annotations": "reader.read",
  "reader.activity": "reader.read",
  "reader.addAnnotation": "reader.annotate",
  "reader.gotoChapter": "reader.navigate",
  "reader.gotoCfi": "reader.navigate",
  "reader.gotoFraction": "reader.navigate",
  "storage.get": "storage.plugin",
  "storage.set": "storage.plugin",
  "storage.delete": "storage.plugin",
  "storage.list": "storage.plugin",
  // P3.10：网络。范围检查在调用点做（目标 origin 必须被授权覆盖），见 requireCapability 的 scope 参数
  "net.fetch": "net.fetch",
};

/** 需要异步完成的 op（返回 promise 给插件 await）；其余同步返回 */
export const ASYNC_OPS = new Set([
  "net.fetch",
  "reader.search",
  "reader.annotations",
  "reader.activity",
  "reader.addAnnotation",
  "reader.gotoChapter",
  "reader.gotoCfi",
  "reader.gotoFraction",
  "storage.get",
  "storage.set",
  "storage.delete",
  "storage.list",
]);

/**
 * 插件里能看到的 ⟨ctx⟩（在 QuickJS 里求值的一段 shim）。
 *
 * 只暴露"能做什么"，不暴露"怎么做到"：所有动作都走 host.call(op, argsJson) 一个入口，
 * 于是权限检查、审计、超时都在宿主侧一处完成。
 *
 * 工具函数与 disposer 都挂在 **JS 侧的全局**（__aireaderTools / __aireaderDisposers）上，
 * 宿主**不跨调用持有任何 QuickJS 句柄** —— 句柄一旦过了作用域就会失效（实测踩到 Lifetime not alive）。
 */
export const QUICKJS_PRELUDE = [
  "globalThis.__aireaderTools = Object.create(null);",
  "globalThis.__aireaderDisposers = [];",
  // P3.4 UI 桥：渲染函数与事件处理器都挂在 JS 侧的全局上（宿主不跨调用持有句柄）
  "globalThis.__aireaderUiRender = Object.create(null);",
  "globalThis.__aireaderUiHandlers = Object.create(null);",
  // chain 槽位要的自提名函数（函数过不了 JSON，所以和 render 一样存在 JS 侧全局上）
  "globalThis.__aireaderUiSelect = Object.create(null);",
  "globalThis.__aireaderRunDisposers = async function () {",
  "  var list = globalThis.__aireaderDisposers.splice(0).reverse();",
  "  for (var i = 0; i < list.length; i++) { try { await list[i](); } catch (e) { globalThis.__aireaderDisposerError = String(e && e.message ? e.message : e); } }",
  "  return list.length;",
  "};",
  // P5 教学式陷阱：沙箱里默认没有 Node/浏览器全局，只把最常见的误用点做成"会说话的报错"
  // （照 DSH sandbox.js:78-108 的思路，方向相反：我们默认没有、再白名单注入）。
  // 只 trap 函数型全局；window/document/process 这类数据型保持不存在，免得 typeof 探测被骗。
  "(function () {",
  "  var trap = function (name, message) { globalThis[name] = function () { throw new Error(message); }; };",
  "  trap('setTimeout', '沙箱里没有 setTimeout。要定时请用 ctx.timeout(fn, ms)：它返回一个 handle，可用 ctx.clear(handle) 取消，插件卸载时宿主会自动清理');",
  "  trap('setInterval', '沙箱里没有 setInterval。周期执行请用 ctx.interval(fn, ms)（最小 100ms，卸载自动清理）；只跑一次用 ctx.timeout(fn, ms)');",
  "  trap('clearTimeout', '沙箱里没有 clearTimeout');",
  "  trap('clearInterval', '沙箱里没有 clearInterval');",
  "  trap('requestAnimationFrame', '沙箱里没有 requestAnimationFrame。画完调 ctx.slots.refresh() 触发重渲染');",
  "  trap('fetch', '沙箱里没有 fetch。请用 ctx.net.fetch(url, options)：需在 manifest.capabilities 声明 net.fetch 并在 network.origins 写明域名，由用户授权');",
  "  trap('XMLHttpRequest', '沙箱里没有 XMLHttpRequest。请用 ctx.net.fetch(url, options)');",
  "  trap('require', '沙箱里没有 require/module：插件就是单文件模块，没有 npm 依赖。要用宿主能力先调 plugin_inspect 看清单，再从 ctx.* 取');",
  "  trap('importScripts', '沙箱里没有 importScripts：插件是单文件，不要加载外部脚本');",
  "})();",
  // P5 计时器回调表：宿主函数的入参句柄会被引擎释放，所以函数存在 VM 里，宿主只传编号
  "globalThis.__aireaderTimerCbs = Object.create(null);",
  "globalThis.__aireaderTimerSeq = 0;",
  "globalThis.__aireaderCtx = function (host) {",
  "  var parse = function (s) { return s === \"\" || s === undefined || s === null ? undefined : JSON.parse(s); };",
  "  var unwrap = function (raw) {",
  "    var value = parse(raw);",
  "    if (value && typeof value === 'object' && value.__aireaderError) throw new Error(value.__aireaderError);",
  "    return value;",
  "  };",
  "  var call = function (op, args) {",
  "    var json = args === undefined ? \"\" : JSON.stringify(args);",
  // 实测：插件把**函数**塞进参数（例如想用 provide 当服务注册表）时，JSON.stringify 返回 undefined，
  // 宿主拿到字符串 \"undefined\" 再去 JSON.parse 就会抛 \"undefined\" is not valid JSON —— 完全看不出病因。
  "    if (json === undefined) throw new Error(op + ' 的参数没法序列化成 JSON（不要把函数 / undefined 传进来）');",
  "    var raw = host.call(op, json);",
  "    if (raw && typeof raw.then === 'function') return raw.then(unwrap);",
  "    return unwrap(raw);",
  "  };",
  "  var must = function (err) { if (err) throw new Error(err); };",
  "  return {",
  "    log: function () {",
  "      var parts = [];",
  "      for (var i = 0; i < arguments.length; i++) {",
  "        var a = arguments[i];",
  "        parts.push(typeof a === 'string' ? a : JSON.stringify(a));",
  "      }",
  "      try { host.log('info', parts.join(' ')); } catch (e) { /* 日志失败不该影响插件 */ }",
  "    },",
  "    effect: function (fn) {",
  "      if (typeof fn !== 'function') throw new Error('ctx.effect 需要一个函数');",
  "      must(host.effect(fn));",
  "    },",
  "    provide: function (name, data) {",
  "      if (typeof data === 'function') throw new Error('ctx.provide 只能给**纯数据**：函数过不了沙箱边界（两半在同一个 realm，要共享状态请用 globalThis；要暴露能力请用 ctx.tools.register）');",
  "      if (typeof data === 'undefined') throw new Error('ctx.provide 的第二个参数不能是 undefined');",
  "      var json = JSON.stringify(data);",
  "      if (json === undefined) throw new Error('ctx.provide 的值没法序列化成 JSON');",
  "      must(host.provide(String(name), json));",
  "    },",
  "    tools: {",
  "      register: function (def, execute) {",
  "        if (!def || !def.name) throw new Error('ctx.tools.register 需要 { name, description, parameters, capabilities }');",
  "        if (typeof execute !== 'function') throw new Error('ctx.tools.register 需要第二个参数：async execute(args) 函数');",
  "        must(host.registerTool(JSON.stringify({",
  "          name: String(def.name),",
  "          description: String(def.description || ''),",
  "          parameters: def.parameters,",
  "          capabilities: def.capabilities || [],",
  "        }), execute));",
  "      },",
  "    },",
  "    reader: {",
  "      progress: function () { return call('reader.progress'); },",
  "      chapters: function () { return call('reader.chapters'); },",
  "      chapter: function (n, offset, maxChars) { return call('reader.chapter', { n: n, offset: offset || 0, maxChars: maxChars || 4000 }); },",
  "      search: function (query, limit) { return call('reader.search', { query: query, limit: limit || 10 }); },",
  "      selection: function () { return call('reader.selection'); },",
  "      annotations: function () { return call('reader.annotations'); },",
  "      activity: function () { return call('reader.activity'); },",
  "      addAnnotation: function (input) { return call('reader.addAnnotation', input); },",
  "      gotoChapter: function (n) { return call('reader.gotoChapter', { n: n }); },",
  "      gotoCfi: function (cfi) { return call('reader.gotoCfi', { cfi: cfi }); },",
  "      gotoFraction: function (fraction) { return call('reader.gotoFraction', { fraction: fraction }); },",
  "    },",
  "    net: {",
  "      fetch: function (url, options) {",
  "        if (!url || typeof url !== 'string') throw new Error('ctx.net.fetch(url, options?) 需要 URL 字符串');",
  "        if (options === undefined || options === null) return call('net.fetch', { url: url });",
  "        if (typeof options !== 'object') throw new Error('ctx.net.fetch 的第二个参数必须是 { method?, headers?, body? }');",
  "        return call('net.fetch', { url: url, init: { method: options.method, headers: options.headers, body: options.body } });",
  "      },",
  "    },",
  "    storage: {",
  "      get: function (key) { return call('storage.get', { key: key }); },",
  "      set: function (key, value) {",
  // JSON.stringify 会把函数**静默丢掉**（{key, value: fn} → {"key":"k"}），存进去的是空值 ——
  // 这种"看起来成功、其实没存"的失败最难查，所以在调用点直接拒。
  "        if (typeof value === 'function') throw new Error('ctx.storage.set 只能存 JSON 数据：函数存不进去（要共享状态用 globalThis）');",
  "        return call('storage.set', { key: key, value: value });",
  "      },",
  "      remove: function (key) { return call('storage.delete', { key: key }); },",
  "      keys: function () { return call('storage.list'); },",
  "    },",
  "    theme: {",
  "      overrideTokens: function (tokens) {",
  "        if (!tokens || typeof tokens !== 'object') throw new Error('ctx.theme.overrideTokens 需要 { \"--air-accent\": \"#c00\" }（值可以是字符串，也可以按主题给 { light, sepia, dark }）');",
  "        must(host.themeOverride(JSON.stringify(tokens)));",
  "      },",
  "    },",
  "    slots: {",
  "      register: function (options, render) {",
  // 宿主面的 SlotRegistration 字段叫 name、动态插件面叫 slot —— 两个都认，别让作者踩这个名字坑
  "        var slotName = options && (options.slot !== undefined ? options.slot : options.name);",
  "        if (!options || typeof slotName !== 'string' || !slotName) throw new Error('ctx.slots.register 需要 { slot: 「槽位名」 }（也接受 name）；槽位名必须来自 plugin_inspect 的插槽目录');",
  "        if (typeof render !== 'function') throw new Error('ctx.slots.register 需要第二个参数：同步的 render(props, ui) 函数');",
  "        var selectFn = options && typeof options.select === 'function' ? options.select : null;",
  "        must(host.uiRegister(JSON.stringify({",
  "          slot: String(slotName),",
  "          id: options.id === undefined ? undefined : String(options.id),",
  "          key: options.key === undefined ? undefined : String(options.key),",
  "          order: options.order === undefined ? undefined : Number(options.order),",
  "          priority: options.priority === undefined ? undefined : Number(options.priority),",
  "          label: options.label === undefined ? undefined : String(options.label),",
  "        }), render, selectFn));",
  "        return undefined;",
  "      },",
  "      refresh: function () { must(host.uiRefresh('')); },",
  "    },",
    // P5：宿主提供的计时器（照 DSH 的 timer 服务）。返回 handle，用 ctx.clear(handle) 取消；
    // 忘了取消也没关系：插件卸载时宿主会统一清掉（interval 是最常见的泄漏源）。
    "    timeout: function (fn, ms) {",
    "      if (typeof fn !== 'function') throw new Error('ctx.timeout(fn, ms) 的第一个参数必须是函数');",
    "      var n = ++globalThis.__aireaderTimerSeq; globalThis.__aireaderTimerCbs[n] = fn;",
    "      var r = JSON.parse(String(host.timer('timeout', n, Number(ms))));",
    "      if (r.error) throw new Error(r.error);",
    "      return r.id;",
    "    },",
    "    interval: function (fn, ms) {",
    "      if (typeof fn !== 'function') throw new Error('ctx.interval(fn, ms) 的第一个参数必须是函数');",
    "      var n = ++globalThis.__aireaderTimerSeq; globalThis.__aireaderTimerCbs[n] = fn;",
    "      var r = JSON.parse(String(host.timer('interval', n, Number(ms))));",
    "      if (r.error) throw new Error(r.error);",
    "      return r.id;",
    "    },",
    "    clear: function (handle) {",
    "      var r = JSON.parse(String(host.clearTimer(String(handle))));",
    "      if (r.error) throw new Error(r.error);",
    "    },",
    // P5：宿主给的两样"Node 里白送"的东西：随机 id 与环境事实（都不需要授权）
    "    crypto: {",
    "      randomUUID: function () { var r = JSON.parse(String(host.crypto('uuid', 0))); if (r.error) throw new Error(r.error); return r.value; },",
    "      randomHex: function (n) { var r = JSON.parse(String(host.crypto('randomHex', Number(n || 16)))); if (r.error) throw new Error(r.error); return r.value; },",
    "    },",
    "    env: function () { var r = JSON.parse(String(host.env())); if (r.error) throw new Error(r.error); return r.value; },",
    // 纯 JS 的小工具（不需要宿主）：插件拼文件名/截断文本时天天要用
    "    text: {",
    "      basename: function (p) { var s = String(p || '').replace(/[\\\\/]+$/, ''); var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\\\')); return i < 0 ? s : s.slice(i + 1); },",
    "      extname: function (p) { var b = String(p || ''); var i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i); },",
    "      truncate: function (s, n) { var t = String(s || ''); return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + '…'; },",
    "      slug: function (s) { return String(s || '').trim().replace(/[\\\\/:*?\"<>|]+/g, '-').replace(/\\s+/g, '-').slice(0, 60); },",
    "    },",
  "    on: function () {",
  "      throw new Error('ctx.on 还没接入：动态包不能订阅宿主事件（要重渲染就调 ctx.slots.refresh()）');",
  "    },",
  "  };",
  "};",
].join("\n");

/**
 * 动态包 UI 桥的契约（P3.4 第 0 步）。
 *
 * 跨 realm 传不了 React 元素（函数/原型/Symbol 都过不去），所以插件交出来的是
 * **声明式 JSON VDOM**，宿主用 src/ui/dynamic/vdom.tsx 那个薄渲染器变成 React 元素。
 * 这里只定义"宿主渲染器需要什么"，不 import React —— core 层不认识 React。
 */
export type DynamicUiBridge = {
  pluginId: string;
  /** 同步渲染：返回声明式 VDOM 的 JSON 字符串；抛错 = 这一格渲染失败（会被摘掉并上报） */
  render(props: Record<string, unknown>): string;
  /** 同步调用插件注册的事件处理器（令牌由 ui.handler 生成） */
  invoke(token: string): void;
  /** 订阅"需要重渲染"（插件调 ctx.slots.refresh()，或某个 handler 跑完之后） */
  subscribe(cb: () => void): () => void;
  /** useSyncExternalStore 的快照 */
  version(): number;
  /** 渲染期失败上报（DSH 的 reportRenderFailure；plugin_diagnose 读它） */
  report(error: unknown): void;
};

export type DynamicHostServices = {
  /** 阅读器能力缝（与工具层同一个 ToolHost） */
  reader: () => ToolHost | null;
  /** 阅读活动（P3.7）：不给 = ctx.reader.activity() 返回 null */
  activity?: () => ReadingActivityService | null;
  /**
   * 网络（P3.10）：**由 app 注入**（core 不认识 fetch 的实现细节，测试里也能换掉）。
   * allowedOrigins 是"这个插件被授予的域名清单"，pluginFetch 用它复核重定向的每一跳。
   */
  net?: {
    fetch(url: string, init: NetRequestInit, allowedOrigins: string[]): Promise<NetFetchResponse>;
  };
  /**
   * 宿主自己的 AI 凭据（P3.11）：**只用于在宿主侧代填请求头**。
   * 插件拿不到它（既不进沙箱，也不出现在任何 inspect 输出里）。
   */
  aiCredentials?: () => AiCredentials | null;
  /** 插件自己的存储（宿主按 pluginId 隔离） */
  storage: {
    get(pluginId: string, key: string): Promise<unknown>;
    set(pluginId: string, key: string, value: unknown): Promise<void>;
    remove(pluginId: string, key: string): Promise<void>;
    keys(pluginId: string): Promise<string[]>;
  };
  log?: (pluginId: string, level: string, message: string) => void;
  /**
   * UI 桥的宿主侧工厂（由 app runtime 注入 src/ui/dynamic 的实现）。
   * 不给 = 动态包不能挂界面：ctx.slots.register 会明确报错，而不是静默什么都不显示。
   */
  ui?: { createComponent(bridge: DynamicUiBridge): unknown };
};

export type DynamicPluginSpec = {
  pluginId: string;
  version: string;
  /**
   * **宿主半**（manifest.main）的内容：函数体 / IIFE 均可，只要能交出 apply(ctx, config)。
   * 只写 UI 半的包这里给空串（两半至少有一个，这是 DSH 的"至少一半代码"）。
   */
  code: string;
  /** **UI 半**（manifest.ui.entry）的内容：同一个 realm、同一份 ctx，用 ctx.slots.register 挂界面 */
  uiCode?: string;
  /** manifest 里声明的能力（授权检查的依据） */
  capabilities: CapabilityId[];
};

export type QuickJsRuntimeOptions = {
  permissions: PermissionBroker;
  services: DynamicHostServices;
  log?: (level: "info" | "warn" | "error", message: string, error?: unknown) => void;
  /** 单次进入插件代码的**总**时间预算（毫秒）：同步死循环与 await 卡死都算 */
  budgetMs?: number;
  /** 每个插件上下文的内存上限 */
  memoryLimitBytes?: number;
  now?: () => number;
};

/** ctx.slots.register 的选项（prelude 已经把类型收敛成这几个字段） */
type UiOptions = {
  slot: string;
  id?: string;
  key?: string;
  order?: number;
  priority?: number;
  label?: string;
};

/** 一次界面注册在宿主侧的账本 */
type UiHandle = {
  id: string;
  slot: string;
  label?: string;
  /** chain 槽位：插件交过 select（宿主会同步回调它） */
  hasSelect?: boolean;
  /** useSyncExternalStore 的快照：refresh / handler 之后 +1 */
  version: number;
  listeners: Set<() => void>;
};

type ToolMeta = {
  name: string;
  description: string;
  parameters: JsonSchemaNode;
  capabilities: CapabilityId[];
};

/** 一个动态插件实例 = 一个 QuickJSContext（HMR/重挂 = 换掉整个 context + 重放） */
export class DynamicPluginInstance {
  private vm: QuickJSContext;
  private runtime: QuickJsRuntime;
  private spec: DynamicPluginSpec;
  private ctx: Context;
  private permissionBroker: PermissionBroker;
  private budgetMs: number;
  private deadline = 0;
  /** 还没结算的宿主 promise（停止时要释放） */
  private deferreds = new Set<QuickJSDeferredPromise>();
  /** 后台泵正在跑（渲染期发起的异步 op 靠它推进 job 队列，见 schedulePump） */
  private pumping = false;
  private toolMeta = new Map<string, ToolMeta>();
  /** P3.4 UI 桥：一个 handle = 一次 ctx.slots.register（渲染函数 + 事件处理器表 + 订阅者） */
  private uiHandles = new Map<string, UiHandle>();
  private uiSeq = 0;
  /** P5 计时器：key = 给插件的 handle，value = 取消函数。卸载时统一清（interval 最易泄漏） */
  private timers = new Map<string, () => void>();
  private timerSeq = 0;
  /** 正在停止（跑 disposer 期间）：不再接受新的外部调用，但插件自己的清理还能用宿主 API */
  private stopping = false;
  private stopped = false;
  private loaded = false;

  constructor(opts: {
    runtime: QuickJsRuntime;
    vm: QuickJSContext;
    spec: DynamicPluginSpec;
    ctx: Context;
    permissions: PermissionBroker;
    budgetMs: number;
  }) {
    this.runtime = opts.runtime;
    this.vm = opts.vm;
    this.spec = opts.spec;
    this.ctx = opts.ctx;
    this.permissionBroker = opts.permissions;
    this.budgetMs = opts.budgetMs;
  }

  get pluginId(): string {
    return this.spec.pluginId;
  }

  get isStopped(): boolean {
    return this.stopped || this.stopping;
  }

  memoryBytes(): number {
    const usage = this.vm.runtime.computeMemoryUsage();
    return typeof usage === "number" ? usage : 0;
  }

  /** 这个能力现在还有效吗（每次调用都问，撤销因此立刻生效）。scope 给了就按范围判（net.fetch） */
  private allowed(capability: CapabilityId, scope?: PermissionScope): boolean {
    if (this.stopped) return false;
    return this.permissionBroker.allows({
      pluginId: this.spec.pluginId,
      version: this.spec.version,
      capability,
      scope,
    });
  }

  private requireCapability(capability: CapabilityId, what: string, scope?: PermissionScope): void {
    if (this.stopping) throw new Error("插件正在停止，不再接受新的调用（" + this.spec.pluginId + "）");
    if (this.stopped) throw new Error("插件已停止（" + this.spec.pluginId + "）");
    if (!this.allowed(capability, scope)) {
      throw new Error(
        what + " 需要能力 " + capability + "，但它没有（未被授予、范围不够、或已被撤销）",
      );
    }
  }

  /**
   * 宿主代填 Authorization（P3.11）：插件声明并获授 `ai.credentials` 时，
   * 对**当前 AI 服务**的 **GET/HEAD** 请求由宿主加上 `Authorization: Bearer <宿主配置的 Key>`。
   *
   * 三条边界：
   *   1. **只 GET/HEAD**：查余额这类读操作可以，`chat/completions` 那种花钱的写操作不行 ——
   *      插件因此拿不到"花用户钱"的能力；
   *   2. **只在当前 provider 的 origin 上**，而且要与授权时记下的那个 origin 一致
   *      （用户换了服务商，旧授权不会跟着漂过去，需要重新授权）；
   *   3. **插件自己给了 authorization 就不覆盖**（它想用自己的 Key 是它的自由）；
   *      Key 本身**不进沙箱**：这里拼完请求头就交给宿主侧 fetch，插件全程看不到它。
   */
  private withHostAiKey(
    origin: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ): Record<string, string> | undefined {
    const headers = { ...(init?.headers ?? {}) };
    const hasOwn = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
    if (hasOwn) return headers;

    const creds = this.runtime.servicesAiCredentials();
    if (!creds) return headers;
    // 没声明就没这回事（不报错，走普通请求）
    if (!(this.spec.capabilities ?? []).includes("ai.credentials")) return headers;
    if (!this.allowed("ai.credentials", { origins: [creds.origin] })) {
      throw new Error("这个插件声明了 ai.credentials，但没被授予（或授权范围不是 " + creds.origin + "）");
    }
    const method = String(init?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      throw new Error(
        "ai.credentials 只对 GET / HEAD 生效：带 Key 的写请求（POST）必须由用户自己在插件配置里提供，宿主不会替他发",
      );
    }
    if (origin !== creds.origin) {
      throw new Error("ai.credentials 只用于你配置的 AI 服务（" + creds.origin + "）；这次要访问的是 " + origin);
    }
    if (!creds.authorization) {
      throw new Error("应用里还没配置 AI Key（设置 → AI 服务），所以没法替你带上 Authorization");
    }
    headers.authorization = creds.authorization;
    return headers;
  }

  /**
   * 这个插件**已被授予**的域名（P3.10）：重定向的每一跳要用它复核。
   * 注意与 requireCapability 的分工：那边判"这一次的目标能不能访问"，这边给出清单让
   * pluginFetch 在跟随重定向时自己再判一次 —— 少了这一步，一次 302 就能把插件带到任意域名。
   */
  private grantedOrigins(): string[] {
    return this.permissionBroker
      .list(this.spec.pluginId)
      .filter((r) => r.capability === "net.fetch" && r.state === "granted")
      .flatMap((r) => r.scope?.origins ?? []);
  }

  /** 把引擎里的 error handle 说成人话（dump 出来的可能是 Error/普通对象，不能直接 String） */
  private describeError(handle: QuickJSHandle): string {
    try {
      const dumped = this.vm.dump(handle);
      if (dumped instanceof Error) return dumped.message || String(dumped);
      if (dumped && typeof dumped === "object") {
        const obj = dumped as { name?: string; message?: string };
        if (obj.message) return (obj.name && obj.name !== "Error" ? obj.name + ": " : "") + obj.message;
        try {
          return JSON.stringify(dumped);
        } catch {
          return "[无法序列化的引擎错误]";
        }
      }
      return String(dumped);
    } catch {
      return "[无法读取的引擎错误]";
    }
  }

  private arm(): void {
    this.deadline = this.runtime.nowFn() + this.budgetMs;
    this.vm.runtime.setInterruptHandler(() => this.runtime.nowFn() > this.deadline);
  }

  /**
   * 求值插件代码 → 拿到 apply（只做形状检查，不执行）。
   *
   * **两半**（DSH 的 host 半 / client 半）：main 与 ui.entry 各求值一次，各自交出 apply，
   * 共用同一个 realm 与同一份 ctx。我们不分两个 realm（那要跨 realm 桥），
   * 但对"AI 写的插件"来说两半的分工仍然成立：宿主半注册工具/服务，UI 半挂界面。
   */
  async load(): Promise<void> {
    const vm = this.vm;
    const prelude = vm.evalCode(QUICKJS_PRELUDE, "aireader-prelude.js");
    if (prelude.error) {
      const message = this.describeError(prelude.error);
      prelude.error.dispose();
      throw new Error(t("core.quickjsPreludeFailed", { error: message }));
    }
    prelude.value.dispose();

    const halves: { global: string; file: string; code: string }[] = [];
    if (this.spec.code.trim()) halves.push({ global: "__aireaderApply", file: "main.js", code: this.spec.code });
    if (this.spec.uiCode?.trim()) halves.push({ global: "__aireaderApplyUi", file: "ui.js", code: this.spec.uiCode });
    if (!halves.length) throw new Error(t("core.quickjsEmptyPackage"));

    for (const half of halves) {
      // 插件代码被包成"交出 apply"的形式：函数体 / IIFE / module.exports 都认
      const wrapped = [
        "(function () {",
        "  var module = { exports: {} }; var exports = module.exports;",
        half.code,
        "  ; if (typeof apply === 'function') return { apply: apply };",
        "  if (typeof module.exports === 'function') return { apply: module.exports };",
        "  if (module.exports && typeof module.exports.apply === 'function') return module.exports;",
        "  throw new Error('这一半必须交出 apply(ctx, config)（或 module.exports.apply）');",
        "})()",
      ].join("\n");
      this.arm();
      const evaluated = vm.evalCode(wrapped, this.spec.pluginId + "/" + half.file);
      if (evaluated.error) {
        const message = this.describeError(evaluated.error);
        evaluated.error.dispose();
        throw new Error(t("core.quickjsEvalFailed", { file: half.file, error: message }));
      }
      const moduleHandle = evaluated.value;
      const applyHandle = vm.getProp(moduleHandle, "apply");
      if (vm.typeof(applyHandle) !== "function") {
        moduleHandle.dispose();
        applyHandle.dispose();
        throw new Error(t("core.quickjsNoApply", { file: half.file }));
      }
      // 不跨调用持有句柄：挂到 JS 侧全局上
      vm.setProp(vm.global, "__aireaderApplyArg", applyHandle);
      const kept = vm.evalCode("globalThis." + half.global + " = __aireaderApplyArg");
      if (kept.error) kept.error.dispose();
      else kept.value.dispose();
      applyHandle.dispose();
      moduleHandle.dispose();
    }
    this.loaded = true;
  }

  /** 执行插件的 apply(ctx, config)：宿主造 ctx → 调 apply → 把返回的 disposer 挂到 JS 侧 */
  async apply(config: unknown): Promise<void> {
    if (!this.loaded) throw new Error(t("core.quickjsNotLoaded"));
    const vm = this.vm;
    const hostHandle = vm.newObject();
    try {
      this.installHost(hostHandle);
      vm.setProp(vm.global, "__aireaderHost", hostHandle);
      const configHandle = this.jsonHandle(config ?? {});
      vm.setProp(vm.global, "__aireaderConfigArg", configHandle);
      configHandle.dispose();

      const runHalf = (name: string) =>
        [
          "(function () {",
          "  var fn = globalThis." + name + ";",
          "  if (typeof fn !== 'function') return 'ok';",
          "  var returned = fn(__aireaderCtx(__aireaderHost), __aireaderConfigArg);",
          "  if (returned && typeof returned.then === 'function') {",
          "    return returned.then(function (d) { if (typeof d === 'function') __aireaderDisposers.push(d); return 'ok'; });",
          "  }",
          "  if (typeof returned === 'function') __aireaderDisposers.push(returned);",
          "  return 'ok';",
          "})()",
        ].join("\n");
      // 宿主半在前、UI 半在后（UI 半可能要用宿主半 provide 出来的东西）。
      //
      // **必须 await 这两半**（P3.7 修）：原来只是「调用一下」，于是 apply 里
      // await ctx.storage.get(...) 之后要做的事**没人泵** —— 装载被当成「成功且已完成」，
      // 插件却什么都还没注册，而且不会报错（要等下一次进 VM 才会接着跑）。
      // 实测：await ctx.reader.activity() 的回调一直不执行，日志里什么都没有。
      const entry =
        "(async function () { await " + runHalf("__aireaderApply") + "; await " + runHalf("__aireaderApplyUi") + "; return 'ok'; })()";
      this.arm();
      const result = vm.evalCode(entry, this.spec.pluginId + "/apply");
      if (result.error) {
        const message = this.describeError(result.error);
        result.error.dispose();
        throw new Error(t("core.quickjsApplyThrew", { error: message }));
      }
      const settled = await this.settle(result.value, "apply");
      result.value.dispose();
      if (!settled.ok) throw new Error(t("core.quickjsApplyFailed", { error: settled.error }));
    } finally {
      hostHandle.dispose();
    }
  }

  /** 驱动 promise 直到结算：executePendingJobs → 让出事件循环 → 再查状态 */
  private async settle(main: QuickJSHandle, what: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    const vm = this.vm;
    let state = vm.getPromiseState(main);
    while (state.type === "pending") {
      vm.runtime.executePendingJobs();
      state = vm.getPromiseState(main);
      if (state.type !== "pending") break;
      if (this.runtime.nowFn() > this.deadline) {
        return { ok: false, error: t("core.quickjsTimeout", { ms: this.budgetMs, stage: what }) };
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (state.type === "rejected") {
      const message = this.describeError(state.error);
      if (state.error !== main) state.error.dispose();
      return { ok: false, error: message };
    }
    if (state.type === "fulfilled") {
      const value = vm.dump(state.value);
      // 非 promise 的结果会原样返回（notAPromise），这时 value 就是 main 本身 —— 不能重复释放
      if (state.value !== main && !state.notAPromise) state.value.dispose();
      return { ok: true, value };
    }
    return { ok: true, value: undefined };
  }

  /** 宿主函数面：白名单 + 每次调用校验能力 */
  private installHost(target: QuickJSHandle): void {
    const vm = this.vm;
    const set = (name: string, fn: QuickJSHandle) => {
      vm.setProp(target, name, fn);
      fn.dispose();
    };

    set(
      "call",
      vm.newFunction("hostCall", (opHandle, argsHandle) => {
        const op = String(vm.dump(opHandle));
        const rawArgs = String(vm.dump(argsHandle));
        let args: Record<string, unknown> | undefined;
        try {
          args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : undefined;
        } catch {
          // 纵深防御：prelude 已经拦了一层，这里再拦一次并说清是哪个 op（别把 JSON.parse 的原文抛给用户）
          throw new Error(op + " 的参数不是合法 JSON：" + rawArgs.slice(0, 80));
        }
        try {
          // 能力检查放在**同步边界**：异步 op 也要同步就报错，
          // 否则插件不 await 时错误只会在 promise 里悄悄发生（实测踩到）
          const capability = OP_CAPABILITY[op];
          if (!capability) throw new Error("未知的宿主操作：" + op);
          this.requireCapability(capability, "调用 " + op);
          // 说明：宿主函数**不向 VM 抛异常**，而是把错误放进返回值（__aireaderError），
          // 由 prelude 在 JS 侧 throw —— 宿主抛出的异常会在引擎里留下我们碰不到的句柄（实测泄漏）。
          if (ASYNC_OPS.has(op)) {
            // 异步 op：给插件一个真正的 promise，宿主侧完成后再 resolve
            // 按 quickjs-emscripten 的推荐用法：宿主函数**返回 deferred.handle**，
            // 结算后除 handle 交给引擎之外不需要额外清理（resolve/reject 会自己释放回调句柄）
            const deferred = vm.newPromise();
            this.deferreds.add(deferred);
            Promise.resolve(this.dispatch(op, args)).then(
              (value) => {
                try {
                  // 必须 resolve 一个**字符串**：prelude 那边对 promise 的结果还要 JSON.parse 一次。
                  // 早先这里传的是 jsonHandle（解析后的 JS 值），于是 JSON.parse(对象) 抛
                  // "unexpected token: 'object'" —— 只有 null 侥幸能过。实测踩到，别改回去。
                  const json = JSON.stringify(value === undefined ? null : value) ?? "null";
                  const handle = vm.newString(json);
                  deferred.resolve(handle);
                  try {
                    handle.dispose();
                  } catch {
                    /* 已被接管 */
                  }
                } catch (e) {
                  this.runtime.log("warn", "结算宿主 promise 失败", e);
                }
                this.deferreds.delete(deferred);
              },
              (error) => {
                try {
                  const errorHandle = vm.newError(String(error instanceof Error ? error.message : error));
                  deferred.reject(errorHandle);
                  // reject 与 resolve 不同：它不接管这个句柄，不释放就会让 QuickJS 在
                  // FreeRuntime 时断言失败（gc_obj_list 非空）—— 实测踩到，别删这行
                  try {
                    errorHandle.dispose();
                  } catch {
                    /* 已被接管 */
                  }
                } catch (e) {
                  this.runtime.log("warn", "拒绝宿主 promise 失败", e);
                }
                this.deferreds.delete(deferred);
              },
            );
            return deferred.handle;
          }
          const value = this.dispatchSync(op, args);
          return vm.newString(value === undefined ? "" : JSON.stringify(value));
        } catch (e) {
          return vm.newString(JSON.stringify({ __aireaderError: e instanceof Error ? e.message : String(e) }));
        }
      }),
    );

    set(
      "log",
      vm.newFunction("hostLog", (levelHandle, messageHandle) => {
        const level = String(vm.dump(levelHandle));
        const message = String(vm.dump(messageHandle));
        if (this.allowed("log.write")) this.runtime.logFn(this.spec.pluginId, level, message);
      }),
    );

    set(
      "effect",
      vm.newFunction("hostEffect", (fnHandle) => {
        // 回调必须是同步的（宿主函数都是同步的，没法在里头等一个 promise）
        const result = vm.callFunction(fnHandle, vm.undefined);
        if (result.error) {
          const message = this.describeError(result.error);
          result.error.dispose();
          return vm.newString("ctx.effect 的回调抛错：" + message);
        }
        const disposeHandle = result.value;
        if (vm.typeof(disposeHandle) === "function") {
          vm.setProp(vm.global, "__aireaderDisposerArg", disposeHandle);
          const pushed = vm.evalCode("__aireaderDisposers.push(__aireaderDisposerArg)");
          if (pushed.error) pushed.error.dispose();
          else pushed.value.dispose();
        }
        disposeHandle.dispose();
        return vm.newString("");
      }),
    );

    /**
     * P5 计时器（照 DSH 的 timer 服务）：**宿主提供**，插件不用自己造。
     *
     * 实现要点：宿主函数的**入参句柄在返回后就被引擎释放**，所以回调不靠句柄传递 ——
     * prelude 把函数存进 VM 自己的表 `__aireaderTimerCbs[n]`，这里只收编号 n；
     * 到点用 `vm.evalCode` 现场取出来调（表达式只由数字拼成，没有注入面）。
     * 这样既不用持有句柄，也不会在引擎释放后触发 GC 断言。
     */
    set(
      "timer",
      vm.newFunction("hostTimer", (kindHandle, indexHandle, msHandle) => {
        const kind = String(vm.dump(kindHandle));
        const index = Number(vm.dump(indexHandle));
        const ms = Number(vm.dump(msHandle));
        if (this.stopped || this.stopping) return vm.newString(JSON.stringify({ error: "插件正在停止，不能再起定时器" }));
        if (kind !== "timeout" && kind !== "interval") {
          return vm.newString(JSON.stringify({ error: "只有 ctx.timeout / ctx.interval 可用，收到：" + kind }));
        }
        if (!Number.isFinite(ms) || ms < 0) {
          return vm.newString(JSON.stringify({ error: kind + " 的毫秒数不合法：" + String(vm.dump(msHandle)) }));
        }
        // interval 下限 100ms（别让 1ms 定时器把界面拖死），上限 1 小时
        const delay = kind === "interval" ? Math.min(Math.max(ms, 100), 3_600_000) : Math.min(ms, 3_600_000);
        const id = "t" + ++this.timerSeq;
        const fire = () => {
          if (this.stopped || this.stopping || !this.timers.has(id) || !vm.alive) return;
          if (kind === "timeout") this.timers.delete(id);
          try {
            const result = vm.evalCode(
              "(function () { var f = globalThis.__aireaderTimerCbs[" + index + "];" +
                " if (typeof f !== 'function') return 'missing';" +
                " try { f(); } catch (e) { return String(e && e.message ? e.message : e); }" +
                " if (" + JSON.stringify(kind) + " === 'timeout') delete globalThis.__aireaderTimerCbs[" + index + "];" +
                " return ''; })()",
            );
            if (result.error) {
              this.runtime.log("warn", "定时器回调抛错：" + this.describeError(result.error));
              result.error.dispose();
            } else {
              const note = String(vm.dump(result.value));
              result.value.dispose();
              if (note && note !== "missing") this.runtime.log("warn", "定时器回调抛错：" + note);
            }
          } catch (e) {
            this.runtime.log("warn", "定时器回调无法执行：" + String(e instanceof Error ? e.message : e));
          }
        };
        const real = kind === "interval" ? setInterval(fire, delay) : setTimeout(fire, delay);
        this.timers.set(id, () => {
          if (kind === "interval") clearInterval(real);
          else clearTimeout(real);
        });
        return vm.newString(JSON.stringify({ id }));
      }),
    );

    set(
      "clearTimer",
      vm.newFunction("hostClearTimer", (idHandle) => {
        const id = String(vm.dump(idHandle));
        const cancel = this.timers.get(id);
        if (!cancel) return vm.newString(JSON.stringify({ error: "没有这个计时器 handle：" + id + "（可能已经触发过了）" }));
        cancel();
        this.timers.delete(id);
        return vm.newString(JSON.stringify({ ok: true }));
      }),
    );

    /**
     * P5：把"Node 里随手就有、插件最常用"的两样补齐 —— **随机/唯一 id** 与**宿主环境事实**。
     * DSH 这两样是 Node 白送的（crypto / process.env），我们这边从宿主函数来。
     * 都是同步、无副作用、不需要授权（不碰用户数据，也花不了钱）。
     */
    set(
      "crypto",
      vm.newFunction("hostCrypto", (opHandle, argHandle) => {
        const op = String(vm.dump(opHandle));
        try {
          if (typeof crypto === "undefined") return vm.newString(JSON.stringify({ error: "这个环境没有 crypto" }));
          if (op === "uuid") return vm.newString(JSON.stringify({ value: crypto.randomUUID() }));
          if (op === "randomHex") {
            const asked = Number(vm.dump(argHandle));
            const n = Math.min(Math.max(Number.isFinite(asked) ? Math.floor(asked) : 16, 1), 256);
            const bytes = new Uint8Array(Math.ceil(n / 2));
            crypto.getRandomValues(bytes);
            const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
            return vm.newString(JSON.stringify({ value: hex.slice(0, n) }));
          }
          return vm.newString(JSON.stringify({ error: "不支持的 crypto 操作：" + op + "（可用：uuid / randomHex）" }));
        } catch (e) {
          return vm.newString(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
        }
      }),
    );

    set(
      "env",
      vm.newFunction("hostEnv", () => {
        // 宿主侧事实：插件拿它做"移动端/桌面端不同布局"这类判断（Tauri 没有 process.env）
        const facts: Record<string, unknown> = { now: Date.now() };
        try {
          if (typeof navigator !== "undefined") {
            facts.locale = navigator.language || null;
            facts.touch = (navigator.maxTouchPoints ?? 0) > 0 || "ontouchstart" in window;
            facts.userAgent = String(navigator.userAgent || "").slice(0, 120);
          }
          facts.platform = document?.documentElement?.dataset?.mobile === "true" ? "mobile" : "desktop";
          facts.viewport = { w: window.innerWidth, h: window.innerHeight };
          facts.theme = document?.documentElement?.dataset?.theme ?? null;
        } catch {
          /* 读不到就给最少的事实 */
        }
        return vm.newString(JSON.stringify({ value: facts }));
      }),
    );

    set(
      "provide",
      vm.newFunction("hostProvide", (nameHandle, dataHandle) => {
        const name = String(vm.dump(nameHandle));
        const raw = String(vm.dump(dataHandle));
        if (!name.startsWith("plugin.")) {
          return vm.newString('动态包提供的服务必须以 "plugin." 开头（避免盖住宿主服务）：' + name);
        }
        try {
          // 只提供**数据**：跨 realm 的函数没法当服务用（P3.3 的限制）
          this.ctx.provide(name, raw ? JSON.parse(raw) : null);
          return vm.newString("");
        } catch (e) {
          return vm.newString(String(e instanceof Error ? e.message : e));
        }
      }),
    );

    set(
      "registerTool",
      vm.newFunction("hostRegisterTool", (metaHandle, executeHandle) => {
        const meta = JSON.parse(String(vm.dump(metaHandle))) as ToolMeta;
        try {
          this.registerTool(meta, executeHandle);
          return vm.newString("");
        } catch (e) {
          return vm.newString(String(e instanceof Error ? e.message : e));
        }
      }),
    );

    set(
      "uiRegister",
      vm.newFunction("hostUiRegister", (optionsHandle, renderHandle, selectHandle) => {
        try {
          const raw = String(vm.dump(optionsHandle));
          const options = JSON.parse(raw || "{}") as UiOptions;
          this.registerUi(options, renderHandle, selectHandle);
          return vm.newString("");
        } catch (e) {
          return vm.newString(String(e instanceof Error ? e.message : e));
        }
      }),
    );

    set(
      "themeOverride",
      vm.newFunction("hostThemeOverride", (tokensHandle) => {
        try {
          const raw = String(vm.dump(tokensHandle));
          const tokens = JSON.parse(raw || "{}") as Record<string, never>;
          this.overrideTheme(tokens);
          return vm.newString("");
        } catch (e) {
          return vm.newString(String(e instanceof Error ? e.message : e));
        }
      }),
    );

    set(
      "uiRefresh",
      vm.newFunction("hostUiRefresh", (idHandle) => {
        const id = String(vm.dump(idHandle));
        if (!this.allowed("ui.slot")) return vm.newString("能力 ui.slot 已被撤销，界面不再更新");
        this.bumpUi(id || "*");
        return vm.newString("");
      }),
    );
  }

  /**
   * 覆盖主题 token：source 强制成插件 id，disposer 通过 ctx.effect 挂到插件自己的 fiber 上
   *（插件卸载 → 它的那层颜色自动消失）。
   */
  private overrideTheme(tokens: Record<string, never>): void {
    this.requireCapability("ui.theme", "覆盖主题");
    const theme = this.ctx.get<{ overrideTokens?: (source: string, tokens: Record<string, never>) => unknown }>("theme");
    if (!theme?.overrideTokens) throw new Error("宿主没有可覆盖的主题服务");
    theme.overrideTokens(this.spec.pluginId, tokens);
  }

  /** 注册一次界面：渲染函数存到 JS 侧，组件由宿主侧的桥工厂造出来 */
  private registerUi(options: UiOptions, renderHandle: QuickJSHandle, selectHandle?: QuickJSHandle): void {
    const slots = this.ctx.get<SlotsService>("slots");
    if (!slots) throw new Error("宿主没有 slots 服务，注册不了界面");
    if (!options?.slot) throw new Error("ctx.slots.register 需要 slot（槽位名）");
    this.requireCapability("ui.slot", "注册界面 " + options.slot);
    const ui = this.runtime.servicesUi();
    if (!ui) throw new Error("宿主没有接 UI 桥：动态包的 UI 半在这个构建里不可用");

    const vm = this.vm;
    const handleId = String(++this.uiSeq);
    vm.setProp(vm.global, "__aireaderUiRenderArg", renderHandle);
    const stored = vm.evalCode("__aireaderUiRender[" + JSON.stringify(handleId) + "] = __aireaderUiRenderArg");
    if (stored.error) {
      const message = this.describeError(stored.error);
      stored.error.dispose();
      throw new Error("保存 UI 渲染函数失败：" + message);
    }
    stored.value.dispose();

    // chain 槽位的自提名函数：同样存在 JS 侧全局（宿主不跨调用持有句柄）
    let hasSelect = false;
    if (selectHandle && vm.typeof(selectHandle) === "function") {
      vm.setProp(vm.global, "__aireaderSelectArg", selectHandle);
      const kept = vm.evalCode("__aireaderUiSelect[" + JSON.stringify(handleId) + "] = __aireaderSelectArg");
      if (kept.error) {
        const message = this.describeError(kept.error);
        kept.error.dispose();
        throw new Error("保存 chain 的 select 失败：" + message);
      }
      kept.value.dispose();
      hasSelect = true;
    }

    this.uiHandles.set(handleId, {
      id: handleId,
      slot: options.slot,
      label: options.label,
      version: 0,
      listeners: new Set(),
      hasSelect,
    });

    const instance = this;
    const bridge: DynamicUiBridge = {
      pluginId: this.spec.pluginId,
      render: (props) => instance.renderComponent(handleId, props),
      invoke: (token) => {
        try {
          instance.invokeHandler(handleId, token);
        } catch (e) {
          instance.runtime.reportRenderFailure(instance.spec.pluginId, options.slot, e);
        }
        // 事件处理完就重渲染一次：插件把状态存在自己的变量里，界面跟着刷新
        instance.bumpUi(handleId);
      },
      subscribe: (cb) => {
        const handle = instance.uiHandles.get(handleId);
        if (!handle) return () => {};
        handle.listeners.add(cb);
        return () => {
          handle.listeners.delete(cb);
        };
      },
      version: () => instance.uiHandles.get(handleId)?.version ?? 0,
      report: (error) => instance.runtime.reportRenderFailure(instance.spec.pluginId, options.slot, error),
    };

    // 与工具注册同一条纪律：**每个注册都是 effect**（挂到插件自己的 fiber 上，
    // 插件卸载或后续抛错时都会被撤掉）
    this.ctx.effect(
      () =>
        slots.register({
          name: options.slot,
          id: options.id,
          key: options.key,
          order: options.order,
          priority: options.priority,
          label: options.label ?? "动态包 " + this.spec.pluginId,
          component: ui.createComponent(bridge),
          // chain 槽位：select 由宿主同步回调回 VM（函数过不了 JSON，只能这样桥）
          select: hasSelect ? (props: Record<string, unknown>) => instance.callSelect(handleId, props) : undefined,
        }),
      "dynamic-ui:" + options.slot + (options.id ? "#" + options.id : options.key ? "@" + options.key : ""),
    );
  }

  /**
   * chain 槽位选举：同步回调插件里的 select(props)。
   * 与 render 同一条纪律：**必须同步**（渲染期不能等 IO）、带时间预算、出错由调用方当弃权处理。
   */
  callSelect(handleId: string, props: Record<string, unknown>): unknown {
    if (this.stopped || this.stopping) return null;
    this.requireCapability("ui.slot", "chain 选举");
    const vm = this.vm;
    const key = JSON.stringify(handleId);
    this.arm();
    const argsHandle = this.jsonHandle(props ?? {});
    vm.setProp(vm.global, "__aireaderSelectArgsArg", argsHandle);
    argsHandle.dispose();
    const result = vm.evalCode(
      "(function () { var fn = __aireaderUiSelect[" + key + "]; if (typeof fn !== 'function') return 'null';" +
        " var out = fn(__aireaderSelectArgsArg);" +
        " if (out && typeof out.then === 'function') throw new Error('chain 的 select 必须同步返回（不能是 async）');" +
        " return JSON.stringify(out === undefined ? null : out); })()",
      this.spec.pluginId + "/select:" + handleId,
    );
    if (result.error) {
      const message = this.describeError(result.error);
      result.error.dispose();
      // 抛错 = 弃权（与 DSH 的 selector 语义一致），但要留下痕迹给 diagnose
      this.runtime.reportRenderFailure(this.spec.pluginId, this.uiHandles.get(handleId)?.slot ?? "?", new Error("chain 选举的 select 抛错：" + message));
      return null;
    }
    const value = vm.dump(result.value);
    result.value.dispose();
    if (typeof value !== "string") return null;
    return JSON.parse(value);
  }

  /**
   * 后台泵（P3.8）：**渲染期发起的异步 op 没人等它**。
   *
   * 渲染必须同步返回（React 渲染期不能等 IO），所以 render 之后没有 settle 循环在跑 ——
   * 插件在 render 里调 ctx.reader.activity() 拿到的 promise，宿主 resolve 了，
   * 但 VM 的 job 队列没人推进，.then 回调永远不执行：界面就停在「正在读取…」。
   * （实测就是 AI 写的那版热力图：数据早就回来了，界面一直不更新。）
   *
   * 这里在事件循环的空隙里推进 VM 的 job 队列，直到没有宿主 deferred 在飞为止；
   * 加一条 15 秒的总时限，免得某个宿主调用永远不结算时把泵卡成死循环。
   */
  private schedulePump(): void {
    if (this.pumping || this.stopped || this.stopping) return;
    this.pumping = true;
    const until = this.runtime.nowFn() + 15000;
    const step = () => {
      if (this.stopped || this.stopping) {
        this.pumping = false;
        return;
      }
      try {
        this.vm.runtime.executePendingJobs();
      } catch (e) {
        this.runtime.log("warn", "后台泵推进 job 失败（" + this.spec.pluginId + "）", e);
        this.pumping = false;
        return;
      }
      if (this.deferreds.size > 0 && this.runtime.nowFn() < until) setTimeout(step, 0);
      else this.pumping = false;
    };
    setTimeout(step, 0);
  }

  private bumpUi(which: string): void {
    const targets = which === "*" ? [...this.uiHandles.values()] : [this.uiHandles.get(which)].filter(Boolean) as UiHandle[];
    for (const handle of targets) {
      handle.version += 1;
      for (const listener of [...handle.listeners]) {
        try {
          listener();
        } catch (e) {
          this.runtime.log("warn", "重渲染订阅者抛错（" + this.spec.pluginId + "/" + handle.slot + "）", e);
        }
      }
    }
  }

  /**
   * 同步渲染一格界面。React 渲染期调用，所以：
   *   - 必须同步（返回 promise 直接报错：界面渲染不能等 IO）；
   *   - 带时间预算（渲染函数里写死循环不会把界面卡住）；
   *   - 事件处理器表**每次渲染重建**（旧令牌作废，避免闭包积压）。
   */
  renderComponent(handleId: string, props: unknown): string {
    if (!this.uiHandles.has(handleId)) throw new Error("这块界面已经不在插件里了（可能已卸载）");
    if (this.stopping) throw new Error("插件正在停止，不再渲染界面（" + this.spec.pluginId + "）");
    if (this.stopped) throw new Error("插件已停止（" + this.spec.pluginId + "）");
    this.requireCapability("ui.slot", "渲染界面");
    const vm = this.vm;
    this.arm();
    const propsHandle = this.jsonHandle(props ?? {});
    vm.setProp(vm.global, "__aireaderUiPropsArg", propsHandle);
    propsHandle.dispose();
    const key = JSON.stringify(handleId);
    const result = vm.evalCode(
      [
        "(function () {",
        "  var h = __aireaderUiHandlers[" + key + "] = [];",
        "  var api = {",
        "    handler: function (fn) {",
        "      if (typeof fn !== 'function') throw new Error('ui.handler 需要一个函数');",
        "      h.push(fn);",
        "      return '@' + (h.length - 1);",
        "    },",
        "  };",
        "  var out = __aireaderUiRender[" + key + "](__aireaderUiPropsArg, api);",
        "  if (out && typeof out.then === 'function') throw new Error('UI 半的 render 必须同步返回界面结构（不能是 async：渲染期不能等 IO，异步数据先在 handler 里取好）');",
        "  return JSON.stringify(out === undefined ? null : out);",
        "})()",
      ].join("\n"),
      this.spec.pluginId + "/render:" + handleId,
    );
    if (result.error) {
      const message = this.describeError(result.error);
      result.error.dispose();
      throw new Error("插件 UI 渲染抛错：" + message);
    }
    const value = vm.dump(result.value);
    result.value.dispose();
    if (typeof value !== "string") throw new Error("UI 半的 render 没有返回可序列化的界面结构");
    // 这一格里可能有刚发起的异步 op：挂上后台泵，数据回来时插件的 refresh 才跑得起来
    this.schedulePump();
    return value;
  }

  /** 调一次界面事件处理器（令牌形如 @0，指向本次渲染建立的处理器表） */
  invokeHandler(handleId: string, token: string): void {
    if (this.stopped || this.stopping) return;
    this.requireCapability("ui.slot", "调用界面动作");
    const index = Number(String(token).replace(/^@/, ""));
    if (!Number.isInteger(index) || index < 0) throw new Error("不是合法的事件令牌：" + token);
    const vm = this.vm;
    this.arm();
    const key = JSON.stringify(handleId);
    const result = vm.evalCode(
      "(function () { var h = __aireaderUiHandlers[" + key + "]; var fn = h && h[" + index + "]; if (typeof fn !== 'function') throw new Error('这个界面动作已经失效（界面在它之后重渲染过）'); return fn(); })()",
      this.spec.pluginId + "/ui-action:" + handleId,
    );
    if (result.error) {
      const message = this.describeError(result.error);
      result.error.dispose();
      this.runtime.reportRenderFailure(this.spec.pluginId, this.uiHandles.get(handleId)?.slot ?? "?", new Error("界面动作抛错：" + message));
      return;
    }
    result.value.dispose();
    // 动作里发起的异步 op 同理（点一下 → 取数据 → refresh）
    this.schedulePump();
  }

  private registerTool(meta: ToolMeta, executeHandle: QuickJSHandle): void {
    const tools = this.ctx.get<ToolRegistry>("tools");
    if (!tools) throw new Error("宿主没有 tools 服务，注册不了工具");
    if (!meta.name || !/^[a-z0-9_]+$/.test(meta.name)) throw new Error("工具名只能是 a-z0-9_：" + meta.name);
    if (!Array.isArray(meta.capabilities) || !meta.capabilities.length) {
      throw new Error("动态包注册工具必须声明 capabilities（宿主用它做执行前校验）：" + meta.name);
    }
    const undeclared = meta.capabilities.filter((c) => !this.spec.capabilities.includes(c));
    if (undeclared.length) {
      throw new Error("工具 " + meta.name + " 声明了 manifest 里没有的能力：" + undeclared.join(" / "));
    }
    for (const capability of meta.capabilities) this.requireCapability(capability, "注册工具 " + meta.name);

    // 工具函数存到 JS 侧全局（宿主不持有句柄）
    const vm = this.vm;
    vm.setProp(vm.global, "__aireaderToolArg", executeHandle);
    const stored = vm.evalCode("__aireaderTools[" + JSON.stringify(meta.name) + "] = __aireaderToolArg");
    if (stored.error) {
      const message = this.describeError(stored.error);
      stored.error.dispose();
      throw new Error("保存工具函数失败：" + message);
    }
    stored.value.dispose();
    this.toolMeta.set(meta.name, meta);

    const instance = this;
    // 与内置工具走**同一条**流水线：同一个 registry、同一个守卫数组
    this.ctx.effect(() => {
      const offTool = tools.register({
        name: meta.name,
        description: meta.description,
        parameters: meta.parameters,
        executionMode: "parallel-safe",
        timeoutMs: 15000,
        execute: async (args: unknown): Promise<ToolOutcome> => instance.callTool(meta.name, args),
      } as ToolDefinition);
      const offGuard = tools.registerGuard(({ name }) => {
        if (name !== meta.name) return null;
        for (const capability of meta.capabilities) {
          if (!instance.allowed(capability)) {
            return "工具 " + meta.name + " 所属插件的能力 " + capability + " 已被撤销，调用被拒绝";
          }
        }
        return null;
      });
      return [offTool, offGuard];
    }, "dynamic-tool:" + meta.name);
  }

  /** 工具执行：进 QuickJS 调插件的 execute，把返回值当 JSON 结果 */
  async callTool(name: string, args: unknown): Promise<ToolOutcome> {
    if (this.stopping || this.stopped) {
      return { ok: false, error: { code: "NOT_AVAILABLE", message: "插件正在停止或已停止，工具 " + name + " 不再可用" } };
    }
    const meta = this.toolMeta.get(name);
    if (!meta) {
      return { ok: false, error: { code: "UNKNOWN_TOOL", message: "动态工具 " + name + " 已经不在了（插件可能已卸载）" } };
    }
    for (const capability of meta.capabilities) {
      if (!this.allowed(capability)) {
        return { ok: false, error: { code: "NOT_AVAILABLE", message: "能力 " + capability + " 已被撤销，工具 " + name + " 不再可用" } };
      }
    }
    const vm = this.vm;
    try {
      const argsHandle = this.jsonHandle(args ?? {});
      vm.setProp(vm.global, "__aireaderToolArgsArg", argsHandle);
      argsHandle.dispose();
      this.arm();
      const result = vm.evalCode(
        "(function () { var fn = __aireaderTools[" + JSON.stringify(name) + "]; if (typeof fn !== 'function') throw new Error('工具函数不见了'); return fn(__aireaderToolArgsArg); })()",
        this.spec.pluginId + "/tool:" + name,
      );
      if (result.error) {
        const message = this.describeError(result.error);
        result.error.dispose();
        return { ok: false, error: { code: "INTERNAL", message: "插件工具抛错：" + message } };
      }
      const settled = await this.settle(result.value, "tool:" + name);
      result.value.dispose();
      if (!settled.ok) {
        return { ok: false, error: { code: "INTERNAL", message: settled.error, hint: "这是插件自己的错误" } };
      }
      const value = settled.value;
      if (value && typeof value === "object" && "error" in (value as Record<string, unknown>)) {
        return { ok: false, error: { code: "NOT_FOUND", message: String((value as { error: unknown }).error) } };
      }
      return { ok: true, value: value === undefined ? null : value };
    } catch (e) {
      return { ok: false, error: { code: "INTERNAL", message: String(e instanceof Error ? e.message : e) } };
    }
  }

  private jsonHandle(value: unknown): QuickJSHandle {
    const json = JSON.stringify(value ?? null) ?? "null";
    const parsed = this.vm.evalCode("(" + json + ")");
    if (parsed.error) {
      parsed.error.dispose();
      return this.vm.newObject();
    }
    return parsed.value;
  }

  /** 同步 op 的分发 */
  private dispatchSync(op: string, args: Record<string, unknown> | undefined): unknown {
    const capability = OP_CAPABILITY[op];
    if (!capability) throw new Error("未知的宿主操作：" + op);
    this.requireCapability(capability, "调用 " + op);
    const reader = this.runtime.servicesReader();
    switch (op) {
      case "reader.progress":
        return reader?.progress() ?? null;
      case "reader.chapters":
        return reader?.chapters() ?? [];
      case "reader.chapter": {
        const entry = reader?.chapter(Number(args?.n), Number(args?.offset ?? 0), Number(args?.maxChars ?? 4000));
        return entry
          ? { n: entry.entry.n, title: entry.entry.title, text: entry.text, truncated: entry.truncated, nextOffset: entry.nextOffset }
          : null;
      }
      case "reader.selection":
        return reader?.selection() ?? null;
      default:
        throw new Error("这个 op 不是同步的：" + op);
    }
  }

  /** 异步 op 的分发 */
  private async dispatch(op: string, args: Record<string, unknown> | undefined): Promise<unknown> {
    const capability = OP_CAPABILITY[op];
    if (!capability) throw new Error("未知的宿主操作：" + op);
    this.requireCapability(capability, "调用 " + op);
    const reader = this.runtime.servicesReader();
    switch (op) {
      case "reader.search":
        return (await reader?.search(String(args?.query ?? ""), Number(args?.limit ?? 10))) ?? [];
      case "reader.annotations":
        return (await reader?.annotations()) ?? [];
      case "reader.activity":
        // 宿主采集的阅读活动（P3.7）：插件拿事实，自己决定怎么画
        return (await this.runtime.servicesActivity()?.()?.snapshot()) ?? null;
      case "net.fetch": {
        // P3.10：宿主代发。顺序是**先判域名、再发请求**，而且范围是从授权记录里来的
        const url = String(args?.url ?? "");
        const origin = originOf(url);
        if (!origin) throw new Error("net.fetch 只接受 http / https 的绝对 URL，收到：" + url.slice(0, 120));
        this.requireCapability("net.fetch", "访问 " + origin, { origins: [origin] });
        const net = this.runtime.servicesNet();
        if (!net) throw new Error("宿主没有接网络门面");
        const init = { ...((args?.init ?? {}) as { method?: string; headers?: Record<string, string>; body?: string }) };
        init.headers = this.withHostAiKey(origin, init);
        return await net.fetch(url, init, this.grantedOrigins());
      }
      case "reader.addAnnotation": {
        const input = (args ?? {}) as { kind?: string; cfi?: string; text?: string; note?: string; color?: string };
        return (
          (await reader?.addAnnotation({
            kind: (input.kind ?? "note") as "highlight" | "note" | "bookmark",
            cfi: String(input.cfi ?? ""),
            text: input.text,
            note: input.note,
            color: input.color,
          })) ?? null
        );
      }
      case "reader.gotoChapter":
        await reader?.goToChapter(Number(args?.n));
        return null;
      case "reader.gotoCfi":
        await reader?.goToCfi(String(args?.cfi ?? ""));
        return null;
      case "reader.gotoFraction":
        await reader?.goToFraction(Number(args?.fraction ?? 0));
        return null;
      case "storage.get":
        return this.runtime.servicesStorage().get(this.spec.pluginId, String(args?.key ?? ""));
      case "storage.set":
        await this.runtime.servicesStorage().set(this.spec.pluginId, String(args?.key ?? ""), args?.value);
        return null;
      case "storage.delete":
        await this.runtime.servicesStorage().remove(this.spec.pluginId, String(args?.key ?? ""));
        return null;
      case "storage.list":
        return this.runtime.servicesStorage().keys(this.spec.pluginId);
      default:
        throw new Error("未实现的宿主操作：" + op);
    }
  }

  /** 停止：先跑插件侧的 disposer（还活着的时候），再释放上下文 */
  async stop(): Promise<void> {
    if (this.stopped || this.stopping) return;
    // 先标"正在停止"：新的外部调用被挡住，但插件自己的 disposer 还能用宿主 API
    //（否则 disposer 里的一句 ctx.log 会因为"插件已停止"被静默丢掉 —— 实测踩到）
    this.stopping = true;
    // P5：先停计时器（回调可能在 VM 释放后才触发）。插件自己 clear 过的不受影响，没 clear 的宿主兜底。
    for (const cancel of this.timers.values()) {
      try {
        cancel();
      } catch {
        /* 清理失败不该影响卸载 */
      }
    }
    this.timers.clear();
    try {
      const result = this.vm.evalCode("(async () => await __aireaderRunDisposers())()", this.spec.pluginId + "/dispose");
      if (result.error) {
        this.runtime.log("warn", "插件 " + this.spec.pluginId + " 的 disposer 调用失败：" + this.describeError(result.error));
        result.error.dispose();
      } else {
        const settled = await this.settle(result.value, "dispose");
        result.value.dispose();
        if (!settled.ok) this.runtime.log("warn", "插件 " + this.spec.pluginId + " 的 disposer 抛错：" + settled.error);
        const disposerError = this.vm.evalCode("globalThis.__aireaderDisposerError || ''");
        if (!disposerError.error) {
          const text = String(this.vm.dump(disposerError.value));
          if (text) this.runtime.log("warn", "插件 " + this.spec.pluginId + " 的 disposer 抛错：" + text);
          disposerError.value.dispose();
        } else disposerError.error.dispose();
      }
    } catch (e) {
      this.runtime.log("warn", "插件 " + this.spec.pluginId + " 停止时出错", e);
    }
    for (const deferred of [...this.deferreds]) {
      try {
        deferred.dispose();
      } catch {
        /* 可能已经被回收 */
      }
    }
    this.deferreds.clear();
    this.toolMeta.clear();
    this.uiHandles.clear();
    try {
      this.vm.dispose();
    } catch (e) {
      this.runtime.log("warn", "释放 QuickJS 上下文失败（" + this.spec.pluginId + "）", e);
    }
    this.stopping = false;
    this.stopped = true;
  }
}

export class QuickJsRuntime {
  private module: QuickJSWASMModule;
  private permissions: PermissionBroker;
  private services: DynamicHostServices;
  private budgetMs: number;
  private memoryBytesLimit: number;
  private nowValue: () => number;
  private logOutput: (level: "info" | "warn" | "error", message: string, error?: unknown) => void;
  private instances = new Set<DynamicPluginInstance>();
  /** 渲染期失败：插件 → 最近几条（append-only，诊断用） */
  private renderFailures = new Map<string, { slot: string; message: string; at: number; count?: number }[]>();

  private constructor(module: QuickJSWASMModule, opts: QuickJsRuntimeOptions) {
    this.module = module;
    this.permissions = opts.permissions;
    this.services = opts.services;
    this.budgetMs = opts.budgetMs ?? 5000;
    this.memoryBytesLimit = opts.memoryLimitBytes ?? 16 * 1024 * 1024;
    this.nowValue = opts.now ?? (() => Date.now());
    this.logOutput = opts.log ?? (() => {});
  }

  /** 载入 WASM 模块（进程内只载一次） */
  static async create(opts: QuickJsRuntimeOptions): Promise<QuickJsRuntime> {
    const module = await newQuickJSWASMModuleFromVariant(variant);
    return new QuickJsRuntime(module, opts);
  }

  /** 造一个插件实例（= 一个 QuickJSContext） */
  createInstance(spec: DynamicPluginSpec, ctx: Context): DynamicPluginInstance {
    const vm = this.module.newContext();
    vm.runtime.setMemoryLimit(this.memoryBytesLimit);
    const instance = new DynamicPluginInstance({
      runtime: this,
      vm,
      spec,
      ctx,
      permissions: this.permissions,
      budgetMs: this.budgetMs,
    });
    this.instances.add(instance);
    return instance;
  }

  nowFn(): number {
    return this.nowValue();
  }

  logFn(pluginId: string, level: string, message: string): void {
    this.services.log?.(pluginId, level, message);
    this.logOutput(level === "error" ? "error" : "info", "[" + pluginId + "] " + message);
  }

  log(level: "info" | "warn" | "error", message: string, error?: unknown): void {
    this.logOutput(level, message, error);
  }

  servicesReader(): ToolHost | null {
    return this.services.reader();
  }

  servicesStorage(): DynamicHostServices["storage"] {
    return this.services.storage;
  }

  /** 阅读活动（P3.7）：宿主采集的事实，动态包只读 */
  servicesActivity(): DynamicHostServices["activity"] {
    return this.services.activity;
  }

  /** 网络门面（P3.10）：真的发请求那件事在宿主侧，这里只取实现 */
  servicesNet(): DynamicHostServices["net"] {
    return this.services.net;
  }

  /** 宿主自己的 AI 凭据（P3.11）：只用来在宿主侧拼一个 Authorization 头 */
  servicesAiCredentials(): AiCredentials | null {
    return this.services.aiCredentials?.() ?? null;
  }

  servicesUi(): DynamicHostServices["ui"] {
    return this.services.ui;
  }

  /**
   * 渲染期失败上报（DSH 的 reportRenderFailure，client-runner/lib/client.js:412-426）。
   * 每个插件只留**最新几条**：diagnose 要看的是"刚才为什么炸"，不是全部历史。
   */
  reportRenderFailure(pluginId: string, slot: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const list = this.renderFailures.get(pluginId) ?? [];
    const prev = list[0];
    // **同一个失败只记一次**：React 会在摘掉这一格之前重试好几轮，
    // 不去重的话一次错误会刷 8 行一模一样的日志（实测踩到），把真实信息淹掉。
    if (prev && prev.slot === slot && prev.message === message && this.nowValue() - prev.at < 5000) {
      prev.count = (prev.count ?? 1) + 1;
      return;
    }
    list.unshift({ slot, message, at: this.nowValue(), count: 1 });
    this.renderFailures.set(pluginId, list.slice(0, 5));
    // 同时进插件日志（P3.5）：用户与模型在"日志"里能看到它，不用去翻控制台
    this.services.log?.(pluginId, "warn", "界面渲染失败（" + slot + "）：" + message);
    this.logOutput("warn", "[aireader/plugin:" + pluginId + "] 界面渲染失败（" + slot + "）：" + message);
  }

  renderFailuresOf(pluginId: string): { slot: string; message: string; at: number; count?: number }[] {
    return (this.renderFailures.get(pluginId) ?? []).map((e) => ({ ...e }));
  }

  async dispose(): Promise<void> {
    for (const instance of [...this.instances]) await instance.stop();
    this.instances.clear();
  }
}

/** 造一个"动态插件"（交给加载器的 resolveImplementation 用） */
export function createDynamicPlugin(opts: {
  /** 运行时（给个 getter：WASM 只在真有动态包要挂时才载入，不拖慢启动） */
  runtime: () => Promise<QuickJsRuntime>;
  spec: Omit<DynamicPluginSpec, "code" | "uiCode">;
  /** 读 main 文件内容（挂载时才读，所以这边是懒的）；只有 UI 半的包给空串 */
  readCode: () => Promise<string>;
  /** 读 ui.entry 文件内容（可选：纯宿主半的包没有这一半） */
  readUiCode?: () => Promise<string>;
  log?: (level: "info" | "warn" | "error", message: string, error?: unknown) => void;
}): { apply: (ctx: Context, config: unknown) => Promise<Disposer> } {
  return {
    async apply(ctx: Context, config: unknown): Promise<Disposer> {
      const runtime = await opts.runtime();
      const code = await opts.readCode();
      const uiCode = opts.readUiCode ? await opts.readUiCode() : undefined;
      const instance = runtime.createInstance({ ...opts.spec, code, uiCode }, ctx);
      try {
        await instance.load();
        await instance.apply(config);
      } catch (e) {
        await instance.stop();
        throw e;
      }
      return () => instance.stop();
    },
  };
}
