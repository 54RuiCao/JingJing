/**
 * 动作工具（P2.3）：add_highlight / add_note / goto_location / list_annotations。
 *
 * 这些工具都标成 executionMode: "exclusive"——它们是写操作，也是"独占调用形成排序屏障"的那一类
 * （对齐 dsh-agent-loop：并行安全调用可重叠，独占调用单独跑，结果按模型发出的顺序回填）。
 *
 * 纪律：模型不能只说不做。用户说"帮我划线/记一笔/带我去第 N 章"时，必须真的落到数据里，
 * 且返回结果要能对上用户看得见的变化（侧栏多一条、阅读器跳过去了）。
 */

import type { ToolDefinition, ToolErrorCode, ToolOutcome } from "./types";
import type { ToolHost } from "./host";

const ok = (value: unknown): ToolOutcome => ({ ok: true, value });
const fail = (code: ToolErrorCode, message: string, hint?: string): ToolOutcome => ({
  ok: false,
  error: { code, message, hint },
});

const COLORS = ["yellow", "green", "blue", "pink"];

function requireBook(host: ToolHost): ToolOutcome | null {
  if (host.bookId()) return null;
  return fail("NOT_AVAILABLE", "当前没有打开书库里的书，无法写入批注或跳转", "先让用户从书架打开一本书");
}

/** 划线/笔记的公共取位置逻辑：优先显式 cfi，其次当前选区 */
function resolveAnchor(
  host: ToolHost,
  args: { cfi?: unknown; text?: unknown },
): { cfi: string; text: string } | ToolOutcome {
  const cfi = typeof args.cfi === "string" ? args.cfi.trim() : "";
  if (cfi) {
    return { cfi, text: typeof args.text === "string" ? args.text : "" };
  }
  const sel = host.selection();
  if (sel?.cfi) return { cfi: sel.cfi, text: sel.text };
  return fail(
    "NOT_AVAILABLE",
    "没有可标注的位置：既没给 cfi，用户当前也没有选中文字",
    "先让用户划选一段话，或从 get_selection / 上下文里的 cfi 取值后再调用",
  );
}

const isOutcome = (v: unknown): v is ToolOutcome =>
  typeof v === "object" && v !== null && "ok" in (v as Record<string, unknown>);

