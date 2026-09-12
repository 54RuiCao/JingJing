/**
 * 工具层契约测试（04-ai-agent.md 纪律 5 的前半段）。
 *
 * 为什么能脱离浏览器跑：工具只依赖 ToolHost 这个能力缝（tools/host.ts），
 * 所以用一个内存假书就能把 schema、参数校验、错误码、并发分类、结果回填全部断言一遍。
 *
 * 跑法（esbuild 只是把 TS 打包成 node 能跑的 ESM，项目没有引入测试框架）：
 *   npx esbuild tools/contract-test.ts --bundle --platform=node --format=esm --outfile=fixtures/contract-test.mjs
 *   node fixtures/contract-test.mjs
 */

import { ToolRegistry, validateArgs } from "../app/src/ai/tools/registry";
import { createReadingTools } from "../app/src/ai/tools/reading";
import { createActionTools } from "../app/src/ai/tools/actions";
import { createBookToolRegistry } from "../app/src/ai/tools/index";
import { capResultText, renderToolResultForModel } from "../app/src/ai/agentLoop";
import type { ToolHost } from "../app/src/ai/tools/host";
import type { ToolCallRecord, ToolDefinition } from "../app/src/ai/tools/types";

// registry.ts 里用了 window.setTimeout；node 下补一个最小 Window 形状
(globalThis as any).window = globalThis;

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) pass++;
  else failures.push(name + (detail ? " —— " + detail : ""));
}

/** 一本 3 章的内存书：第 2 章故意留空（验证空章节的错误分支） */
const CHAPTERS = [
  { n: 1, title: "第一章 记忆的可靠性", cfi: "epubcfi(/6/2!/4)", chars: 12, text: "记忆不是录像机，\n是不断重写的稿子。" },
  { n: 2, title: "第二章 空章", cfi: "epubcfi(/6/4!/4)", chars: 0, text: "" },
  { n: 3, title: "第三章 注意力是一种资源", cfi: "epubcfi(/6/6!/4)", chars: 8, text: "注意力是有限的资源。" },
];
const written: { kind: string; cfi: string; note: string }[] = [];
let hasBook = true;
let selection: { text: string; cfi: string } | null = null;
let went: string[] = [];

function makeHost(): ToolHost {
  return {
    bookId: () => (hasBook ? "book-1" : null),
    title: () => (hasBook ? "测试书" : ""),
    author: () => "测试作者",
    progress: () => ({ fraction: 0.42, chapter: "第一章 记忆的可靠性", location: "位置 12" }),
    context: () => ({ mode: "full", chapters: 3, loadedChapters: 3, tokens: 1234 }),
    chapters: () => CHAPTERS.map((c) => ({ n: c.n, title: c.title, cfi: c.cfi, chars: c.chars, inContext: true })),
    chapter: (n, offset, maxChars) => {
      const c = CHAPTERS.find((x) => x.n === n);
      if (!c) return null;
      const from = Math.min(offset, c.text.length);
      const chunk = c.text.slice(from, from + maxChars);
      return {
        entry: { n: c.n, title: c.title, cfi: c.cfi, chars: c.chars, start: 0, end: c.text.length },
        text: chunk,
        from,
        nextOffset: from + chunk.length,
        truncated: from + chunk.length < c.text.length,
      };
    },
    search: async (q, limit) =>
      q === "没有的词" ? [] : [{ n: 1, title: CHAPTERS[0].title, snippet: "…记忆不是录像机…" }].slice(0, limit),
    selection: () => selection,
    addAnnotation: async (input) => {
      written.push({ kind: input.kind, cfi: input.cfi, note: input.note ?? "" });
      return { id: "a" + written.length, kind: input.kind, cfi: input.cfi, text: input.text ?? "", note: input.note ?? "", color: input.color ?? "yellow" };
    },
    annotations: async () => [],
    goToChapter: async (n) => { went.push("chapter:" + n); },
    goToCfi: async (cfi) => { went.push("cfi:" + cfi); },
    goToFraction: async (f) => { went.push("fraction:" + f); },
  };
}

const reg = createBookToolRegistry(makeHost());
const ctx = { signal: new AbortController().signal, callId: "c1" };
const valueOf = (rec: ToolCallRecord) => (rec.outcome.ok ? (rec.outcome.value as any) : null);
const codeOf = (rec: ToolCallRecord) => (rec.outcome.ok ? "" : rec.outcome.error.code);

