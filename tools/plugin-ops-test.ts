/**
 * P3.5 契约测试：插件日志 + 把内存里的动态包**落到插件目录**（安装 / 卸载）。
 *
 * 三块：
 *   1. 日志缓冲本身（环形上限、按插件限流、丢了多少条如实记账、清空、订阅）
 *   2. 接进运行时之后（ctx.log 与界面渲染失败都进日志；plugin_diagnose 能读到）
 *   3. **落盘**：install 之后它就是一个普通的用户插件 —— 用一个**全新的运行时**（= 重启）
 *      在同一份"插件目录"上再跑一遍，它照常被加载、照常 ACTIVE（授权绑 (id, version, capability)）
 *
 * 跑法：npm test（第 8 套）或
 *   cd app && npx esbuild ../tools/plugin-ops-test.ts --bundle --platform=node --format=esm \
 *     --external:react --external:react/jsx-runtime --external:react-dom/server \
 *     --external:@jitl/* --external:quickjs-emscripten-core \
 *     --outfile=node_modules/.cache/aireader-tests/plugin-ops-test.mjs
 *   node node_modules/.cache/aireader-tests/plugin-ops-test.mjs
 */

import { createElement } from "react";
import { setLangPref } from "../app/src/i18n";

// 断言写的是中文默认文案：把界面语言钉死，别受开发机系统语言影响
setLangPref("zh");
import { renderToStaticMarkup } from "react-dom/server";
import { createAppRuntime } from "../app/src/core/app/runtime";
import { PluginLogStore } from "../app/src/core/plugin/logs";
import { SlotView } from "../app/src/ui/slots/index";
import type { PluginInvoke } from "../app/src/core/app/pluginFs";
import type { PluginsService, PluginStatus } from "../app/src/core/plugin/types";

(globalThis as any).window = globalThis;

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) pass++;
  else failures.push(name + (detail ? " —— " + detail : ""));
}

// ---------- 1) 日志缓冲 ----------

{
  const store = new PluginLogStore({ max: 10, perPlugin: 3, now: () => 1000 });
  store.write("a", "info", "第一条");
  store.write("a", "warn", "第二条");
  store.write("b", "error", "别人的");
  check("顺序：最近的在后", store.list().map((e) => e.message).join(",") === "第一条,第二条,别人的", store.list().map((e) => e.message).join(","));
  check("按插件过滤", store.list("b").length === 1 && store.list("b")[0].pluginId === "b");
  check("limit 取最后 N 条", store.list(undefined, 2).map((e) => e.message).join(",") === "第二条,别人的");
  check("seq 单调递增（排序稳定）", store.list().every((e, i, arr) => i === 0 || e.seq > arr[i - 1].seq));
  check("stats 报出条数与插件数", JSON.stringify(store.stats()) === JSON.stringify({ kept: 3, dropped: 0, plugins: 2 }), JSON.stringify(store.stats()));

  // 单插件限流：a 只留 3 条
  for (let i = 0; i < 5; i++) store.write("a", "info", "a-" + i);
  check("单插件上限生效（只留最近 3 条）", store.list("a").map((e) => e.message).join(",") === "a-2,a-3,a-4", store.list("a").map((e) => e.message).join(","));
  // a 一共写了 7 条、只留 3 条 → 丢掉 4 条
  check("被丢掉的条数如实记账", store.stats().dropped === 4, String(store.stats().dropped));
  check("限流不影响别的插件", store.list("b").length === 1);

  // 全局上限
  for (let i = 0; i < 20; i++) store.write("c" + i, "info", "x");
  check("全局上限生效", store.list().length === 10, String(store.list().length));

  let changes = 0;
  const off = store.onChange(() => changes++);
  const before = store.version();
  store.write("z", "info", "触发一次");
  check("写入会让版本 +1（useSyncExternalStore 的快照）", store.version() > before && changes === 1, changes + "/" + store.version());
  off();
  store.write("z", "info", "再来一次");
  check("退订之后不再回调", changes === 1, String(changes));

  // 先补一条 b（上面那轮全局上限已经把早期条目挤掉了）
  store.write("b", "error", "别人的又来了");
  check("clear(pluginId) 只清它", store.clear("b") === 1 && store.list("b").length === 0 && store.list().length > 0);
  check("clear() 清全部", store.clear() > 0 && store.list().length === 0);

  const big = new PluginLogStore({ maxMessageChars: 20 });
  big.write("a", "info", "x".repeat(100));
  check(
    "单条消息超长会被截断（不让一行日志撑爆缓冲）",
    big.list()[0].message.length === 20 + "…（截断）".length && big.list()[0].message.endsWith("…（截断）"),
    String(big.list()[0].message.length),
  );
  check("级别只认 info/warn/error（别的当 info）", big.write("a", "debug", "d").level === "info");
}

