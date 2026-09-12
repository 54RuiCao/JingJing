/**
 * P3.9 契约测试：**书库管理**的纯逻辑（筛选 / 书组计数 / 笔记分组 / 相对时间 / 组名校验）。
 *
 * 为什么单独测这些：它们在界面上到处被复用（书架、侧栏、卡片气泡），
 * 而"按组筛书"要跟搜索词和排序叠加、"全部笔记按书分组"要容忍书被删掉、
 * "相对时间"边界一堆 —— 手写最容易在这些地方出无声的错。
 *
 * 跑法：node tools/run-tests.mjs library-test
 */

import {
  countByGroup,
  filterBooks,
  groupAnnotations,
  groupNameError,
  groupsOfBook,
  matchesQuery,
  normalizeGroupName,
  relativeTime,
  toggleGroupId,
} from "../app/src/library/manage";
import { setLangPref } from "../app/src/i18n";

// 断言写的是中文默认文案：把界面语言钉死，别受开发机系统语言影响
setLangPref("zh");
import type { Annotation, Book } from "../app/src/store/db";

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) pass++;
  else failures.push(name + (detail ? " —— " + detail : ""));
}

const book = (id: string, title: string, extra: Partial<Book> = {}): Book =>
  ({
    id,
    title,
    author: extra.author ?? "作者" + id,
    language: "zh",
    format: "epub",
    path: "C:/books/" + id + ".epub",
    original_name: id + ".epub",
    size: 100,
    added_at: extra.added_at ?? 1000,
    opened_at: extra.opened_at ?? null,
    cover_path: null,
    chapters: 10,
    ...extra,
  }) as Book;

// ---------- 1) 会话筛选与排序 ----------

const books = [
  book("a", "样书甲", { added_at: 300, opened_at: 900 }),
  book("b", "样书乙", { added_at: 200, opened_at: null }),
  book("c", "Attention Is All You Need", { added_at: 100, opened_at: 500, original_name: "paper.pdf" }),
];
check("空条件 → 全给", filterBooks(books).length === 3);
check("搜索标题", filterBooks(books, { query: "样书甲" }).map((b) => b.id).join() === "a");
check("搜索作者", filterBooks(books, { query: "作者c" }).map((b) => b.id).join() === "c");
check("搜索文件名", filterBooks(books, { query: "paper" }).map((b) => b.id).join() === "c");
check("大小写不敏感", filterBooks(books, { query: "ATTENTION" }).map((b) => b.id).join() === "c");
check("搜不到就是空", filterBooks(books, { query: "没有这本书" }).length === 0);
check("matchesQuery 空串恒真", matchesQuery(books[0], "   "));

const links = [
  { book_id: "a", group_id: "g1" },
  { book_id: "c", group_id: "g1" },
  { book_id: "a", group_id: "g2" },
];
check("按组筛（多对多：一本书可以在两组）", filterBooks(books, { groupId: "g1", links }).map((b) => b.id).sort().join() === "a,c");
check("换一组", filterBooks(books, { groupId: "g2", links }).map((b) => b.id).join() === "a");
check("组里没书 → 空", filterBooks(books, { groupId: "g9", links }).length === 0);
check("groupId 为 null = 不按组过滤", filterBooks(books, { groupId: null, links }).length === 3);

check(
  "搜索 + 书组叠加",
  filterBooks(books, { query: "样书甲", groupId: "g1", links }).map((b) => b.id).join() === "a",
);
check(
  "排序：最近阅读（没读过的按导入时间垫底，不能是 NaN 乱序）",
  filterBooks(books, { sort: "recent" }).map((b) => b.id).join() === "a,c,b",
);
check("排序：最近导入", filterBooks(books, { sort: "added" }).map((b) => b.id).join() === "a,b,c");
check("筛选不改原数组", books.length === 3 && books[0].id === "a");

// ---------- 2) 书组计数与勾选 ----------

