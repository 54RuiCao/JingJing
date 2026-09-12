/**
 * P3.4 契约测试：AI 写插件闭环（inspect / define / run / diagnose）+ 动态包的 UI 桥。
 *
 * 对应 内部设计笔记 §5.1 的验收：
 *   「让 AI 写一个"显示当前章节剩余页数"的小组件并成功运行，再故意失败一次并修好」
 *
 * 四块：
 *   1. 不可变包定义注册表（校验 / 语法预检只编译不执行 / 版本不可变 / 幂等 / id 冲突）
 *   2. 虚拟插件目录（define 不改运行态；版本指针决定加载器看到哪一版）
 *   3. UI 桥（quickjs 里注册 → 宿主渲染器 → **真的用 react-dom/server 渲出 HTML**；事件回调桥）
 *   4. 闭环（走真实 app runtime：define → run → 等授权 → 授权后自动 ACTIVE → 渲染 → 故意失败 → 诊断 → 修好）
 *
 * 跑法：npm test（第 7 套）或
 *   cd app && npx esbuild ../tools/plugin-ai-test.ts --bundle --platform=node --format=esm \
 *     --external:react --external:react/jsx-runtime --external:react-dom/server \
 *     --external:@jitl/* --external:quickjs-emscripten-core \
 *     --outfile=node_modules/.cache/aireader-tests/plugin-ai-test.mjs
 *   node node_modules/.cache/aireader-tests/plugin-ai-test.mjs
 */

import { createElement } from "react";
import { setLangPref } from "../app/src/i18n";

// 断言写的是中文默认文案：把界面语言钉死，别受开发机系统语言影响
setLangPref("zh");
import { renderToStaticMarkup } from "react-dom/server";
import { createAppRuntime } from "../app/src/core/app/runtime";
import { createContainer, contextBoundService } from "../app/src/core/service/index";
import { SlotCore, SlotView, createSlotsService } from "../app/src/ui/slots/index";
import type { SlotsService } from "../app/src/ui/slots/index";
import { PermissionBroker, createMemoryPermissionStore } from "../app/src/core/plugin/permissions";
import { PluginDefinitionRegistry, checkSyntax } from "../app/src/core/plugin/definitions";
import { createDynamicPluginFs, dynamicDirOf, isDynamicDir } from "../app/src/core/plugin/dynamicFs";
import { QuickJsRuntime, createDynamicPlugin } from "../app/src/core/plugin/runtime-quickjs";
import { createMemoryPluginFs } from "../app/src/core/app/pluginFs";
import { createDynamicSlotComponent, validateVdom, VdomError } from "../app/src/ui/dynamic/vdom";
import { ToolRegistry } from "../app/src/ai/tools/registry";
import { createPluginTools } from "../app/src/ai/tools/plugin";
import type { ToolHost } from "../app/src/ai/tools/host";
import type { DynamicUiBridge } from "../app/src/core/plugin/runtime-quickjs";
import type { CapabilityId } from "../app/src/core/plugin/manifest";
import type { Context } from "../app/src/core/service/index";

// ToolRegistry.execute 的超时用了 window.setTimeout；node 下补一个最小 Window 形状
(globalThis as any).window = globalThis;

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) pass++;
  else failures.push(name + (detail ? " —— " + detail : ""));
}

// ---------- 公共素材 ----------

/** 一个"只声明 ui.slot"的最小插件：宿主半是空的，UI 半才是本体 */
const UI_ONLY_MAIN = [
  "// 纯 UI 半的包：宿主半什么都不做（DSH 的「至少一半代码」）",
  "function apply(ctx) {",
  "  ctx.log('宿主半启动');",
  "}",
].join("\n");

const LEFT_PAGES_UI = [
  "function apply(ctx) {",
  "  ctx.slots.register(",
  "    { slot: 'reader.view.tail', id: 'left-pages', order: 5, label: '本章剩余页数' },",
  "    function (props, ui) {",
  "      var p = ctx.reader.progress() || {};",
  "      var start = p.sectionStartFraction === undefined ? 0 : p.sectionStartFraction;",
  "      var end = p.sectionEndFraction === undefined ? 1 : p.sectionEndFraction;",
  "      var span = Math.max(0.000001, end - start);",
  "      var inChapter = p.sectionFraction === undefined ? 0 : p.sectionFraction;",
  "      var totalLoc = (p.locations && p.locations.total) || 100;",
  "      var pages = Math.max(1, Math.round(span * totalLoc));",
  "      var left = Math.max(0, Math.round(pages * (1 - inChapter)));",
  "      return {",
  "        type: 'div',",
  "        props: { className: 'air-slot-tail' },",
  "        children: [",
  "          { type: 'span', props: {}, children: ['本章约剩 ' + left + ' 页 / 共 ' + pages + ' 页'] },",
  "          { type: 'button', props: { className: 'air-slot-tail-btn', onClick: ui.handler(function () { count = count + 1; ctx.slots.refresh(); }) }, children: ['记一次'] },",
  "        ],",
  "      };",
  "    },",
  "  );",
  "}",
  "var count = 0;",
].join("\n");

