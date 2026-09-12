/**
 * 书库管理（P3.9）：**筛选 / 归类 / 笔记总览**的纯逻辑。
 *
 * 为什么单独一个模块：这几件事全在界面上手算最容易写错 —— "按组筛书"要跟搜索词、
 * 排序叠加；"全部笔记按书分组"要在书被删掉时也不丢数据；"相对时间"有一堆边界。
 * 提成纯函数之后能在 node 里直接跑契约测试（见 tools/library-test.ts）。
 */

import { t } from "../i18n";
import type { Annotation, AnnotationKind, Book } from "../store/db";

export type BookGroup = { id: string; name: string; sort: number };
export type BookGroupLink = { book_id: string; group_id: string };

export type SortKey = "recent" | "added" | "title";

/** 搜索词命中标题 / 作者 / 文件名（大小写不敏感） */
export function matchesQuery(book: Book, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    String(book.title ?? "").toLowerCase().includes(q) ||
    String(book.author ?? "").toLowerCase().includes(q) ||
    String(book.original_name ?? "").toLowerCase().includes(q)
  );
}

/** 书架列表：搜索 + 书组 + 排序（三者叠加，顺序固定：先筛后排） */
export function filterBooks(
  books: Book[],
  opts: { query?: string; groupId?: string | null; links?: BookGroupLink[]; sort?: SortKey } = {},
): Book[] {
  const { query = "", groupId = null, links = [], sort = "recent" } = opts;
  const inGroup = new Set(links.filter((l) => l.group_id === groupId).map((l) => l.book_id));
  const shown = books.filter((b) => matchesQuery(b, query) && (!groupId || inGroup.has(b.id)));
  const sorted = [...shown];
  if (sort === "title") sorted.sort((a, b) => String(a.title).localeCompare(String(b.title), "zh"));
  else if (sort === "added") sorted.sort((a, b) => (b.added_at ?? 0) - (a.added_at ?? 0));
  else {
    // 最近阅读：没读过的按导入时间排在后面（不能拿 null 去减，会得到 NaN 导致顺序随机）
    sorted.sort(
      (a, b) => (b.opened_at ?? 0) - (a.opened_at ?? 0) || (b.added_at ?? 0) - (a.added_at ?? 0),
    );
  }
  return sorted;
}

/** 每个书组有几本书（侧栏的计数） */
export function countByGroup(links: BookGroupLink[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of links ?? []) {
    if (!l?.group_id) continue;
    out[l.group_id] = (out[l.group_id] ?? 0) + 1;
  }
  return out;
}

/** 某本书属于哪些组（卡片上的勾选状态） */
export function groupsOfBook(links: BookGroupLink[], bookId: string): string[] {
  return (links ?? []).filter((l) => l.book_id === bookId).map((l) => l.group_id);
}

/** 勾选/取消勾选一个组，返回新的组列表（卡片上的开关就是它） */
export function toggleGroupId(current: string[], groupId: string, on: boolean): string[] {
  const set = new Set(current);
  if (on) set.add(groupId);
  else set.delete(groupId);
  return [...set];
}

export type NotesFilter = { kind?: "all" | AnnotationKind; query?: string };

export type NoteGroup = {
  bookId: string;
  /** 书被删掉时用「（已移除的书）」占位，绝不把笔记丢掉 */
  title: string;
  items: Annotation[];
};

/**
 * 全部笔记按书分组：组内按时间倒序（最近的在最上面），组之间按"最新一条"排。
 * 书标题缺失（书已删）时仍然成组，标题列显示占位 —— 用户还能把笔记读出来、删掉。
 */
export function groupAnnotations(
  rows: (Annotation & { book_title?: string | null })[],
  filter: NotesFilter = {},
): NoteGroup[] {
  const q = String(filter.query ?? "").trim().toLowerCase();
  const kind = filter.kind ?? "all";
  const kept = (rows ?? []).filter((r) => {
    if (!r) return false;
    if (kind !== "all" && r.kind !== kind) return false;
    if (!q) return true;
    return (
      String(r.text ?? "").toLowerCase().includes(q) ||
      String(r.note ?? "").toLowerCase().includes(q) ||
      String(r.book_title ?? "").toLowerCase().includes(q)
    );
  });

  const byBook = new Map<string, NoteGroup>();
  for (const r of kept) {
    const g = byBook.get(r.book_id) ?? {
      bookId: r.book_id,
      title: (r.book_title || "").trim() || t("lib.removedBook"),
      items: [],
    };
    g.items.push(r);
    byBook.set(r.book_id, g);
  }
  const groups = [...byBook.values()];
  for (const g of groups) g.items.sort((a, b) => b.created_at - a.created_at);
  groups.sort((a, b) => (b.items[0]?.created_at ?? 0) - (a.items[0]?.created_at ?? 0));
  return groups;
}

/** 组名清洗：去首尾空白、折叠内部空白、截断到 24 字 */
export function normalizeGroupName(raw: string): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
}

/** 新建/重命名书组的校验（返回错误文案；null = 可以建） */
export function groupNameError(name: string, existing: string[], self?: string): string | null {
  const n = normalizeGroupName(name);
  if (!n) return t("lib.groupNameEmpty");
  const others = (existing ?? []).filter((x) => x !== self).map((x) => normalizeGroupName(x));
  if (others.includes(n)) return t("lib.groupNameTaken");
  return null;
}

/**
 * 相对时间（列表上比"2026-09-12 14:03"好读）。
 * 只按"自然天"比较，不用小时差 —— 否则 23:59 与次日 00:01 会显示成"0 分钟前"。
 */
export function relativeTime(ts: number, now = Date.now()): string {
  if (!ts) return "";
  const diff = now - ts;
  if (diff < 60_000) return t("lib.timeJustNow");
  const then = new Date(ts);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const days = Math.max(0, Math.floor((startOfToday - new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) / 86400000));
  if (days === 0) return t("lib.timeMinutesAgo", { n: Math.floor(diff / 60000) });
  if (days === 1) return t("lib.timeYesterday");
  if (days < 7) return t("lib.timeDaysAgo", { n: days });
  const pad = (n: number) => (n < 10 ? "0" + n : String(n));
  const ymd = then.getFullYear() + "-" + pad(then.getMonth() + 1) + "-" + pad(then.getDate());
  return then.getFullYear() === today.getFullYear() ? ymd.slice(5) : ymd;
}
