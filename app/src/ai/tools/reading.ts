/**
 * 只读工具（P2.3）：get_toc / get_chapter / search_book / get_selection / get_reading_progress。
 *
 * 设计要点（对齐 内部设计笔记 第 3 节的六条纪律）：
 *   - 描述里写清"什么时候该用/不该用"，因为全书已在上下文时，取章节工具的价值是**兜底与精确定位**；
 *   - 大结果不整段回传：章节按 offset/maxChars 分片，检索只回片段（纪律 3：摘要 + 引用 + 可按需取回）；
 *   - 失败一定回传错误码与修正建议（纪律 2），例如章节号越界时告诉模型合法区间。
 */

import type { ToolDefinition, ToolOutcome } from "./types";
import type { ToolHost } from "./host";

const ok = (value: unknown): ToolOutcome => ({ ok: true, value });
const fail = (code: "NOT_AVAILABLE" | "NOT_FOUND" | "INVALID_ARGUMENTS", message: string, hint?: string): ToolOutcome => ({
  ok: false,
  error: { code, message, hint },
});

/** 所有阅读器工具的共同前置：必须有一本打开的书 */
function requireBook(host: ToolHost): ToolOutcome | null {
  if (host.bookId()) return null;
  if (!host.title()) {
    return fail("NOT_AVAILABLE", "当前没有打开任何书", "先让用户在书架里打开一本书");
  }
  return fail("NOT_AVAILABLE", "当前打开的不是书库里的书，无法读写批注与进度", "请用户从书架打开书籍");
}

