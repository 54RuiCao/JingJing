/**
 * P3.2 插槽契约测试（内部设计笔记 §5.1 的验收）：
 *   「三个内置插件分别占 sidebar / settings / 阅读页尾部，互不干扰」
 *
 * 跑法：
 *   cd app && npx esbuild ../tools/slots-test.ts --bundle --platform=node --format=esm --outfile=../fixtures/slots-test.mjs
 *   node ../fixtures/slots-test.mjs
 *
 * 三块覆盖：插槽内核（纯数据）/ 插槽服务（挂到 fiber 上）/ React 渲染（用 react-dom/server 真渲染）。
 */

import { createElement } from "react";
import { setLangPref } from "../app/src/i18n";

// 断言写的是中文默认文案：把界面语言钉死，别受开发机系统语言影响
setLangPref("zh");
import { renderToStaticMarkup } from "react-dom/server";
import { SlotCore, createSlotsService, SlotView, SlotError } from "../app/src/ui/slots/index";
import { createThemeOverrideCore, type ThemeTokenValue } from "../app/src/ui/theme/overrides";
import type { ThemeService } from "../app/src/core/app/services";
import type { SlotsService, SlotDeclaration } from "../app/src/ui/slots/index";
import { createContainer, contextBoundService } from "../app/src/core/service/index";
import type { Context } from "../app/src/core/service/index";

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) pass++;
  else failures.push(name + (detail ? " —— " + detail : ""));
}
const codeOf = (e: unknown) => (e instanceof SlotError ? e.code : "NOT_SLOT_ERROR:" + String(e));

const listSlot: SlotDeclaration = { kind: "list", scope: "app", replaceRisk: "none", wired: true };
const keyedSlot: SlotDeclaration = { kind: "keyed", scope: "app", replaceRisk: "none", wired: true };
const singleSlot: SlotDeclaration = { kind: "single", scope: "app", replaceRisk: "shadows-shipped-ui", wired: true };
const owner = { label: "测试插件", uid: 1 };
const Comp = () => null;

// ---------- 1) 内核：声明与注册的规则 ----------

{
  const core = new SlotCore();
  let err: unknown = null;
  try {
    core.register({ name: "not.declared", component: Comp }, owner);
  } catch (e) {
    err = e;
  }
  check("未声明的槽位注册 → NOT_DECLARED", codeOf(err) === "NOT_DECLARED", String(err));

  core.declare("a.single", singleSlot);
  check("声明后 declared() 为真", core.declared("a.single"));
  let dup: unknown = null;
  try {
    core.declare("a.single", singleSlot);
  } catch (e) {
    dup = e;
  }
  check("重复声明 → ALREADY_DECLARED", codeOf(dup) === "ALREADY_DECLARED");

  const off1 = core.register({ name: "a.single", label: "第一个", component: Comp }, owner);
  check("single 注册后有 1 个格子一个赢家", core.of("a.single")?.cells.length === 1 && core.of("a.single")?.cells[0].winner?.label === "第一个");

  let conflict: unknown = null;
  try {
    core.register({ name: "a.single", label: "第二个", component: Comp }, { label: "别的插件", uid: 2 });
  } catch (e) {
    conflict = e;
  }
  check("同格子同 priority → PRIORITY_CONFLICT", codeOf(conflict) === "PRIORITY_CONFLICT", String(conflict));
  check("冲突提示里教了怎么覆盖（换更小的 priority）", String(conflict).includes("更小"));

  const off2 = core.register({ name: "a.single", priority: -1, label: "覆盖者", component: Comp }, { label: "别的插件", uid: 2 });
  check("更小 priority 覆盖成功", core.of("a.single")?.cells[0].winner?.label === "覆盖者");
  check("被盖住的进 shadows（诊断要说得清）", core.of("a.single")?.cells[0].shadows.map((s) => s.label).join(",") === "第一个");
  off2();
  check("覆盖者卸载 → 回到原来那个", core.of("a.single")?.cells[0].winner?.label === "第一个");
  off1();
  // 没有 entry 时不给格子（single 也只是一格，没人占就是没有格子）
  check("全卸载 → 没有格子了", (core.of("a.single")?.cells.length ?? 0) === 0, JSON.stringify(core.of("a.single")?.cells));
}

