/**
 * P3.0 服务容器契约测试（内部设计笔记 §5.1 的验收）：
 *   「一个内置插件能被卸载，依赖它的插件自动 park/unpark；控制台无泄漏 disposer」
 *
 * 跑法：
 *   cd app && npx esbuild ../tools/container-test.ts --bundle --platform=node --format=esm --outfile=../fixtures/container-test.mjs
 *   node ../fixtures/container-test.mjs
 *
 * 全部断言都跑在 node 里，不需要浏览器 —— 容器是纯 TS，没有一行 DOM 依赖。
 */

import { createContainer, ValidationError, type Container } from "../app/src/core/service/index";
import { setLangPref } from "../app/src/i18n";

// 断言写的是中文默认文案：把界面语言钉死，别受开发机系统语言影响
setLangPref("zh");
import { jsonSchemaStandard } from "../app/src/core/jsonSchema";
import { ToolRegistry } from "../app/src/ai/tools/registry";
import type { ToolDefinition } from "../app/src/ai/tools/types";

// ToolRegistry 的超时用了 window.setTimeout；node 下补一个最小 Window 形状
(globalThis as any).window = globalThis;

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) pass++;
  else failures.push(name + (detail ? " —— " + detail : ""));
}

const logs: string[] = [];
/** root fiber 的首次落地是异步的（一次微任务），测试里等它一下再断言 */
const makeContainer = async (name = "test"): Promise<Container> => {
  const c = createContainer({
    name,
    log: (level, message) => {
      logs.push(level + ": " + message);
    },
  });
  await c.settle();
  return c;
};

// ---------- 1) provide / get：注册即 effect，注销即消失 ----------

{
  const c = await makeContainer();
  check("root fiber 一开始就是 ACTIVE", c.root.state === "ACTIVE", c.root.state);
  check("没注册的服务 get 到 undefined", c.ctx.get("nope") === undefined);
  const off = c.ctx.provide("svc", { v: 1 });
  check("注册后能取到", (c.ctx.get<{ v: number }>("svc")?.v ?? 0) === 1);
  check("服务名进了目录", c.ctx.services().includes("svc"));
  off();
  check("注销后取不到", c.ctx.get("svc") === undefined);
  c.ctx.provide("dup", 1);
  let threw = "";
  try {
    c.ctx.provide("dup", 2);
  } catch (e) {
    threw = String(e);
  }
  check("同名重复注册抛错", threw.includes("已经被注册过"), threw);
  await c.dispose();
}

// ---------- 2) effect：逆序、async、异常被吞掉且计数 ----------

{
  const c = await makeContainer();
  const order: string[] = [];
  c.ctx.effect(() => {
    order.push("a");
    return () => {
      order.push("dispose-a");
    };
  }, "a");
  c.ctx.effect(
    () => async () => {
      await new Promise((r) => setTimeout(r, 1));
      order.push("dispose-b(async)");
    },
    "b",
  );
  c.ctx.effect(() => [() => order.push("dispose-c1"), () => order.push("dispose-c2")], "c");
  c.ctx.effect(
    () => () => {
      throw new Error("故意坏的 disposer");
    },
    "bad",
  );
  await c.root.dispose();
  check("effect 注册时立刻执行了", order.includes("a"));
  // 注册顺序 a → b → c1,c2 → bad；卸载必须**逆序**（bad 抛错被吞掉，不进 order）
  check(
    "卸载是逆序的",
    order.join(",") === "a,dispose-c2,dispose-c1,dispose-b(async),dispose-a",
    order.join(","),
  );
  const diag = c.diagnostics();
  check("坏 disposer 被吞掉并计数", diag.disposerFailures === 1, String(diag.disposerFailures));
  check("坏 disposer 不阻断其余", order.includes("dispose-c2"));
  check("日志里记了失败", logs.some((l) => l.startsWith("error:") && l.includes("卸载 effect")), logs.join(" | "));
  await c.dispose();
}

// ---------- 3) 插件：加载 / 卸载 / 配置校验 ----------

