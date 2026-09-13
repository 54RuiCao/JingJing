/**
 * P3.3 动态包运行时契约测试：**真的在 quickjs-ng 里执行插件代码**（node 里跑，不需要浏览器）。
 *
 * 覆盖（对应 内部设计笔记 §5.1 的验收"动态包只能碰它声明的能力；撤销授权后立刻停"）：
 *   1. 沙箱事实：插件里没有 fetch/require/document/setTimeout/process
 *   2. 能力门禁：没授予的能力调用必失败（且错误信息说清是哪个能力）
 *   3. 撤销立刻生效：granted → 调用成功 → revoke → 同一个调用立刻失败
 *   4. 工具桥：插件注册的工具进同一个 ToolRegistry、执行时进 QuickJS、撤销后 guard 拦下
 *   5. 卸载：插件侧的 disposer 被调用（还活着的时候），随后释放整个上下文
 *   6. 时间/内存上限：同步死循环被中断；内存超限被杀
 *   7. apply 抛错 → 加载失败（不留半挂实例）
 *
 * 跑法：npm test（5 套里的第 6 套会加进来）或
 *   cd app && npx esbuild ../tools/dynamic-runtime-test.ts --bundle --platform=node --format=esm \
 *     --external:@jitl/* --external:quickjs-emscripten-core --outfile=node_modules/.cache/aireader-tests/dynamic-runtime-test.mjs
 *   node node_modules/.cache/aireader-tests/dynamic-runtime-test.mjs
 */

import { createContainer } from "../app/src/core/service/index";
import { setLangPref } from "../app/src/i18n";

// 断言写的是中文默认文案：把界面语言钉死，别受开发机系统语言影响
setLangPref("zh");
import { PermissionBroker, createMemoryPermissionStore } from "../app/src/core/plugin/permissions";
import { QuickJsRuntime, createDynamicPlugin, QUICKJS_PRELUDE, OP_CAPABILITY, OP_DECLARATION_ONLY } from "../app/src/core/plugin/runtime-quickjs";
import { ToolRegistry } from "../app/src/ai/tools/registry";
import { SlotCore, createSlotsService } from "../app/src/ui/slots/index";
import { contextBoundService } from "../app/src/core/service/index";
import type { SlotsService } from "../app/src/ui/slots/index";
import type { ToolHost } from "../app/src/ai/tools/host";
import type { CapabilityId } from "../app/src/core/plugin/manifest";
import { createStyleCore, MAX_SHEETS_PER_PLUGIN, type StylesService } from "../app/src/ui/theme/styles";
import { createThemeOverrideCore } from "../app/src/ui/theme/overrides";
import { buildBookCSS, defaultTypography } from "../app/src/reader/bookStyles";
import { THEMES } from "../app/src/reader/themes";

// ToolRegistry.execute 的超时用了 window.setTimeout；node 下补一个最小 Window 形状
(globalThis as any).window = globalThis;

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) pass++;
  else failures.push(name + (detail ? " —— " + detail : ""));
}

const PLUGIN_ID = "test.dynamic";
const VERSION = "1.0.0";

function fakeReader(): ToolHost {
  return {
    bookId: () => "book-1",
    title: () => "测试书",
    author: () => "作者",
    progress: () => ({ fraction: 0.42, chapter: "第三章", location: "位置 120" }),
    context: () => ({ mode: "full", chapters: 10, loadedChapters: 10, tokens: 1234 }),
    chapters: () => [
      { n: 1, title: "一", cfi: "cfi1", chars: 10, inContext: true },
      { n: 2, title: "二", cfi: "cfi2", chars: 20, inContext: true },
    ],
    chapter: (n, offset, maxChars) => ({
      entry: { n, title: "第" + n + "章", cfi: "cfi", chars: 100, start: 0, end: 100 },
      text: "正文片段".repeat(Math.min(10, maxChars)),
      from: offset,
      nextOffset: offset + 40,
      truncated: false,
    }),
    search: async (q, limit) => [{ n: 1, title: "一", snippet: "…" + q + "…" }].slice(0, limit),
    selection: () => null,
    addAnnotation: async (input) => ({
      id: "a1",
      kind: input.kind,
      cfi: input.cfi,
      text: input.text ?? "",
      note: input.note ?? "",
      color: input.color ?? "yellow",
    }),
    annotations: async () => [],
    goToChapter: async () => {},
    goToHref: async () => {},
    goToCfi: async () => {},
    goToFraction: async () => {},
  };
}

type Harness = {
  runtime: QuickJsRuntime;
  broker: PermissionBroker;
  container: ReturnType<typeof createContainer>;
  tools: ToolRegistry;
  logs: string[];
  storage: Map<string, unknown>;
  grants: { pluginId: string; version: string; capability: CapabilityId; mode: "once" | "always" }[];
  /** P5 外观权限：样式表账本 */
  styleCore: ReturnType<typeof createStyleCore>;
  /** P5 外观权限：主题 token 覆盖层 */
  themeOverrides: ReturnType<typeof createThemeOverrideCore>;
};