// ---------- 公共：内存版"插件目录 + 设置表" ----------

/** PluginInvoke 的内存实现：让 install / uninstall 在 node 里能真跑（读写同一张表） */
function memoryPluginIo(initial: Record<string, string> = {}): PluginInvoke & { files: Map<string, string> } {
  const table = new Map<string, string>(Object.entries(initial));
  const dirsOf = () => {
    const set = new Set<string>();
    for (const path of table.keys()) {
      const at = path.indexOf("/");
      if (at > 0 && path === path.slice(0, at) + "/manifest.json") set.add(path.slice(0, at));
    }
    return [...set].sort();
  };
  return {
    files: table,
    getPluginsDir: async () => "X:/plugins",
    scanPlugins: async () =>
      dirsOf().map((relDir) => ({
        relDir,
        absDir: "X:/plugins/" + relDir,
        files: [...table.keys()].filter((p) => p.startsWith(relDir + "/")).map((p) => p.slice(relDir.length + 1)).sort(),
      })),
    readPluginText: async (rel) => {
      const text = table.get(rel);
      if (text === undefined) throw new Error("没有这个文件：" + rel);
      return text;
    },
    writePluginText: async (rel, text) => {
      table.set(rel, text);
      return "X:/plugins/" + rel;
    },
    deletePlugin: async (relDir) => {
      for (const key of [...table.keys()]) if (key.startsWith(relDir + "/")) table.delete(key);
    },
  };
}

const settings = new Map<string, unknown>();
const settingsIo = {
  getSetting: async <T,>(key: string, fallback: T) => (settings.has(key) ? (settings.get(key) as T) : fallback),
  setSetting: async (key: string, value: unknown) => {
    settings.set(key, value);
  },
};

const fakeReader = () => ({
  bookId: () => "book-1",
  title: () => "测试书",
  author: () => "作者",
  progress: () => ({
    fraction: 0.3,
    chapter: "第三章",
    location: "位置 120",
    sectionIndex: 2,
    sectionTotal: 10,
    sectionFraction: 0.5,
    sectionStartFraction: 0.2,
    sectionEndFraction: 0.4,
    locations: { current: 300, total: 1000 },
  }),
  context: () => null,
  chapters: () => [],
  chapter: () => null,
  search: async () => [],
  selection: () => null,
  addAnnotation: async () => {
    throw new Error("测试里不写库");
  },
  annotations: async () => [],
  goToChapter: async () => {},
  goToHref: async () => {},
  goToCfi: async () => {},
  goToFraction: async () => {},
});

const skillsStub = {
  registry: { candidates: () => [], modelInvocable: () => [], get: async () => undefined },
  refresh: async () => ({ userSkills: 0, total: 0, digest: "" }),
  write: async () => "",
  readResource: async () => ({ ok: false as const, error: "no" }),
  remove: async () => {},
  dir: async () => "",
  warnings: () => [],
  entries: () => [],
};

async function makeRuntime(io: PluginInvoke, logs: string[] = []) {
  const runtime = createAppRuntime({
    reader: fakeReader() as never,
    skills: skillsStub as never,
    db: { listAnnotations: async () => [], addAnnotation: async () => { throw new Error("不写库"); }, searchBook: async () => [], ...settingsIo },
    theme: { current: () => "light" as never, set: () => {}, list: () => [] },
    paths: { skillsDir: () => "X:/skills", pluginsDir: () => "X:/plugins" },
    pluginIo: io,
    log: (level, message) => logs.push(level + ":" + message),
  });
  await runtime.mount();
  return runtime;
}

/** AppRuntime.plugins() 是"状态列表"，控制面在容器服务上（装机/卸载这类动作属于它） */
const controlPlaneOf = (runtime: { container: { ctx: { get<T>(name: string): T | undefined } } }) =>
  runtime.container.ctx.get<PluginsService>("plugins") as PluginsService;

