/**
 * P3.1 插件加载契约测试（内部设计笔记 §5.1 的验收）：
 *   「故意写坏一个插件：它 FAILED，其他插件不受影响」
 *
 * 跑法：
 *   cd app && npx esbuild ../tools/plugin-loader-test.ts --bundle --platform=node --format=esm --outfile=../fixtures/plugin-loader-test.mjs
 *   node ../fixtures/plugin-loader-test.mjs
 *
 * 全程在 node 里跑：加载器只依赖"文件 IO 缝"与容器，没有 DOM、没有 Tauri。
 */

import { createContainer, contextBoundService } from "../app/src/core/service/index";
import { setLangPref } from "../app/src/i18n";

// 断言写的是中文默认文案：把界面语言钉死，别受开发机系统语言影响
setLangPref("zh");
import { SlotCore, createSlotsService } from "../app/src/ui/slots/index";
import type { SlotsService } from "../app/src/ui/slots/index";
import {
  HOST_API_VERSION,
  PluginLoader,
  createMemoryPluginStore,
  isSafeRelPath,
  parseManifest,
  verifyPackageHash,
} from "../app/src/core/plugin/index";
import { createMemoryPluginFs } from "../app/src/core/app/pluginFs";
import { BUILTIN_PLUGINS, builtinImplementation, readingStatsPlugin } from "../app/src/core/app/builtinPlugins";
import { ToolRegistry } from "../app/src/ai/tools/registry";
import type { BuiltinPlugin, PluginObject } from "../app/src/core/plugin/index";
import type { ToolHost } from "../app/src/ai/tools/host";

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) pass++;
  else failures.push(name + (detail ? " —— " + detail : ""));
}

const goodManifest = (over: Record<string, unknown> = {}) => ({
  id: "com.example.hello",
  name: "示例插件",
  purpose: "演示插件包的最小形态。",
  version: "1.0.0",
  apiVersion: HOST_API_VERSION,
  capabilities: ["reader.read"],
  ...over,
});

const issueFields = (issues: { field: string }[]) => issues.map((i) => i.field).join(",");

// ---------- 1) manifest 校验 ----------