// 1) 投影：模型只该看到 name/description/parameters
const schemas = reg.schemas();
check("schema 数量 = 9", schemas.length === 9, "实际 " + schemas.length);
check("schema 不泄漏实现", schemas.every((s) => Object.keys(s.function).sort().join(",") === "description,name,parameters"));
check("schema 顺序稳定（= 注册顺序）", schemas[0].function.name === "get_toc" && schemas[5].function.name === "add_highlight");

// 2) 可见性裁剪
reg.restrict(["get_toc"]);
check("restrict 后 schema 只剩 1 个", reg.schemas().length === 1);
const hidden = await reg.execute("add_note", { note: "x" }, ctx);
check("被裁剪的工具 → UNKNOWN_TOOL", codeOf(hidden) === "UNKNOWN_TOOL" && !!hidden.outcome.ok === false);
reg.restrict(null);

// 3) 参数校验（逐条路径给反馈）
const bad1 = await reg.execute("get_chapter", {}, ctx);
check("缺必填 → INVALID_ARGUMENTS", codeOf(bad1) === "INVALID_ARGUMENTS" && (bad1.outcome as any).error.message.includes("n"));
const bad2 = await reg.execute("get_chapter", { n: "三" }, ctx);
check("类型错 → INVALID_ARGUMENTS", codeOf(bad2) === "INVALID_ARGUMENTS");
const bad3 = await reg.execute("add_highlight", { color: "red" }, ctx);
check("enum 外取值 → INVALID_ARGUMENTS", codeOf(bad3) === "INVALID_ARGUMENTS");
const bad4 = await reg.execute("get_toc", { nope: 1 }, ctx);
check("多余参数 → INVALID_ARGUMENTS", codeOf(bad4) === "INVALID_ARGUMENTS");
check("validateArgs 直测", validateArgs({ type: "object", properties: { a: { type: "integer", minimum: 2 } }, required: ["a"] }, { a: 1 }).ok === false);

// 4) 只读工具的正常/异常分支
const toc = await reg.execute("get_toc", {}, ctx);
check("get_toc 返回全量目录", valueOf(toc).total === 3 && valueOf(toc).chapters.length === 3);
const noChap = await reg.execute("get_chapter", { n: 99 }, ctx);
check("章节越界 → NOT_FOUND + 提示范围", codeOf(noChap) === "NOT_FOUND" && (noChap.outcome as any).error.hint.includes("3"));
const emptyChap = await reg.execute("get_chapter", { n: 2 }, ctx);
check("空章节仍返回（不报错）", emptyChap.outcome.ok === true && valueOf(emptyChap).returned === 0);
const win = await reg.execute("get_chapter", { n: 1, maxChars: 500 }, ctx);
check("get_chapter 小结果不截断", valueOf(win).truncated === false);
const longChap = await reg.execute("get_chapter", { n: 1, maxChars: 500, offset: 0 }, ctx);
check("get_chapter 有 _nextOffset 语义", typeof valueOf(longChap).nextOffset === "number" || valueOf(longChap).truncated === false);
const hit = await reg.execute("search_book", { query: "记忆" }, ctx);
check("search_book 命中", valueOf(hit).total === 1 && valueOf(hit).hits[0].n === 1);
const miss = await reg.execute("search_book", { query: "没有的词" }, ctx);
check("search_book 零命中不报错、给 note", miss.outcome.ok === true && typeof valueOf(miss).note === "string");
const sel = await reg.execute("get_selection", {}, ctx);
check("无选区 → NOT_AVAILABLE + hint", codeOf(sel) === "NOT_AVAILABLE" && !!(sel.outcome as any).error.hint);