{
  const c = await makeContainer();
  const events: string[] = [];
  const fiber = c.ctx.plugin({
    name: "demo",
    config: jsonSchemaStandard<{ n: number }>({
      type: "object",
      properties: { n: { type: "integer", minimum: 1 } },
      required: ["n"],
      additionalProperties: false,
    }),
    apply(ctx, cfg: { n: number }) {
      events.push("apply:" + cfg.n);
      return () => events.push("dispose");
    },
  }, { n: 3 });
  await fiber;
  check("await fiber 后是 ACTIVE", fiber.state === "ACTIVE", fiber.state);
  check("config 校验通过并传给 apply", events.includes("apply:3"), events.join(","));
  check("fiber 名字可读", fiber.name === "demo");
  await fiber.dispose();
  check("卸载后 DISPOSED 且 disposer 跑过", fiber.state === "DISPOSED" && events.includes("dispose"));
  check("卸载后没有残留 effect", fiber.pendingEffects() === 0);

  const bad = c.ctx.plugin(
    { name: "bad-config", config: jsonSchemaStandard({ type: "object", properties: { n: { type: "integer" } }, required: ["n"] }), apply: () => {} },
    { n: "三" },
  );
  let reason: unknown = null;
  await bad.ready.catch((e) => {
    reason = e;
  });
  check("配置不合法 → FAILED", bad.state === "FAILED", bad.state);
  check("错误是 ValidationError 且带路径", reason instanceof ValidationError, String(reason));
  check("ValidationError 带 issues", (reason as ValidationError)?.issues?.length > 0);

  const asyncSchema = c.ctx.plugin(
    {
      name: "async-schema",
      config: {
        "~standard": {
          version: 1 as const,
          vendor: "test",
          validate: (() => Promise.resolve({ value: {} })) as never,
        },
      },
      apply: () => {},
    },
    {},
  );
  await asyncSchema.ready.catch(() => {});
  check("异步 schema → FAILED（只支持同步校验）", asyncSchema.state === "FAILED");

  const broken = c.ctx.plugin({
    name: "broken",
    apply(ctx) {
      ctx.provide("half-way", 1);
      throw new Error("启动就炸");
    },
  });
  await broken.ready.catch(() => {});
  check("启动失败 → FAILED", broken.state === "FAILED");
  check("失败插件不留半挂服务", c.ctx.get("half-way") === undefined);
  const ok = c.ctx.plugin({ name: "ok", apply: () => () => {} });
  await ok;
  check("坏插件不影响别的插件", ok.state === "ACTIVE");
  await c.dispose();
}

// ---------- 4) epoch：park / unpark / 换实现重载 ----------