{
  const ok = parseManifest(JSON.stringify(goodManifest()));
  check("合法 manifest 通过", ok.ok, ok.ok ? "" : JSON.stringify(ok.issues));
  check("缺字段时一次报全部问题", (() => {
    const r = parseManifest(JSON.stringify({ purpose: "x" }));
    return !r.ok && issueFields(r.issues).includes("id") && issueFields(r.issues).includes("name") &&
      issueFields(r.issues).includes("version") && issueFields(r.issues).includes("apiVersion");
  })());
  const badId = parseManifest(JSON.stringify(goodManifest({ id: "Com.Example_Hello" })));
  check("id 非法被拒（大写/下划线）", !badId.ok && issueFields(badId.issues) === "id");
  const badVer = parseManifest(JSON.stringify(goodManifest({ version: "1.0" })));
  check("version 非语义化被拒", !badVer.ok && issueFields(badVer.issues) === "version");
  const badApi = parseManifest(JSON.stringify(goodManifest({ apiVersion: "aireader-plugin-2" })));
  check("apiVersion 不匹配被拒且说明宿主版本", !badApi.ok && badApi.error !== undefined ? true : (!badApi.ok && badApi.issues[0].message.includes(HOST_API_VERSION)), !badApi.ok ? badApi.issues[0].message : "");
  const missingMain = parseManifest(JSON.stringify(goodManifest({ main: "index.js" })), "manifest.json", [{ path: "manifest.json", content: "{}" }]);
  check("main 指向不存在的文件被拒", !missingMain.ok && issueFields(missingMain.issues) === "main");
  const escapeMain = parseManifest(JSON.stringify(goodManifest({ main: "../evil.js" })));
  check("main 越出包目录被拒", !escapeMain.ok && issueFields(escapeMain.issues) === "main");
  const badUi = parseManifest(JSON.stringify(goodManifest({ ui: { entry: "ui.js" } })), "manifest.json", [{ path: "manifest.json", content: "{}" }]);
  check("ui.entry 不存在被拒", !badUi.ok && issueFields(badUi.issues) === "ui.entry");
  const badConfig = parseManifest(JSON.stringify(goodManifest({ config: { type: "string" } })));
  check("config 必须是 object schema", !badConfig.ok && issueFields(badConfig.issues) === "config");
  const badCap = parseManifest(JSON.stringify(goodManifest({ capabilities: ["reader.read", "fs.delete_everything"] })));
  check("不认识的能力被拒且列出可用能力", !badCap.ok && badCap.issues[0].message.includes("fs.delete_everything") && badCap.issues[0].message.includes("reader.read"));
  const notJson = parseManifest("{ 这不是 json }");
  check("不是 JSON 被拒", !notJson.ok && notJson.issues[0].field === "manifest.json");
  check("不是对象被拒", !parseManifest("[1,2,3]").ok);

  // 包哈希：写了就校验，不写则加载器补
  const files = [
    { path: "manifest.json", content: "{}" },
    { path: "index.js", content: "export const a = 1;" },
  ];
  const real = parseManifest(JSON.stringify(goodManifest()), "m", files);
  check("没写 hash 时加载器补上", real.ok && typeof real.manifest.hash === "string" && real.manifest.hash.length === 16);
  const hashOk = parseManifest(JSON.stringify(goodManifest({ hash: (real as { manifest: { hash: string } }).manifest.hash })), "m", files);
  check("hash 对得上就通过", hashOk.ok, hashOk.ok ? "" : JSON.stringify(hashOk.issues));
  const hashBad = parseManifest(JSON.stringify(goodManifest({ hash: "deadbeefdeadbeef" })), "m", files);
  check("hash 对不上被拒（包被改过）", !hashBad.ok && issueFields(hashBad.issues) === "hash");
  check("verifyPackageHash 直测", verifyPackageHash(files, (real as { manifest: { hash: string } }).manifest.hash) === true);
  check("改一个字节哈希就变", verifyPackageHash([{ path: "a", content: "1" }], (real as { manifest: { hash: string } }).manifest.hash) === false);
  check("路径安全检查", isSafeRelPath("index.js") && !isSafeRelPath("../x") && !isSafeRelPath("/etc/passwd") && !isSafeRelPath("C:/x"));
}

// ---------- 2) 假书 + 假内置插件 ----------