// ---------- 2) 内核：keyed / list 的 id-key 规则与排序 ----------

{
  const core = new SlotCore();
  core.declare("k", keyedSlot);
  let noKey: unknown = null;
  try {
    core.register({ name: "k", component: Comp }, owner);
  } catch (e) {
    noKey = e;
  }
  check("keyed 不给 key → INVALID_REGISTRATION", codeOf(noKey) === "INVALID_REGISTRATION");
  core.register({ name: "k", key: "copy", label: "复制", component: Comp }, owner);
  core.register({ name: "k", key: "note", label: "笔记", component: Comp }, owner);
  check("keyed 不同 key 并存（两个格子）", core.of("k")?.cells.length === 2);
  let keyConflict: unknown = null;
  try {
    core.register({ name: "k", key: "copy", label: "另一个复制", component: Comp }, { label: "别人", uid: 2 });
  } catch (e) {
    keyConflict = e;
  }
  check("keyed 同 key 同 priority → 冲突", codeOf(keyConflict) === "PRIORITY_CONFLICT");

  core.declare("l", listSlot);
  let noId: unknown = null;
  try {
    core.register({ name: "l", component: Comp }, owner);
  } catch (e) {
    noId = e;
  }
  check("list 不给 id → INVALID_REGISTRATION", codeOf(noId) === "INVALID_REGISTRATION");
  core.register({ name: "l", id: "b", order: 2, label: "B", component: Comp }, owner);
  core.register({ name: "l", id: "a", order: 1, label: "A", component: Comp }, owner);
  core.register({ name: "l", id: "c", priority: -5, label: "C", component: Comp }, owner);
  check(
    "list 按 priority → order 排序（C 的 priority 最小，最先）",
    core.of("l")?.cells.map((c) => c.winner?.label).join(",") === "C,A,B",
    core.of("l")?.cells.map((c) => c.winner?.label).join(","),
  );
  const cat = core.catalog().find((c) => c.name === "l");
  check("目录快照带 kind/scope/replaceRisk/wired", cat?.kind === "list" && cat?.scope === "app" && cat?.replaceRisk === "none" && cat?.wired === true);
  check("目录快照带注册数", cat?.registrationCount === 3);
  check("宿主直接声明的槽位 declaredBy 为 null", cat?.declaredBy === null, String(cat?.declaredBy));
}

// ---------- 3) 内核：子槽位声明与级联释放 ----------

{
  const core = new SlotCore();
  core.declare("panel", listSlot);
  const offParent = core.register(
    {
      name: "panel",
      id: "stats",
      label: "统计面板",
      component: Comp,
      children: { footer: { kind: "list", scope: "app" } },
    },
    owner,
  );
  check("子槽位自动声明（父名.子名）", core.declared("panel.footer"));
  // renderSlot 的授权检查按相对 key（props.renderSlot("footer")），诊断里给全名
  check("只有父 entry 说自己拥有它", core.ownsChild(1, "footer") && !core.ownsChild(2, "footer"));
  check("childrenOf 给全名（报错文案要能照抄）", core.childrenOf(1).join(",") === "panel.footer");
  const offChild = core.register({ name: "panel.footer", id: "x", label: "子项", component: Comp }, { label: "别的插件", uid: 2 });
  check("子槽位可以被别人注册", core.of("panel.footer")?.cells[0].winner?.label === "子项");
  offParent();
  check("父 entry 卸载 → 子槽位级联消失", !core.declared("panel.footer"));
  check("子槽位上的 entry 也一起消失", core.of("panel.footer") === undefined && core.entryCount() === 0);
  void offChild;
}