async function makeHarness(
  opts: {
    capabilities?: CapabilityId[];
    /** net.fetch 的授权域名（P3.10）：范围跟着授权一起落库 */
    origins?: string[];
    budgetMs?: number;
    memoryLimitBytes?: number;
    pluginId?: string;
  } = {},
): Promise<Harness> {
  const pluginId = opts.pluginId ?? PLUGIN_ID;
  const logs: string[] = [];
  const storage = new Map<string, unknown>();
  // 用 always：这些测试里插件会换版本（工厂那个用 2.0.0），once 只覆盖声明时那个版本
  const grants = (opts.capabilities ?? []).map((capability) => ({
    pluginId,
    version: VERSION,
    capability,
    mode: "always" as const,
    // P3.11：ai.credentials 的授权范围同样是域名（宿主在真实流程里写的是当时 provider 的 origin）
    ...((capability === "net.fetch" || capability === "ai.credentials") && opts.origins
      ? { scope: { origins: opts.origins } }
      : {}),
  }));
  const store = createMemoryPermissionStore(
    grants.map((g) => ({ ...g, state: "granted" as const, at: Date.now() })),
  );
  const broker = new PermissionBroker({ store, log: () => {} });
  await broker.ready();
  const container = createContainer({ log: () => {} });
  const tools = new ToolRegistry();
  container.ctx.provide("tools", tools);
  // UI 半要往插槽里挂：给一个真的插槽内核（P3.8 的"渲染期异步"用例需要它）
  const slotCore = new SlotCore();
  slotCore.declare("reader.view.tail", {
    kind: "list",
    scope: "app",
    replaceRisk: "none",
    wired: true,
    description: "测试用席位（与宿主 ui-layout 声明的一致）",
  });
  container.ctx.provide("slots", contextBoundService<SlotsService>((c) => createSlotsService(slotCore, c)));
  /**
   * P5 外观权限：真的接上 theme 覆盖层与样式表账本（不是桩）——
   * 校验规则、token 形状限制、卸载撤销都因此被这一套测到。
   * 两份都按上下文绑定，与 runtime.ts 里给插件的门面同一个形状。
   */
  const themeOverrides = createThemeOverrideCore();
  container.ctx.provide(
    "theme",
    contextBoundService<{ overrideTokens(source: string, tokens: Record<string, never>): unknown }>((c) => ({
      overrideTokens: (source, tokens) => c.effect(() => themeOverrides.override(source, tokens), "theme-override:" + source),
    })),
  );
  const styleCore = createStyleCore();
  container.ctx.provide(
    "styles",
    contextBoundService<StylesService>((c) => ({
      insert: (source, css, scope) => c.effect(() => styleCore.insert(source, css, scope), "plugin-styles:" + source),
      clear: (source) => styleCore.clear(source),
    })),
  );
  const runtime = await QuickJsRuntime.create({
    permissions: broker,
    services: {
      reader: () => fakeReader(),
      // P3.7：阅读活动（宿主采集的事实；插件只读）
      activity: () => ({
        snapshot: async () => ({
          today: "2026-09-12",
          todaySeconds: 1800,
          todayTurns: 42,
          days: [{ day: "2026-09-12", seconds: 1800, turns: 42 }],
          totalSeconds: 1800,
          activeDays: 1,
          streak: 3,
          longestStreak: 9,
          bestDay: { day: "2026-09-12", seconds: 1800, turns: 42 },
        }),
      }),
      storage: {
        get: async (_id, key) => storage.get(key),
        set: async (_id, key, value) => {
          storage.set(key, value);
        },
        remove: async (_id, key) => {
          storage.delete(key);
        },
        keys: async () => [...storage.keys()],
      },
      log: (id, level, message) => logs.push(id + ":" + level + ":" + message),
      // UI 桥的宿主工厂：这一套不渲染 React，只直接调 renderComponent（桥本身在 plugin-ai-test 里测）
      ui: { createComponent: () => ({}) as never },
      // 网络门面（P3.10）：真的 pluginFetch 由 net-test 那一套测；这里只验证
      // "能力 + 域名范围"这两道闸门，以及宿主把授权域名交给了 fetch 实现。
      net: {
        fetch: async (url: string, init: unknown, origins: string[]) => {
          const h = ((init ?? {}) as { headers?: Record<string, string> }).headers ?? {};
          const auth = Object.entries(h).find(([k]) => k.toLowerCase() === "authorization");
          return {
            ok: true,
            status: 200,
            url,
            contentType: "text/plain",
            // 把"宿主有没有代填 Authorization"如实回给插件，测试才能断言（值本身不敏感）
            text: "NET:" + url + "|" + origins.join(",") + "|auth=" + (auth ? auth[1] : "none"),
            truncated: false,
            redirects: 0,
          };
        },
      },
      // 宿主自己配的 AI 凭据（P3.11）：Key **只在这一层**，不经过 VM
      aiCredentials: () => ({ origin: "https://api.deepseek.com", hasKey: true, authorization: "Bearer sk-host-side-key" }),
      // P5 前置服务：可依赖的插件服务清单（与 runtime.ts 同一个取法：容器账本里 plugin.* 那些）
      serviceNames: () => container.diagnostics().services.filter((n) => n.startsWith("plugin.")).sort(),
    },
    log: (level, message) => logs.push("runtime:" + level + ":" + message),
    budgetMs: opts.budgetMs ?? 3000,
    memoryLimitBytes: opts.memoryLimitBytes ?? 16 * 1024 * 1024,
  });
  return { runtime, broker, container, tools, logs, storage, grants, styleCore, themeOverrides };
}

/** 一段最典型的插件代码：读进度、写存储、注册工具、注册带 disposer 的 effect */
const GOOD_CODE = [
  "function apply(ctx, config) {",
  "  ctx.log('apply 收到配置', config);",
  "  ctx.effect(function () {",
  "    ctx.log('effect 跑了一次');",
  "    return function () { ctx.log('effect disposer 跑了'); };",
  "  });",
  "  ctx.tools.register({",
  "    name: 'dyn_progress',",
  "    description: '插件提供的：读当前进度',",
  "    parameters: { type: 'object', properties: {} },",
  "    capabilities: ['reader.read'],",
  "  }, async function (args) {",
  "    const p = ctx.reader.progress();",
  "    return { fraction: p.fraction, chapter: p.chapter, from: 'plugin' };",
  "  });",
  "  ctx.tools.register({",
  "    name: 'dyn_search',",
  "    description: '插件提供的：检索（走异步 reader op）',",
  "    parameters: { type: 'object', properties: {} },",
  "    capabilities: ['reader.read'],",
  "  }, async function () {",
  "    const hits = await ctx.reader.search('记忆', 3);",
  "    return { hits: hits.length, first: hits[0] && hits[0].snippet };",
  "  });",
  "  ctx.tools.register({",
  "    name: 'dyn_remember',",
  "    description: '插件提供的：记一笔',",
  "    parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },",
  "    capabilities: ['storage.plugin'],",
  "  }, async function (args) {",
  "    await ctx.storage.set('last-note', args.note);",
  "    return { saved: args.note };",
  "  });",
  "  return function () { ctx.log('apply 返回的 disposer 跑了'); };",
  "}",
].join("\n");

/** P5 外观权限：跑一段插件代码，返回 { err, ok } */
async function runPluginCode(
  h: Harness,
  code: string,
  capabilities: CapabilityId[] = [],
): Promise<{ err: string; ok: boolean }> {
  const instance = h.runtime.createInstance({ pluginId: PLUGIN_ID, version: VERSION, code, capabilities }, h.container.ctx);
  try {
    await instance.load();
    await instance.apply({});
    return { err: "", ok: true };
  } catch (e) {
    return { err: String(e instanceof Error ? e.message : e), ok: false };
  } finally {
    await instance.stop();
  }
}

/** 把插件代码包进 apply */
function wrap(body: string): string {
  return ["function apply(ctx) {", body, "}"].join("\n");
}

// ---------- 1) 沙箱事实 + 正常加载 ----------

{
  const h = await makeHarness({ capabilities: ["reader.read", "storage.plugin", "log.write"] });
  const sandboxCode = [
    "function apply(ctx) {",
    "  ctx.log(JSON.stringify({",
    "    fetch: typeof fetch, require: typeof require, document: typeof document,",
    "    setTimeout: typeof setTimeout, process: typeof process, window: typeof window,",
    "    innerKeys: Object.getOwnPropertyNames(globalThis).filter(function (k) { return k.indexOf('__aireader') === 0; }).sort(),",
    "  }));",
    "}",
  ].join("\n");
  const instance = h.runtime.createInstance({ pluginId: PLUGIN_ID, version: VERSION, code: sandboxCode, capabilities: ["log.write"] }, h.container.ctx);
  await instance.load();
  await instance.apply({});
  const report = JSON.parse(h.logs.find((l) => l.includes("fetch"))?.split(":info:")[1] ?? "{}");

  check("沙箱里没有 document/window（没有 DOM）", report.document === "undefined" && report.window === "undefined");
  // P5：setTimeout/setInterval 现在是**同名陷阱**（存在但一调用就抛教学错误），
  // 比"静默 undefined"对模型友好得多 —— 它至少知道该换成什么。
  check("沙箱里没有真的 setTimeout（是教学陷阱）", report.setTimeout === "function");
  check("沙箱里没有真的 require（是教学陷阱）", report.require === "function");
  check("沙箱里没有 fetch 真身（是教学陷阱）", report.fetch === "function");
  check("沙箱里没有 process", report.process === "undefined");
  await instance.stop();
  await h.runtime.dispose();
  await h.container.dispose();
}