function fakeReader(): ToolHost {
  return {
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
}

/** 一个会注册工具的内置插件（用来观察"卸载后工具真的消失"） */
const toolPlugin: BuiltinPlugin = {
  manifest: {
    id: "test.tool-plugin",
    name: "测试工具插件",
    purpose: "注册一个工具，用于验证加载/卸载。",
    version: "1.0.0",
    apiVersion: HOST_API_VERSION,
  },
  plugin: {
    name: "tool-plugin",
    inject: ["tools"],
    apply(ctx) {
      const tools = ctx.get<ToolRegistry>("tools");
      if (!tools) return;
      ctx.effect(
        () =>
          tools.registerAll([
            {
              name: "t_from_plugin",
              description: "x",
              parameters: { type: "object", properties: {} },
              executionMode: "parallel-safe",
              execute: async () => ({ ok: true, value: 1 }),
            } satisfies import("../app/src/ai/tools/types").ToolDefinition,
          ]),
        "tool-plugin:register",
      );
    },
  },
};

/** 故意写坏的插件：apply 先注册一半东西再抛错 */
const brokenPlugin: BuiltinPlugin = {
  manifest: {
    id: "test.broken-plugin",
    name: "写坏的插件",
    purpose: "启动即抛错，用于验证失败隔离。",
    version: "1.0.0",
    apiVersion: HOST_API_VERSION,
  },
  plugin: {
    name: "broken-plugin",
    inject: ["tools"],
    apply(ctx) {
      const tools = ctx.get<ToolRegistry>("tools");
      // 先注册一半东西，再抛错：验证 fiber 会把已经挂上的 effect 逆序撤掉
      ctx.effect(
        () =>
          tools?.registerAll([
            {
              name: "t_half_way",
              description: "x",
              parameters: { type: "object", properties: {} },
              executionMode: "parallel-safe",
              execute: async () => ({ ok: true, value: 1 }),
            } satisfies import("../app/src/ai/tools/types").ToolDefinition,
          ]) ?? (() => {}),
        "broken:half-way",
      );
      throw new Error("这个插件在启动时就炸了");
    },
  },
};

type Setup = {
  loader: PluginLoader;
  container: ReturnType<typeof createContainer>;
  tools: ToolRegistry;
  store: ReturnType<typeof createMemoryPluginStore>;
};

async function setup(init: {
  files?: Record<string, string>;
  builtins?: BuiltinPlugin[];
  options?: Record<string, { disabled?: boolean; config?: unknown }>;
  resolve?: (id: string) => PluginObject | undefined;
} = {}): Promise<Setup> {
  const container = createContainer({ log: () => {} });
  const tools = new ToolRegistry();
  const store = createMemoryPluginStore(init.options ?? {});
  container.ctx.provide("tools", tools);
  container.ctx.provide("reader", fakeReader());
  const builtins = init.builtins ?? [toolPlugin];
  const loader = new PluginLoader(container.ctx, {
    builtins,
    store,
    fs: createMemoryPluginFs(init.files ?? {}),
    resolveImplementation: init.resolve ?? ((id) => builtins.find((b) => b.manifest.id === id)?.plugin),
    log: () => {},
  });
  return { loader, container, tools, store };
}

// ---------- 3) 扫描：顺序、被拒、重复 ----------

{
  const { loader, container } = await setup({
    files: {
      "zzz-user/manifest.json": JSON.stringify(goodManifest({ id: "com.example.zzz" })),
      "aaa-user/manifest.json": JSON.stringify(goodManifest({ id: "com.example.aaa" })),
      "broken/manifest.json": "{ not json }",
      "no-manifest/index.js": "x",
    },
  });
  const scan = await loader.scan();
  check("扫描只认有 manifest.json 的目录", scan.entries.length === 3, JSON.stringify(scan.entries.map((e) => e.id)));
  check("顺序 = 内置在前、用户按目录名", scan.entries.map((e) => e.id).join(",") === "test.tool-plugin,com.example.aaa,com.example.zzz", scan.entries.map((e) => e.id).join(","));
  check("写坏的包进 rejected（不静默消失）", scan.rejected.length === 1 && scan.rejected[0].dir === "broken");
  check("rejected 带字段级原因", scan.rejected[0].issues[0].field.includes("manifest.json"));
  check("没有 manifest 的目录被忽略（不是错误）", !scan.errors.some((e) => e.dir === "no-manifest"));
  await container.dispose();
}

{
  const { loader, container } = await setup({
    files: { "shadow/manifest.json": JSON.stringify(goodManifest({ id: "test.tool-plugin" })) },
  });
  const scan = await loader.scan();
  check("与内置同 id 的用户包被拒（不静默覆盖实现）", scan.duplicates.length === 1 && scan.duplicates[0].kept === "<builtin>");
  check("保留的是内置那份", scan.entries.length === 1 && scan.entries[0].source === "builtin");
  await container.dispose();
}

// ---------- 4) 挂载：分类与失败隔离 ----------

{
  const { loader, tools, container } = await setup({
    files: {
      "needs-runtime/manifest.json": JSON.stringify(goodManifest({ id: "com.example.needs-runtime", main: "index.js" })),
      "needs-runtime/index.js": "export function apply() {}",
      "bad-config/manifest.json": JSON.stringify(goodManifest({ id: "com.example.bad-config", config: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] } })),
      "disabled-one/manifest.json": JSON.stringify(goodManifest({ id: "com.example.disabled" })),
    },
    builtins: [toolPlugin, brokenPlugin],
    options: { "com.example.disabled": { disabled: true }, "com.example.bad-config": { config: { n: "三" } } },
  });
  const load = await loader.mountAll();
  const stateOf = (id: string) => loader.statuses().find((s) => s.id === id)?.state;

  check("正常插件 ACTIVE", stateOf("test.tool-plugin") === "ACTIVE", String(stateOf("test.tool-plugin")));
  check("写坏的插件 FAILED", stateOf("test.broken-plugin") === "FAILED", String(stateOf("test.broken-plugin")));
  check("失败原因进了 detail", (loader.statuses().find((s) => s.id === "test.broken-plugin")?.detail ?? "").includes("启动时就炸了"));
  check("一个插件坏了不影响别人（工具照常注册）", tools.schemas().some((s) => s.function.name === "t_from_plugin"));
  check("失败插件不留半挂的东西", !tools.schemas().some((s) => s.function.name === "t_half_way"));
  check("挂载失败聚合进报告而不是抛异常", load.failed.join(",") === "test.broken-plugin", JSON.stringify(load.failed));
  check("带 main 的用户包标成 UNAVAILABLE（等 P3.3 运行时）", stateOf("com.example.needs-runtime") === "UNAVAILABLE");
  check(
    "UNAVAILABLE 的原因讲清楚了",
    (loader.statuses().find((s) => s.id === "com.example.needs-runtime")?.detail ?? "").includes("quickjs-ng"),
    loader.statuses().find((s) => s.id === "com.example.needs-runtime")?.detail ?? "",
  );
  check("配置不合法 → INVALID（不挂载也不影响别人）", stateOf("com.example.bad-config") === "INVALID", String(stateOf("com.example.bad-config")));
  check("被关掉的插件 → DISABLED", stateOf("com.example.disabled") === "DISABLED");
  check("报告里给出 unavailable 清单", load.unavailable.join(",") === "com.example.needs-runtime", JSON.stringify(load.unavailable));
  await container.dispose();
}