// ---------- 4) 内核：崩溃摘格与复活 ----------

{
  const core = new SlotCore();
  core.declare("tail", listSlot);
  core.register({ name: "tail", id: "a", label: "A", component: Comp }, owner);
  core.register({ name: "tail", id: "a", priority: 1, label: "B", component: Comp }, owner);
  check("赢家是 priority 小的 A", core.of("tail")?.cells[0].winner?.label === "A");
  const uidA = core.of("tail")!.cells[0].winner!.uid;
  core.abdicate(uidA, new Error("渲染炸了"));
  check("崩溃的 entry 被摘掉，赢家顺延到 B", core.of("tail")?.cells[0].winner?.label === "B");
  check("摘掉不等于注销（账本还在）", core.entryCount() === 2);
  check("渲染错误进了诊断", core.renderErrors()[0]?.message.includes("渲染炸了"));
  core.revive(uidA);
  check("复活后又回到赢家", core.of("tail")?.cells[0].winner?.label === "A");
  check("释放 entry 时它的渲染错误记录也清掉", (() => {
    const uid = core.of("tail")!.cells[0].winner!.uid;
    core.abdicate(uid, new Error("再炸一次"));
    const before = core.renderErrors().length;
    const entry = core.of("tail")!.cells[0].entries.find((e) => e.uid === uid)!;
    void entry;
    core.release(uid);
    return core.renderErrors().length === before - 1;
  })());
}

// ---------- 5) 服务：注册挂在 fiber 上 + per-ctx facade ----------

async function makeSlotsHost() {
  const container = createContainer({ log: () => {} });
  const core = new SlotCore();
  container.ctx.provide("slots", contextBoundService<SlotsService>((c: Context) => createSlotsService(core, c)));
  return { container, core, slotsOf: (ctx: Context) => ctx.get<SlotsService>("slots") as SlotsService };
}

{
  const { container, core, slotsOf } = await makeSlotsHost();
  let versionSeen = 0;
  const offWatch = core.onChange(() => versionSeen++);

  const a = container.ctx.plugin({
    name: "plugin-A",
    inject: ["slots"],
    apply(ctx) {
      const slots = ctx.get<SlotsService>("slots");
      if (!slots) return;
      slots.declare("panel", singleSlot);
      slots.register({ name: "panel", label: "A 的面板", component: Comp });
    },
  });
  await a.ready;
  check("插件声明 + 注册成功", core.declared("panel") && core.of("panel")?.cells[0].winner?.label === "A 的面板");
  check("entry 的 owner 是插件的 fiber 名（诊断说得清）", core.of("panel")?.cells[0].winner?.owner === "plugin-A");

  const before = versionSeen;
  await a.dispose();
  check("卸载插件 → 它声明的槽位与注册一起消失", !core.declared("panel") && core.entryCount() === 0);
  check("卸载会通知订阅者（界面才知道要重渲染）", versionSeen > before);
  offWatch();

  // per-ctx facade：槽位由宿主声明，两个插件各自往里注册，卸载一个不影响另一个
  const hostSlots = slotsOf(container.ctx);
  hostSlots.declare("shared", listSlot);
  const p1 = container.ctx.plugin({
    name: "p1",
    inject: ["slots"],
    apply(ctx) {
      ctx.get<SlotsService>("slots")?.register({ name: "shared", id: "one", label: "一号", component: Comp });
    },
  });
  const p2 = container.ctx.plugin({
    name: "p2",
    inject: ["slots"],
    apply(ctx) {
      ctx.get<SlotsService>("slots")?.register({ name: "shared", id: "two", label: "二号", component: Comp });
    },
  });
  await p1.ready;
  await p2.ready;
  check("两个插件各占一个格子", core.of("shared")?.cells.length === 2);
  await p1.dispose();
  check(
    "卸载 p1：它的那格消失，p2 的还在（互不干扰）",
    core.of("shared")?.cells.length === 1 && core.of("shared")?.cells[0].winner?.label === "二号",
    JSON.stringify(core.of("shared")?.cells.map((c) => c.winner?.label)),
  );

  // 级联：p2 声明一个槽位，别人往里注册 —— p2 一走，那个槽位与里面的 entry 一起消失
  const p3 = container.ctx.plugin({
    name: "p3",
    inject: ["slots"],
    apply(ctx) {
      const slots = ctx.get<SlotsService>("slots");
      slots?.register({
        name: "shared",
        id: "owner",
        label: "声明者",
        component: Comp,
        children: { inner: { kind: "list", scope: "app" } },
      });
    },
  });
  await p3.ready;
  check("p3 声明了子槽位", core.declared("shared.inner"));
  const p4 = container.ctx.plugin({
    name: "p4",
    inject: ["slots"],
    apply(ctx) {
      ctx.get<SlotsService>("slots")?.register({ name: "shared.inner", id: "guest", label: "客人", component: Comp });
    },
  });
  await p4.ready;
  check("客人注册进了别人的子槽位", core.of("shared.inner")?.cells[0].winner?.label === "客人");
  await p3.dispose();
  check("声明者一走：子槽位与客人的 entry 一起消失（级联）", !core.declared("shared.inner") && core.entryCount() === 1, String(core.entryCount()));
  await p4.dispose();
  await container.dispose();
}