const PLUGIN_ID = "ai.logging-left-pages";
const MAIN = [
  "function apply(ctx, config) {",
  "  ctx.log('宿主半启动，配置=' + JSON.stringify(config || {}));",
  "}",
].join("\n");
const UI = [
  "function apply(ctx) {",
  "  ctx.slots.register({ slot: 'reader.view.tail', id: 'logged', order: 20, label: '带日志的格子' }, function () {",
  "    var p = ctx.reader.progress() || {};",
  "    return { type: 'span', props: {}, children: ['日志插件：' + (p.chapter || '')] };",
  "  });",
  "  ctx.log('界面挂好了');",
  "}",
].join("\n");

// ---------- 2) 接进运行时：ctx.log / 渲染失败 / diagnose ----------

{
  const io = memoryPluginIo();
  const runtime = await makeRuntime(io);
  const call = (name: string, args: unknown) =>
    runtime.tools.execute(name, args, { signal: new AbortController().signal, callId: "ops-" + name });

  check("pluginLogs 服务在（面板与 diagnose 都读它）", typeof runtime.pluginLogs?.list === "function");

  const defined = await call("plugin_define", {
    pluginId: PLUGIN_ID,
    name: "带日志的插件",
    purpose: "验证 ctx.log 落到插件日志里。",
    main: MAIN,
    ui: UI,
    capabilities: ["reader.read", "ui.slot", "log.write"],
  });
  check("定义成功", defined.outcome.ok, JSON.stringify(defined.outcome));
  const run1 = await call("plugin_run", { pluginId: PLUGIN_ID });
  check("未授权时停在待授权", run1.outcome.ok && (run1.outcome.value as { state: string }).state === "PENDING_PERMISSION");
  check("还没挂起来时日志是空的（什么都没跑）", runtime.pluginLogs.list(PLUGIN_ID).length === 0);

  await runtime.permissions.grant(PLUGIN_ID, "1.0.0", ["reader.read", "ui.slot", "log.write"], "always");
  const deadline = Date.now() + 4000;
  let status: PluginStatus | undefined;
  for (;;) {
    await runtime.container.settle();
    status = runtime.plugins().find((p) => p.id === PLUGIN_ID);
    if (status?.state === "ACTIVE" || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  check("授权后自动挂起来", status?.state === "ACTIVE", JSON.stringify(status));

  const lines = runtime.pluginLogs.list(PLUGIN_ID);
  check("ctx.log 的两条都进了日志（宿主半 + UI 半）", lines.length === 2 && lines[0].message.includes("宿主半启动") && lines[1].message.includes("界面挂好了"), JSON.stringify(lines.map((l) => l.message)));
  check("日志带级别与时间", lines.every((l) => l.level === "info" && l.at > 0));
  check("stats 说得清有几个插件在写日志", runtime.pluginLogs.stats().plugins >= 1, JSON.stringify(runtime.pluginLogs.stats()));

  const diag = await call("plugin_diagnose", { pluginId: PLUGIN_ID, includeSource: false });
  const diagLogs = diag.outcome.ok ? ((diag.outcome.value as { logs: { message: string }[] }).logs ?? []) : [];
  check("plugin_diagnose 带上这个插件的日志（AI 闭环里「它自己说了什么」）", diagLogs.some((l) => l.message.includes("宿主半启动")), JSON.stringify(diagLogs));

  // 界面渲染失败也进日志
  const badUi = UI.replace("type: 'span'", "type: 'marquee'");
  await call("plugin_define", {
    pluginId: PLUGIN_ID,
    name: "带日志的插件",
    purpose: "验证 ctx.log 落到插件日志里。",
    version: "1.0.1",
    main: MAIN,
    ui: badUi,
    capabilities: ["reader.read", "ui.slot", "log.write"],
  });
  await call("plugin_run", { pluginId: PLUGIN_ID });
  await new Promise((r) => setTimeout(r, 60));
  // 注意：SSR 里没有错误边界，renderToStaticMarkup 会把异常直接抛出来
  //（"崩一个只摘它自己"是浏览器里的行为，probe-p34 验过）。这里只关心"失败有没有进日志"。
  let renderThrew = "";
  try {
    renderToStaticMarkup(createElement(SlotView, { slots: runtime.slots, name: "reader.view.tail" }));
  } catch (e) {
    renderThrew = String(e instanceof Error ? e.message : e);
  }
  check("界面白名单外的标签会抛错（浏览器里由槽位边界摘掉那一格）", renderThrew.includes("marquee"), renderThrew.slice(0, 80));
  const afterRender = runtime.pluginLogs.list(PLUGIN_ID);
  check("界面渲染失败也进日志（warn 级，带槽位）", afterRender.some((l) => l.level === "warn" && l.message.includes("界面渲染失败")), JSON.stringify(afterRender.map((l) => l.level + ":" + l.message.slice(0, 30))));
  // 同一个错误不刷屏：React 会在摘掉那一格之前重试好几轮，日志里只该有一条（其余记成 count）
  const warnLines = afterRender.filter((l) => l.message.includes("界面渲染失败"));
  check("同一个渲染失败只记一条日志（重复的折成 count）", warnLines.length === 1, String(warnLines.length));

  // ---------- 3) 落盘 ----------
  // 回到 1.0.0（用户满意的那个版本），再落到插件目录
  const pkgs = runtime.pluginDev.packagesOf(PLUGIN_ID);
  const good = pkgs.find((p) => p.version === "1.0.0")!;
  await call("plugin_run", { pluginId: PLUGIN_ID, packageId: good.packageId });
  await new Promise((r) => setTimeout(r, 60));

  const before = runtime.plugins().find((p) => p.id === PLUGIN_ID);
  check("运行中的是内存里的动态包（面板据此显示「保留到插件目录」）", before?.dynamic === true && String(before?.dir).startsWith("aireader://dynamic/"), JSON.stringify(before?.dir));

  const report = await controlPlaneOf(runtime).install(PLUGIN_ID);
  check("落盘回执给出写进去的文件", report.files.join(",") === "manifest.json,main.js,ui.js", report.files.join(","));
  check("文件真的在插件目录里", io.files.has(PLUGIN_ID + "/manifest.json") && io.files.has(PLUGIN_ID + "/main.js") && io.files.has(PLUGIN_ID + "/ui.js"));
  check("内存里的定义已经删掉（否则叠加层会遮住磁盘上的同一个 id）", runtime.pluginDev.packagesOf(PLUGIN_ID).length === 0);
  const after = runtime.plugins().find((p) => p.id === PLUGIN_ID);
  check("落盘后它不再是动态包（是一个普通用户插件）", after?.dynamic === false && after?.source === "user", JSON.stringify({ dynamic: after?.dynamic, source: after?.source }));
  check("版本没变、状态还是 ACTIVE（同一份代码，不需要重挂）", after?.version === "1.0.0" && after?.state === "ACTIVE", JSON.stringify(after));
  check("授予过的能力继续有效（授权绑 (pluginId, version, capability)）", runtime.permissions.list(PLUGIN_ID).filter((r) => r.state === "granted").length === 3, JSON.stringify(runtime.permissions.list(PLUGIN_ID).map((r) => r.capability)));

  // 再来一次应当被拒（目录里已经有同名包）
  let refused = "";
  try {
    await controlPlaneOf(runtime).install(PLUGIN_ID);
  } catch (e) {
    refused = String(e instanceof Error ? e.message : e);
  }
  check("重复落盘被拒且说清原因", refused.includes("不在内存里") || refused.includes("同名"), refused);

  await runtime.dispose();

  // ---------- 3b) 换一个运行时 = 重启：它作为普通用户插件重新被加载 ----------
  const restarted = await makeRuntime(io);
  await restarted.container.settle();
  const revived = restarted.plugins().find((p) => p.id === PLUGIN_ID);
  check("重启后插件还在（这次是从插件目录加载的）", Boolean(revived), JSON.stringify(restarted.plugins().map((p) => p.id)));
  check("重启后它照常 ACTIVE（授权也还在）", revived?.state === "ACTIVE" && revived?.dynamic === false, JSON.stringify(revived));
  check("重启后它能重新贡献界面", (revived?.contributions ?? []).some((c) => c.startsWith("dynamic-ui:reader.view.tail")), JSON.stringify(revived?.contributions));
  const restartedHtml = renderToStaticMarkup(createElement(SlotView, { slots: restarted.slots, name: "reader.view.tail" }));
  check("重启后界面照常渲染（真的读到了这本书）", restartedHtml.includes("日志插件：第三章"), restartedHtml.slice(0, 120));
  // 日志**不落盘**：重启后缓冲里只有这次启动新写的那两行，
  // 上一个进程里"界面渲染失败"那条不会跟过来
  check(
    "重启后日志是新的（日志是运行现场，不落盘）",
    !restarted.pluginLogs.list(PLUGIN_ID).some((l) => l.message.includes("界面渲染失败")) &&
      restarted.pluginLogs.list(PLUGIN_ID).length === 2,
    JSON.stringify(restarted.pluginLogs.list(PLUGIN_ID).map((l) => l.message.slice(0, 24))),
  );

  // ---------- 3c) 卸载 ----------
  await controlPlaneOf(restarted).uninstall(PLUGIN_ID);
  check("卸载后插件列表里没有它", !restarted.plugins().some((p) => p.id === PLUGIN_ID));
  check("卸载后文件也没了", !io.files.has(PLUGIN_ID + "/manifest.json"));
  check("卸载后内置插件照常（9 个 ACTIVE）", restarted.plugins().filter((p) => p.source === "builtin" && p.state === "ACTIVE").length === 9, JSON.stringify(restarted.plugins().map((p) => p.id + ":" + p.state)));
  check("卸载时没有坏 disposer（disposerFailures = 0）", restarted.diagnostics().disposerFailures === 0);

  // ---------- 3d) 插件包的可移植：导出 → 粘贴安装（不装授权） ----------
  {
    const io3 = memoryPluginIo();
    const rt3 = await makeRuntime(io3);
    const call3 = (name: string, args: unknown) =>
      rt3.tools.execute(name, args, { signal: new AbortController().signal, callId: "bundle-" + name });
    const ctl = controlPlaneOf(rt3);
    await call3("plugin_define", {
      pluginId: "ai.portable",
      name: "可移植插件",
      purpose: "导出/导入用的最小包。",
      main: "function apply(ctx) { ctx.log('便携包启动'); }",
      capabilities: ["log.write"],
    });
    const bundle = await ctl.exportBundle("ai.portable");
    check("导出的是可移植的 JSON 包", bundle.kind === "jingjing.plugin" && bundle.schema === 1 && bundle.id === "ai.portable", JSON.stringify(bundle).slice(0, 80));
    check("包里有 manifest 与 main", bundle.files.map((f) => f.path).sort().join(",") === "main.js,manifest.json", bundle.files.map((f) => f.path).join(","));
    check("包里**不带授权**（授权要接收方自己点）", JSON.stringify(bundle).includes("granted") === false);

    await rt3.pluginDev.undefine("ai.portable");
    check("卸载后本地没有这个包了", rt3.pluginDev.packagesOf("ai.portable").length === 0);

    const imported = await ctl.importBundle(JSON.stringify(bundle));
    check("粘贴安装：define + run 都跑了", imported.run.state === "PENDING_PERMISSION" && imported.run.pluginId === "ai.portable", JSON.stringify(imported.run));
    check("装回来的包在内存里（等授权）", rt3.pluginDev.packagesOf("ai.portable").length === 1);

    let badBundle = "";
    try {
      await ctl.importBundle('{"kind":"something-else"}');
    } catch (e) {
      badBundle = String(e instanceof Error ? e.message : e);
    }
    check("不是插件包的 JSON 被拒且说清要什么", badBundle.includes("jingjing.plugin"), badBundle.slice(0, 60));
    let brokenJson = "";
    try {
      await ctl.importBundle("{ 这不是 json }");
    } catch (e) {
      brokenJson = String(e instanceof Error ? e.message : e);
    }
    check("坏 JSON 被拒", brokenJson.includes("JSON"), brokenJson.slice(0, 40));
    await rt3.pluginDev.undefine("ai.portable");
    await rt3.dispose();
  }

  // ---------- 4) 面板 ----------
  const settingsSlot = restarted.slots.of("settings.section");
  const cells = settingsSlot?.cells ?? [];
  const owners = cells.map((c) => c.winner?.owner);
  check("设置里有「插件管理」与「插件日志」两块（各占一格，互不干扰）", owners.includes("app.aireader.plugin-settings") && owners.includes("app.aireader.plugin-logs"), JSON.stringify(owners));
  const Panel = cells.find((c) => c.winner?.owner === "app.aireader.plugin-logs")?.winner?.component as (p: Record<string, unknown>) => unknown;
  restarted.pluginLogs.clear();
  const emptyHtml = renderToStaticMarkup(createElement(Panel as never, {}));
  check("还没有日志时面板给出「日志从哪来」的提示", emptyHtml.includes("ctx.log") && emptyHtml.includes("保留 0 条"), emptyHtml.slice(0, 200));

  // 造几条真的日志：再定义一个会写日志的小插件
  const callR = (name: string, args: unknown) =>
    restarted.tools.execute(name, args, { signal: new AbortController().signal, callId: "panel-" + name });
  await callR("plugin_define", {
    pluginId: "ai.panel-logger",
    name: "面板测试插件",
    purpose: "往日志里写两行，验证面板会显示它们。",
    main: "function apply(ctx) { ctx.log('面板里应当出现这一行'); ctx.log({ 结构化: 1 }); }",
    capabilities: ["log.write"],
  });
  await callR("plugin_run", { pluginId: "ai.panel-logger" });
  await restarted.permissions.grant("ai.panel-logger", "1.0.0", ["log.write"], "always");
  const deadline2 = Date.now() + 4000;
  for (;;) {
    await restarted.container.settle();
    const s = restarted.plugins().find((p) => p.id === "ai.panel-logger");
    if (s?.state === "ACTIVE" || Date.now() > deadline2) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const html = renderToStaticMarkup(createElement(Panel as never, {}));
  check("面板把插件写的日志显示出来了", html.includes("面板里应当出现这一行"), html.slice(0, 300));
  check("面板用插件名而不是 id 显示来源", html.includes("面板测试插件"), html.slice(0, 300));
  const kept = restarted.pluginLogs.stats().kept;
  check(
    "面板显示保留条数与过滤控件",
    // 上一步清过一次，所以这里只剩刚定义的 ai.panel-logger 写的那两行
    kept === 2 && html.includes("保留 " + kept + " 条") && html.includes("只看警告/错误") && html.includes("清空"),
    kept + " / " + html.slice(0, 200),
  );
  check("结构化参数会被序列化后再写日志（不会变成 [object Object]）", html.includes("结构化"), html.slice(0, 400));

  // 面板上的"清掉这个插件的日志"（清空按钮走的是同一条服务调用）
  // 造一条"别的插件"的日志，验证 clear(pluginId) 不会波及别人
  await callR("plugin_define", {
    pluginId: "ai.other-logger",
    name: "另一个插件",
    purpose: "只写一行日志，用来验证按插件清空是精确的。",
    main: "function apply(ctx) { ctx.log('别人家的日志'); }",
    capabilities: ["log.write"],
  });
  await callR("plugin_run", { pluginId: "ai.other-logger" });
  await restarted.permissions.grant("ai.other-logger", "1.0.0", ["log.write"], "always");
  const deadline3 = Date.now() + 4000;
  for (;;) {
    await restarted.container.settle();
    const s = restarted.plugins().find((p) => p.id === "ai.other-logger");
    if (s?.state === "ACTIVE" || Date.now() > deadline3) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  check(
    "clear(pluginId) 只清这一个插件（另一个插件的日志还在）",
    restarted.pluginLogs.clear("ai.panel-logger") === 2 &&
      restarted.pluginLogs.list("ai.panel-logger").length === 0 &&
      restarted.pluginLogs.list("ai.other-logger").length === 1,
    JSON.stringify(restarted.pluginLogs.list().map((l) => l.pluginId)),
  );
  restarted.pluginLogs.clear();
  check("全部清空之后面板回到空态", renderToStaticMarkup(createElement(Panel as never, {})).includes("保留 0 条"));

  // 插件管理面板：动态包上应当出现「保留到插件目录」
  const Manager = cells.find((c) => c.winner?.owner === "app.aireader.plugin-settings")?.winner?.component as (p: Record<string, unknown>) => unknown;
  const managerHtml = renderToStaticMarkup(createElement(Manager as never, {}));
  check("动态包那一行有「保留到插件目录」按钮（安装是用户的动作）", managerHtml.includes("保留到插件目录"), managerHtml.slice(0, 200));
  const totalPlugins = restarted.plugins().length;
  check(
    "管理面板顶部报出插件总数与运行数",
    managerHtml.includes(totalPlugins + " 个插件 · 运行中 " + totalPlugins),
    totalPlugins + " / " + managerHtml.slice(0, 160),
  );

  await restarted.pluginDev.undefine("ai.panel-logger");
  await restarted.pluginDev.undefine("ai.other-logger");
  await restarted.dispose();
}

console.log("P3.5 插件日志与落盘契约测试：" + pass + " 通过 / " + failures.length + " 失败");
if (failures.length) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("  ✓ 全部通过（日志缓冲与上限 / ctx.log 与渲染失败进日志 / diagnose 带日志 / 落盘与重启后仍在 / 卸载 / 面板）");