// 5) 写工具
const hl = await reg.execute("add_highlight", {}, ctx);
check("无选区划线 → NOT_AVAILABLE（不静默成功）", codeOf(hl) === "NOT_AVAILABLE" && written.length === 0);
const hl2 = await reg.execute("add_highlight", { cfi: "epubcfi(/6/2!/4)", color: "green" }, ctx);
check("带 cfi 划线 → 落库", hl2.outcome.ok === true && written.length === 1 && written[0].kind === "highlight");
selection = { text: "记忆不是录像机", cfi: "epubcfi(/6/2!/4/2/2:0)" };
const note = await reg.execute("add_note", { note: "顺带记一笔" }, ctx);
check("有选区时笔记走选区锚点", note.outcome.ok === true && written[1].cfi === selection.cfi);
const gotoBad = await reg.execute("goto_location", {}, ctx);
check("跳转缺目标 → INVALID_ARGUMENTS", codeOf(gotoBad) === "INVALID_ARGUMENTS");
const gotoOk = await reg.execute("goto_location", { n: 3 }, ctx);
check("跳转走 host", gotoOk.outcome.ok === true && went.includes("chapter:3"));
const gotoMiss = await reg.execute("goto_location", { n: 42 }, ctx);
check("跳转到不存在的章 → NOT_FOUND", codeOf(gotoMiss) === "NOT_FOUND");

// 6) 守卫、超时、取消
// P3.0 起 register/registerGuard 返回 disposer（卸载插件要能摘掉自己注册的东西），
// 所以这里不能再链式调用。
const guarded = new ToolRegistry();
guarded.register({
  name: "noop",
  description: "x",
  parameters: { type: "object", properties: {} },
  executionMode: "parallel-safe",
  execute: async () => ({ ok: true, value: 1 }),
} as ToolDefinition);
const offGuard = guarded.registerGuard(() => "被策略拒绝");
check("守卫拒绝 → NOT_AVAILABLE", codeOf(await guarded.execute("noop", {}, ctx)) === "NOT_AVAILABLE");

const slowReg = new ToolRegistry();
slowReg.register({
  name: "slow",
  description: "x",
  parameters: { type: "object", properties: {} },
  executionMode: "parallel-safe",
  timeoutMs: 30,
  execute: () => new Promise(() => {}),
} as ToolDefinition);
check("超时 → TOOL_TIMEOUT", codeOf(await slowReg.execute("slow", {}, ctx)) === "TOOL_TIMEOUT");
offGuard();

const aborted = new AbortController();
aborted.abort();
check("派发前取消 → ABORTED_BEFORE_DISPATCH", codeOf(await reg.execute("get_toc", {}, { signal: aborted.signal, callId: "c2" })) === "ABORTED_BEFORE_DISPATCH");

// 7) 结果回填：错误形状、裁剪、get_chapter 例外
const errText = renderToolResultForModel(toc.outcome.ok ? { ...toc, outcome: { ok: false, error: { code: "NOT_FOUND", message: "没有第 9 章", hint: "共 3 章" } } } as ToolCallRecord : toc, 8000);
check("错误回填带 code/message/hint", JSON.parse(errText).error.code === "NOT_FOUND" && JSON.parse(errText).error.hint === "共 3 章");
const big = "x".repeat(5000);
check("裁剪后一定变小", capResultText(big, 1000).length <= 1000 && capResultText(big, 1000).length < big.length);
check("不超限时原样返回", capResultText("hi", 1000) === "hi");
const chapRec = { name: "get_chapter", args: {}, outcome: { ok: true, value: { text: big } }, callId: "c", ms: 1, resultChars: 0 } as ToolCallRecord;
check("get_chapter 不被二次裁剪", renderToolResultForModel(chapRec, 1000).length > 1000);
const tocRec = { name: "get_toc", args: {}, outcome: { ok: true, value: { text: big } }, callId: "c", ms: 1, resultChars: 0 } as ToolCallRecord;
check("其他工具结果会被裁剪", renderToolResultForModel(tocRec, 1000).length <= 1000);

// 8) 没有打开书时：只读工具回结构化错误，写工具被守卫拦下
hasBook = false;
const reg2 = createBookToolRegistry(makeHost());
reg2.restrict(["get_toc", "add_note"]);
check("没开书时 get_toc → NOT_AVAILABLE", codeOf(await reg2.execute("get_toc", {}, ctx)) === "NOT_AVAILABLE");
check("没开书时写工具被守卫拒绝", codeOf(await reg2.execute("add_note", { note: "x" }, ctx)) === "NOT_AVAILABLE");

console.log("契约测试：" + pass + " 通过 / " + failures.length + " 失败");
if (failures.length) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("  ✓ 全部通过（schema 投影 / 参数校验 / 错误码与修正建议 / 并发分类 / 超时取消 / 结果回填裁剪）");