{
  const c = await makeContainer();
  let consumerApplies = 0;
  let consumerDisposes = 0;
  const consumer = c.ctx.plugin({
    name: "consumer",
    inject: ["dep"],
    apply(ctx) {
      consumerApplies++;
      const dep = ctx.get<{ tag: string }>("dep");
      if (!dep) throw new Error("inject 了却拿不到依赖");
      return () => {
        consumerDisposes++;
      };
    },
  });
  await consumer.ready;
  check("依赖缺失时停在 PENDING", consumer.state === "PENDING", consumer.state);
  check("PENDING 时 apply 没跑过", consumerApplies === 0);

  const offA = c.ctx.provide("dep", { tag: "A" });
  await c.settle();
  check("服务出现 → 自动加载（unpark）", consumer.state === "ACTIVE", consumer.state);
  check("apply 跑了一次", consumerApplies === 1);

  offA();
  await c.settle();
  check("服务注销 → 自动卸载（park）", consumer.state === "PENDING", consumer.state);
  check("park 时依赖方的清理跑过", consumerDisposes === 1, String(consumerDisposes));

  const offB = c.ctx.provide("dep", { tag: "B" });
  await c.settle();
  check("服务再来 → 再次加载", consumer.state === "ACTIVE" && consumerApplies === 2, String(consumerApplies));

  // 换成**另一个 fiber** 提供同一个服务：epoch 串里的 uid 变了 → 依赖方走"卸载后重载"。
  // 注意同一时刻只能有一个 provider（同名重复注册会抛错），所以真实过程必然是
  // 「旧 provider 撤 → 依赖方 park → 新 provider 上 → 依赖方重载」，断言要按这个顺序写。
  const appliesBefore = consumerApplies;
  const disposesBefore = consumerDisposes;
  offB();
  await c.settle();
  check("旧 provider 撤掉 → 依赖方 park", consumer.state === "PENDING", consumer.state);
  const fiberB = c.ctx.plugin({
    name: "provider-B",
    apply(ctx) {
      return ctx.provide("dep", { tag: "C" });
    },
  });
  await fiberB.ready;
  await c.settle();
  check("新 fiber 提供服务 → 依赖方重载", consumer.state === "ACTIVE", consumer.state);
  check(
    "重载 = 先清理上一轮再跑新的 apply",
    consumerApplies === appliesBefore + 1 && consumerDisposes === disposesBefore + 1,
    "applies=" + consumerApplies + " disposes=" + consumerDisposes,
  );

  await fiberB.dispose();
  await c.settle();
  check("provider 卸载 → 依赖方再次 park", consumer.state === "PENDING", consumer.state);

  // check() 谓词：为 false 时依赖方把它当作不存在
  let available = false;
  c.ctx.provide("gated", { tag: "G" }, () => available);
  const gated = c.ctx.plugin({ name: "gated-consumer", inject: ["gated"], apply: () => () => {} });
  await gated.ready;
  check("check() 为 false → 依赖方 PENDING", gated.state === "PENDING", gated.state);
  available = true;
  c.recheck();
  await c.settle();
  check("check() 翻转 + recheck() → 加载", gated.state === "ACTIVE", gated.state);
  available = false;
  c.recheck();
  await c.settle();
  check("check() 翻回去 → 再次 park", gated.state === "PENDING", gated.state);
  await c.dispose();
}

// ---------- 5) ctx.inject / mixin / isolate ----------

{
  const c = await makeContainer();
  const ran: string[] = [];
  const offInject = c.ctx.inject(["later"], (ctx) => {
    ran.push("inject-cb:" + ctx.get<number>("later"));
    return () => ran.push("inject-dispose");
  });
  await c.settle();
  check("ctx.inject 依赖缺失时不执行", ran.length === 0);
  const offLater = c.ctx.provide("later", 7);
  await c.settle();
  check("ctx.inject 依赖出现后执行", ran.includes("inject-cb:7"), ran.join(","));
  offInject();
  await c.settle();
  check("ctx.inject 的 disposer 生效", ran.includes("inject-dispose"));
  offLater();

  const svc = {
    hello: (who: string) => "hi " + who,
    who: () => "svc",
  };
  const offMixin = c.ctx.mixin(svc, ["hello", "who"]);
  const ctxAny = c.ctx as unknown as { hello: (w: string) => string; who: () => string };
  check("mixin 把方法挂到 ctx 上", ctxAny.hello("x") === "hi x");
  check("mixin 绑定 this 到服务实例", ctxAny.who() === "svc");
  offMixin();
  check("mixin 注销后方法消失", typeof ctxAny.hello === "undefined");

  const offSvc = c.ctx.provide("scoped", "outer");
  const isolated = c.ctx.isolate("book", "book-1");
  check("isolate 后子上下文看不到父级服务", isolated.get("scoped") === undefined);
  isolated.provide("scoped", "inner");
  check("isolate 内可注册同名服务", isolated.get("scoped") === "inner");
  check("父级不受影响", c.ctx.get("scoped") === "outer");
  offSvc();
  await c.dispose();
}

// ---------- 6) 级联卸载与"无泄漏 disposer" ----------

