/**
 * 工具宿主接口（P2.3）：工具只认识这些能力，不认识 foliate-js、SQLite 或 React。
 *
 * 这层隔离是照 DSH 抄的：那边工具通过 ctx 拿服务（ctx.fs / ctx.bash / …），
 * 我们从 App 注入一组回调。好处是工具可以被契约测试直接驱动（不需要开界面），
 * 也是"执行层与呈现层分离"能成立的前提。
 */

import type { ChapterEntry } from "../bookContext";

export type TocEntry = {
  /**
   * 1 起的章节号，与 <<CH n=..>> 一致。
   *
   * **注意（P3.7）**：不再等于 section index + 1 —— 单文件 EPUB 会按目录锚点
   * 把一节切成多章（一本单文件中文 EPUB：1 节 / 46 章）。跳转请用 href。
   */
  n: number;
  title: string;
  cfi: string;
  /** 跳转用的 href（含锚点）；整节一章时就是节 href */
  href: string;
  chars: number;
  /** 该章正文是否已经在模型的上下文里 */
  inContext: boolean;
  /** 所属 spine 节（0 起）：检索命中的 section_index 靠它对应到章 */
  section: number;
};

export type ChapterContent = {
  entry: ChapterEntry;
  text: string;
  from: number;
  nextOffset: number;
  truncated: boolean;
};

export type HostSelection = { text: string; cfi: string; chapter?: string };

export type HostSearchHit = {
  n: number;
  title: string;
  snippet: string;
  /**
   * 命中落不到具体某一章时的说明（P3.7）：全文索引是按**节**建的，
   * 一节多章的书里如果坐标对不上，就如实说"在这一节的第 X–Y 章之间"，不猜。
   */
  note?: string;
};

export type HostAnnotationInput = {
  kind: "highlight" | "note" | "bookmark";
  cfi: string;
  text?: string;
  note?: string;
  color?: string;
};

export type HostAnnotation = { id: string; kind: string; cfi: string; text: string; note: string; color: string };

export type ToolHost = {
  /** 当前书；null 表示没有打开书（或打开的是书库外的文件） */
  bookId(): string | null;
  title(): string;
  author(): string;
  /**
   * 当前阅读位置（用户正看着哪里）。
   *
   * P3.4 起多带几项**真实可达**的定位数据，好让插件（尤其是 UI 半）能算"这一章还剩多少"：
   * 这些字段直接来自 foliate 的 relocate 事件（section/location 是引擎自己算的），
   * 不是我们猜的。可选：假实现的宿主（契约测试）不必给。
   */
  progress(): {
    fraction: number;
    chapter: string;
    location: string;
    /** 当前在 spine 里的第几节（0 起）与总节数 */
    sectionIndex?: number;
    sectionTotal?: number;
    /** 在这一节（≈ 这一章）里的进度 0~1 */
    sectionFraction?: number;
    /** 这一节在全书里的起止 fraction（用它 × locations.total 就能估出"这一章有多少页"） */
    sectionStartFraction?: number;
    sectionEndFraction?: number;
    /** foliate 的"位置"：全书共多少个、当前第几个（每 1024 字符一个位置） */
    locations?: { current: number; total: number };
  };
  /** 已装载的全书上下文元信息；null 表示没装载 */
  context(): { mode: "full" | "partial"; chapters: number; loadedChapters: number; tokens: number } | null;
  /** 章节索引（来自已装载的上下文）；没装载时为空数组 */
  chapters(): TocEntry[];
  /** 取章节正文（按偏移切片） */
  chapter(n: number, offset: number, maxChars: number): ChapterContent | null;
  /** 全文检索（FTS5） */
  search(query: string, limit: number): Promise<HostSearchHit[]>;
  /** 当前选区 */
  selection(): HostSelection | null;
  /** 写批注 */
  addAnnotation(input: HostAnnotationInput): Promise<HostAnnotation>;
  /** 现有批注 */
  annotations(): Promise<HostAnnotation[]>;
  /** 跳转到章节（按节号；只有拿不到 href 时才用） */
  goToChapter(n: number): Promise<void>;
  /** 跳转到 href（含 #锚点）。P3.7 起章节跳转优先走它 —— 引擎的 resolveHref 认这个形式 */
  goToHref(href: string): Promise<void>;
  /** 跳转到 CFI */
  goToCfi(cfi: string): Promise<void>;
  /** 跳转到百分比位置 */
  goToFraction(fraction: number): Promise<void>;
};
