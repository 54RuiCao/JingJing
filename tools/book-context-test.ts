/**
 * P3.7 待办 A 的契约测试：**单文件 EPUB 的多章节切分** + 跳转改用 href。
 *
 * 为什么能脱浏览器跑：切分逻辑（splitSectionDocument）是纯 DOM 遍历，只用到
 * body.childNodes / textContent / id —— 所以这里用一棵几十行的**假 DOM** 就能驱动它，
 * 不需要 foliate、不需要 WebView2、不需要真书。
 *
 * 假数据照着实测的《样书》长相搭：spine 只有 1 项，整本书在一个 HTML 里，
 * 细粒度目录全挂在 <span id="filepos..."> 这类锚点上（toc.ncx 里带 #fragment）。
 *
 * 跑法（与其它契约测试一致）：
 *   node tools/run-tests.mjs book-context-test
 */

import {
  assembleBookText,
  chapterAtPlainOffset,
  locateHits,
  parseChapterIndex,
  splitSectionDocument,
  stripSpaces,
  type SectionPiece,
  type TocAnchor,
} from "../app/src/ai/bookContext";
import { buildRequestMessages } from "../app/src/ai/prompt";
import { createToolHost, type ToolHostDeps } from "../app/src/ai/toolHost";
import { createBookToolRegistry } from "../app/src/ai/tools/index";
import type { ToolCallRecord } from "../app/src/ai/tools/types";
import type { ToolHost } from "../app/src/ai/tools/host";

// registry.ts 里用了 window.setTimeout；node 下补一个最小 Window 形状
(globalThis as any).window = globalThis;

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) pass++;
  else failures.push(name + (detail ? " —— " + detail : ""));
}

// ---------- 一棵假 DOM（够 docToText / splitSectionDocument 用） ----------

type FakeNode = {
  nodeType: number;
  nodeValue?: string;
  tagName?: string;
  id?: string;
  childNodes?: FakeNode[];
  textContent: string;
};

const textOf = (n: FakeNode): string =>
  n.nodeType === 3 ? n.nodeValue ?? "" : (n.childNodes ?? []).map(textOf).join("");

const txt = (s: string): FakeNode => ({ nodeType: 3, nodeValue: s, textContent: s });

const el = (tag: string, attrs: { id?: string } = {}, ...kids: FakeNode[]): FakeNode => {
  const node: FakeNode = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id: attrs.id,
    childNodes: kids,
    textContent: "",
  };
  // 与真 DOM 一致：元素的 textContent = 后代文本按文档顺序拼接
  node.textContent = kids.map(textOf).join("");
  return node;
};

const fakeDoc = (...kids: FakeNode[]) => ({ body: el("body", {}, ...kids) });

/** 去空白长度（与切分逻辑里的坐标口径一致） */
const normLen = (s: string) => s.replace(/\s+/g, "").length;

// ---------- 假书：1 节 / 3 个锚点 ----------

/** 书头无锚点的内容（封面 + 目录页）：应当并进第一章，不丢内容 */
const PREAMBLE = ["封面图片", "目录"];

function singleFileBody(): FakeNode {
  return fakeDoc(
    el("p", {}, txt("封面图片")),
    // 书首那份**目录列表**：《样书》里 46 个章节标题全都印在这里（同一节的开头），
    // 于是"取 indexOf 第一次"的定位办法会把每个标题词都报成第 1 章（实测踩到）。
    el("ul", {}, el("li", {}, txt("目录")), el("li", {}, txt("收尾一章"))),
    el("span", { id: "filepos0000006289" }),
    el("p", {}, txt("开篇一章")),
    el("p", {}, txt("这是第一章的正文，用来验证锚点切章。")),
    el("span", { id: "filepos0000012025" }),
    el("p", {}, txt("中段一章")),
    el("p", {}, txt("这是第二章的正文，讲到心气与耐性。")),
    el("span", { id: "filepos0000082065" }),
    el("p", {}, txt("收尾一章")),
    el("p", {}, txt("这是第三章的正文，用来验证尾部并入。")),
  );
}

const SINGLE_FILE_TOC: TocAnchor[] = [
  { label: "开篇一章", fragment: "filepos0000006289" },
  { label: "中段一章", fragment: "filepos0000012025" },
  { label: "收尾一章", fragment: "filepos0000082065" },
];

const SECTION_HREF = "OEBPS/text00000.html";

// 1) 同一 section 多个锚点 → 多章
const pieces = splitSectionDocument(
  { body: singleFileBody().body },
  SECTION_HREF,
  SINGLE_FILE_TOC,
  "样书",
);