// ---------- 5) 卸载、开关、sync ----------

{
  const { loader, tools, store, container } = await setup();
  await loader.mountAll();
  check("挂载后有插件工具", tools.schemas().length === 1);
  await loader.unmount("test.tool-plugin");
  check("卸载后工具消失（前缀不留残渣）", tools.schemas().length === 0, String(tools.schemas().length));
  check("卸载后状态是 UNMOUNTED", loader.statuses()[0].state === "UNMOUNTED", loader.statuses()[0].state);
  check("卸载后没有残留 effect", container.diagnostics().pendingEffects === 0 || container.diagnostics().fibers.every((f) => f.name !== "test.tool-plugin" || f.pendingEffects === 0));

  await loader.setEnabled("test.tool-plugin", false);
  check("关掉之后不会挂上", loader.statuses()[0].state === "DISABLED", loader.statuses()[0].state);
  check("关掉之后工具仍然没有", tools.schemas().length === 0);
  await loader.setEnabled("test.tool-plugin", true);
  check("打开之后回来了", loader.statuses()[0].state === "ACTIVE" && tools.schemas().length === 1);

  // 选项存在 store 里：换一个 loader（同一个 store）仍然是开启状态
  // （先把当前的卸掉，否则同一个容器里会重复注册同名工具）
  await loader.unmount("test.tool-plugin");
  const second = new PluginLoader(container.ctx, {
    builtins: [toolPlugin],
    store,
    fs: createMemoryPluginFs({}),
    resolveImplementation: (id) => (id === "test.tool-plugin" ? toolPlugin.plugin : undefined),
  });
  await second.scan();
  await second.mountAll();
  check("选项存在设置表里：新 loader 也认", second.statuses()[0].state === "ACTIVE");
  check("store 里确实有记录", store.all()["test.tool-plugin"] !== undefined);
  await container.dispose();
}

