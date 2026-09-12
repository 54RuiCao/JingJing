/**
 * P2.5 技能包契约测试。
 *
 * 跑法（与 tools/contract-test.ts 同一套：esbuild 打包成 node 能跑的 ESM）：
 *   cd app && npx esbuild ../tools/skills-test.ts --bundle --platform=node --format=esm --outfile=../fixtures/skills-test.mjs
 *   node ../fixtures/skills-test.mjs
 *
 * 为什么能脱离浏览器跑：技能层只依赖「文件 IO 缝」（loader.ts 的 SkillFsDeps）与注册表，
 * 所以一个内存技能目录就能把解析容错、同名裁决、目录 digest、工具分支全部断言一遍。
 */

import {
  parseSkillFile,
  splitFrontmatter,
  parseYamlSubset,
  formatSkillFile,
} from "../app/src/skills/parse";
import { SkillRegistry, catalogDigest, normalizeDescription, parseSkillGestures, matchSkillSlash } from "../app/src/skills/registry";
import { createBuiltinSkillProvider, BUILTIN_SKILL_NAMES } from "../app/src/skills/builtin";
import { createUserSkillProvider, type SkillFileEntry } from "../app/src/skills/loader";
import { renderSkillContent, neutralizeBlockMarkers } from "../app/src/skills/render";
import { createSkillTools } from "../app/src/ai/tools/skills";
import { buildRequestMessages, buildSkillCatalogMessage } from "../app/src/ai/prompt";
import type { ToolOutcome } from "../app/src/ai/tools/types";

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) pass++;
  else failures.push(name + (detail ? " —— " + detail : ""));
}

const val = (o: ToolOutcome) => (o.ok ? (o.value as any) : null);
const code = (o: ToolOutcome) => (o.ok ? "" : o.error.code);
const ctx = { signal: new AbortController().signal, callId: "c1" };
const rec = async (fn: () => Promise<ToolOutcome>): Promise<ToolOutcome> => fn();

// ---------- 1) frontmatter 解析：容错语义照 DSH ----------

const GOOD = [
  "---",
  "name: close-reading",
  "description: 逐句精读一段文字，引用原文并给出 [CH n]。",
  "whenToUse: 用户明确要求逐句分析时",
  "metadata: { category: reading, level: 2 }",
  "disable-model-invocation: false",
  "user-invocable: yes",
  "---",
  "",
  "正文第一行",
  "正文第二行",
].join("\n");

const good = parseSkillFile(GOOD, "close-reading/SKILL.md");
check("正常文件解析成功", good.ok, good.ok ? "" : good.error);
check("名字取自 frontmatter", good.ok && good.skill.name === "close-reading");
check("描述取到", good.ok && good.skill.description.includes("逐句精读"));
check("whenToUse 取到", good.ok && good.skill.whenToUse === "用户明确要求逐句分析时");
check("默认双向开放", good.ok && good.skill.invocation.modelInvocable && good.skill.invocation.userInvocable);
check("yes 被当作 true", good.ok && good.skill.invocation.userInvocable === true);
check("正文 trim 后保留换行", good.ok && good.skill.content === "正文第一行\n正文第二行");
check("metadata 行内映射", good.ok && (good.skill.metadata as any)?.category === "reading");