check("3 个锚点 → 3 章", pieces.length === 3, "实际 " + pieces.length);
check(
  "章标题取自目录标签（不是「第 N 节」）",
  pieces.map((p) => p.title).join("|") === "开篇一章|中段一章|收尾一章",
  pieces.map((p) => p.title).join("|"),
);
check(
  "章 href 带锚点（跳转靠它）",
  pieces.map((p) => p.href).join("|") ===
    SECTION_HREF + "#filepos0000006289|" + SECTION_HREF + "#filepos0000012025|" + SECTION_HREF + "#filepos0000082065",
  pieces.map((p) => p.href).join("|"),
);
check("第一章含锚点后的正文", pieces[0].text.includes("这是第一章的正文"));
check(
  "锚点之前的内容并进第一章（不丢内容）",
  PREAMBLE.every((t) => pieces[0].text.includes(t)),
  pieces[0].text.slice(0, 40),
);
check(
  "各章正文不串台",
  !pieces[1].text.includes("开篇一章") && !pieces[1].text.includes("封面图片"),
);
check("末章含锚点后的正文（无锚点的尾部并进最后一章）", pieces[2].text.includes("这是第三章的正文"));
check("每章都有正文（本轮 3 段都有字）", pieces.every((p) => p.text.length > 0));

// 2) 纯文本坐标（检索命中定位到章靠它）
const totalNorm = normLen(singleFileBody().body.textContent);
check("首章 plainFrom = 0", pieces[0].plainFrom === 0, String(pieces[0].plainFrom));
check(
  "坐标首尾相接（无重叠无空洞）",
  pieces.every((p, i) => (i === 0 ? p.plainFrom === 0 : p.plainFrom === pieces[i - 1].plainTo)),
  pieces.map((p) => p.plainFrom + "-" + p.plainTo).join(" "),
);
check("末章 plainTo = 整节纯文本长度", pieces[pieces.length - 1].plainTo === totalNorm,
  pieces[pieces.length - 1].plainTo + " vs " + totalNorm);
check(
  "坐标能反查到章（命中的字落在谁的范围里）",
  pieces.findIndex((p) => {
    const at = singleFileBody().body.textContent.replace(/\s+/g, "").indexOf("心气");
    return at >= p.plainFrom && at < p.plainTo;
  }) === 1,
);

// 3) 只有 1 个锚点 → 不切（整节一章）
const one = splitSectionDocument(
  { body: singleFileBody().body },
  SECTION_HREF,
  [SINGLE_FILE_TOC[0]],
  "样书",
);
check("只有 1 个锚点 → 1 段（调用方按整节一章处理）", one.length === 1, String(one.length));

// 4) 目录没有锚点 → 空数组（回退成整节一章，绝不能切出空章）
check("没有锚点 → 空数组", splitSectionDocument({ body: singleFileBody().body }, SECTION_HREF, [], "x").length === 0);
check(
  "锚点 id 在文档里不存在 → 空数组（不硬切）",
  splitSectionDocument({ body: singleFileBody().body }, SECTION_HREF,
    [{ label: "不存在", fragment: "nope" }], "x").length === 0,
);

// 5) 粒度限制：锚点埋在大元素里 → 整个元素归一章（如实记录的行为）
const nested = fakeDoc(
  el("span", { id: "a" }),
  el("div", {}, el("span", { id: "b" }), el("p", {}, txt("第二个锚点在 div 内部"))),
  el("p", {}, txt("尾部")),
);
const nestedPieces = splitSectionDocument({ body: nested.body }, SECTION_HREF, [
  { label: "甲", fragment: "a" },
  { label: "乙", fragment: "b" },
], "x");
check("后代命中也算命中：换桶落在那层的顶层元素上", nestedPieces.length === 2, String(nestedPieces.length));
check(
  "锚点元素内部不切（粒度限制）：div 里的内容与尾部同属一章",
  nestedPieces[1].text.includes("第二个锚点在 div 内部") && nestedPieces[1].text.includes("尾部"),
  nestedPieces[1].text,
);
check(
  "切分不丢字（各段去空白长度之和 = 整节去空白长度）",
  nestedPieces.reduce((n, p) => n + normLen(p.text), 0) === normLen(nested.body.textContent),
);

// 6) 图片章：锚点后只有一个 <img> → 这一章正文为空，但**要保留**
//（与"空章节保留占位"一致；《样书》的 5 个「插图（N）」就是这种）
const imgBody = fakeDoc(
  el("span", { id: "i1" }),
  el("p", {}, el("img")),
  el("span", { id: "i2" }),
  el("p", {}, txt("正文在这里")),
);
const imgPieces = splitSectionDocument({ body: imgBody.body }, SECTION_HREF, [
  { label: "插图（1）", fragment: "i1" },
  { label: "中段一章", fragment: "i2" },
], "x");
check("空章也保留（标题在、chars=0）", imgPieces.length === 2 && imgPieces[0].text === "" && imgPieces[0].title === "插图（1）",
  JSON.stringify(imgPieces.map((p) => [p.title, p.text])));