{
  const files: Record<string, string> = {
    "user-plugin/manifest.json": JSON.stringify(goodManifest({ id: "com.example.syncme", version: "1.0.0" })),
  };
  const container = createContainer({ log: () => {} });
  const tools = new ToolRegistry();
  container.ctx.provide("tools", tools);
  const fs = createMemoryPluginFs(files);
  const impls = new Map<string, PluginObject>();
  const impl = (id: string): PluginObject => {
    let made = impls.get(id);
    if (!made) {
      made = { name: id, inject: ["tools"], apply: (ctx) => ctx.get<ToolRegistry>("tools")?.registerAll([]) };
      impls.set(id, made);
    }
    return made;
  };
  const loader = new PluginLoader(container.ctx, {
    builtins: [],
    fs,
    resolveImplementation: (id) => impl(id),
    log: () => {},
  });
  await loader.scan();
  await loader.mountAll();
  check("sync：新包被挂上", loader.statuses()[0]?.state === "ACTIVE", JSON.stringify(loader.statuses()));

  files["newone/manifest.json"] = JSON.stringify(goodManifest({ id: "com.example.newone" }));
  let report = await loader.sync();
  check("sync：磁盘上多了一个包 → 自动挂上", loader.statuses().length === 2 && loader.statuses().every((s) => s.state === "ACTIVE"), JSON.stringify(loader.statuses().map((s) => s.id + ":" + s.state)));

  files["user-plugin/manifest.json"] = JSON.stringify(goodManifest({ id: "com.example.syncme", version: "2.0.0" }));
  report = await loader.sync();
  check("sync：版本变了 → 卸载并重挂", report.removed.includes("com.example.syncme"), JSON.stringify(report.removed));
  check("sync 后两个都是 ACTIVE", loader.statuses().every((s) => s.state === "ACTIVE"), JSON.stringify(loader.statuses().map((s) => s.state)));

  delete files["newone/manifest.json"];
  report = await loader.sync();
  check("sync：包被删掉 → 卸载并清记录", report.removed.includes("com.example.newone") && loader.statuses().length === 1, JSON.stringify(report.removed));
  await container.dispose();
}

// ---------- 6) 配置热更与回滚（真实的内置实现：reading-stats） ----------