{
  const c = await makeContainer();
  const trace: string[] = [];
  const parent = c.ctx.plugin({
    name: "parent",
    apply(ctx) {
      ctx.provide("parent-svc", 1);
      const child = ctx.plugin({
        name: "child",
        inject: ["parent-svc"],
        apply(c2) {
          c2.provide("child-svc", 2);
          return () => trace.push("child-dispose");
        },
      });
      void child.ready;
      return () => trace.push("parent-dispose");
    },
  });
  await parent;
  await c.settle();
  check("子 fiber 挂上了（root + parent + child）", c.diagnostics().fibers.length === 3, String(c.diagnostics().fibers.length));
  check("子插件注入了父提供的服务", c.ctx.get("child-svc") === 2);
  await parent.dispose();
  check("卸载父 → 子级联卸载", trace.includes("child-dispose") && trace.includes("parent-dispose"), trace.join(","));
  check("父提供的服务消失", c.ctx.get("parent-svc") === undefined);
  check("子提供的服务消失", c.ctx.get("child-svc") === undefined);

  await c.dispose();
  const diag = c.diagnostics();
  check("容器释放后没有残留 effect（无泄漏 disposer）", diag.pendingEffects === 0, JSON.stringify(diag.fibers));
  check("容器释放后服务清空", diag.services.length === 0, diag.services.join(","));
}

// ---------- 7) 工具注册表：disposer + 按作用域裁剪 ----------

{
  const c = await makeContainer();
  const tools = new ToolRegistry();
  c.ctx.provide("tools", tools);
  const mk = (name: string): ToolDefinition => ({
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    executionMode: "parallel-safe",
    execute: async () => ({ ok: true, value: { name } }),
  });

  const fiber = c.ctx.plugin({
    name: "tool-plugin",
    inject: ["tools"],
    apply(ctx) {
      const reg = ctx.get<ToolRegistry>("tools");
      if (!reg) return;
      const offTools = reg.registerAll([mk("t1"), mk("t2")]);
      const offGuard = reg.registerGuard(() => null);
      return [offTools, offGuard];
    },
  });
  await fiber;
  check("插件注册的工具进了 schema", tools.schemas().map((s) => s.function.name).join(",") === "t1,t2");
  await fiber.dispose();
  check("卸载插件后工具消失（前缀不留残渣）", tools.schemas().length === 0, String(tools.schemas().length));

  tools.registerAll([mk("t1"), mk("t2")]);
  const offMaskA = tools.restrict(["t1"], "scope-a");
  check("作用域 A 的掩码只影响 A", tools.visible("scope-a").length === 1 && tools.visible("scope-b").length === 2);
  const ctxExec = { signal: new AbortController().signal, callId: "c1", scopeId: "scope-a" };
  const masked = await tools.execute("t2", {}, ctxExec);
  check("被掩码遮住的工具 → UNKNOWN_TOOL", !masked.outcome.ok && masked.outcome.error.code === "UNKNOWN_TOOL");
  const allowed = await tools.execute("t1", {}, ctxExec);
  check("掩码内工具照常执行", allowed.outcome.ok === true);
  offMaskA();
  check("解除掩码后恢复全部可见", tools.visible("scope-a").length === 2);
  const guardOff = tools.registerGuard(({ name }) => (name === "t1" ? "被守卫拒绝" : null));
  const blocked = await tools.execute("t1", {}, { signal: new AbortController().signal, callId: "c2" });
  check("守卫拒绝 → NOT_AVAILABLE", !blocked.outcome.ok && blocked.outcome.error.code === "NOT_AVAILABLE");
  guardOff();
  const unblocked = await tools.execute("t1", {}, { signal: new AbortController().signal, callId: "c3" });
  check("守卫注销后放行", unblocked.outcome.ok === true);
  await c.dispose();
}

// ---------- 8) 内置插件装配（真实的那三个） ----------