export function createActionTools(host: ToolHost): ToolDefinition<never>[] {
  const addHighlight: ToolDefinition<never> = {
    name: "add_highlight",
    description:
      "给一段文字加高亮（划线）。不传 cfi 时默认用用户当前选中的文字。" +
      "用户说「这句划一下」「标记这里」时用它；调用后书页与侧栏会立刻出现这条划线。",
    parameters: {
      type: "object",
      properties: {
        color: { type: "string", enum: COLORS, description: "颜色，默认 yellow" },
        note: { type: "string", description: "可选：同时附一条笔记" },
        cfi: { type: "string", description: "可选：显式指定位置（不传就用当前选区）" },
        text: { type: "string", description: "可选：与 cfi 搭配的原文片段" },
      },
      additionalProperties: false,
    },
    executionMode: "exclusive",
    timeoutMs: 8000,
    async execute(args) {
      const bad = requireBook(host);
      if (bad) return bad;
      const anchor = resolveAnchor(host, args as never);
      if (isOutcome(anchor)) return anchor;
      const color = COLORS.includes(String((args as any).color)) ? String((args as any).color) : "yellow";
      const row = await host.addAnnotation({
        kind: "highlight",
        cfi: anchor.cfi,
        text: anchor.text,
        note: typeof (args as any).note === "string" ? (args as any).note : "",
        color,
      });
      return ok({ id: row.id, cfi: row.cfi, color: row.color, text: row.text.slice(0, 60) });
    },
    present: (_a, out) => ({
      title: "加高亮",
      summary: out.ok ? "已划线（" + String((out.value as { color: string }).color) + "）" : "失败",
      tone: out.ok ? "ok" : "error",
    }),
  };

  const addNote: ToolDefinition<never> = {
    name: "add_note",
    description:
      "给一段文字加笔记（note 是笔记正文，必填）。不传 cfi 时默认用用户当前选中的文字。" +
      "适合把理解、疑问、联想沉淀到书里；调用后侧栏批注列表会多一条。",
    parameters: {
      type: "object",
      properties: {
        note: { type: "string", description: "笔记正文" },
        cfi: { type: "string", description: "可选：显式指定位置（不传就用当前选区）" },
        text: { type: "string", description: "可选：与 cfi 搭配的原文片段" },
      },
      required: ["note"],
      additionalProperties: false,
    },
    executionMode: "exclusive",
    timeoutMs: 8000,
    async execute(args) {
      const bad = requireBook(host);
      if (bad) return bad;
      const note = String((args as any).note ?? "").trim();
      if (!note) return fail("INVALID_ARGUMENTS", "笔记正文不能为空", "给一句具体的笔记内容");
      const anchor = resolveAnchor(host, args as never);
      if (isOutcome(anchor)) return anchor;
      const row = await host.addAnnotation({
        kind: "note",
        cfi: anchor.cfi,
        text: anchor.text,
        note,
        color: "blue",
      });
      return ok({ id: row.id, cfi: row.cfi, note: row.note.slice(0, 80) });
    },
    present: (_a, out) => ({
      title: "加笔记",
      summary: out.ok ? "已记录" : "失败",
      tone: out.ok ? "ok" : "error",
    }),
  };

  const gotoLocation: ToolDefinition<never> = {
    name: "goto_location",
    description:
      "把阅读器跳到指定位置：章节号 n、CFI、或全书百分比 fraction（0–1）。三者至少给一个。" +
      "用户说「带我去某处」「翻到那一章」时用它；跳转后用户立刻能看见。",
    parameters: {
      type: "object",
      properties: {
        n: { type: "integer", minimum: 1, description: "章节号（1 起）" },
        cfi: { type: "string", description: "EPUB CFI 位置" },
        fraction: { type: "number", minimum: 0, maximum: 1, description: "全书百分比，0–1" },
      },
      additionalProperties: false,
    },
    executionMode: "exclusive",
    timeoutMs: 8000,
    async execute(args) {
      const bad = requireBook(host);
      if (bad) return bad;
      const a = args as { n?: number; cfi?: string; fraction?: number };
      try {
        if (typeof a.n === "number") {
          const all = host.chapters();
          const entry = all.find((c) => c.n === a.n);
          if (!entry) {
            return fail("NOT_FOUND", "没有第 " + a.n + " 章",
              all.length ? "本书共 " + all.length + " 章" : "章节索引还没准备好");
          }
          // P3.7：优先用 href 跳。单文件 EPUB（一节多章）里 n 不再等于节号，
          // goToSection(n - 1) 会跳到整节开头（一本单文件中文 EPUB46 章全在同一节里）。
          if (entry.href) await host.goToHref(entry.href);
          else await host.goToChapter(a.n);
          return ok({ moved: "chapter", n: a.n, title: entry.title });
        }
        if (typeof a.cfi === "string" && a.cfi) {
          await host.goToCfi(a.cfi);
          return ok({ moved: "cfi", cfi: a.cfi });
        }
        if (typeof a.fraction === "number") {
          await host.goToFraction(Math.min(1, Math.max(0, a.fraction)));
          return ok({ moved: "fraction", fraction: a.fraction });
        }
        return fail("INVALID_ARGUMENTS", "没有给跳转目标", "至少要给 n、cfi 或 fraction 之一");
      } catch (e) {
        return fail("INTERNAL", "跳转失败：" + String(e), "可以改试章节号 n");
      }
    },
    present: (a, out) => ({
      title: "跳转位置",
      summary: out.ok
        ? "已跳到 " + (("n" in (a as object) && (a as any).n) ? "第 " + (a as any).n + " 章" : (a as any).cfi ? "指定 CFI" : "指定百分比")
        : "失败",
      tone: out.ok ? "ok" : "error",
    }),
  };

  const listAnnotations: ToolDefinition<never> = {
    name: "list_annotations",
    description:
      "列出用户在这本书里已有的划线、书签与笔记（含位置与内容）。" +
      "用户问「我之前划了什么」「我的笔记」时用它；回答时给出章节号与原文片段。",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, description: "最多返回多少条（默认 30）" },
      },
      additionalProperties: false,
    },
    executionMode: "parallel-safe",
    timeoutMs: 5000,
    async execute(args) {
      const bad = requireBook(host);
      if (bad) return bad;
      const rows = await host.annotations();
      const limit = Math.min(100, Number((args as any).limit ?? 30));
      const all = host.chapters();
      const items = rows
        .slice(-limit) // 最近的在后，取尾部
        .reverse()
        .map((r) => ({
          kind: r.kind,
          chapter: (() => {
            // CFI 的 /6/N 只精确到 **spine 节**（P3.7 起一节可能含多章），
            // 所以只能给出"这一节的第一章"标题，不假装知道具体是哪一章。
            const m = /^epubcfi\(\/6\/(\d+)/.exec(r.cfi);
            if (!m) return null;
            const section = Number(m[1]) / 2 - 1;
            return all.find((c) => c.section === section)?.title ?? null;
          })(),
          cfi: r.cfi,
          text: r.text.slice(0, 80),
          note: r.note,
        }));
      return ok({ total: rows.length, showing: items.length, items });
    },
    present: (_a, out) => ({
      title: "查看批注",
      summary: out.ok ? (out.value as { total: number }).total + " 条" : "失败",
      tone: out.ok ? "ok" : "error",
    }),
  };

  return [addHighlight, addNote, gotoLocation, listAnnotations] as ToolDefinition<never>[];
}