const uiPackage = (over: Record<string, unknown> = {}) => ({
  pluginId: "ai.left-pages",
  name: "本章剩余页数",
  purpose: "在阅读区尾部显示当前章节还剩多少页。",
  main: UI_ONLY_MAIN,
  ui: LEFT_PAGES_UI,
  capabilities: ["reader.read", "ui.slot", "log.write"],
  ...over,
});

// ---------- 1) 不可变包定义注册表 ----------

{
  const reg = new PluginDefinitionRegistry();
  const first = reg.define(uiPackage());
  check("合法定义铸出包", first.ok, first.ok ? "" : JSON.stringify(first.issues));
  if (first.ok) {
    check("packageId = pluginId@version#hash8", /^ai\.left-pages@1\.0\.0#[0-9a-f]{8}$/.test(first.package.packageId), first.package.packageId);
    check("包里有 manifest.json / main.js / ui.js", first.package.files.map((f) => f.path).join(",") === "manifest.json,main.js,ui.js", first.package.files.map((f) => f.path).join(","));
    check("生成的 manifest 是我们自己校验得过的", JSON.parse(first.package.files[0].content).apiVersion === "aireader-plugin-1");
    check("生成的 manifest **不写 hash**（写了的话 readPackage 把它自己算进哈希，永远对不上）", !("hash" in JSON.parse(first.package.files[0].content)));
  }
  check("define 不改变运行态（没有版本指针）", reg.currentOf("ai.left-pages") === undefined);

  const same = reg.define(uiPackage());
  check("同内容重复定义是幂等的（不重铸）", same.ok && !same.created && same.package.packageId === (first.ok ? first.package.packageId : ""));

  const changed = reg.define(uiPackage({ ui: LEFT_PAGES_UI + "\n// 改了一个字节", version: "1.0.0" }));
  check("同版本换内容被拒（包不可变）", !changed.ok && changed.issues[0].field === "version", JSON.stringify(changed.ok ? {} : changed.issues));
  const bumped = reg.define(uiPackage({ ui: LEFT_PAGES_UI + "\n// 改了一个字节", version: "1.0.1" }));
  check("换版本号就能追加新包", bumped.ok && bumped.created, bumped.ok ? "" : JSON.stringify(bumped.issues));
  check("追加而不是覆盖：两个包都在", reg.packagesOf("ai.left-pages").length === 2);

  const auto = reg.define(uiPackage({ ui: LEFT_PAGES_UI + "\n// 再改一次" }));
  check("不给 version 就自动 +1（1.0.2）", auto.ok && auto.package.version === "1.0.2", auto.ok ? auto.package.version : JSON.stringify(auto.issues));

  const bad = reg.define({ pluginId: "Bad_ID", name: "", purpose: "", main: "" } as never);
  const fields = bad.ok ? [] : bad.issues.map((i) => i.field);
  check("字段问题一次报全部（pluginId/name/purpose/main）", !bad.ok && ["pluginId", "name", "purpose", "main"].every((f) => fields.includes(f)), fields.join(","));

  const syntax = reg.define(uiPackage({ main: "function apply(ctx) { 这不是 JS }", version: "9.9.9" }));
  check("语法预检拦下编译不过的 main", !syntax.ok && syntax.issues.some((i) => i.field === "syntax"), JSON.stringify(syntax.ok ? {} : syntax.issues));
  check("语法预检只编译不执行", checkSyntax("globalThis.__aireaderSyntaxProbe = 1", "t").ok && (globalThis as any).__aireaderSyntaxProbe === undefined);

  const badCap = reg.define(uiPackage({ capabilities: ["reader.read", "fs.delete_everything"], version: "9.9.8" }));
  check("不认识的能力被拒", !badCap.ok && badCap.issues.some((i) => i.field === "capabilities"), JSON.stringify(badCap.ok ? {} : badCap.issues));

  const badConfig = reg.define(uiPackage({ config: { type: "string" }, version: "9.9.7" }));
  check("config 必须是 object schema", !badConfig.ok && badConfig.issues[0].field === "config");

  const taken = new PluginDefinitionRegistry({ isIdTaken: (id) => id === "ai.left-pages" });
  const clash = taken.define(uiPackage());
  check("与已有 id 冲突被拒（内置/磁盘包不会被 AI 顶掉）", !clash.ok && clash.issues[0].field === "pluginId", JSON.stringify(clash.ok ? {} : clash.issues));

  const onlyUi = reg.define(uiPackage({ pluginId: "ai.ui-only", main: "", version: "1.0.0" }));
  check("只有 UI 半的包也能定义（两半至少一个）", onlyUi.ok, onlyUi.ok ? "" : JSON.stringify(onlyUi.issues));
  check("纯 UI 半的 manifest 不写 main（写了就会指向不存在的文件）", onlyUi.ok && !("main" in JSON.parse(onlyUi.package.files[0].content)), onlyUi.ok ? onlyUi.package.files[0].content : "");
  const empty = reg.define(uiPackage({ pluginId: "ai.empty", main: "", ui: "", version: "1.0.0" }));
  check("两半都没有被拒", !empty.ok && empty.issues.some((i) => i.field === "main"), JSON.stringify(empty.ok ? {} : empty.issues));

  // 版本指针
  if (bumped.ok) check("setCurrent 指向旧包 = 回滚的前提", reg.setCurrent("ai.left-pages", bumped.package.packageId) && reg.currentOf("ai.left-pages")?.packageId === bumped.package.packageId);
  check("setCurrent 拒绝不存在的包", !reg.setCurrent("ai.left-pages", "ai.left-pages@9.9.9#deadbeef"));
  check("remove 之后包全没了", reg.remove("ai.left-pages") && reg.packagesOf("ai.left-pages").length === 0 && reg.currentOf("ai.left-pages") === undefined);
}

// ---------- 2) 虚拟插件目录（接进 P3.1 的加载器路径） ----------

{
  const reg = new PluginDefinitionRegistry();
  const disk = createMemoryPluginFs({
    "com.example.disk/manifest.json": JSON.stringify({
      id: "com.example.disk",
      name: "磁盘上的包",
      purpose: "证明叠加层不影响磁盘上的包",
      version: "1.0.0",
      apiVersion: "aireader-plugin-1",
    }),
  });
  const fs = createDynamicPluginFs(disk, reg);
  const defined = reg.define(uiPackage());
  const before = await fs.scan();
  check("只有 define、还没 run：虚拟目录里没有它（define 不改运行态）", before.map((d) => d.relDir).join(",") === "com.example.disk", before.map((d) => d.relDir).join(","));
  check("磁盘上的包照常可见", before.some((d) => d.relDir === "com.example.disk"));

  if (defined.ok) reg.setCurrent("ai.left-pages", defined.package.packageId);
  const after = await fs.scan();
  check("run（= 移动版本指针）之后才进目录", after.some((d) => d.relDir === "ai.left-pages"), after.map((d) => d.relDir).join(","));
  check("虚拟目录的 absDir 带 aireader://dynamic 前缀", isDynamicDir(dynamicDirOf("ai.left-pages")) && after.find((d) => d.relDir === "ai.left-pages")?.absDir === "aireader://dynamic/ai.left-pages");
  const uiText = await fs.read("ai.left-pages/ui.js");
  check("能读出 UI 半的源码", uiText.includes("ctx.slots.register"));
  const manifestText = await fs.read("ai.left-pages/manifest.json");
  check("读出的 manifest 里 ui.entry 指向 ui.js", JSON.parse(manifestText).ui.entry === "ui.js", manifestText);
  check("磁盘文件仍然走底层 fs", (await fs.read("com.example.disk/manifest.json")).includes("磁盘上的包"));
}

// ---------- 3) UI 桥：quickjs 里注册 → 宿主渲染 → 真的渲出 HTML ----------

function fakeReader(): ToolHost {
  return {
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
  };
}

type BridgeHarness = {
  container: ReturnType<typeof createContainer>;
  runtime: QuickJsRuntime;
  broker: PermissionBroker;
  bridges: Map<string, DynamicUiBridge>;
  slotCore: SlotCore;
  slots: SlotsService;
  dispose(): Promise<void>;
};

async function makeUiHarness(pluginId: string, version: string, granted: CapabilityId[]): Promise<BridgeHarness> {
  const store = createMemoryPermissionStore(
    granted.map((capability) => ({ pluginId, version, capability, state: "granted" as const, at: Date.now() })),
  );
  const broker = new PermissionBroker({ store, log: () => {} });
  await broker.ready();
  const container = createContainer({ log: () => {} });
  const slotCore = new SlotCore();
  container.ctx.provide("slots", contextBoundService<SlotsService>((c) => createSlotsService(slotCore, c)));
  const bridges = new Map<string, DynamicUiBridge>();
  const runtime = await QuickJsRuntime.create({
    permissions: broker,
    services: {
      reader: () => fakeReader(),
      storage: {
        get: async () => undefined,
        set: async () => {},
        remove: async () => {},
        keys: async () => [],
      },
      // 宿主侧工厂：真组件 + 记下桥，好让测试直接驱动 render/invoke
      ui: {
        createComponent: (bridge) => {
          bridges.set(bridge.pluginId + ":" + bridges.size, bridge);
          return createDynamicSlotComponent(bridge);
        },
      },
    },
    budgetMs: 3000,
  });
  const slots = container.ctx.get<SlotsService>("slots") as SlotsService;
  return {
    container,
    runtime,
    broker,
    bridges,
    slotCore,
    slots,
    async dispose() {
      await runtime.dispose();
      await container.dispose();
    },
  };
}

{
  const h = await makeUiHarness("ai.left-pages", "1.0.0", ["reader.read", "ui.slot"]);
  h.slots.declare("reader.view.tail", { kind: "list", scope: "book", replaceRisk: "none", wired: true });
  const factory = createDynamicPlugin({
    runtime: async () => h.runtime,
    spec: { pluginId: "ai.left-pages", version: "1.0.0", capabilities: ["reader.read", "ui.slot"] },
    readCode: async () => UI_ONLY_MAIN,
    readUiCode: async () => LEFT_PAGES_UI,
  });
  const fiber = h.container.ctx.plugin({ name: "ai.left-pages", apply: factory.apply }, {});
  await fiber.ready;
  await h.container.settle();
  check("两半都跑完，fiber ACTIVE", fiber.state === "ACTIVE", String(fiber.error ?? fiber.state));
  check("插件注册的界面进了插槽（owner 是插件 fiber）", h.slots.of("reader.view.tail")?.cells[0]?.winner?.owner === "ai.left-pages", JSON.stringify(h.slots.of("reader.view.tail")?.cells.map((c) => c.winner?.owner)));
  const bridge = [...h.bridges.values()][0];
  check("宿主工厂拿到了桥", Boolean(bridge));

  const raw = bridge.render({});
  check("render 同步返回声明式 VDOM（JSON）", raw.startsWith("{") && raw.includes("本章约剩"), raw.slice(0, 80));
  const parsed = JSON.parse(raw) as { type: string; children: { type: string; children: string[] }[] };
  check("插件自己算出了剩余页数（span 0.2 × 1000 位 = 200 页，读了一半 → 剩 100）", parsed.children[0].children[0] === "本章约剩 100 页 / 共 200 页", parsed.children[0].children[0]);
  check("事件写成了 ui.handler 的令牌（不是函数）", typeof (parsed.children[1] as { props: { onClick: unknown } }).props.onClick === "string", JSON.stringify(parsed.children[1]));

  // 真渲染：桥 + 校验器 + React
  const Comp = createDynamicSlotComponent(bridge);
  const html = renderToStaticMarkup(createElement(Comp, {}));
  check("真的用 React 渲出了 HTML", html.includes("本章约剩 100 页"), html);
  check("事件的令牌被换成了 React 的 onClick", html.includes("<button"), html);

  // 事件回调桥：直接调令牌（renderToStaticMarkup 点不了按钮，令牌等价于点击）
  const token = (parsed.children[1] as { props: { onClick: string } }).props.onClick;
  const before = bridge.version();
  bridge.invoke(token);
  check("事件令牌调回了插件里的回调", bridge.version() > before, bridge.version() + " vs " + before);

  // 能力门禁：撤销 ui.slot 之后立刻不能渲染
  await h.broker.revoke("ai.left-pages", "ui.slot");
  let blocked = "";
  try {
    bridge.render({});
  } catch (e) {
    blocked = String(e instanceof Error ? e.message : e);
  }
  check("撤销 ui.slot 后渲染立刻被拒（结构性，不是补丁）", blocked.includes("ui.slot"), blocked);

  // chain 槽位：select 是函数，过不了 JSON，走的是和 render 一样的同步回调桥
  {
    const chainCore = new SlotCore();
    chainCore.declare("chain.card", { kind: "chain", scope: "session", replaceRisk: "none", wired: true });
    const container = createContainer({ log: () => {} });
    container.ctx.provide("slots", contextBoundService<SlotsService>((c) => createSlotsService(chainCore, c)));
    const chainSlots = container.ctx.get<SlotsService>("slots") as SlotsService;
    const bridges2 = new Map<string, DynamicUiBridge>();
    const broker2 = new PermissionBroker({
      store: createMemoryPermissionStore([
        { pluginId: "ai.chain", version: "1.0.0", capability: "ui.slot", state: "granted", at: Date.now(), mode: "always" },
      ]),
      log: () => {},
    });
    await broker2.ready();
    const runtime2 = await QuickJsRuntime.create({
      permissions: broker2,
      services: {
        reader: () => fakeReader(),
        storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, keys: async () => [] },
        ui: {
          createComponent: (bridge) => {
            bridges2.set("b", bridge);
            return createDynamicSlotComponent(bridge);
          },
        },
      },
    });
    const CHAIN_UI = [
      "function apply(ctx) {",
      "  ctx.slots.register({",
      "    slot: 'chain.card',",
      "    select: function (props) { return props && props.kind === 'y' ? { from: 'chain' } : null; },",
      "  }, function (props) {",
      "    return { type: 'span', props: {}, children: ['取了：' + JSON.stringify(props.matched)] };",
      "  });",
      "}",
    ].join("\n");
    const synth = createDynamicPlugin({
      runtime: async () => runtime2,
      spec: { pluginId: "ai.chain", version: "1.0.0", capabilities: ["ui.slot"] },
      readCode: async () => "",
      readUiCode: async () => CHAIN_UI,
    });
    const fiber2 = container.ctx.plugin({ name: "ai.chain", apply: synth.apply }, {});
    await fiber2.ready;
    await container.settle();
    check("动态包能往 chain 槽位注册（select 走同步回调桥）", chainCore.of("chain.card")?.cells.flatMap((c) => c.entries).length === 1, JSON.stringify(chainCore.of("chain.card")?.cells.length));
    const entry2 = chainCore.of("chain.card")!.cells[0].entries[0];
    // select 在渲染时被调用：不匹配 → null（弃权），匹配 → 返回跨 realm 传回来的对象
    check("select 不匹配时弃权", entry2.select!({ kind: "x" }) === null, JSON.stringify(entry2.select!({ kind: "x" })));
    check("select 匹配时把值带回宿主", JSON.stringify(entry2.select!({ kind: "y" })) === JSON.stringify({ from: "chain" }), JSON.stringify(entry2.select!({ kind: "y" })));
    const chainHtml = renderToStaticMarkup(createElement(SlotView, { slots: chainSlots, name: "chain.card", hostProps: { kind: "y" } }));
    check("chain 选举后渲染出插件交的界面", chainHtml.includes("取了：") && chainHtml.includes("chain"), chainHtml.slice(0, 120));
    check("没人接手时用 fallback", renderToStaticMarkup(createElement(SlotView, { slots: chainSlots, name: "chain.card", hostProps: { kind: "x" }, fallback: "默认卡" })) === "默认卡");
    await fiber2.dispose();
    await container.dispose();
    await runtime2.dispose();
  }

  // 校验器：白名单外的标签/属性/异步 render
  let vdomError = "";
  try {
    validateVdom({ type: "script", props: {}, children: [] });
  } catch (e) {
    vdomError = e instanceof VdomError ? e.message : String(e);
  }
  check("白名单外的标签被拒且提示可用标签", vdomError.includes("script") && vdomError.includes("div"), vdomError);
  let propError = "";
  try {
    validateVdom({ type: "div", props: { dangerouslySetInnerHTML: { __html: "<b>x</b>" } }, children: [] });
  } catch (e) {
    propError = e instanceof VdomError ? e.message : String(e);
  }
  check("白名单外的属性被拒", propError.includes("dangerouslySetInnerHTML"), propError);
  let depthError = "";
  const deep = (n: number): unknown => (n === 0 ? { type: "span", props: {}, children: ["x"] } : { type: "div", props: {}, children: [deep(n - 1)] });
  try {
    validateVdom(deep(40));
  } catch (e) {
    depthError = e instanceof VdomError ? e.message : String(e);
  }
  check("过深的树被拒（深度上限）", depthError.includes("嵌套太深"), depthError);

  await fiber.dispose();
  const afterUnload = h.slotCore.catalog().find((s) => s.name === "reader.view.tail");
  check("卸载后插槽里的这块 UI 也消失（账本归零）", afterUnload?.registrationCount === 0, JSON.stringify(afterUnload));
  check("卸载后没有残留 effect", fiber.pendingEffects() === 0, String(fiber.pendingEffects()));
  await h.dispose();
}