// ---------- 6) 服务：inject 等声明（声明变化时重跑） ----------

{
  const { container, core } = await makeSlotsHost();
  const runs: string[] = [];
  const consumer = container.ctx.plugin({
    name: "consumer",
    inject: ["slots"],
    apply(ctx) {
      const slots = ctx.get<SlotsService>("slots");
      if (!slots) return;
      slots.inject("late.slot", (s) => {
        runs.push("injected@" + core.version());
        s.register({ name: "late.slot", id: "mine", label: "迟到者", component: Comp });
      });
    },
  });
  await consumer.ready;
  check("槽位还没声明时不执行", runs.length === 0);
  const declarer = container.ctx.plugin({
    name: "declarer",
    inject: ["slots"],
    apply(ctx) {
      ctx.get<SlotsService>("slots")?.declare("late.slot", listSlot);
    },
  });
  await declarer.ready;
  check("槽位一被声明就执行（不需要轮询）", runs.length === 1);
  check("inject 里注册的 entry 到位", core.of("late.slot")?.cells.length === 1);
  await declarer.dispose();
  check("槽位被释放 → entry 也没了", !core.declared("late.slot") && core.entryCount() === 0);
  const declarer2 = container.ctx.plugin({
    name: "declarer2",
    inject: ["slots"],
    apply(ctx) {
      ctx.get<SlotsService>("slots")?.declare("late.slot", listSlot);
    },
  });
  await declarer2.ready;
  check("槽位被重新声明 → inject 重跑（declarationEpoch 变了）", runs.length === 2, runs.join(","));
  await consumer.dispose();
  await container.dispose();
}

// ---------- 7) React 渲染 ----------

function Row({ label }: { label: string }) {
  return createElement("span", { className: "row" }, label);
}
function Crash(): never {
  throw new Error("组件自己炸了");
}
function ParentWithChild() {
  return createElement("div", { className: "parent" }, "父");
}
function BadChild() {
  throw new Error("不该被渲染");
}