// 首行不是 --- → 整个文件丢弃
check("首行不是 --- → 报错", !parseSkillFile("name: x\ndescription: y").ok);
// 没有闭合 ---
check("没有闭合 --- → 报错", !parseSkillFile("---\nname: x\ndescription: y").ok);
// 没有 name
check("缺 name → 报错", !parseSkillFile("---\ndescription: y\n---\nbody").ok);
// name 不是 kebab
const badName = parseSkillFile("---\nname: Close_Reading\ndescription: y\n---\nbody");
check("name 非 kebab → 报错且提示规则", !badName.ok && badName.error.includes("kebab-case"));
// 空 description
check("空 description → 报错", !parseSkillFile("---\nname: a-b\ndescription: \"\"\n---\nbody").ok);
// 旧键名显式拒绝
const legacy = parseSkillFile("---\nname: a-b\ndescription: y\ndisableModelInvocation: true\n---\nbody");
check("旧键名被显式拒绝", !legacy.ok && legacy.error.includes("disable-model-invocation"));
// 布尔字段非法值 → 报错，不静默放行
const badBool = parseSkillFile("---\nname: a-b\ndescription: y\nuser-invocable: maybe\n---\nbody");
check("布尔非法值 → 报错", !badBool.ok && badBool.error.includes("user-invocable"));
// 未知字段静默忽略
const unknownField = parseSkillFile("---\nname: a-b\ndescription: y\ntools: [get_toc]\n---\nbody");
check("未知字段被忽略（tools 不是我们的字段）", unknownField.ok);
// 目录名与技能名无关（名字只来自 frontmatter）
const mismatch = parseSkillFile("---\nname: bar\ndescription: y\n---\nbody", "skills/foo/SKILL.md");
check("目录名不影响技能名", mismatch.ok && mismatch.skill.name === "bar");
// CRLF 兼容
const crlf = parseSkillFile("---\r\nname: a-b\r\ndescription: y\r\n---\r\nbody\r\n");
check("CRLF 兼容", crlf.ok && crlf.skill.content === "body");
// 块标量
const block = parseSkillFile("---\nname: a-b\ndescription: |\n  第一行\n  第二行\n---\nbody");
check("块标量 | 保留换行", block.ok && block.skill.description === "第一行\n第二行");
// 嵌套映射（metadata 缩进写法）
const nested = parseYamlSubset("metadata:\n  category: reading\n  level: 3\nother: 1");
check("嵌套映射可解析", (nested as any).metadata?.level === 3 && (nested as any).other === 1);
// 注释与引号
const quoted = parseYamlSubset('name: a-b\ndescription: "带 # 号 与: 冒号" # 行尾注释');
check("引号内的 # 不当注释", (quoted as any).description === "带 # 号 与: 冒号");
check("splitFrontmatter 直测", splitFrontmatter("---\na: 1\n---\nbody").ok);
// formatSkillFile → parseSkillFile 往返
const round = parseSkillFile(formatSkillFile({ name: "a-b", description: '含 " 引号 与\n换行', body: "正文" }));
check("format→parse 往返", round.ok && round.skill.description === '含 " 引号 与\n换行', round.ok ? JSON.stringify(round.skill.description) : round.error);
check("目录渲染把换行折叠成空格", round.ok && normalizeDescription(round.skill.description) === '含 " 引号 与 换行');

// ---------- 2) 注册表：同名裁决 / digest / 目录 ----------

const reg = new SkillRegistry();
const disposeBuiltin = reg.registerProvider(createBuiltinSkillProvider());
await reg.refresh();
check("内置技能都进了目录", reg.catalog().entries.length === BUILTIN_SKILL_NAMES.length);
check("目录按名字代码序", reg.catalog().entries.map((e) => e.name).join() === [...BUILTIN_SKILL_NAMES].sort().join());

const d1 = catalogDigest([{ name: "a", description: "x" }]);
const d2 = catalogDigest([{ name: "a", description: "x" }]);
const d3 = catalogDigest([{ name: "a", description: "y" }]);
check("digest 确定性", d1 === d2 && d1.length === 16);
check("描述变了 digest 就变", d1 !== d3);
check("顺序敏感（同集合不同序 → 不同 digest）", catalogDigest([{ name: "a", description: "1" }, { name: "b", description: "2" }]) !== catalogDigest([{ name: "b", description: "2" }, { name: "a", description: "1" }]));