export function createReadingTools(host: ToolHost): ToolDefinition<never>[] {
  const getToc: ToolDefinition<never> = {
    name: "get_toc",
    description:
      "列出本书目录：章节号 n、标题、该章字数，以及该章正文是否已在你的上下文里（inContext）。" +
      "n 与正文里 <<CH n=..>> 的编号一致。全书正文已在上下文时通常不需要调用；" +
      "只有在超长书（上下文里只装了前若干章）或需要确认章节号时才用。",
    parameters: {
      type: "object",
      properties: {
        from: { type: "integer", minimum: 1, description: "从第几章开始列（默认 1）" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "最多列多少章（默认 60）" },
      },
      additionalProperties: false,
    },
    executionMode: "parallel-safe",
    timeoutMs: 3000,
    async execute(args) {
      const bad = requireBook(host);
      if (bad) return bad;
      const all = host.chapters();
      if (!all.length) {
        return fail("NOT_AVAILABLE", "本书的章节索引还没准备好（全书上下文尚未装载完）",
          "可以先用 search_book 直接检索，或稍后再试");
      }
      const from = Math.max(1, Number((args as any).from ?? 1));
      const limit = Math.min(200, Number((args as any).limit ?? 60));
      const slice = all.filter((c) => c.n >= from).slice(0, limit);
      if (!slice.length) {
        return fail("NOT_FOUND", "没有从第 " + from + " 章开始的章节", "本书共 " + all.length + " 章，章节号从 1 开始");
      }
      return ok({
        book: host.title(),
        total: all.length,
        from,
        showing: slice.length,
        chapters: slice.map((c) => ({ n: c.n, title: c.title, chars: c.chars, inContext: c.inContext })),
      });
    },
    present: (_a, out) => {
      const v = out.ok ? (out.value as { showing: number; total: number }) : null;
      return {
        title: "查看目录",
        summary: v ? v.showing + "/" + v.total + " 章" : "失败",
        tone: out.ok ? "ok" : "error",
      };
    },
  };

  const getChapter: ToolDefinition<never> = {
    name: "get_chapter",
    description:
      "取某一章的正文（可按 offset 分次取长章节）。" +
      "全书已经在你的上下文里时一般是多余的——先看 get_toc 的 inContext 标记；" +
      "当 inContext 为 false（超长书只装了前若干章）、或你需要精确复述原文时再调用。",
    parameters: {
      type: "object",
      properties: {
        n: { type: "integer", minimum: 1, description: "章节号（1 起，与 <<CH n=..>> 一致）" },
        offset: { type: "integer", minimum: 0, description: "从该章第几个字符开始取（默认 0）" },
        maxChars: { type: "integer", minimum: 500, maximum: 20000, description: "本次最多返回多少字符（默认 6000）" },
      },
      required: ["n"],
      additionalProperties: false,
    },
    executionMode: "parallel-safe",
    timeoutMs: 5000,
    async execute(args) {
      const bad = requireBook(host);
      if (bad) return bad;
      const n = Number((args as any).n);
      const all = host.chapters();
      if (!all.length) {
        return fail("NOT_AVAILABLE", "本书的章节索引还没准备好（全书上下文尚未装载完）",
          "稍后再试；也可以用 search_book 直接检索");
      }
      const entry = all.find((c) => c.n === n);
      if (!entry) {
        return fail("NOT_FOUND", "没有第 " + n + " 章", "本书共 " + all.length + " 章，章节号从 1 开始");
      }
      const content = host.chapter(n, Number((args as any).offset ?? 0), Number((args as any).maxChars ?? 6000));
      if (!content) {
        return fail("NOT_FOUND", "第 " + n + " 章没有正文（可能是封面或图片页）",
          "用 get_toc 挑一个有 chars 的章节");
      }
      return ok({
        n,
        title: entry.title,
        chars: entry.chars,
        from: content.from,
        returned: content.text.length,
        truncated: content.truncated,
        ...(content.truncated
          ? { nextOffset: content.nextOffset, note: "本章还没取完，用 offset=" + content.nextOffset + " 继续" }
          : {}),
        text: content.text,
      });
    },
    present: (a, out) => ({
      title: "读第 " + (a as any).n + " 章",
      summary: out.ok
        ? (out.value as { returned: number; truncated: boolean }).returned + " 字符" +
          ((out.value as { truncated: boolean }).truncated ? "（未完）" : "")
        : "失败",
      tone: out.ok ? "ok" : "error",
    }),
  };

  const searchBook: ToolDefinition<never> = {
    name: "search_book",
    description:
      "在本书里做全文检索（本地 SQLite FTS5 逐字索引，中文可精确匹配词组）。" +
      "返回命中的章节号、章节标题与片段。适合定位人名、术语、句子出现在哪一章，" +
      "拿到章节号后再配合 get_chapter 或上下文里的对应章节回答。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索词（中文按字匹配，可用空格分隔多个词做 AND）" },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "最多返回多少条命中（默认 8）" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    executionMode: "parallel-safe",
    timeoutMs: 8000,
    async execute(args) {
      const bad = requireBook(host);
      if (bad) return bad;
      const query = String((args as any).query ?? "").trim();
      if (!query) return fail("INVALID_ARGUMENTS", "检索词不能为空", "给一个具体的词或短语");
      const limit = Math.min(20, Number((args as any).limit ?? 8));
      const hits = await host.search(query, limit);
      const all = host.chapters();
      const titled = hits.map((h) => ({
        n: h.n,
        title: all.find((c) => c.n === h.n)?.title ?? h.title,
        snippet: h.snippet,
      }));
      return ok({
        query,
        total: titled.length,
        hits: titled,
        ...(titled.length ? {} : { note: "没有命中。可以换更短的词，或去掉标点再试。" }),
      });
    },
    present: (a, out) => ({
      title: "检索「" + String((a as any).query ?? "").slice(0, 12) + "」",
      summary: out.ok ? (out.value as { total: number }).total + " 条命中" : "失败",
      tone: out.ok ? ((out.value as { total: number }).total ? "ok" : "warn") : "error",
    }),
  };

  const getSelection: ToolDefinition<never> = {
    name: "get_selection",
    description:
      "取用户此刻选中的文字（含所属章节与 CFI）。当用户说「这句话」「这段」「这里」而你无法确定指代时，用它对齐。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    executionMode: "parallel-safe",
    timeoutMs: 2000,
    async execute() {
      const bad = requireBook(host);
      if (bad) return bad;
      const sel = host.selection();
      if (!sel || !sel.text) {
        return fail("NOT_AVAILABLE", "用户现在没有选中任何文字",
          "可以让用户先划选一段；也可以改用 get_chapter 取上下文，或直接按当前阅读位置回答");
      }
      return ok({ text: sel.text, cfi: sel.cfi, chapter: sel.chapter ?? null });
    },
    present: (_a, out) => ({
      title: "读取选中文字",
      summary: out.ok ? (out.value as { text: string }).text.slice(0, 16) + "…" : "没有选中",
      tone: out.ok ? "ok" : "warn",
    }),
  };

  const progress: ToolDefinition<never> = {
    name: "get_reading_progress",
    description:
      "取用户的阅读进度（百分比、所在章节、位置）以及全书上下文装载情况（full 还是 partial、装了多少章）。" +
      "回答「我看到哪了」「还剩多少」这类问题时用它，不要靠猜。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    executionMode: "parallel-safe",
    timeoutMs: 2000,
    async execute() {
      const bad = requireBook(host);
      if (bad) return bad;
      const p = host.progress();
      const c = host.context();
      return ok({
        fraction: Math.round(p.fraction * 1000) / 1000,
        percent: Math.round(p.fraction * 100) + "%",
        chapter: p.chapter || null,
        location: p.location || null,
        context: c ? { mode: c.mode, loadedChapters: c.loadedChapters, chapters: c.chapters } : null,
      });
    },
    present: (_a, out) => ({
      title: "查看阅读进度",
      summary: out.ok ? String((out.value as { percent: string }).percent) : "失败",
      tone: out.ok ? "ok" : "error",
    }),
  };

  return [getToc, getChapter, searchBook, getSelection, progress] as ToolDefinition<never>[];
}