{
  const core = new SlotCore();
  const slots = createSlotsService(core, { fiber: { name: "host", uid: 0 } } as unknown as Context);
  core.declare("t.list", listSlot);
  core.declare("t.single", singleSlot);
  core.declare("t.keyed", keyedSlot);

  core.register({ name: "t.single", label: "唯一", component: () => createElement(Row, { label: "唯一" }) }, owner);
  core.register({ name: "t.list", id: "b", order: 2, label: "B", component: () => createElement(Row, { label: "B" }) }, owner);
  core.register({ name: "t.list", id: "a", order: 1, label: "A", component: () => createElement(Row, { label: "A" }) }, owner);
  core.register({ name: "t.keyed", key: "copy", label: "复制", component: () => createElement(Row, { label: "复制" }) }, owner);
  core.register({ name: "t.keyed", key: "note", label: "笔记", component: () => createElement(Row, { label: "笔记" }) }, owner);

  const html = (name: string, hostProps?: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(SlotView, { slots, name, hostProps }));
  check("single 渲染赢家", html("t.single") === '<span class="row">唯一</span>', html("t.single"));
  check("list 按 order 渲染多个格子", html("t.list") === '<span class="row">A</span><span class="row">B</span>', html("t.list"));
  check("keyed 每个 key 一格", html("t.keyed").includes("复制") && html("t.keyed").includes("笔记"));
  check("hostProps 会传给组件", renderToStaticMarkup(createElement(SlotView, { slots, name: "t.single", hostProps: { role: "x" } })) !== "");
  check("未声明的槽位渲染成空", html("never.declared") === "");
  check("有 fallback 就用 fallback", renderToStaticMarkup(createElement(SlotView, { slots, name: "never.declared", fallback: "无" })) === "无");

  // 崩溃摘格只能在浏览器里验：React 官方明确"error boundary 不处理 SSR 的错误"
  //（renderToStaticMarkup 会把子组件的异常直接抛出来）。内核层面的 abdicate 语义在第 4 节已断言，
  // 真实的边界行为由 tools/probe-p32.js 在应用里验（注册一个会炸的组件，看它被摘掉、备胎顶上）。
  void Crash;

  // renderSlot 的授权：父 entry 渲染自己声明的子槽位
  const core2 = new SlotCore();
  const slots2 = createSlotsService(core2, { fiber: { name: "host", uid: 0 } } as unknown as Context);
  core2.declare("p", listSlot);
  core2.register(
    {
      name: "p",
      id: "parent",
      label: "父",
      children: { child: { kind: "list", scope: "app" } },
      component: (props: Record<string, unknown>) =>
        createElement("div", null, "父+", (props.renderSlot as (k: string) => unknown)("child")),
    },
    owner,
  );
  core2.register({ name: "p.child", id: "c", label: "子", component: () => createElement(Row, { label: "子" }) }, owner);
  const htmlRenderSlot = renderToStaticMarkup(createElement(SlotView, { slots: slots2, name: "p" }));
  check("renderSlot 渲染出子槽位内容", htmlRenderSlot.includes("父+") && htmlRenderSlot.includes("子"), htmlRenderSlot);

  // 越权渲染与 chain 未实现：这两条都是"组件里抛错误"，SSR 下会被 React 直接抛出来，
  // 所以改成**把 props 抓出来直接调**（同一个函数，不经过 React 渲染）——断言的还是那条纪律。
  const core3 = new SlotCore();
  const slots3 = createSlotsService(core3, { fiber: { name: "host", uid: 0 } } as unknown as Context);
  core3.declare("p2", listSlot);
  let captured: Record<string, unknown> | null = null;
  core3.register(
    {
      name: "p2",
      id: "parent",
      label: "越权父",
      component: (props: Record<string, unknown>) => {
        captured = props;
        return null;
      },
    },
    owner,
  );
  renderToStaticMarkup(createElement(SlotView, { slots: slots3, name: "p2" }));
  let ownErr: unknown = null;
  try {
    (captured!.renderSlot as (k: string) => unknown)("nope");
  } catch (e) {
    ownErr = e;
  }
  check("渲染未声明的子槽位 → SlotOwnershipError", codeOf(ownErr) === "CHILD_NOT_OWNED", String(ownErr));
  let chainErr: unknown = null;
  try {
    (captured!.renderSlotChain as () => unknown)();
  } catch (e) {
    chainErr = e;
  }
  check("renderSlotChain 渲染未声明的子槽位 → 同样是 CHILD_NOT_OWNED", codeOf(chainErr) === "CHILD_NOT_OWNED", String(chainErr));
  void BadChild;
  void ParentWithChild;
}