// ---------- 组装 → 解析：href 进标记、manifest 带 section/坐标 ----------

const drafts = pieces.map((p: SectionPiece, i: number) => ({
  n: i + 1,
  title: p.title,
  cfi: "",
  href: p.href,
  text: p.text,
  section: 0,
  plainFrom: p.plainFrom,
  plainTo: p.plainTo,
}));
const built = assembleBookText("样书", "佚名", { total: drafts.length, sections: drafts });

check("书头章数 = 3", built.text.startsWith('<book title="样书" author="佚名" chapters="3">'), built.text.slice(0, 60));
check("标记里带 href", built.text.includes('n=2 title="中段一章" href="' + SECTION_HREF + '#filepos0000012025" chars='));
check("标记里没有 cfi（切分后 CFI 只到节级，故意留空）", !built.text.includes('cfi=""'));

const parsed = parseChapterIndex(built.text);
check("解析回 3 章", parsed.length === 3, String(parsed.length));
check("n 连续（切分后重新编号）", parsed.map((e) => e.n).join(",") === "1,2,3");
check("解析出 href（跳转要用）", parsed[1].href === SECTION_HREF + "#filepos0000012025", parsed[1].href);
check("manifest 带 section 与坐标", built.manifest.every((m) => m.section === 0 && typeof m.plainFrom === "number"));
check("manifest 的 chars 与标记一致", built.manifest[2].chars === drafts[2].text.length);

// ---------- 检索命中 → 章（全文索引按节建，要靠坐标对齐） ----------

const sectionPlain = singleFileBody().body.textContent.replace(/\s+/g, " ").trim();

const makeDeps = (plain: string): ToolHostDeps => ({
  bookId: () => "book-1",
  title: () => "样书",
  author: () => "佚名",
  progress: () => ({ fraction: 0.3, chapter: "中段一章", location: "位置 12" }),
  context: () => ({
    chapters: built.manifest.length,
    loadedChapters: built.manifest.length,
    chars: built.chars,
    tokens: built.tokens,
    mode: "full" as const,
    text: built.text,
    manifest: built.manifest,
    builtAt: 0,
    fromCache: false,
  }),
  search: async (_q, limit) =>
    [{ sectionIndex: 0, snippet: "…", plain }].slice(0, limit),
  selection: () => null,
  addAnnotation: async () => {
    throw new Error("测试里不写库");
  },
  listAnnotations: async () => [],
  goToChapter: async () => {},
  goToHref: async () => {},
  goToCfi: async () => {},
  goToFraction: async () => {},
});

const host = createToolHost(makeDeps(sectionPlain));
const got = await host.search("心气", 8);
check("命中落在第 2 章（坐标对齐精确）", got[0]?.n === 2, JSON.stringify(got[0]));
check("命中定位时不给 note（有把握就不含糊）", got[0]?.note === undefined);
check("首章的命中 → n=1", (await host.search("长乐", 8))[0]?.n === 1);

// 一个词在书里出现多处（目录列表里一次 + 正文里一次）→ 每一处都算一条命中
const multi = await host.search("收尾一章", 8);
check(
  "多章都提到时返回多条（不是只报第一次出现的第 1 章）",
  multi.map((h) => h.n).join(",") === "1,3",
  JSON.stringify(multi.map((h) => [h.n, h.title])),
);
check("多条命中各自带标题", multi[1]?.title === "收尾一章");

const bad = await createToolHost(makeDeps("这段纯文本跟正文对不上")).search("心气", 8);
check("索引与正文对不上时 → 退回该节第一章", bad[0]?.n === 1, JSON.stringify(bad[0]));
check("并且如实说明「落在第 1–3 章之间」", typeof bad[0]?.note === "string" && bad[0].note.includes("1–3"));

// ---------- 工具层：跳转走 href，取章走 n ----------

const went: string[] = [];
const jumping: ToolHost = {
  ...host,
  goToChapter: async (n) => {
    went.push("chapter:" + n);
  },
  goToHref: async (h) => {
    went.push("href:" + h);
  },
};
const reg = createBookToolRegistry(jumping);
const ctx = { signal: new AbortController().signal, callId: "c1" };
const valueOf = (rec: ToolCallRecord) => (rec.outcome.ok ? (rec.outcome.value as any) : null);