// ---------- 1c) P5：宿主计时器 ----------
//
// 为什么要有：插件沙箱里没有 setTimeout，"AI 想定时"是最高频的需求之一。
// 宿主提供 ctx.timeout / ctx.interval，handle 用 ctx.clear 取消，**卸载时宿主兜底清理**
// （interval 是插件最典型的泄漏源）。这条测试钉住"真的跑"和"卸载后不再跑"。
{
  const h = await makeHarness({ capabilities: ["log.write"] });
  const code = [
    "function apply(ctx) {",
    "  ctx.timeout(function () { ctx.log('一次性跑了'); }, 20);",
    "  ctx.interval(function () { ctx.log('心跳'); }, 110);",
    "  try { ctx.timeout('不是函数', 10); } catch (e) { ctx.log('参数校验:' + e.message); }",
    "  try { setTimeout(function () {}, 10); } catch (e) { ctx.log('陷阱:' + e.message); }",
    "}",
  ].join("\n");
  const inst = h.runtime.createInstance({ pluginId: PLUGIN_ID, version: VERSION, code, capabilities: ["log.write"] });
  await inst.load();
  await inst.apply({});
  check("ctx.timeout 校验第一个参数", h.logs.some((l) => l.includes("参数校验:") && l.includes("必须是函数")));
  check(
    "写 setTimeout 时教它用 ctx.timeout",
    h.logs.some((l) => l.includes("陷阱:") && l.includes("ctx.timeout")),
    JSON.stringify(h.logs.filter((l) => l.includes("陷阱")).slice(0, 2)),
  );
  await new Promise((r) => setTimeout(r, 260));
  check("ctx.timeout 的回调真的跑了", h.logs.some((l) => l.includes("一次性跑了")), JSON.stringify(h.logs.slice(-4)));
  check("ctx.interval 真的在跑", h.logs.some((l) => l.includes("心跳")));
  await inst.stop();
  const beats = h.logs.filter((l) => l.includes("心跳")).length;
  await new Promise((r) => setTimeout(r, 300));
  check(
    "卸载后 interval 不再触发（宿主兜底清理）",
    h.logs.filter((l) => l.includes("心跳")).length === beats,
    "停止后又多跑了 " + (h.logs.filter((l) => l.includes("心跳")).length - beats) + " 次",
  );
  await h.runtime.dispose();
  await h.container.dispose();
}

// ---------- 1b) 阅读活动（P3.7）：能力门禁 + 值透传 ----------
//
// 为什么要有这个 op：插件沙箱里连 setTimeout 都没有，插件自己没法"记阅读时长"；
// 宿主知道路由/焦点/翻页，所以由宿主采集、插件读。这里钉住"它同样受能力门禁管"。
{
  const h = await makeHarness({ capabilities: ["log.write"] });
  const denied = [
    "function apply(ctx) {",
    "  try { ctx.reader.activity(); ctx.log('不该走到这里：没授权也读到了活动'); }",
    "  catch (e) { ctx.log('被拦住:' + e.message); }",
    "}",
  ].join("\n");
  const inst = h.runtime.createInstance({ pluginId: PLUGIN_ID, version: VERSION, code: denied, capabilities: ["log.write"] }, h.container.ctx);
  await inst.load();
  await inst.apply({});
  await new Promise((r) => setTimeout(r, 30));
  check(
    "没授予 reader.read 时 ctx.reader.activity() 被拦下",
    h.logs.some((l) => l.includes("被拦住") && l.includes("reader.read")),
    JSON.stringify(h.logs.filter((l) => l.includes("reader"))),
  );
  await inst.stop();
  await h.runtime.dispose();
  await h.container.dispose();
}

{
  const h = await makeHarness({ capabilities: ["reader.read", "log.write"] });
  // apply 里 await 它：宿主泵循环会在 apply 期间驱动 pending jobs
  //（不 await 的话 promise 的回调要等下一次进 VM 才跑，这是执行模型不是 bug）
  const allowed = [
    "async function apply(ctx) {",
    "  try {",
    "    ctx.log('typeof activity=' + typeof ctx.reader.activity);",
    "    var a = await ctx.reader.activity();",
    "    ctx.log('活动:' + JSON.stringify({ today: a.today, seconds: a.todaySeconds, streak: a.streak, days: a.days.length }));",
    "  } catch (e) { ctx.log('活动失败:' + e.message); }",
    "}",
  ].join("\n");
  const inst = h.runtime.createInstance({ pluginId: PLUGIN_ID, version: VERSION, code: allowed, capabilities: ["reader.read", "log.write"] }, h.container.ctx);
  await inst.load();
  await inst.apply({});
  await new Promise((r) => setTimeout(r, 50));
  const line = h.logs.find((l) => l.includes("活动:"));
  check(
    "授权后拿到宿主采集的阅读活动快照",
    !!line && line.includes('"today":"2026-09-12"') && line.includes('"seconds":1800') && line.includes('"streak":3'),
    String(line),
  );
  await inst.stop();
  await h.runtime.dispose();
  await h.container.dispose();
}

// ---------- 1c) 渲染期发起的异步 op 必须能自己走完（P3.8 修的坑） ----------
//
// 实况：AI 写的热力图在 render 里调 ctx.reader.activity()，数据回来了、界面却一直停在
// 「正在读取…」—— 因为渲染必须同步返回，那之后没有人推进 VM 的 job 队列。
// 这里钉住：render 里发起的异步 op 拿到数据后，插件的 ctx.slots.refresh() 真的会跑到。
{
  const h = await makeHarness({ capabilities: ["reader.read", "ui.slot", "log.write"] });
  const code = [
    "function apply(ctx) {",
    "  var data = null;",
    "  ctx.slots.register({ slot: 'reader.view.tail', id: 'async-heatmap', label: 'x' }, function () {",
    "    if (!data) {",
    "      ctx.reader.activity().then(function (a) { data = a; ctx.log('拿到数据:' + a.todaySeconds); ctx.slots.refresh(); });",
    "      return { type: 'div', props: {}, children: ['正在读取…'] };",
    "    }",
    "    return { type: 'div', props: {}, children: ['已读完 ' + data.todaySeconds + ' 秒'] };",
    "  });",
    "}",
  ].join("\n");
  const inst = h.runtime.createInstance({ pluginId: PLUGIN_ID, version: VERSION, code, capabilities: ["reader.read", "ui.slot", "log.write"] }, h.container.ctx);
  await inst.load();
  await inst.apply({});
  // 第一次渲染：异步 op 在这里发起（宿主侧数据是现成的，但要等后台泵把 .then 推起来）
  const first = inst.renderComponent("1", {});
  await new Promise((r) => setTimeout(r, 60));
  const second = inst.renderComponent("1", {});
  check("渲染期发起的异步 op 会自己走完（不再永远停在加载中）", second.includes("已读完 1800 秒"), second + " ← 第一帧 " + first);
  check("数据回来时插件确实 refresh 了一次", h.logs.some((l) => l.includes("拿到数据:1800")), JSON.stringify(h.logs.filter((l) => l.includes("拿到数据"))));
  await inst.stop();
  await h.runtime.dispose();
  await h.container.dispose();
}

// ---------- 1d) 网络（P3.10）：能力 + 域名范围两道闸门 ----------
{
  // 没授权：连调用都进不去
  const h = await makeHarness({ capabilities: ["log.write"] });
  const denied = [
    "async function apply(ctx) {",
    "  try { await ctx.net.fetch('https://api.example.com/x'); ctx.log('不该走到这里：没授权也能联网'); }",
    "  catch (e) { ctx.log('被拦住:' + e.message); }",
    "}",
  ].join("\n");
  const inst = h.runtime.createInstance({ pluginId: PLUGIN_ID, version: VERSION, code: denied, capabilities: ["log.write"] }, h.container.ctx);
  await inst.load();
  await inst.apply({});
  check(
    "没授予 net.fetch 时联网被拦下",
    h.logs.some((l) => l.includes("被拦住") && l.includes("net.fetch")),
    JSON.stringify(h.logs.filter((l) => l.includes("拦住"))),
  );
  await inst.stop();
  await h.runtime.dispose();
  await h.container.dispose();
}

