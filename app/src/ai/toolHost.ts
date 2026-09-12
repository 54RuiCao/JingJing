/**
 * ToolHost 的实现（P2.3）：把 App 里的状态与引擎能力包成工具认识的那几个方法。
 *
 * 这里不 import 任何 React / foliate 细节，只吃一组回调 —— 所以工具层可以被探针
 * 直接驱动（tools/probe-p23.js 就是这么做的），也可以在没有界面的情况下做契约测试。
 */

import { locateHits, parseChapterIndex, sliceChapter, type ChapterEntry } from "./bookContext";
import type {
  ChapterContent,
  HostAnnotation,
  HostAnnotationInput,
  HostSearchHit,
  HostSelection,
  TocEntry,
  ToolHost,
} from "./tools/host";
import type { BookContextData } from "./bookContext";

export type ToolHostDeps = {
  bookId(): string | null;
  title(): string;
  author(): string;
  progress(): { fraction: number; chapter: string; location: string };
  context(): BookContextData | null;
  /**
   * 全文检索（FTS5，按**节**建索引）。
   * P3.7 起多带一个 plain（该节纯文本）：一节被切成多章时，
   * 要靠它把命中位置对齐到具体某一章（见 createToolHost 里的 hitToChapter）。
   */
  search(query: string, limit: number): Promise<{ sectionIndex: number; snippet: string; plain: string }[]>;
  selection(): HostSelection | null;
  addAnnotation(input: HostAnnotationInput): Promise<HostAnnotation>;
  listAnnotations(): Promise<HostAnnotation[]>;
  goToChapter(n: number): Promise<void>;
  goToHref(href: string): Promise<void>;
  goToCfi(cfi: string): Promise<void>;
  goToFraction(fraction: number): Promise<void>;
};

export function createToolHost(deps: ToolHostDeps): ToolHost {
  /** 章节索引缓存：key 是上下文文本本身（换书/重装会换引用） */
  let cachedText: string | null = null;
  let cachedEntries: ChapterEntry[] = [];

  const entries = (): ChapterEntry[] => {
    const data = deps.context();
    if (!data?.text) return [];
    if (cachedText !== data.text) {
      cachedText = data.text;
      cachedEntries = parseChapterIndex(data.text);
    }
    return cachedEntries;
  };

  /** 章节清单（清单缺失的旧缓存退化成"已装载的那些章"） */
  const chaptersOf = (): TocEntry[] => {
    const data = deps.context();
    const loaded = new Set(entries().map((e) => e.n));
    const manifest = data?.manifest ?? [];
    if (manifest.length) {
      return manifest.map((m) => ({
        n: m.n,
        title: m.title,
        cfi: m.cfi,
        href: m.href ?? "",
        chars: m.chars,
        inContext: loaded.has(m.n),
        section: m.section ?? m.n - 1,
      }));
    }
    // 没有清单（旧缓存）时只剩 n - 1 这个老口径可用
    return entries().map((e) => ({
      n: e.n,
      title: e.title,
      cfi: e.cfi,
      href: e.href,
      chars: e.chars,
      inContext: true,
      section: e.n - 1,
    }));
  };

  /**
   * 检索命中 → 落在第几章。
   *
   * 全文索引是按**节**建的（indexBook），而 P3.7 之后一章不再等于一节：
   *   - 该节只有一章（绝大多数书）：直接就是它；
   *   - 该节被切成多章（单文件 EPUB，如一本单文件中文 EPUB1 节 46 章）：
   *     用**去空白坐标**把命中位置对齐到章 —— 索引里的 plain 与切分时的
   *     body.textContent 是同一份文本，只是空白处理不同，去掉空白后逐字符可比，
   *     所以定位是精确的；对不上（老缓存 / 索引与正文不同源）就退回该节第一章，
   *     并在 note 里如实说明"落在这一节的第 X–Y 章之间"，绝不假装知道。
   */
  const hitToChapter = (
    row: { sectionIndex: number; snippet: string; plain: string },
    query: string,
  ): HostSearchHit[] => {
    const all = chaptersOf();
    const same = all.filter((c) => c.section === row.sectionIndex);
    const first = same[0];
    if (same.length <= 1) {
      return [{ n: first?.n ?? row.sectionIndex + 1, title: first?.title ?? "", snippet: row.snippet }];
    }
    // 该节多章才需要定位（单章的书直接就是它）
    // 一个词在这一节里可能出现多次（目录列表 + 正文），逐处定位、按章去重
    const located = locateHits(deps.context()?.manifest ?? [], row.sectionIndex, row.plain, query, 3);
    if (located.length) {
      return located.map((h) => ({ n: h.n, title: h.title, snippet: h.snippet }));
    }
    return [
      {
        n: first.n,
        title: first.title,
        snippet: row.snippet,
        note:
          "这一节里合了第 " + first.n + "–" + same[same.length - 1].n + " 章（同一个文件），" +
          "命中具体落在哪一章无法确定：先按这 " + same.length + " 章看上下文，或逐章 get_chapter 确认。",
      },
    ];
  };

  return {
    bookId: () => deps.bookId(),
    title: () => deps.title(),
    author: () => deps.author(),
    progress: () => deps.progress(),
    context: () => {
      const d = deps.context();
      return d ? { mode: d.mode, chapters: d.chapters, loadedChapters: d.loadedChapters, tokens: d.tokens } : null;
    },
    chapters: () => chaptersOf(),
    chapter: (n: number, offset: number, maxChars: number): ChapterContent | null => {
      const text = deps.context()?.text;
      if (!text) return null;
      const entry = entries().find((e) => e.n === n);
      if (!entry) return null;
      const cut = sliceChapter(text, entry, offset, maxChars);
      return { entry, text: cut.chunk, from: cut.from, nextOffset: cut.nextOffset, truncated: cut.truncated };
    },
    search: async (query: string, limit: number): Promise<HostSearchHit[]> => {
      const rows = await deps.search(query, limit);
      // 一节可展开成多条（一节多章时每处命中各算一条），所以是 flatMap
      return rows.flatMap((r) => hitToChapter(r, query));
    },
    selection: () => deps.selection(),
    addAnnotation: (input) => deps.addAnnotation(input),
    annotations: () => deps.listAnnotations(),
    goToChapter: (n) => deps.goToChapter(n),
    goToHref: (href) => deps.goToHref(href),
    goToCfi: (cfi) => deps.goToCfi(cfi),
    goToFraction: (f) => deps.goToFraction(f),
  };
}