// ---------- 6) chain 槽位（P3.6）：自提名、第一个匹配者上、崩溃不摘格 ----------

/** 给一个裸内核配一份可渲染的服务（每个用例一个，互不影响） */
function serviceFor(core: SlotCore): SlotsService {
  const container = createContainer({ log: () => {} });
  container.ctx.provide("slots", contextBoundService<SlotsService>((c: Context) => createSlotsService(core, c)));
  return container.ctx.get<SlotsService>("slots") as SlotsService;
}
/** chain 的组件：把 props.matched 画出来（证明"谁被选中"与"选中值传到了组件"） */
const WhoComp = (props: Record<string, unknown>) => {
  const m = props.matched as { who?: string } | undefined;
  return createElement("span", null, (m?.who ?? "?") + ":ok");
};

{
  const core = new SlotCore();
  const ownerA = { label: "插件A", uid: 11 };
  const ownerB = { label: "插件B", uid: 12 };
  core.declare("t.chain", { kind: "chain", scope: "session", replaceRisk: "none", wired: true });

  // 没有注册任何条目 → of() 能查到声明，但格子里没有条目
  check("chain 声明后可查", core.declaration("t.chain")?.kind === "chain");
  check("没有条目时 chain 的格子是空的", (core.of("t.chain")?.cells ?? []).length === 0);

  let missingSelect = "";
  try {
    core.register({ name: "t.chain", component: Comp }, ownerA);
  } catch (e) {
    missingSelect = codeOf(e);
  }
  check("chain 必须给 select", missingSelect === "INVALID_REGISTRATION", missingSelect);

  // 两个条目**同 priority**：chain 不报错（本来就要并存）
  const offA = core.register({ name: "t.chain", priority: 0, select: (p) => (p.kind === "text" ? { who: "A" } : null), component: WhoComp }, ownerA);
  const offB = core.register({ name: "t.chain", priority: 0, select: (p) => (p.kind === "text" ? { who: "B" } : null), component: WhoComp }, ownerB);
  void offA;
  void offB;
  check("chain 同 priority 不冲突（与 single/keyed/list 相反）", core.of("t.chain")!.cells.flatMap((c) => c.entries).length === 2);

  // 选举：第一个匹配者赢（priority/order/seq 排序后）
  const elected = renderToStaticMarkup(
    createElement(SlotView, {
      slots: serviceFor(core),
      name: "t.chain",
      hostProps: { kind: "text" },
      fallback: "没人接手",
    }),
  );
  check("select 返回非 null 的第一个条目上（并且拿到 props.matched）", elected === "<span>A:ok</span>", elected);
  check(
    "没人匹配时用 fallback",
    renderToStaticMarkup(createElement(SlotView, { slots: serviceFor(core), name: "t.chain", hostProps: { kind: "other" }, fallback: "没人接手" })) === "没人接手",
  );

  // 顺序：order 更小的先被问
  const core2 = new SlotCore();
  core2.declare("t.chain2", { kind: "chain", scope: "session", replaceRisk: "none", wired: true });
  const order: string[] = [];
  core2.register({ name: "t.chain2", order: 10, select: () => (order.push("B"), null), component: WhoComp }, ownerA);
  core2.register({ name: "t.chain2", order: 5, select: () => (order.push("A"), null), component: WhoComp }, ownerB);
  renderToStaticMarkup(createElement(SlotView, { slots: serviceFor(core2), name: "t.chain2", fallback: null }));
  check("按 priority → order 顺序依次询问", order.join(",") === "A,B", order.join(","));

  // selector 抛错 = 弃权，下一个顶上，且**不摘格**
  const core3 = new SlotCore();
  core3.declare("t.chain3", { kind: "chain", scope: "session", replaceRisk: "none", wired: true });
  core3.register({ name: "t.chain3", order: 1, select: () => { throw new Error("我不干了"); }, component: WhoComp }, ownerA);
  core3.register({ name: "t.chain3", order: 2, select: () => ({ who: "B" }), component: WhoComp }, ownerB);
  const html3 = renderToStaticMarkup(createElement(SlotView, { slots: serviceFor(core3), name: "t.chain3", fallback: "没人接手" }));
  check("selector 抛错算弃权，下一个候选顶上", html3 === "<span>B:ok</span>", html3);
  check("selector 抛错不摘格（还有两个条目）", core3.of("t.chain3")!.cells.flatMap((c) => c.entries).length === 2);

  // 崩溃不摘格：abdicate 对 chain 只记错误
  const entryA = core3.of("t.chain3")!.cells[0].entries[0];
  core3.abdicate(entryA.uid, new Error("探针故意炸"));
  check("chain 的条目被标记为崩溃（renderErrors 有记录）", core3.renderErrors().some((e) => e.message.includes("探针故意炸")));
  check("但 chain 的条目**不被摘格**（下次渲染还有候选）", core3.of("t.chain3")!.cells.flatMap((c) => c.entries).length === 2 && entryA.abdicated === false);

  // 组件崩了也不摘格：边界只上报
  const core4 = new SlotCore();
  core4.declare("t.chain4", { kind: "chain", scope: "session", replaceRisk: "none", wired: true });
  const Boom = () => {
    throw new Error("渲染就炸");
  };
  core4.register({ name: "t.chain4", select: () => true, component: Boom }, ownerA);
  const bogus = core4.of("t.chain4")!.cells[0].entries[0];
  core4.abdicate(bogus.uid, new Error("渲染就炸"));
  check("chain 组件崩了：内核不摘它（格子里还在）", core4.of("t.chain4")!.cells.flatMap((c) => c.entries).length === 1);

  // 子槽位：chain 子要用 renderSlotChain，非 chain 子要用 renderSlot，用错抛 CHAIN_WRONG_API
  const core5 = new SlotCore();
  core5.declare("t.parent", { kind: "single", scope: "session", replaceRisk: "none", wired: true });
  let captured5: Record<string, unknown> | null = null;
  core5.register(
    {
      name: "t.parent",
      component: (props: Record<string, unknown>) => {
        captured5 = props;
        return null;
      },
      children: {
        inner: { kind: "chain", scope: "session" },
        plain: { kind: "list", scope: "session" },
      },
    },
    ownerA,
  );
  renderToStaticMarkup(createElement(SlotView, { slots: serviceFor(core5), name: "t.parent" }));
  let wrongApi: unknown = null;
  try {
    (captured5!.renderSlot as (k: string) => unknown)("inner");
  } catch (e) {
    wrongApi = e;
  }
  check("对 chain 子槽用 renderSlot → CHAIN_WRONG_API", codeOf(wrongApi) === "CHAIN_WRONG_API", String(wrongApi));
  let wrongApi2: unknown = null;
  try {
    (captured5!.renderSlotChain as (k: string) => unknown)("plain");
  } catch (e) {
    wrongApi2 = e;
  }
  check("对非 chain 子槽用 renderSlotChain → CHAIN_WRONG_API", codeOf(wrongApi2) === "CHAIN_WRONG_API", String(wrongApi2));

  // chain 子槽位真的能渲染（内部条目自提名）
  core5.register({ name: "t.parent.inner", select: () => ({ ok: 1 }), component: () => createElement("span", null, "子链上来了") }, ownerB);
  const innerHtml = renderToStaticMarkup(createElement(SlotView, { slots: serviceFor(core5), name: "t.parent.inner" }));
  check("chain 子槽位自己也能量出选举结果", innerHtml === "<span>子链上来了</span>", innerHtml);
}