{
  // 只授权了 api.example.com：它能过，别的域名过不去
  const h = await makeHarness({ capabilities: ["net.fetch", "log.write"], origins: ["https://api.example.com"] });
  const code = [
    "async function apply(ctx) {",
    "  try { var r = await ctx.net.fetch('https://api.example.com/x'); ctx.log('放行:' + r.text); }",
    "  catch (e) { ctx.log('放行失败:' + e.message); }",
    "  try { await ctx.net.fetch('https://evil.example.org/x'); ctx.log('不该走到这里：未授权域名也放行了'); }",
    "  catch (e) { ctx.log('跨域被拦:' + e.message); }",
    "  try { await ctx.net.fetch('file:///c:/windows/win.ini'); ctx.log('不该走到这里：file 协议也放行了'); }",
    "  catch (e) { ctx.log('非http被拦:' + e.message); }",
    "}",
  ].join("\n");
  const inst = h.runtime.createInstance({
    pluginId: PLUGIN_ID,
    version: VERSION,
    code,
    capabilities: ["net.fetch", "log.write"],
  }, h.container.ctx);
  await inst.load();
  await inst.apply({});
  const okLine = h.logs.find((l) => l.includes("放行:"));
  check("授权域名可以访问，且宿主把范围交给了 fetch 实现", !!okLine && okLine.includes("NET:https://api.example.com/x|https://api.example.com"), String(okLine));
  check("未授权域名被拦（同一个能力，不同域名）", h.logs.some((l) => l.includes("跨域被拦") && l.includes("net.fetch")), JSON.stringify(h.logs.filter((l) => l.includes("跨域"))));
  check("非 http(s) 的 URL 被拦", h.logs.some((l) => l.includes("非http被拦") && l.includes("只接受 http")), JSON.stringify(h.logs.filter((l) => l.includes("非http"))));
  await inst.stop();
  await h.runtime.dispose();
  await h.container.dispose();
}

// ---------- 1e) ai.credentials：宿主代填 Authorization（P3.11） ----------
//
// 三条边界要钉住：① 只在**当前 AI 服务域名**的 GET 上代填；② POST 直接拒（宿主不替插件花钱）；
// ③ 插件拿不到 Key 本身（它在宿主侧拼头，VM 里看不到）。
{
  const code = [
    "async function apply(ctx) {",
    "  try { var a = await ctx.net.fetch('https://api.deepseek.com/user/balance'); ctx.log('余额请求:' + a.text); }",
    "  catch (e) { ctx.log('余额请求失败:' + e.message); }",
    "  try { var b = await ctx.net.fetch('https://api.deepseek.com/chat/completions', { method: 'POST', body: '{}' }); ctx.log('POST竟然过了:' + b.text); }",
    "  catch (e) { ctx.log('POST被拒:' + e.message); }",
    "  try { var c = await ctx.net.fetch('https://example.org/x'); ctx.log('他域竟然过了:' + c.text); }",
    "  catch (e) { ctx.log('他域被拒:' + e.message); }",
    "}",
  ].join("\n");

  const mk = async (capabilities: CapabilityId[], origins = ["https://api.deepseek.com"]) => {
    const h = await makeHarness({
      capabilities: [...capabilities, "log.write"],
      origins,
    });
    const inst = h.runtime.createInstance(
      { pluginId: PLUGIN_ID, version: VERSION, code, capabilities: [...capabilities, "log.write"] },
      h.container.ctx,
    );
    await inst.load();
    await inst.apply({});
    return { h, inst };
  };

  const withCred = await mk(["net.fetch", "ai.credentials"]);
  const okLine = withCred.h.logs.find((l) => l.includes("余额请求:"));
  check(
    "声明并获授 ai.credentials 时，GET 由宿主代填 Authorization",
    !!okLine && okLine.includes("auth=Bearer sk-host-side-key"),
    String(okLine),
  );
  check(
    "POST 被明确拒绝（不替插件花钱）",
    withCred.h.logs.some((l) => l.includes("POST被拒") && l.includes("只对 GET")),
    JSON.stringify(withCred.h.logs.filter((l) => l.includes("POST"))),
  );
  // 一个"已被 net.fetch 授权、但不是 AI 服务"的域名：这时该轮到 ai.credentials 的边界生效
  const other = await mk(["net.fetch", "ai.credentials"], ["https://api.deepseek.com", "https://example.org"]);
  check(
    "ai.credentials 不会把 Key 带到别的（哪怕已授权的）域名上",
    other.h.logs.some((l) => l.includes("他域被拒") && l.includes("只用于你配置的 AI 服务")),
    JSON.stringify(other.h.logs.filter((l) => l.includes("他域"))),
  );
  await other.inst.stop();
  await other.h.runtime.dispose();
  await other.h.container.dispose();

  await withCred.inst.stop();
  await withCred.h.runtime.dispose();
  await withCred.h.container.dispose();

  // Key 不进沙箱：ctx 上根本没有拿凭据的入口（这一条是这套设计的地基）
  {
    const h = await makeHarness({ capabilities: ["ai.credentials", "log.write"] });
    const probeCode = [
      "async function apply(ctx) {",
      "  ctx.log('凭据入口:' + [typeof ctx.ai, typeof ctx.aiKey, typeof ctx.credentials, typeof ctx.key].join(','));",
      "}",
    ].join("\n");
    const inst = h.runtime.createInstance(
      { pluginId: PLUGIN_ID, version: VERSION, code: probeCode, capabilities: ["ai.credentials", "log.write"] },
      h.container.ctx,
    );
    await inst.load();
    await inst.apply({});
    check(
      "插件里没有任何读 Key 的入口（ctx.ai / ctx.aiKey / ctx.credentials / ctx.key 都是 undefined）",
      h.logs.some((l) => l.includes("凭据入口:undefined,undefined,undefined,undefined")),
      JSON.stringify(h.logs.filter((l) => l.includes("凭据入口"))),
    );
    await inst.stop();
    await h.runtime.dispose();
    await h.container.dispose();
  }

  // 没声明这个能力：不代填（普通请求照发，不带 Authorization）
  const without = await mk(["net.fetch"]);
  const plain = without.h.logs.find((l) => l.includes("余额请求:"));
  check("没声明 ai.credentials 时不代填", !!plain && plain.includes("auth=none"), String(plain));
  await without.inst.stop();
  await without.h.runtime.dispose();
  await without.h.container.dispose();

  // 声明了但没授权：调用被拦（不是静默不带 Key）
  const h3 = await makeHarness({ capabilities: ["net.fetch", "log.write"], origins: ["https://api.deepseek.com"] });
  const inst3 = h3.runtime.createInstance(
    { pluginId: PLUGIN_ID, version: VERSION, code, capabilities: ["net.fetch", "ai.credentials", "log.write"] },
    h3.container.ctx,
  );
  await inst3.load();
  await inst3.apply({});
  check(
    "声明了但没授权 → 明确报错（不静默降级）",
    h3.logs.some((l) => l.includes("余额请求失败") && l.includes("ai.credentials")),
    JSON.stringify(h3.logs.filter((l) => l.includes("余额请求"))),
  );
  await inst3.stop();
  await h3.runtime.dispose();
  await h3.container.dispose();
}