{
  const container = createContainer({ log: () => {} });
  const tools = new ToolRegistry();
  container.ctx.provide("tools", tools);
  container.ctx.provide("reader", fakeReader());
  // skill-tools 插件 inject ["tools","skills"]：给个最小的假 skills，验证它也能 ACTIVE
  container.ctx.provide("skills", {
    registry: { candidates: () => [], modelInvocable: () => [], get: async () => undefined },
    refresh: async () => ({ userSkills: 0, total: 0, digest: "" }),
    write: async () => "",
    readResource: async () => ({ ok: false, error: "no" }),
    remove: async () => {},
    dir: async () => "",
    warnings: () => [],
    entries: () => [],
  });
  // 内置的界面类插件 inject ["slots","plugins"]：给它们最小的真服务（插槽内核是真的）
  const slotCore = new SlotCore();
  container.ctx.provide("slots", contextBoundService<SlotsService>((c) => createSlotsService(slotCore, c)));
  container.ctx.provide("plugins", {
    list: () => [],
    manifestOf: () => undefined,
    scanReport: () => null,
    setEnabled: async () => ({}) as never,
    reload: async () => ({}) as never,
    configOf: () => ({}),
    capabilities: () => [],
    dir: () => "X:/plugins",
    sync: async () => ({ removed: [], failed: [], unavailable: [] }),
  });
  const store = createMemoryPluginStore();
  const loader = new PluginLoader(container.ctx, {
    builtins: BUILTIN_PLUGINS,
    store,
    fs: createMemoryPluginFs({}),
    resolveImplementation: builtinImplementation,
    log: () => {},
  });
  await loader.mountAll();
  const stats = () => container.ctx.get<{ summary(): string }>("readingStats");
  // P3.4 的 plugin-tools 注入 pluginDev/slots/plugins、P3.5 的 plugin-logs 注入 pluginLogs，
  // 这个测试容器只提供了一部分，所以它们停在 PENDING（**等依赖不是错误**，P3.0 的语义）
  // —— 正好把这条语义钉在测试里
  const pendingByDesign = new Set(["app.aireader.plugin-tools", "app.aireader.plugin-logs"]);
  const stateOfBuiltin = (id: string) => loader.statuses().find((s) => s.id === id)?.state;
  check(
    "内置插件全部挂上（缺依赖的那两个等依赖，其余 ACTIVE）",
    loader.statuses().every((s) => s.state === "ACTIVE" || pendingByDesign.has(s.id)),
    JSON.stringify(loader.statuses().map((s) => s.id + ":" + s.state)),
  );
  check("缺依赖的内置插件是 PENDING 而不是 FAILED", stateOfBuiltin("app.aireader.plugin-tools") === "PENDING" && stateOfBuiltin("app.aireader.plugin-logs") === "PENDING", String(stateOfBuiltin("app.aireader.plugin-logs")));
  check("默认配置下的统计", stats()?.summary() === "已读 25.0% · 共 2 章", String(stats()?.summary()));
  check(
    "内置 manifest 的 id 用反 DNS 形式",
    loader.statuses().map((s) => s.id).join(",") ===
      "app.aireader.reader-tools,app.aireader.skill-tools,app.aireader.reading-stats,app.aireader.plugin-tools,app.aireader.ui-layout,app.aireader.status-badge,app.aireader.reader-tail,app.aireader.plugin-settings,app.aireader.plugin-logs",
    loader.statuses().map((s) => s.id).join(","),
  );
  check(
    "界面类插件也真的挂上了（槽位声明生效）",
    loader.statuses().filter((s) => !pendingByDesign.has(s.id)).every((s) => s.state === "ACTIVE") && slotCore.declared("sidebar.footer.action"),
  );

  await loader.reload("app.aireader.reading-stats", { style: "long" });
  check("热更配置后行为变了", (stats()?.summary() ?? "").includes("当前位置"), String(stats()?.summary()));
  check("配置写进了 store", (store.get("app.aireader.reading-stats")?.config as { style?: string })?.style === "long");

  let threw = "";
  try {
    await loader.reload("app.aireader.reading-stats", { style: "没这个选项" });
  } catch (e) {
    threw = String(e instanceof Error ? e.message : e);
  }
  check("非法配置被拒（schema 挡住）", threw.includes("配置不合法"), threw);
  check("被拒之后旧配置仍在生效", (stats()?.summary() ?? "").includes("当前位置"), String(stats()?.summary()));

  const realStats = loader.statuses().find((s) => s.id === "app.aireader.reading-stats");
  check("reload 返回最新状态", realStats?.state === "ACTIVE");
  await container.dispose();
}

// ---------- 6c) 配置不合法的插件：改好配置要能"活过来"（P3.10 修的死路） ----------
//
// 实测：AI 写的「查 DeepSeek 余额」插件把 config 里的 apiKey 标成必填 → 用户还没填 →
// 插件停在 INVALID（配置不合法不挂载）→ 而 reload 要求"已挂载"才能改配置 → **没有任何路径能让它生效**。
// 现在：配置校验通过就挂起来。
{
  const picky: BuiltinPlugin = {
    manifest: {
      id: "test.picky",
      name: "要配置的插件",
      purpose: "config 里有一个必填项，用来验证「不合法 → 改好 → 挂起来」这条路",
      version: "1.0.0",
      apiVersion: "aireader-plugin-1",
      capabilities: [],
      config: {
        type: "object",
        properties: { apiKey: { type: "string", description: "用户自己的 Key" } },
        required: ["apiKey"],
      } as never,
    },
    plugin: {
      name: "picky",
      apply() {
        /* 挂上就够：这里不需要注册什么 */
      },
    },
  };
  const container = createContainer({ log: () => {} });
  const store = createMemoryPluginStore();
  const loader = new PluginLoader(container.ctx, {
    builtins: [picky],
    fs: createMemoryPluginFs({}),
    resolveImplementation: () => picky.plugin as never,
    store,
  });
  await loader.mountAll();
  check(
    "必填配置没给 → INVALID（不挂载）",
    loader.statuses().find((s) => s.id === "test.picky")?.state === "INVALID",
    String(loader.statuses().find((s) => s.id === "test.picky")?.state),
  );

  let threw2 = "";
  try {
    await loader.reload("test.picky", {});
  } catch (e) {
    threw2 = String(e instanceof Error ? e.message : e);
  }
  check("坏配置仍然被 schema 挡住", threw2.includes("配置不合法"), threw2);

  const fixed = await loader.reload("test.picky", { apiKey: "sk-test" });
  check("补上配置后能挂起来（不再有死路）", fixed.state === "ACTIVE", fixed.state);
  check("配置写进了 store", (store.get("test.picky")?.config as { apiKey?: string })?.apiKey === "sk-test");
  await container.dispose();
}