// 用户技能 rank 更低 → 覆盖同名内置技能
const files: Record<string, string> = {
  "close-reading/SKILL.md": "---\nname: close-reading\ndescription: 用户版精读\n---\n用户正文",
  "close-reading/references/checklist.md": "# 清单\n- 一\n- 二",
  "essay/SKILL.md": "---\nname: essay\ndescription: 写读书笔记\nuser-invocable: false\n---\n笔记正文",
  "only-user/SKILL.md": "---\nname: only-user\ndescription: 只给用户直呼\ndisable-model-invocation: true\n---\n只给用户",
  "broken/SKILL.md": "name: 没有 frontmatter",
  "flat.md": "---\nname: flat-skill\ndescription: 平铺形态\n---\n平铺正文",
};
const entryList: SkillFileEntry[] = [
  { relPath: "close-reading/SKILL.md", dirRel: "close-reading", absDir: "X:/skills/close-reading", resources: ["references/checklist.md"] },
  { relPath: "essay/SKILL.md", dirRel: "essay", absDir: "X:/skills/essay", resources: [] },
  { relPath: "only-user/SKILL.md", dirRel: "only-user", absDir: "X:/skills/only-user", resources: [] },
  { relPath: "broken/SKILL.md", dirRel: "broken", absDir: "X:/skills/broken", resources: [] },
  { relPath: "flat.md", dirRel: "", absDir: "X:/skills", resources: [] },
];
const user = createUserSkillProvider({
  list: async () => entryList,
  read: async (rel) => {
    const t = files[rel];
    if (t === undefined) throw new Error("没有这个文件：" + rel);
    return t;
  },
});
const disposeUser = reg.registerProvider(user);
// list() 只回上一次扫描的结果：真正的读盘发生在 refresh()（生产里由 SkillHost.refresh 调）
await user.refresh();
const refreshed = await reg.refresh();
check("用户技能进入目录", restored(reg, "close-reading")?.source === "user");
check("同名用户技能盖住内置（rank 400 < 600）", reg.catalog().entries.find((e) => e.name === "close-reading")?.description === "用户版精读");
check("被盖住的候选记进 shadowed", reg.catalog().shadowed.some((s) => s.name === "close-reading" && s.provider === "builtin"));
check("写坏的文件进告警而不是静默消失", reg.catalog().warnings.some((w) => w.includes("broken/SKILL.md")));
check("平铺文件也能被发现", !!restored(reg, "flat-skill"));
check("user-invocable: false 的技能仍在目录（模型可用）", reg.catalog().entries.some((e) => e.name === "essay"));
check("disable-model-invocation 的技能不进目录", !reg.catalog().entries.some((e) => e.name === "only-user"));
check("但它仍是候选（用户 /only-user 能调）", !!restored(reg, "only-user"));
check("用户可调用的候选里能看到它", reg.userInvocable().some((c) => c.name === "only-user"));
check("模型可调用的候选里看不到它", !reg.modelInvocable().some((c) => c.name === "only-user"));
void refreshed;

function restored(r: SkillRegistry, name: string) {
  return r.candidates().find((c) => c.name === name);
}

// 正文每次重新读（改了正文立刻生效，不需要任何缓存失效）
const def1 = await reg.get("close-reading");
check("get 返回用户版正文", def1?.content === "用户正文");
check("get 带资源清单", (def1?.resources ?? []).includes("references/checklist.md"));
check("resourceBase 是技能目录", def1?.resourceBase?.kind === "directory" && (def1?.resourceBase as any).path.includes("close-reading"));
files["close-reading/SKILL.md"] = "---\nname: close-reading\ndescription: 用户版精读\n---\n改过的正文";
const def2 = await reg.get("close-reading");
check("正文不缓存：改完立刻是新的", def2?.content === "改过的正文");

// 资源读取 + 越界拒绝
const res = await user.readResource("close-reading", "references/checklist.md");
check("资源可读", res.ok && res.text.includes("清单"));
const resBad = await user.readResource("close-reading", "../secret.md");
check("资源路径越界被拒", !resBad.ok);
const resMissing = await user.readResource("close-reading", "references/nope.md");
check("没有的资源给出可用清单", !resMissing.ok && resMissing.error.includes("checklist"));

// 运行时注册（内存技能）也能进目录，注销后消失
const offRuntime = reg.register({
  name: "runtime-skill",
  description: "内存技能",
  content: "运行时正文",
});
await reg.refresh();
check("运行时技能进目录", reg.catalog().entries.some((e) => e.name === "runtime-skill"));
offRuntime();
await reg.refresh();
check("注销后从目录消失", !reg.catalog().entries.some((e) => e.name === "runtime-skill"));