// ---------- 1f) 参数不可序列化时要说人话（P3.11 实测） ----------
//
// 实测：模型把**函数**传给 ctx.provide（想当服务注册表用），JSON.stringify 得到 undefined，
// 宿主拿到字符串 "undefined" 再 JSON.parse → 报 `"undefined" is not valid JSON` —— 完全看不出病因，
// 模型为此连撞三轮。现在这类错误要在**调用点**就说清是哪个 op、参数是什么毛病。
{
  const h = await makeHarness({ capabilities: ["storage.plugin", "log.write"] });
  const code = [
    "async function apply(ctx) {",
    "  try { ctx.provide('plugin.bad', function () {}); ctx.log('不该走到这里：函数也被 provide 了'); }",
    "  catch (e) { ctx.log('provide被拒:' + e.message); }",
    "  try { await ctx.storage.set('k', function () {}); ctx.log('不该走到这里：函数也被 set 了'); }",
    "  catch (e) { ctx.log('storage被拒:' + e.message); }",
    "  try { ctx.provide('plugin.ok', { a: 1 }); ctx.log('纯数据通过'); }",
    "  catch (e) { ctx.log('纯数据被拒:' + e.message); }",
    "}",
  ].join("\n");
  const inst = h.runtime.createInstance(
    { pluginId: PLUGIN_ID, version: VERSION, code, capabilities: ["storage.plugin", "log.write"] },
    h.container.ctx,
  );
  await inst.load();
  await inst.apply({});
  check(
    "ctx.provide 收到函数 → 明说只能给纯数据（不是 JSON 报错）",
    h.logs.some((l) => l.includes("provide被拒") && l.includes("纯数据")),
    JSON.stringify(h.logs.filter((l) => l.includes("provide被拒"))),
  );
  check(
    "storage.set 收到函数 → 明说参数没法序列化",
    h.logs.some((l) => l.includes("storage被拒") && l.includes("只能存 JSON 数据")),
    JSON.stringify(h.logs.filter((l) => l.includes("storage被拒"))),
  );
  check("纯数据照常通过", h.logs.some((l) => l.includes("纯数据通过")));
  await inst.stop();
  await h.runtime.dispose();
  await h.container.dispose();
}

// ---------- 2) 能力门禁 ----------

{
  const h = await makeHarness({ capabilities: ["log.write"] });
  const code = [
    "function apply(ctx) {",
    "  try { ctx.reader.progress(); ctx.log('不该走到这里：没授权也能读'); }",
    "  catch (e) { ctx.log('被拦住:' + e.message); }",
    "  try { ctx.storage.set('a', 1); ctx.log('不该走到这里：没授权也能写存储'); }",
    "  catch (e) { ctx.log('被拦住:' + e.message); }",
    "}",
  ].join("\n");
  const instance = h.runtime.createInstance({ pluginId: PLUGIN_ID, version: VERSION, code, capabilities: ["log.write"] }, h.container.ctx);
  await instance.load();
  await instance.apply({});
  const joined = h.logs.join(" | ");
  check("未授予 reader.read → 读进度被拦", joined.includes("被拦住:调用 reader.progress 需要能力 reader.read"), joined);
  check("未授予 storage.plugin → 写存储被拦", joined.includes("需要能力 storage.plugin"), joined);
  check("拦下来的调用没有产生副作用", h.storage.size === 0);
  await instance.stop();
  await h.runtime.dispose();
  await h.container.dispose();
}

// ---------- 3) 撤销立刻生效 ----------

{
  const h = await makeHarness({ capabilities: ["reader.read", "log.write"] });
  const code = [
    "var reads = 0;",
    "function apply(ctx) {",
    "  ctx.effect(function () {",
    "    // effect 回调是同步的：这里只做一次性设置",
    "    ctx.log('setup');",
    "  });",
    "  ctx.tools.register({",
    "    name: 'dyn_read',",
    "    description: '读进度',",
    "    parameters: { type: 'object', properties: {} },",
    "    capabilities: ['reader.read'],",
    "  }, async function () { reads++; const p = ctx.reader.progress(); return { chapter: p.chapter, reads: reads }; });",
    "}",
  ].join("\n");
  const instance = h.runtime.createInstance({ pluginId: PLUGIN_ID, version: VERSION, code, capabilities: ["reader.read", "log.write"] }, h.container.ctx);
  await instance.load();
  await instance.apply({});
  check("授权在时：工具注册进了 registry", h.tools.schemas().some((s) => s.function.name === "dyn_read"));
  const before = await h.tools.execute("dyn_read", {}, { signal: new AbortController().signal, callId: "c1" });
  check("授权在时：工具能跑（真的进了 QuickJS）", before.outcome.ok && (before.outcome.value as { chapter: string }).chapter === "第三章", JSON.stringify(before.outcome));

  await h.broker.revoke(PLUGIN_ID, "reader.read");
  const after = await h.tools.execute("dyn_read", {}, { signal: new AbortController().signal, callId: "c2" });
  check(
    "撤销授权后：guard 立刻拦下同一个工具",
    !after.outcome.ok && after.outcome.error.code === "NOT_AVAILABLE" && after.outcome.error.message.includes("已被撤销"),
    JSON.stringify(after.outcome),
  );
  await instance.stop();
  await h.runtime.dispose();
  await h.container.dispose();
}

// ---------- 4) 工具桥（正常路径）+ 卸载跑 disposer ----------

{
  const h = await makeHarness({ capabilities: ["reader.read", "storage.plugin", "log.write"] });
  const instance = h.runtime.createInstance(
    { pluginId: PLUGIN_ID, version: VERSION, code: GOOD_CODE, capabilities: ["reader.read", "storage.plugin", "log.write"] },
    h.container.ctx,
  );
  await instance.load();
  await instance.apply({ n: 7 });
  check("apply 拿到了配置", h.logs.some((l) => l.includes("apply 收到配置")), h.logs.join(" | "));
  check("effect 回调被执行", h.logs.some((l) => l.includes("effect 跑了一次")));

  const names = h.tools.schemas().map((s) => s.function.name).sort();
  check("三个插件工具都注册了", names.join(",") === "dyn_progress,dyn_remember,dyn_search", names.join(","));
  check("工具描述进 schema（模型看到的是插件写的）", h.tools.schemas().find((s) => s.function.name === "dyn_progress")?.function.description === "插件提供的：读当前进度");

  const progress = await h.tools.execute("dyn_progress", {}, { signal: new AbortController().signal, callId: "c1" });
  check("插件工具返回值回填给模型", progress.outcome.ok && (progress.outcome.value as { from: string }).from === "plugin", JSON.stringify(progress.outcome));

  // 异步 op：宿主 promise 的结算值必须是**字符串**，否则 prelude 二次 JSON.parse 会炸
  //（实测踩到过：JSON.parse("[object Object]") → SyntaxError: unexpected token: 'object'）
  const searched = await h.tools.execute("dyn_search", {}, { signal: new AbortController().signal, callId: "c2b" });
  check("插件工具里 await 异步 reader op 可用", searched.outcome.ok && (searched.outcome.value as { hits: number }).hits === 1, JSON.stringify(searched.outcome));

  const remember = await h.tools.execute("dyn_remember", { note: "记住这一句" }, { signal: new AbortController().signal, callId: "c2" });
  check("插件工具能写自己的存储", remember.outcome.ok === true);
  check("存储确实写进去了（宿主按 pluginId 隔离）", h.storage.get("last-note") === "记住这一句", String(h.storage.get("last-note")));

  const bad = await h.tools.execute("dyn_remember", {}, { signal: new AbortController().signal, callId: "c3" });
  check("参数校验走的是同一条流水线", !bad.outcome.ok && bad.outcome.error.code === "INVALID_ARGUMENTS", JSON.stringify(bad.outcome));

  await instance.stop();
  check("卸载时插件侧的 disposer 跑了", h.logs.some((l) => l.includes("effect disposer 跑了")), h.logs.join(" | "));
  check("apply 返回的 disposer 也跑了", h.logs.some((l) => l.includes("apply 返回的 disposer 跑了")));
  check("实例标记为已停止", instance.isStopped);
  const gone = await h.tools.execute("dyn_progress", {}, { signal: new AbortController().signal, callId: "c4" });
  check("上下文没了之后工具也调不动了", gone.outcome.ok === false, JSON.stringify(gone.outcome));
  await h.runtime.dispose();
  await h.container.dispose();
}