// ---------- 6b) 热更失败要回滚（DSH 的 entry.update 立场） ----------

{
  /** 配置成 fail=true 就启动失败：用来验证"能过 schema 但挂不起来"时的回滚 */
  const flaky: BuiltinPlugin = {
    manifest: {
      id: "test.flaky",
      name: "会挑配置的插件",
      purpose: "配置成 fail=true 时启动失败，用于验证热更回滚。",
      version: "1.0.0",
      apiVersion: HOST_API_VERSION,
      config: {
        type: "object",
        properties: { fail: { type: "boolean" }, label: { type: "string" } },
        additionalProperties: false,
      },
    },
    plugin: {
      name: "flaky",
      apply(ctx, raw) {
        const cfg = (raw ?? {}) as { fail?: boolean; label?: string };
        if (cfg.fail) throw new Error("配置让它失败了");
        ctx.provide("flakyLabel", cfg.label ?? "默认");
      },
    },
  };
  const container = createContainer({ log: () => {} });
  const store = createMemoryPluginStore();
  const loader = new PluginLoader(container.ctx, {
    builtins: [flaky],
    store,
    fs: createMemoryPluginFs({}),
    resolveImplementation: (id) => (id === "test.flaky" ? flaky.plugin : undefined),
    log: () => {},
  });
  await loader.mountAll();
  const label = () => container.ctx.get<string>("flakyLabel");
  check("挑配置的插件先按默认配置起来", loader.statuses()[0].state === "ACTIVE" && label() === "默认");

  await loader.reload("test.flaky", { fail: false, label: "新版" });
  check("热更换了配置之后服务重建了", label() === "新版", String(label()));

  let threw = "";
  try {
    await loader.reload("test.flaky", { fail: true, label: "坏配置" });
  } catch (e) {
    threw = String(e instanceof Error ? e.message : e);
  }
  check("挂不起来时 reload 抛错（调用方能知道）", threw.includes("配置让它失败了"), threw);
  check("回滚后插件仍然 ACTIVE", loader.statuses()[0].state === "ACTIVE", loader.statuses()[0].state);
  check("回滚后生效的是旧配置", label() === "新版", String(label()));
  check("store 里的配置没被坏配置污染", (store.get("test.flaky")?.config as { label?: string })?.label === "新版");
  await container.dispose();
}

// ---------- 7) 内置实现映射 ----------

{
  check("内置表里三个 id 都能找到实现", BUILTIN_PLUGINS.every((b) => typeof builtinImplementation(b.manifest.id)?.apply === "function"));
  check("未知 id 回 undefined", builtinImplementation("com.example.nope") === undefined);
  check("readingStatsPlugin 有 config schema", readingStatsPlugin.manifest.config?.type === "object");
}

console.log("插件加载契约测试：" + pass + " 通过 / " + failures.length + " 失败");
if (failures.length) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("  ✓ 全部通过（manifest 校验与包哈希 / 扫描顺序与被拒原因 / 挂载分类与失败隔离 / 卸载开关与 sync / 配置热更与回滚）");