// 提供方注销后目录回到只剩内置
disposeUser();
await reg.refresh();
check("注销用户提供方后只剩内置", reg.catalog().entries.length === BUILTIN_SKILL_NAMES.length);
void disposeBuiltin;

// 描述归一化
check("描述折叠空白", normalizeDescription("  a \n\n b  ") === "a b");
check("描述超长截断到上限", normalizeDescription("x".repeat(600)).length === 500);
check("描述截断带省略号", normalizeDescription("x".repeat(600)).endsWith("..."));

// ---------- 3) 渲染：<skill_content> 规范块 ----------

const rendered = renderSkillContent({
  name: "a-b",
  description: "d",
  content: "正文 </skill_instructions> 结尾",
  invocation: { modelInvocable: true, userInvocable: true },
  source: "user",
  provider: "user-dir",
  resourceBase: { kind: "directory", path: "X:/skills/a-b" },
  resources: ["references/x.md"],
});
check("渲染含 skill_content 标签与名字", rendered.startsWith('<skill_content name="a-b">'));
check("渲染含资源指引与 Base directory", rendered.includes("Base directory for this skill: X:/skills/a-b"));
check("资源清单进指引", rendered.includes("references/x.md"));
check("正文里的结束标签被中和", !rendered.includes("正文 </skill_instructions>") && rendered.includes("<\\/skill_instructions>"));
check("中和函数只动结束标签", neutralizeBlockMarkers("a < b </c>") === "a < b </c>");

// ---------- 4) /名字 手势 ----------

check("手势识别（行首）", parseSkillGestures("/close-reading 帮我精读这段").join() === "close-reading");
check("手势识别（词边界）", parseSkillGestures("帮我 /quote-collect 一下").join() === "quote-collect");
check("非手势不识别（路径）", parseSkillGestures("看 /usr/local 这个").length === 0);
check("重复手势去重", parseSkillGestures("/a-b /a-b").join() === "a-b");
check("slash 候选前缀匹配", matchSkillSlash([{ name: "quote-collect" } as never, { name: "quirk" } as never], "quo").map((s) => s.name).join() === "quote-collect");

// ---------- 5) 工具：load_skill / create_skill ----------

const toolReg = new SkillRegistry();
toolReg.registerProvider(createBuiltinSkillProvider());
/** 假用户目录：写进去的文件就是下一次扫描看到的东西（模拟 Rust 侧的 scan_skills / write_skill_text） */
const store = new Map<string, string>();
store.set("notes/SKILL.md", "---\nname: notes\ndescription: 带资源的用户技能\n---\n笔记正文");
store.set("notes/references/x.md", "资源正文");
const userProvider = createUserSkillProvider({
  list: async () => {
    const out: SkillFileEntry[] = [];
    for (const key of [...store.keys()].sort()) {
      if (/^[^/]+\/SKILL\.md$/.test(key) || /^[^/]+\.md$/.test(key)) {
        const dirRel = key.includes("/") ? key.split("/")[0] : "";
        const resources = [...store.keys()]
          .filter((k) => dirRel && k.startsWith(dirRel + "/") && k !== key)
          .map((k) => k.slice(dirRel.length + 1));
        out.push({ relPath: key, dirRel, absDir: "X:/skills/" + dirRel, resources });
      }
    }
    return out;
  },
  read: async (rel) => {
    const t = store.get(rel);
    if (t === undefined) throw new Error("没有这个文件：" + rel);
    return t;
  },
});
toolReg.registerProvider(userProvider);
const tools = createSkillTools({
  registry: toolReg,
  write: async (rel, text, opts) => {
    if (store.has(rel) && !opts.overwrite) throw new Error("技能文件已存在（覆盖需要 overwrite=true）: " + rel);
    store.set(rel, text);
    return "X:/skills/" + rel;
  },
  refresh: async () => {
    await userProvider.refresh();
    await toolReg.refresh();
  },
  readResource: (name, rel) => userProvider.readResource(name, rel),
  skillsDir: () => "X:/skills",
});
await userProvider.refresh();
await toolReg.refresh();
const byName = new Map(tools.map((t) => [t.name, t]));
check("技能工具名与顺序", tools.map((t) => t.name).join() === "load_skill,create_skill");
check("load_skill 是并行安全的只读工具", byName.get("load_skill")!.executionMode === "parallel-safe");
check("create_skill 是独占工具", byName.get("create_skill")!.executionMode === "exclusive");