// ---------- 5) 时间与内存上限 ----------

{
  const h = await makeHarness({ capabilities: ["log.write"], budgetMs: 300 });
  const loop = "function apply(ctx) { while (true) {} }";
  const instance = h.runtime.createInstance({ pluginId: PLUGIN_ID, version: VERSION, code: loop, capabilities: ["log.write"] }, h.container.ctx);
  await instance.load();
  let loopError = "";
  try {
    await instance.apply({});
  } catch (e) {
    loopError = String(e instanceof Error ? e.message : e);
  }
  check("同步死循环被中断（时间预算）", loopError.length > 0 && /interrupt/i.test(loopError), loopError);
  await instance.stop();
  await h.runtime.dispose();
  await h.container.dispose();
}

{
  const h = await makeHarness({ capabilities: ["log.write"], memoryLimitBytes: 2 * 1024 * 1024 });
  const hog = "function apply(ctx) { var a = []; for (var i = 0; i < 200000; i++) a.push(new Array(200).fill(i)); return a.length; }";
  const instance = h.runtime.createInstance({ pluginId: PLUGIN_ID, version: VERSION, code: hog, capabilities: ["log.write"] }, h.container.ctx);
  await instance.load();
  let memError = "";
  try {
    await instance.apply({});
  } catch (e) {
    memError = String(e instanceof Error ? e.message : e);
  }
  check("内存超限被杀（2MB 上限）", memError.length > 0 && /out of memory|memory/i.test(memError), memError);
  await instance.stop();
  await h.runtime.dispose();
  await h.container.dispose();
}

// ---------- 6) apply 抛错 / 形状不对 ----------

{
  const h = await makeHarness({ capabilities: ["log.write"] });
  const boom = "function apply(ctx) { throw new Error('插件自己炸了'); }";
  const instance = h.runtime.createInstance({ pluginId: PLUGIN_ID, version: VERSION, code: boom, capabilities: ["log.write"] }, h.container.ctx);
  await instance.load();
  let err = "";
  try {
    await instance.apply({});
  } catch (e) {
    err = String(e instanceof Error ? e.message : e);
  }
  check("apply 抛错能传回宿主", err.includes("插件自己炸了"), err);
  await instance.stop();

  const noApply = "var x = 1;";
  const bad = h.runtime.createInstance({ pluginId: PLUGIN_ID, version: VERSION, code: noApply, capabilities: [] }, h.container.ctx);
  let shapeErr = "";
  try {
    await bad.load();
  } catch (e) {
    shapeErr = String(e instanceof Error ? e.message : e);
  }
  check("没交出 apply 的代码被拒", shapeErr.includes("apply"), shapeErr);
  await bad.stop();

  const syntax = "function apply(ctx) { this is not js }";
  const broken = h.runtime.createInstance({ pluginId: PLUGIN_ID, version: VERSION, code: syntax, capabilities: [] }, h.container.ctx);
  let syntaxErr = "";
  try {
    await broken.load();
  } catch (e) {
    syntaxErr = String(e instanceof Error ? e.message : e);
  }
  check("语法错误在 load 阶段就被拒（不执行）", syntaxErr.includes("求值失败"), syntaxErr);
  await broken.stop();
  await h.runtime.dispose();
  await h.container.dispose();
}

// ---------- 7) 工厂（交给加载器的那条路径） ----------

{
  const h = await makeHarness({ capabilities: ["reader.read", "storage.plugin", "log.write"], pluginId: "test.factory" });
  const plugin = createDynamicPlugin({
    runtime: async () => h.runtime,
    spec: { pluginId: "test.factory", version: "2.0.0", capabilities: ["reader.read", "storage.plugin", "log.write"] },
    readCode: async () => GOOD_CODE,
    log: () => {},
  });
  const fiber = h.container.ctx.plugin(
    {
      name: "test.factory",
      inject: ["tools"],
      apply: (ctx, config) => plugin.apply(ctx, config),
    },
    {},
  );
  await fiber.ready;
  check("动态插件能被当普通插件挂进容器", fiber.state === "ACTIVE", fiber.state);
  check("它注册的工具进了共享 registry", h.tools.schemas().some((s) => s.function.name === "dyn_progress"));
  const uid = fiber.uid;
  await fiber.dispose();
  await h.container.settle();
  const diag = h.container.diagnostics();
  check("卸载后 fiber 是 DISPOSED", diag.fibers.find((f) => f.uid === uid)?.state === "DISPOSED", JSON.stringify(diag.fibers.find((f) => f.uid === uid)));
  check("卸载后工具没了（前缀不留残渣）", !h.tools.schemas().some((s) => s.function.name === "dyn_progress"), h.tools.schemas().map((s) => s.function.name).join(","));
  check("卸载后没有残留 effect", (diag.fibers.find((f) => f.uid === uid)?.pendingEffects ?? -1) === 0);
  await h.runtime.dispose();
  await h.container.dispose();
}

// ---------- 9) P5「外观权限」：改得了颜色（含阅读背景），也撤得掉 ----------