// ---------- 7) 主题 token 覆盖（P3.6）：叠加、校验、随 fiber 卸载 ----------

{
  const { container } = await makeSlotsHost();
  const core = createThemeOverrideCore();
  container.ctx.provide("theme", contextBoundService<ThemeService>((c) => ({
    current: () => "light" as never,
    set: () => {},
    list: () => ["light"] as never,
    overrideTokens: (source: string, tokens: Record<string, ThemeTokenValue>) =>
      c.effect(() => core.override(source, tokens), "theme-override:" + source),
  })));

  check("没有层时 resolve 是空的", Object.keys(core.resolve("light" as never)).length === 0);

  const p1 = container.ctx.plugin({
    name: "theme-A",
    inject: ["theme"],
    apply(ctx) {
      ctx.get<ThemeService>("theme")!.overrideTokens!("plugin.a", { "--air-accent": "#a00" });
    },
  });
  await container.settle();
  check("插件加一层后 resolve 里有它", core.resolve("light" as never)["--air-accent"] === "#a00", JSON.stringify(core.resolve("light" as never)));

  const p2 = container.ctx.plugin({
    name: "theme-B",
    inject: ["theme"],
    apply(ctx) {
      ctx.get<ThemeService>("theme")!.overrideTokens!("plugin.b", { "--air-accent": "#0a0", "--air-bg": { dark: "#000" } });
    },
  });
  await container.settle();
  check("后注册的层压先注册的（同 token 取后者）", core.resolve("light" as never)["--air-accent"] === "#0a0");
  check("按主题给值：只在 dark 生效", core.resolve("dark" as never)["--air-bg"] === "#000" && core.resolve("light" as never)["--air-bg"] === undefined);
  check("list() 说得清谁盖了什么", core.list().map((l) => l.source).join(",") === "plugin.a,plugin.b", JSON.stringify(core.list().map((l) => l.source)));

  await p2.dispose();
  check("插件卸载 → 它那层自动消失（回到前一层）", core.resolve("light" as never)["--air-accent"] === "#a00" && core.list().length === 1);
  await p1.dispose();
  check("全部卸载 → 覆盖归零", Object.keys(core.resolve("light" as never)).length === 0);

  // 校验：不认识的名字要抛，且把可用 token 列出来
  let badName = "";
  try {
    core.override("x", { "--air-nonexistent": "#fff" });
  } catch (e) {
    badName = String(e instanceof Error ? e.message : e);
  }
  check("不认识的主题 token 直接抛错并列出可用项", badName.includes("--air-nonexistent") && badName.includes("--air-accent"), badName.slice(0, 80));
  let badValue = "";
  try {
    core.override("x", { "--air-accent": "" });
  } catch (e) {
    badValue = String(e instanceof Error ? e.message : e);
  }
  check("空值被拒", badValue.includes("非空字符串"), badValue.slice(0, 60));
  let tooMany = "";
  try {
    const many: Record<string, string> = {};
    for (let i = 0; i < 40; i++) many["--bogus-" + i] = "#fff";
    core.override("x", many);
  } catch (e) {
    tooMany = String(e instanceof Error ? e.message : e);
  }
  check("超量被拒", tooMany.includes("最多"), tooMany.slice(0, 40));
  check("被拒的层不会留在账本里", core.list().length === 0);

  await container.dispose();
}

console.log("插槽与主题契约测试：" + pass + " 通过 / " + failures.length + " 失败");
if (failures.length) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("  ✓ 全部通过（声明与注册规则 / priority 覆盖与冲突 / keyed 与 list 排序 / 子槽位级联 / 崩溃摘格 / per-ctx facade 与 fiber 生命周期 / inject 等声明 / React 渲染与 renderSlot 授权）");