check("按组计数", JSON.stringify(countByGroup(links)) === JSON.stringify({ g1: 2, g2: 1 }));
check("某本书的组", groupsOfBook(links, "a").sort().join() === "g1,g2");
check("不在任何组里 → 空数组", groupsOfBook(links, "b").length === 0);
check("勾选上", toggleGroupId(["g1"], "g2", true).sort().join() === "g1,g2");
check("取消勾选", toggleGroupId(["g1", "g2"], "g1", false).join() === "g2");
check("重复勾选不重复", toggleGroupId(["g1"], "g1", true).join() === "g1");

// ---------- 3) 组名清洗与校验 ----------

check("首尾空白与多余空白折叠", normalizeGroupName("  在  读 ") === "在 读");
check("超长截断到 24 字", normalizeGroupName("字".repeat(50)).length === 24);
check("空名报错", groupNameError("   ", []) !== null);
check("重名报错", groupNameError("在读", ["在读"]) !== null);
check("重命名成自己不算重名", groupNameError("在读", ["在读"], "在读") === null);
check("正常名字通过", groupNameError("技术", ["在读"]) === null);

// ---------- 4) 全部笔记按书分组 ----------

const anno = (id: string, bookId: string, createdAt: number, extra: Partial<Annotation> = {}): Annotation & { book_title?: string | null } => ({
  id,
  book_id: bookId,
  kind: extra.kind ?? "highlight",
  cfi: "epubcfi(/6/2!/4/2/2:0)",
  text: extra.text ?? "原文片段",
  note: extra.note ?? "",
  color: "yellow",
  created_at: createdAt,
  book_title: extra.book_title === undefined ? "书" + bookId : extra.book_title,
});

const rows = [
  anno("1", "a", 100, { book_title: "样书甲" }),
  anno("2", "b", 300, { book_title: "样书乙", kind: "note", note: "这段很妙" }),
  anno("3", "a", 200, { book_title: "样书甲", kind: "bookmark" }),
  anno("4", "gone", 400, { book_title: null }),
];
const all = groupAnnotations(rows);
check("按书分组：三本书", all.length === 3, String(all.length));
check("组间按最新一条排（书已删的那条最新 → 排最前）", all[0].bookId === "gone");
check("书被删掉也不丢：标题占位", all[0].title === "（已移除的书）");
check("组内按时间倒序", all.find((g) => g.bookId === "a")!.items.map((x) => x.id).join() === "3,1");
check("空输入不炸", groupAnnotations([]).length === 0);
check("按类型过滤", groupAnnotations(rows, { kind: "note" }).flatMap((g) => g.items).map((x) => x.id).join() === "2");
check(
  "按文字过滤（笔记正文）",
  groupAnnotations(rows, { query: "很妙" }).flatMap((g) => g.items).map((x) => x.id).join() === "2",
);
check(
  "按书名过滤",
  // 组内按时间倒序，所以是 3 在前（这条断言顺带钉住"过滤之后仍然保持排序"）
  groupAnnotations(rows, { query: "样书甲" }).flatMap((g) => g.items).map((x) => x.id).join() === "3,1",
);
check("过滤后没命中的书不出现", groupAnnotations(rows, { query: "很妙" }).length === 1);

// ---------- 5) 相对时间 ----------

const now = new Date(2026, 8, 12, 20, 0, 0).getTime();
const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 8, 12 + dayOffset, h, m, 0).getTime();
check("一分钟内 → 刚刚", relativeTime(now - 20_000, now) === "刚刚");
check("同一天 → N 分钟前", relativeTime(at(19, 30), now) === "30 分钟前");
check("前一天 → 昨天", relativeTime(at(23, 0, -1), now) === "昨天");
check("三天前 → 3 天前", relativeTime(at(12, 0, -3), now) === "3 天前");
check("七天前 → 显示日期", /^0?9-0?5$/.test(relativeTime(at(12, 0, -7), now)), relativeTime(at(12, 0, -7), now));
check("跨天但只差 2 小时仍算昨天（不按小时差）", relativeTime(at(23, 59, -1), at(1, 0)) === "昨天");
check("0 时间戳 → 空串", relativeTime(0, now) === "");

console.log("P3.9 书库管理契约测试：" + pass + " 通过 / " + failures.length + " 失败");
if (failures.length) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("  ✓ 全部通过（筛选与排序叠加 / 书组计数与勾选 / 组名校验 / 笔记按书分组 / 相对时间）");