{
  const h = await makeHarness({ capabilities: ["ui.styles", "ui.theme"] });
  const code = wrap(
    [
      "  ctx.styles.insert('#air-test { color: red }', { scope: 'app' });",
      "  ctx.styles.insert('body { background: #101418; }', { scope: 'book' });",
      "  ctx.theme.overrideTokens({ '--air-book-bg': '#101418' });",
    ].join("\n"),
  );
  const instance = h.runtime.createInstance(
    { pluginId: PLUGIN_ID, version: VERSION, code, capabilities: ["ui.styles", "ui.theme"] },
    h.container.ctx,
  );
  await instance.load();
  await instance.apply({});
  check("app 作用域的样式进了账本", h.styleCore.css("app").includes("#air-test { color: red }"), h.styleCore.css("app"));
  check("book 作用域的样式单独一份（正文用）", h.styleCore.css("book").includes("body { background: #101418; }"), h.styleCore.css("book"));
  check("两个作用域互不串门", !h.styleCore.css("app").includes("background: #101418; }"));
  check("账本里留着「谁插的」（出问题能从 DOM 里认出来）", h.styleCore.css("app").includes("/* " + PLUGIN_ID + " */"), h.styleCore.css("app"));
  check("插件插了两张表（诊断数得出来）", h.styleCore.list().length === 2, JSON.stringify(h.styleCore.list()));

  // 用户报的那件事：**阅读背景改不了**。根因是正文在书自己的 iframe 里，外壳变量过不去。
  const resolved = h.themeOverrides.resolve("sepia");
  check("token 覆盖层解出了正文背景色", resolved["--air-book-bg"] === "#101418", JSON.stringify(resolved));
  const withPlugin = buildBookCSS(defaultTypography, THEMES.sepia, resolved);
  check("正文样式表真的用上了插件给的背景色", withPlugin.includes("background: #101418"), withPlugin.slice(0, 240));
  check("正文文档里也声明了变量（注入正文的插件 CSS 能用 var()）", withPlugin.includes("--air-book-bg: #101418;"));
  const withoutPlugin = buildBookCSS(defaultTypography, THEMES.sepia);
  check(
    "没插件覆盖时正文背景回到主题自带色",
    withoutPlugin.includes("background: " + THEMES.sepia.book.bg),
    withoutPlugin.slice(0, 240),
  );

  await instance.stop();
  check("卸载后 app 样式被撤掉", h.styleCore.css("app") === "", h.styleCore.css("app"));
  check("卸载后 book 样式被撤掉", h.styleCore.css("book") === "", h.styleCore.css("book"));
  check("卸载后 token 覆盖层也空了", Object.keys(h.themeOverrides.resolve("sepia")).length === 0, JSON.stringify(h.themeOverrides.resolve("sepia")));
  await h.runtime.dispose();
  await h.container.dispose();
}

// ---------- 10) 外观权限的边界：门禁 / 禁联网 / 张数与体积 / 撤销立刻生效 ----------

{
  // ① 没声明 ui.styles：插入必须失败，且错误要说清是哪个能力
  const hDenied = await makeHarness({ capabilities: ["log.write"] });
  const denied = await runPluginCode(hDenied, wrap("  ctx.styles.insert('#a{}');"), ["log.write"]);
  check("没授权 ui.styles 时插入样式会失败", !denied.ok && denied.err.includes("ui.styles"), denied.err);
  check("被拒时账本里什么都没有（不留半张表）", hDenied.styleCore.css() === "", hDenied.styleCore.css());
  await hDenied.runtime.dispose();
  await hDenied.container.dispose();

  // 下面是"授权了 ui.styles 之后"的边界（门禁已经过了，才谈得上规则）。
  // log.write 也给上：ctx.log 本身是要授权的（日志是给用户看的，不是白送的输出通道）。
  const h = await makeHarness({ capabilities: ["ui.styles", "ui.theme", "log.write"] });

  // ② @import / 远程 url(...)：会绕开 net.fetch 的域名授权，直接拒
  const imp = await runPluginCode(h, wrap("  ctx.styles.insert(\"@import url('https://evil.test/x.css');\");"));
  check("样式里的 @import 被拒", !imp.ok && imp.err.includes("@import"), imp.err);
  const remote = await runPluginCode(h, wrap("  ctx.styles.insert('body { background: url(https://evil.test/p.png) }');"));
  check("样式里的远程 url(...) 被拒", !remote.ok && remote.err.includes("url"), remote.err);
  const dataUri = await runPluginCode(h, wrap("  ctx.styles.insert(\"body { background: url(data:image/png;base64,AAA) }\");"));
  check("data: URI 是允许的（内联资源不算联网）", dataUri.ok, dataUri.err);

  // ③ 作用域写错：报错要列出可用值，别只说"错了"
  const badScope = await runPluginCode(h, wrap("  ctx.styles.insert('body{}', { scope: 'reader' });"));
  check("未知 scope 被拒且列出可用值", !badScope.ok && badScope.err.includes("reader") && badScope.err.includes("app"), badScope.err);

  // ④ 张数 / 体积上限
  const many = await runPluginCode(
    h,
    wrap(
      "  for (var i = 0; i < " + (MAX_SHEETS_PER_PLUGIN + 1) + "; i++) { ctx.styles.insert('#' + i + '{}'); }",
    ),
  );
  check(
    "超过单插件张数上限被拒（" + MAX_SHEETS_PER_PLUGIN + " 张）",
    !many.ok && many.err.includes(String(MAX_SHEETS_PER_PLUGIN + 1)),
    many.err,
  );
  const huge = await runPluginCode(h, wrap("  ctx.styles.insert('#' + new Array(70000).join('a') + '{}');"));
  check("超大样式表被拒", !huge.ok && huge.err.includes("65536"), huge.err);

  // ⑤ ctx.styles.clear()：撤自己的，返回撤掉几张
  const cleared = await runPluginCode(
    h,
    wrap(
      [
        "  ctx.styles.insert('#one{}');",
        "  ctx.styles.insert('#two{}', { scope: 'book' });",
        "  ctx.log('cleared=' + ctx.styles.clear());",
      ].join("\n"),
    ),
  );
  check("ctx.styles.clear() 跑得通", cleared.ok, cleared.err);
  check("clear 之后账本空了", h.styleCore.css() === "", h.styleCore.css());
  check("clear 返回撤掉的张数", h.logs.some((l) => l.includes("cleared=2")), h.logs.join(" | "));

  // ⑥ token 值的形状：值会被原样拼进 CSS，能拆开语句的一律拒
  const unsafe = await runPluginCode(
    h,
    wrap("  ctx.theme.overrideTokens({ '--air-book-bg': 'red; } body { display: none' });"),
  );
  check("token 值里塞 CSS 语句被拒", !unsafe.ok && unsafe.err.includes("--air-book-bg"), unsafe.err);

  // ⑦ 撤销授权立刻生效：授权时插得进去，撤销后同一个调用立刻失败
  const h2 = await makeHarness({ capabilities: ["ui.styles"] });
  const okFirst = await runPluginCode(h2, wrap("  ctx.styles.insert('#before{}');"), ["ui.styles"]);
  check("授权时插样式成功", okFirst.ok, okFirst.err);
  await h2.broker.revoke(PLUGIN_ID, "ui.styles");
  const afterRevoke = await runPluginCode(h2, wrap("  ctx.styles.insert('#after{}');"), ["ui.styles"]);
  check("撤销 ui.styles 后插入立刻失败", !afterRevoke.ok && afterRevoke.err.includes("ui.styles"), afterRevoke.err);
  check("撤销后页面上没有它新插的东西", !h2.styleCore.css().includes("#after{}"), h2.styleCore.css());
  await h2.runtime.dispose();
  await h2.container.dispose();

  await h.runtime.dispose();
  await h.container.dispose();
}

// ---------- 11) P5 前置服务（inject）：读别的插件的数据，依赖没到就 park ----------