const toc = await reg.execute("get_toc", {}, ctx);
check("get_toc 3 章", valueOf(toc).total === 3, JSON.stringify(valueOf(toc)?.total));
const chap = await reg.execute("get_chapter", { n: 2 }, ctx);
check("get_chapter 取到第 2 章正文", chap.outcome.ok && valueOf(chap).text.includes("这是第二章的正文，讲到心气与耐性"));
const goto = await reg.execute("goto_location", { n: 2 }, ctx);
check("goto_location 用 href 跳（不是节号）", goto.outcome.ok && went.includes("href:" + SECTION_HREF + "#filepos0000012025"),
  JSON.stringify(went));
check("goto_location 不再退回 goToSection", !went.some((w) => w.startsWith("chapter:")));
check("返回值里带章标题", valueOf(goto).title === "中段一章");

// href 缺失（老缓存）时必须退回节号，而不是跳失败
const noHref = createBookToolRegistry({
  ...jumping,
  chapters: () => [{ n: 1, title: "老缓存章", cfi: "epubcfi(/6/2!/4)", href: "", chars: 10, inContext: true, section: 0 }],
});
went.length = 0;
const gotoOld = await noHref.execute("goto_location", { n: 1 }, ctx);
check("href 缺失 → 回退 goToChapter", gotoOld.outcome.ok && went.includes("chapter:1"), JSON.stringify(went));

const found = await reg.execute("search_book", { query: "心气" }, ctx);
check("search_book 的命中章号与坐标对齐一致", valueOf(found).hits[0].n === 2, JSON.stringify(valueOf(found).hits[0]));
check("search_book 顺带给出章标题", valueOf(found).hits[0].title === "中段一章");

// ---------- 坐标定位函数本身（检索跳转与工具层共用） ----------

const m = built.manifest;
check("偏移 0 落在第一章", chapterAtPlainOffset(m, 0, 0)?.n === 1);
check("偏移越过首章 → 第二章", chapterAtPlainOffset(m, 0, m[0].plainTo)?.n === 2);
check("偏移 = 末章 plainTo（越界）→ undefined", chapterAtPlainOffset(m, 0, m[m.length - 1].plainTo!) === undefined);
check("负偏移（没找到检索词）→ undefined", chapterAtPlainOffset(m, 0, -1) === undefined);
check("节号不对 → undefined（不会张冠李戴）", chapterAtPlainOffset(m, 7, 0) === undefined);
check("去空白是同一把尺子", stripSpaces(" 中段\n一章 ") === "中段一章");

// locateHits：工具层与「检索」面板共用的那一个函数
const all = singleFileBody().body.textContent.replace(/\s+/g, " ").trim();
const located = locateHits(m, 0, all, "收尾一章");
check("逐处定位：目录列表一处 + 正文一处 → 两章", located.map((h) => h.n).join(",") === "1,3", JSON.stringify(located.map((h) => h.n)));
check("每处给各自的上下文片段（不是同一段复制三遍）", located[0].snippet !== located[1].snippet);
check("片段里带着命中词", located.every((h) => stripSpaces(h.snippet).includes("收尾一章")));
check("上限封顶（高频词不刷屏）", locateHits(m, 0, all, "一章", 2).length === 2);
check("找不到词 → 空数组（调用方自己退）", locateHits(m, 0, all, "不存在词", 3).length === 0);
// 词被换行/空白切开时：原文 indexOf 找不到，退回"去空白"定位一次（不给假答案）
const splitWord = locateHits(m, 0, "收尾一\n章 在正文里", "收尾一章", 3);
check("词被换行切开也能定位（退回去空白口径）", splitWord.length === 1 && splitWord[0].n === 1, JSON.stringify(splitWord));

// ---------- 书库通用对话（待办 B 的请求侧） ----------

const general = buildRequestMessages({
  data: null,
  brief: { title: "" },
  history: [],
  question: "帮我排一个读书计划",
});
check(
  "没有书时用第三套提示（书库页），不是「只见目录」那套",
  general[0].content.includes("书库页") && !general[0].content.includes("只能看到这本书的元信息"),
);
check("没有书时不出现《未打开书籍》这种假书名", !general[1].content.includes("未打开书籍"), general[1].content);
check("没有书时的固定确认说明了「要谈书就先打开」", general[2].content.includes("没有打开书"));
check(
  "打开书但未装载时仍走简要模式（两套提示别混）",
  buildRequestMessages({ data: null, brief: { title: "测试书" }, history: [], question: "q" })[0].content.includes(
    "只能看到这本书的元信息",
  ),
);

console.log("契约测试：" + pass + " 通过 / " + failures.length + " 失败");
if (failures.length) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("  ✓ 全部通过（单文件 EPUB 按锚点切章 / 坐标对齐 / href 跳转 / 老缓存回退）");