// ---------- 4) 闭环：走真实 app runtime（define → run → 授权 → 渲染 → 故意失败 → 诊断 → 修好） ----------

{
  const logs: string[] = [];
  const settings = new Map<string, unknown>();
  const runtime = createAppRuntime({
    reader: fakeReader(),
    skills: {
      registry: { candidates: () => [], modelInvocable: () => [], get: async () => undefined },
      refresh: async () => ({ userSkills: 0, total: 0, digest: "" }),
      write: async () => "",
      readResource: async () => ({ ok: false as const, error: "no" }),
      remove: async () => {},
      dir: async () => "",
      warnings: () => [],
      entries: () => [],
    } as never,
    db: {
      listAnnotations: async () => [],
      addAnnotation: async () => {
        throw new Error("测试里不写库");
      },
      searchBook: async () => [],
      getSetting: async <T,>(k: string, f: T) => (settings.has(k) ? (settings.get(k) as T) : f),
      setSetting: async (k, v) => {
        settings.set(k, v);
      },
    },
    theme: { current: () => "light" as never, set: () => {}, list: () => [] },
    paths: { skillsDir: () => "X:/skills", pluginsDir: () => "X:/plugins" },
    log: (level, message) => logs.push(level + ":" + message),
  });
  await runtime.mount();
  const dev = runtime.pluginDev;
  const call = (name: string, args: unknown) => runtime.tools.execute(name, args, { signal: new AbortController().signal, callId: "t" });

  // — inspect —
  const inspected = await call("plugin_inspect", { query: "slots" });
  const slotsValue = inspected.outcome.ok ? (inspected.outcome.value as { slots: { name: string; wired: boolean }[] }) : { slots: [] };
  check("plugin_inspect 能列出插槽目录", inspected.outcome.ok && slotsValue.slots.some((s) => s.name === "reader.view.tail" && s.wired), JSON.stringify(slotsValue.slots?.map((s) => s.name)));
  const apiValue = await call("plugin_inspect", { query: "api" });
  check("plugin_inspect 的 api 查询给出 ctx 面与能力对照", apiValue.outcome.ok && JSON.stringify(apiValue.outcome.value).includes("ctx.slots.register"));
  const capValue = await call("plugin_inspect", { query: "capabilities" });
  check("ui.slot 现在是「宿主已接门面」的能力", JSON.stringify(capValue.outcome.value).includes('"ui.slot"'));

  // — define —
  const defined = await call("plugin_define", uiPackage());
  check("plugin_define 铸出包", defined.outcome.ok, JSON.stringify(defined.outcome));
  const packageId = defined.outcome.ok ? (defined.outcome.value as { packageId: string }).packageId : "";

  // — run：第一次必然停在等授权 —
  const firstRun = await call("plugin_run", { pluginId: "ai.left-pages" });
  const firstState = firstRun.outcome.ok ? (firstRun.outcome.value as { state: string; missing: string[]; awaitingApproval: boolean }) : { state: "?", missing: [], awaitingApproval: false };
  check("run 之后停在 awaiting-approval（缺 ui.slot / reader.read）", firstRun.outcome.ok && firstState.state === "PENDING_PERMISSION" && firstState.awaitingApproval, JSON.stringify(firstState));
  check("回执说清缺哪些能力", firstState.missing.includes("ui.slot") && firstState.missing.includes("reader.read"), JSON.stringify(firstState.missing));

  // — 人批准（设置面板的那条路径）→ 自动挂起来 —
  // 授权绑定 (pluginId, version, capability)：这里先按"单勾"（once）授给 1.0.0
  await runtime.permissions.grant("ai.left-pages", "1.0.0", ["reader.read", "ui.slot", "log.write"], "once");
  const waitState = async (want: string, ms = 4000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      await runtime.container.settle();
      const status = runtime.plugins().find((p) => p.id === "ai.left-pages");
      if (status?.state === want || Date.now() > deadline) return status;
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const afterGrant = await waitState("ACTIVE");
  check("授权后**自动**变成 ACTIVE（不用再 run 一次）", afterGrant?.state === "ACTIVE", JSON.stringify(afterGrant));
  check("贡献里有它挂的那块界面", (afterGrant?.contributions ?? []).some((c) => c.startsWith("dynamic-ui:reader.view.tail")), JSON.stringify(afterGrant?.contributions));

  // — 界面真的渲染出来了 —
  const html = renderToStaticMarkup(createElement(SlotView, { slots: runtime.slots, name: "reader.view.tail" }));
  check("动态包的小组件在阅读区尾部渲出了 HTML", html.includes("本章约剩 100 页"), html.slice(0, 300));
  const cells = runtime.slots.of("reader.view.tail")?.cells ?? [];
  const owners = cells.map((c) => c.winner?.owner);
  check("它和内置的尾部状态条共存（各占一个格子，不是替换）", cells.length >= 2 && owners.includes("ai.left-pages") && owners.includes("app.aireader.reader-tail"), JSON.stringify(owners));

  // — 故意失败：新版本让 apply 抛错 —
  const broken = await call("plugin_define", uiPackage({ version: "1.1.0", main: "function apply(ctx) { throw new Error('故意炸的'); }" }));
  check("定义一版会炸的包", broken.outcome.ok, JSON.stringify(broken.outcome));
  const brokenGate = await call("plugin_run", { pluginId: "ai.left-pages" });
  const gateState = brokenGate.outcome.ok ? (brokenGate.outcome.value as { state: string; version: string; missing: string[] }) : { state: "?", version: "", missing: [] };
  check(
    "单勾授权只覆盖 1.0.0：新版本 1.1.0 要重新点头（DSH 的 once/always 语义）",
    gateState.state === "PENDING_PERMISSION" && gateState.version === "1.1.0" && gateState.missing.includes("ui.slot"),
    JSON.stringify(gateState),
  );
  // 双勾（always）：覆盖这个插件后续所有版本
  await runtime.permissions.grant("ai.left-pages", "1.1.0", ["reader.read", "ui.slot", "log.write"], "always");
  const brokenStatus = await waitState("FAILED");
  check("apply 抛错 → FAILED（**不自动回滚**：旧版没被自动启回来）", brokenStatus?.state === "FAILED", JSON.stringify(brokenStatus));
  const brokenRun = await call("plugin_run", { pluginId: "ai.left-pages" });
  const brokenState = brokenRun.outcome.ok ? (brokenRun.outcome.value as { state: string; detail?: string; next: string }) : { state: "?", detail: "", next: "" };
  check("再 run 一次仍是 FAILED（失败不会被悄悄吞掉）", brokenState.state === "FAILED", JSON.stringify(brokenState));
  check("回执教了怎么修（追加新包 / 对旧包再 run）", brokenState.next.includes("追加一个新版本"), brokenState.next);

  // — diagnose：版本指针 + 源码 + 诊断 —
  const diag = await call("plugin_diagnose", { pluginId: "ai.left-pages" });
  const diagValue = diag.outcome.ok ? (diag.outcome.value as { state: string; packages: { packageId: string; isCurrent: boolean }[]; source: { files: { path: string; content: string }[] } | null; currentPackageId: string | null }) : null;
  check("diagnose 报告当前状态", diagValue?.state === "FAILED", JSON.stringify(diagValue?.state));
  check("diagnose 给出全部包与版本指针", (diagValue?.packages.length ?? 0) === 2 && diagValue?.packages.filter((p) => p.isCurrent).length === 1, JSON.stringify(diagValue?.packages));
  check("diagnose 说得出版本指针指向哪一版", (diagValue?.currentPackageId ?? "").startsWith("ai.left-pages@1.1.0#"), String(diagValue?.currentPackageId));
  check("diagnose 带出错那一版的源码（修 bug 要看的就是它）", (diagValue?.source?.files.find((f) => f.path === "main.js")?.content ?? "").includes("故意炸的"), JSON.stringify(diagValue?.source?.files.map((f) => f.path)));

  // — 修好：追加新版本再 run —
  const fixed = await call("plugin_define", uiPackage({ version: "1.2.0" }));
  const fixedRun = await call("plugin_run", { pluginId: "ai.left-pages" });
  const fixedState = fixedRun.outcome.ok ? (fixedRun.outcome.value as { state: string; version: string }) : { state: "?", version: "" };
  check("修好后 ACTIVE，版本是 1.2.0", fixed.outcome.ok && fixedState.state === "ACTIVE" && fixedState.version === "1.2.0", JSON.stringify(fixedState));
  check("旧包都还在（失败的那版没被覆盖）", dev.packagesOf("ai.left-pages").map((p) => p.version).join(",") === "1.0.0,1.1.0,1.2.0", dev.packagesOf("ai.left-pages").map((p) => p.version).join(","));

  // — 回滚：对旧的 packageId 再 run —
  const rollback = await call("plugin_run", { pluginId: "ai.left-pages", packageId });
  check("对旧 packageId 再 run = 回滚", rollback.outcome.ok && (rollback.outcome.value as { version: string }).version === "1.0.0", JSON.stringify(rollback.outcome));

  // — 工具层的错误路径 —
  const badArgs = await call("plugin_define", { pluginId: "x.y", name: "n", purpose: "p", main: "function apply(){ 这不是 js }" });
  check("语法错的代码在 define 阶段就被拦下（INVALID_ARGUMENTS）", !badArgs.outcome.ok && badArgs.outcome.error.code === "INVALID_ARGUMENTS", JSON.stringify(badArgs.outcome));
  const unknownRun = await call("plugin_run", { pluginId: "ai.never-defined" });
  check("run 未定义的插件报 NOT_FOUND 并提示先 inspect", !unknownRun.outcome.ok && unknownRun.outcome.error.code === "NOT_FOUND" && (unknownRun.outcome.error.hint ?? "").includes("plugin_inspect"), JSON.stringify(unknownRun.outcome));
  const notDefined = await call("plugin_diagnose", { pluginId: "ai.never-defined" });
  check("diagnose 未定义的插件回 NOT_DEFINED 而不是报错", notDefined.outcome.ok && (notDefined.outcome.value as { state: string }).state === "NOT_DEFINED", JSON.stringify(notDefined.outcome));

  // — 停 / 删 —
  await dev.stop("ai.left-pages");
  check("stop 之后插件不在跑，但定义与版本指针都还在", runtime.plugins().find((p) => p.id === "ai.left-pages")?.state !== "ACTIVE" && dev.currentPackageOf("ai.left-pages") !== undefined);
  const undef = await dev.undefine("ai.left-pages");
  check("undefine 删掉定义与全部包", undef.removedDefinitions === 3 && dev.packagesOf("ai.left-pages").length === 0);
  check("undefine 之后插件列表里没有它", !runtime.plugins().some((p) => p.id === "ai.left-pages"));
  check("内置插件不受影响（9 个照常在）", runtime.plugins().filter((p) => p.source === "builtin" && p.state === "ACTIVE").length === 9, JSON.stringify(runtime.plugins().map((p) => p.id + ":" + p.state)));
  check("disposerFailures = 0（没有坏 disposer 被吞）", runtime.diagnostics().disposerFailures === 0);

  await runtime.dispose();
}

// ---------- 5) 并发挂载：同一个 id 不许挂出两个 fiber ----------
// （P3.4 实测踩到：授权变化会自动挂一次，紧接着手动 remount 又来一次，
//   第二个 fiber 注册同名工具直接 "工具名重复" 而 FAILED）

{
  const { PluginLoader } = await import("../app/src/core/plugin/loader");
  const container = createContainer({ log: () => {} });
  const tools = new ToolRegistry();
  container.ctx.provide("tools", tools);
  const builtin = {
    manifest: {
      id: "test.slow-plugin",
      name: "慢插件",
      purpose: "第一次 apply 慢一点，用来暴露并发的双重挂载",
      version: "1.0.0",
      apiVersion: "aireader-plugin-1",
    },
    plugin: {
      name: "slow",
      inject: ["tools"],
      async apply(ctx: Context) {
        const reg = ctx.get<ToolRegistry>("tools");
        await new Promise((r) => setTimeout(r, 30));
        reg.register({
          name: "t_slow",
          description: "并发测试用",
          parameters: { type: "object", properties: {} },
          executionMode: "parallel-safe",
          execute: async () => ({ ok: true, value: null }),
        });
      },
    },
  };
  const loader = new PluginLoader(container.ctx, {
    builtins: [builtin as never],
    fs: createMemoryPluginFs({}),
    resolveImplementation: () => builtin.plugin as never,
  });
  await loader.mountAll();
  const entry = loader.entryOf("test.slow-plugin");
  const [a, b] = await Promise.all([loader.mountEntry(entry!), loader.mountEntry(entry!)]);
  check("并发 mountEntry 收敛到同一个结果", a.state === "ACTIVE" && b.state === "ACTIVE" && a.fiberUid === b.fiberUid, JSON.stringify([a.state, b.state, a.fiberUid, b.fiberUid]));
  check("工具只注册了一次（没有工具名重复）", tools.schemas().filter((s) => s.function.name === "t_slow").length === 1, tools.schemas().map((s) => s.function.name).join(","));
  check("两次调用只跑了一次 apply", a.state === "ACTIVE");
  await loader.dispose();
  await container.dispose();
}

// ---------- 6) 元数据自检 ----------

{
  const reg = new ToolRegistry();
  const defs = createPluginTools({
    dev: {} as never,
    slots: { catalog: () => [] } as never,
    tools: reg,
    plugins: () => [],
    implemented: () => [],
    container: () => ({ pendingEffects: 0, disposerFailures: 0, fibers: 0 }),
  });
  check("四个工具都在", defs.map((d) => d.name).join(",") === "plugin_inspect,plugin_define,plugin_run,plugin_diagnose", defs.map((d) => d.name).join(","));
  check("四个工具都声明了超时（不会无限挂）", defs.every((d) => typeof d.timeoutMs === "number" && d.timeoutMs > 0));
  check("define / run 是独占执行（改的是全局状态）", defs.find((d) => d.name === "plugin_define")?.executionMode === "exclusive" && defs.find((d) => d.name === "plugin_run")?.executionMode === "exclusive");
}

// ---------- 6b) run 的"回执自检"：刚挂上去就渲染失败要写进结果（P3.8） ----------
//
// 实测教训：模型报「1.1.0 已上线」，可界面因为 overflowX 不在 VDOM 白名单里被摘掉了 ——
// 它没查 diagnose，就不知道。让 run 自己等一小会儿看一眼，比教模型"记得查"可靠。
{
  const reg = new ToolRegistry();
  const stubDev = {
    async run() {
      await new Promise((r) => setTimeout(r, 10));
      return { state: "ACTIVE", contributions: ["dynamic-ui:library.view.top#heat"], missing: [], denied: [], detail: null };
    },
    async diagnose() {
      return {
        state: "ACTIVE",
        contributions: ["dynamic-ui:library.view.top#heat"],
        missing: [],
        denied: [],
        unimplemented: [],
        renderFailures: [{ slot: "library.view.top", message: "props.style.overflowX：不允许的样式属性", at: Date.now(), count: 1 }],
      };
    },
  };
  const defs = createPluginTools({
    dev: stubDev as never,
    slots: { catalog: () => [] } as never,
    tools: reg,
    plugins: () => [],
    implemented: () => [],
    container: () => ({ pendingEffects: 0, disposerFailures: 0, fibers: 0 }),
  });
  const runTool = defs.find((d) => d.name === "plugin_run")!;
  const res = await runTool.execute({ pluginId: "ai.heat" }, { signal: new AbortController().signal, callId: "c" } as never);
  const value = res.ok ? (res.value as { renderFailures?: unknown[]; next?: string }) : null;
  check("run 的回执里带上刚发生的渲染失败", value?.renderFailures?.length === 1, JSON.stringify(res).slice(0, 200));
  check("并在 next 里直接点破 + 给出改法", typeof value?.next === "string" && value.next.includes("界面渲染失败") && value.next.includes("plugin_inspect(query=ui)"), String(value?.next).slice(0, 160));

  // 没有渲染失败时不加这个字段（回执保持干净）
  const cleanDev = { ...stubDev, diagnose: async () => ({ ...(await stubDev.diagnose()), renderFailures: [] }) };
  const cleanTools = createPluginTools({
    dev: cleanDev as never,
    slots: { catalog: () => [] } as never,
    tools: reg,
    plugins: () => [],
    implemented: () => [],
    container: () => ({ pendingEffects: 0, disposerFailures: 0, fibers: 0 }),
  });
  const clean = await cleanTools.find((d) => d.name === "plugin_run")!.execute({ pluginId: "ai.ok" }, { signal: new AbortController().signal, callId: "c" } as never);
  check("没失败时不带 renderFailures 字段", clean.ok && !("renderFailures" in (clean.value as object)));
}

console.log("P3.4 AI 闭环契约测试：" + pass + " 通过 / " + failures.length + " 失败");
if (failures.length) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("  ✓ 全部通过（不可变包定义 / 虚拟插件目录 / UI 桥与真渲染 / 闭环 define-run-授权-诊断-修复-回滚 / 工具元数据）");