{
  const h = await makeHarness({ capabilities: ["log.write"], pluginId: "test.consumer" });
  // 提供方：另一个插件把自己的统计当**纯数据**服务提供出来
  h.container.ctx.provide("plugin.stats", { books: 3, minutes: 128, streak: 5 });
  const code = (name: string, extra = "") =>
    wrap(
      [
        "  ctx.log('services=' + JSON.stringify(ctx.services()));",
        "  var v = ctx.get(" + JSON.stringify(name) + ");",
        "  ctx.log('got=' + JSON.stringify(v));" + extra,
      ].join("\n"),
    );
  const withInject = (inject: string[]) =>
    h.runtime.createInstance(
      { pluginId: "test.consumer", version: VERSION, code: code("plugin.stats"), capabilities: ["log.write"], inject },
      h.container.ctx,
    );

  // ① 声明了依赖：读得到数据
  const okInstance = withInject(["plugin.stats"]);
  await okInstance.load();
  await okInstance.apply({});
  check("声明 inject 后 ctx.get 读到了别的插件的数据", h.logs.some((l) => l.includes('got={"books":3,"minutes":128,"streak":5}')), h.logs.join(" | "));
  check("ctx.services() 只列插件服务（plugin.*）", h.logs.some((l) => l.includes('services=["plugin.stats"]')), h.logs.join(" | "));
  await okInstance.stop();

  // ② 没声明：会失败，而且错误里要给出"怎么改"（列出现在声明了什么）
  const noDecl = withInject([]);
  await noDecl.load();
  let err = "";
  try {
    await noDecl.apply({});
  } catch (e) {
    err = String(e instanceof Error ? e.message : e);
  }
  check("没在 manifest.inject 里声明过就读不到", err.includes("manifest.inject"), err);
  check("错误里列了当前声明（作者知道该往哪加）", err.includes("当前声明了"), err);
  await noDecl.stop();

  // ③ 宿主服务不能从这条门进来（否则等于绕过能力门禁）
  const hostDoor = h.runtime.createInstance(
    { pluginId: "test.consumer", version: VERSION, code: code("db"), capabilities: ["log.write"], inject: ["db"] },
    h.container.ctx,
  );
  await hostDoor.load();
  let hostErr = "";
  try {
    await hostDoor.apply({});
  } catch (e) {
    hostErr = String(e instanceof Error ? e.message : e);
  }
  check("ctx.get 拒绝宿主服务名（只认 plugin. 前缀）", hostErr.includes("plugin."), hostErr);
  await hostDoor.stop();

  // ④ 声明了但提供方不在：报"现在不存在"，不是静默 undefined
  const missing = h.runtime.createInstance(
    { pluginId: "test.consumer", version: VERSION, code: code("plugin.nope"), capabilities: ["log.write"], inject: ["plugin.nope"] },
    h.container.ctx,
  );
  await missing.load();
  let missingErr = "";
  try {
    await missing.apply({});
  } catch (e) {
    missingErr = String(e instanceof Error ? e.message : e);
  }
  check("提供方不在时报「现在不存在」而不是给 undefined", missingErr.includes("现在不存在"), missingErr);
  await missing.stop();
  await h.runtime.dispose();
  await h.container.dispose();
}

// ---------- 12) 前置服务与容器的 park 语义（依赖没到 = 等着，不是失败） ----------

{
  const h = await makeHarness({ capabilities: ["log.write"], pluginId: "test.waiter" });
  const plugin = createDynamicPlugin({
    runtime: async () => h.runtime,
    spec: { pluginId: "test.waiter", version: VERSION, capabilities: ["log.write"], inject: ["plugin.upstream"] },
    readCode: async () => wrap("  ctx.log('依赖到位了：' + JSON.stringify(ctx.get('plugin.upstream')));"),
    log: () => {},
  });
  const fiber = h.container.ctx.plugin(
    { name: "test.waiter", inject: ["plugin.upstream"], apply: (ctx, config) => plugin.apply(ctx, config) },
    {},
  );
  await fiber.ready;
  check("依赖不在时 fiber 停在 PENDING（不是 FAILED）", fiber.state === "PENDING", fiber.state);
  check("停在 PENDING 时插件代码还没跑", !h.logs.some((l) => l.includes("依赖到位了")), h.logs.join(" | "));

  // 提供方上线 → 自动被唤醒（这是"前置服务"的价值：不需要插件自己轮询/兜底）
  const providerFiber = h.container.ctx.plugin(
    { name: "test.upstream", apply: (ctx) => ctx.provide("plugin.upstream", { ready: true }) },
    {},
  );
  await providerFiber.ready;
  for (let i = 0; i < 40 && fiber.state !== "ACTIVE"; i++) await new Promise((r) => setTimeout(r, 25));
  check("提供方挂上后自动变 ACTIVE", fiber.state === "ACTIVE", fiber.state);
  check("插件代码在依赖到位后才跑，且读到了数据", h.logs.some((l) => l.includes('依赖到位了：{"ready":true}')), h.logs.join(" | "));

  // 提供方卸载 → 依赖方 park 回去（不是崩掉）
  await providerFiber.dispose();
  await h.container.settle();
  for (let i = 0; i < 40 && fiber.state === "ACTIVE"; i++) await new Promise((r) => setTimeout(r, 25));
  check("提供方卸载后依赖方 park 回 PENDING", fiber.state === "PENDING", fiber.state);

  await fiber.dispose();
  await h.runtime.dispose();
  await h.container.dispose();
}

// ---------- 8) 元数据自检 ----------

{
  check("每个 op 都挂了能力（没有漏网的宿主操作）", Object.values(OP_CAPABILITY).every((c) => typeof c === "string" && c.length > 0));
  check("预置脚本声明了 ctx.on 未接入", QUICKJS_PRELUDE.includes("ctx.on 还没接入"));
  // P3.4 起动态包能挂界面了（声明式 JSON VDOM，见 ui/dynamic/vdom.tsx）：
  // 预置脚本必须真的把 ctx.slots.register / refresh 交出去，而不是留一个 undefined
  check("预置脚本交出了 ctx.slots（P3.4 的 UI 桥）", QUICKJS_PRELUDE.includes("slots: {") && QUICKJS_PRELUDE.includes("host.uiRegister"));
  check("预置脚本的 slots 只有 register / refresh（没有别的口子）", QUICKJS_PRELUDE.includes("slots: {") && !QUICKJS_PRELUDE.includes("unregister"));
  // P5 外观权限：插件面必须真的交出 ctx.styles（insert/clear），且两个 op 都挂了能力
  check("预置脚本交出了 ctx.styles（P5 外观权限）", QUICKJS_PRELUDE.includes("styles: {") && QUICKJS_PRELUDE.includes("host.stylesInsert"));
  check("styles 的两个 op 都挂上了 ui.styles 能力", OP_CAPABILITY["styles.insert"] === "ui.styles" && OP_CAPABILITY["styles.clear"] === "ui.styles");
  // P5 前置服务：读服务靠**声明**（inject）门禁，不进能力表 —— 但必须显式登记在
  // OP_DECLARATION_ONLY 里：漏写能力名不该悄悄变成"不设防"
  check("读服务的两个 op 显式登记为「靠声明门禁」", OP_DECLARATION_ONLY.has("services.get") && OP_DECLARATION_ONLY.has("services.list"));
  check("声明门禁的 op 不与能力表重叠（表不能互相打架）", Object.keys(OP_CAPABILITY).every((op) => !OP_DECLARATION_ONLY.has(op)));
  // P5：宿主定时器（上一轮补的 Node 白送品）也必须在预置脚本里
  check("预置脚本交出了 ctx.timeout / ctx.interval / ctx.clear", QUICKJS_PRELUDE.includes("timeout: function") && QUICKJS_PRELUDE.includes("interval: function") && QUICKJS_PRELUDE.includes("clear: function"));
}

console.log("动态包运行时契约测试：" + pass + " 通过 / " + failures.length + " 失败");
if (failures.length) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("  ✓ 全部通过（沙箱事实 / 能力门禁 / 撤销立即生效 / 工具桥与存储 / 时间与内存上限 / 加载失败 / 与容器的挂载卸载）");