const loaded = await rec(() => byName.get("load_skill")!.execute({ name: "close-reading" }, ctx));
check("load_skill 拿到 <skill_content>", val(loaded).instructions.includes("<skill_instructions>"));
check("load_skill 带 provider", val(loaded).provider === "builtin");
const notFound = await rec(() => byName.get("load_skill")!.execute({ name: "no-such" }, ctx));
check("未知技能 → NOT_FOUND + 可用清单", code(notFound) === "NOT_FOUND" && notFound.ok === false && notFound.error.hint.includes("close-reading"));
const badKebab = await rec(() => byName.get("load_skill")!.execute({ name: "Not_Kebab" }, ctx));
check("非法名字 → INVALID_ARGUMENTS", code(badKebab) === "INVALID_ARGUMENTS");
const userLoaded = await rec(() => byName.get("load_skill")!.execute({ name: "notes" }, ctx));
check("load_skill 也能加载用户技能", val(userLoaded).provider === "user-dir" && val(userLoaded).instructions.includes("笔记正文"));
check("用户技能的 Base directory 进指引", val(userLoaded).instructions.includes("X:/skills/notes"));
const resource = await rec(() => byName.get("load_skill")!.execute({ name: "notes", file: "references/x.md" }, ctx));
check("资源分支返回内容与提醒", val(resource).content === "资源正文" && String(val(resource).note).includes("数据文件"));
const resourceMissing = await rec(() => byName.get("load_skill")!.execute({ name: "notes", file: "references/nope.md" }, ctx));
check("资源不存在 → NOT_FOUND", code(resourceMissing) === "NOT_FOUND");

// disable-model-invocation 的技能：模型不能加载
const offModel = toolReg.register({
  name: "user-only",
  description: "只给用户用",
  content: "正文",
  invocation: { modelInvocable: false, userInvocable: true },
});
await toolReg.refresh();
const blocked = await rec(() => byName.get("load_skill")!.execute({ name: "user-only" }, ctx));
check("disable-model-invocation → NOT_AVAILABLE", code(blocked) === "NOT_AVAILABLE" && !toolReg.catalog().entries.some((e) => e.name === "user-only"));
offModel();
await toolReg.refresh();

// create_skill：只写数据
const created = await rec(() =>
  byName.get("create_skill")!.execute(
    {
      name: "my-flow",
      description: "用户让我以后都这么答",
      body: "# 我的流程\n1. 先看目录",
      references: [{ path: "references/notes.md", content: "# 备注" }],
    },
    ctx,
  ),
);
check("create_skill 成功", created.ok, created.ok ? "" : JSON.stringify(created));
check("写入 SKILL.md 与资源", [...store.keys()].sort().join() === "my-flow/SKILL.md,my-flow/references/notes.md,notes/SKILL.md,notes/references/x.md");
check("写入内容是带 frontmatter 的 Markdown", (store.get("my-flow/SKILL.md") ?? "").startsWith("---\nname: my-flow\n"));
check("生成的 frontmatter 标了来源", (store.get("my-flow/SKILL.md") ?? "").includes('"createdBy":"ai"'));
check("create_skill 不生成任何代码文件", ![...store.keys()].some((k) => !k.endsWith(".md")));
check("新技能立刻进目录（下一轮就能用）", toolReg.catalog().entries.some((e) => e.name === "my-flow"));
const again = await rec(() =>
  byName.get("create_skill")!.execute({ name: "my-flow", description: "d", body: "b" }, ctx),
);
check("同名已存在 → 要求 overwrite", code(again) === "INVALID_ARGUMENTS" && !again.ok && again.error.hint.includes("overwrite"));
const collide = await rec(() =>
  byName.get("create_skill")!.execute({ name: "close-reading", description: "d", body: "b" }, ctx),
);
check("与内置技能重名被拒", code(collide) === "INVALID_ARGUMENTS");
const badRef = await rec(() =>
  byName.get("create_skill")!.execute(
    { name: "another-one", description: "d", body: "b", references: [{ path: "scripts/run.js", content: "x" }] },
    ctx,
  ),
);
check("资源路径非 references/*.md 被拒", code(badRef) === "INVALID_ARGUMENTS");
const badDesc = await rec(() => byName.get("create_skill")!.execute({ name: "x-y", description: "z".repeat(501), body: "b" }, ctx));
check("description 超 500 被拒", code(badDesc) === "INVALID_ARGUMENTS");
// 参数 schema 校验（走注册表统一流水线时也一样）
check("create_skill schema 要求 body", (byName.get("create_skill")!.parameters as any).required.includes("body"));
check("load_skill schema 只有 name/file", Object.keys((byName.get("load_skill")!.parameters as any).properties).sort().join() === "file,name");