{
  const { createAppRuntime } = await import("../app/src/core/app/runtime");
  const registered: string[] = [];
  const fakeReader = {
    bookId: () => "book-1",
    title: () => "测试书",
    author: () => "作者",
    progress: () => ({ fraction: 0.25, chapter: "第一章", location: "位置 1" }),
    context: () => null,
    chapters: () => [
      { n: 1, title: "一", cfi: "cfi", chars: 10, inContext: true },
      { n: 2, title: "二", cfi: "cfi2", chars: 10, inContext: false },
    ],
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
  const runtime = createAppRuntime({
    reader: fakeReader as never,
    skills: {
      registry: {
        candidates: () => [],
        modelInvocable: () => [],
        get: async () => undefined,
      },
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
      getSetting: async <T,>(_k: string, f: T) => f,
      setSetting: async () => {},
    },
    theme: { current: () => "light" as never, set: () => {}, list: () => [] },
    paths: { skillsDir: () => "X:/skills", pluginsDir: () => "X:/plugins" },
    log: (level, message) => {
      registered.push(level + ":" + message);
    },
  });
  await runtime.mount();
  const names = runtime.tools.schemas().map((s) => s.function.name);
  check("内置插件装出了两套工具 + P3.4 的四个插件工具", names.length === 15, names.join(","));
  check(
    "工具顺序 = 注册顺序（前缀稳定）",
    names[0] === "get_toc" && names[9] === "load_skill" && names[10] === "create_skill" && names[11] === "plugin_inspect" && names[14] === "plugin_diagnose",
    names.join(","),
  );
  check("readingStats 服务可用", runtime.container.ctx.get<{ summary(): string }>("readingStats")?.summary() === "已读 25.0% · 共 2 章");
  check("plugins() 报告全部内置插件（P3.2 界面类 + P3.4 插件开发工具 + P3.5 插件日志，共 9 个）", runtime.plugins().length === 9, JSON.stringify(runtime.plugins().map((m) => m.id)));
  check("全部 ACTIVE", runtime.plugins().every((m) => m.state === "ACTIVE"), JSON.stringify(runtime.plugins().map((m) => m.state)));

  // 卸载"读工具"插件：它注册的工具必须消失，其他插件的工具不受影响
  await runtime.unload("app.aireader.reader-tools");
  const after = runtime.tools.schemas().map((s) => s.function.name);
  check("卸载读工具插件后只剩技能工具与插件工具", after.join(",") === "load_skill,create_skill,plugin_inspect,plugin_define,plugin_run,plugin_diagnose", after.join(","));
  await runtime.remount("app.aireader.reader-tools");
  check("重挂后工具回到 15 个", runtime.tools.schemas().length === 15);

  // 卸载阅读统计：依赖它的插件应当 park（这里用注入它的临时插件验证）
  let statsApplies = 0;
  const statsConsumer = runtime.container.ctx.plugin({
    name: "stats-consumer",
    inject: ["readingStats"],
    apply() {
      statsApplies++;
      return () => {};
    },
  });
  await runtime.container.settle();
  check("依赖 readingStats 的插件 ACTIVE", statsConsumer.state === "ACTIVE", statsConsumer.state);
  await runtime.unload("app.aireader.reading-stats");
  await runtime.container.settle();
  check("卸载 readingStats → 依赖它的插件自动 park", statsConsumer.state === "PENDING", statsConsumer.state);
  await runtime.remount("app.aireader.reading-stats");
  await runtime.container.settle();
  check("重挂 readingStats → 依赖它的插件自动 unpark", statsConsumer.state === "ACTIVE" && statsApplies === 2, String(statsApplies));

  const before = runtime.diagnostics().pendingEffects;
  await runtime.dispose();
  const diag = runtime.diagnostics();
  check("运行时释放后 effect 归零", diag.pendingEffects === 0, String(before) + " → " + JSON.stringify(diag.fibers));
  check("运行时释放后服务清空", diag.services.length === 0, diag.services.join(","));
}

console.log("容器契约测试：" + pass + " 通过 / " + failures.length + " 失败");
if (failures.length) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("  ✓ 全部通过（provide/get 与同名拒绝 / effect 逆序与异常吞噬 / 插件加载卸载与 config 校验 / epoch park-unpark-重载 / 级联卸载 / 无泄漏 disposer / 工具按作用域裁剪）");
void ({} as Container);