// ---------- 6) 请求组装：目录的位置与稳定性 ----------

const snapshot = toolReg.catalog();
const msgOpts = {
  data: null,
  brief: { title: "测试书" },
  history: [{ role: "user" as const, content: "旧问题" }],
  question: "新问题",
};
const first = buildRequestMessages({ ...msgOpts, catalog: { snapshot, isUpdate: false } });
check("目录在全书块与确认之后、历史之前", first[3].content.includes("<available_skills>") && first[4].content === "旧问题");
const againMsg = buildRequestMessages({ ...msgOpts, catalog: { snapshot, isUpdate: false } });
check("同样的技能集 → 目录逐字节相同（前缀可缓存）", first[3].content === againMsg[3].content);
check("技能集没变时不发替换形态", !first[3].content.includes("替换"));
const changed = buildRequestMessages({ ...msgOpts, catalog: { snapshot, isUpdate: true } });
check("技能集变了发全量替换形态", changed[3].content.includes("替换"));
const noSkills = buildRequestMessages(msgOpts);
check("没给目录 → 请求少一条消息", noSkills.length === first.length - 1);
const withSkillMsg = buildRequestMessages({
  ...msgOpts,
  catalog: { snapshot, isUpdate: false },
  skillMessages: [{ role: "user", content: "<skill_content name=\"x\">…" }],
});
check("/名字 注入在历史之后、问题之前", withSkillMsg[withSkillMsg.length - 2].content.startsWith("<skill_content"));
check("目录消息是 user 角色（不进 system）", first[3].role === "user");
check("目录里没有 path/rank/provider 之类泄漏", !first[3].content.includes("X:/skills") && !first[3].content.includes("builtin"));
check("目录渲染函数与请求组装一致", buildSkillCatalogMessage(snapshot).content === first[3].content);

// ---------- 7) 内置技能自身的质量门（数据也是要有约束的） ----------

for (const name of BUILTIN_SKILL_NAMES) {
  const def = await toolReg.get(name);
  const okName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
  const desc = def?.description ?? "";
  check("内置技能 " + name + " 名字合法", okName);
  check("内置技能 " + name + " 描述非空且 ≤500", desc.length > 0 && desc.length <= 500, String(desc.length));
  check(
    "内置技能 " + name + " 描述不含会变的内容（书/章/页/日期）",
    !/[《》]|第\s*\d+\s*章|\d{4}-\d{2}-\d{2}|今天|现在/.test(desc),
  );
  check("内置技能 " + name + " 正文非空", (def?.content ?? "").length > 50);
}

console.log("技能契约测试：" + pass + " 通过 / " + failures.length + " 失败");
if (failures.length) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("  ✓ 全部通过（frontmatter 容错 / 同名裁决 / digest / 资源读取 / 手势 / 两个工具 / 请求组装位置）");
