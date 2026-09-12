/**
 * P2.2 全书上下文：把整本书的正文按结构标记装进上下文（见 内部设计笔记 §1、§2）。
 *
 * 为什么是「整本书塞进去」而不是 RAG：
 *   DeepSeek 上下文 1M token，实测 0.73 token/中文字符 —— 30 万字的书约 22 万 token（占 22%）；
 *   上下文硬盘缓存命中时输入单价是未命中的 1/50，所以「又长又不变的前缀」几乎免费。
 *
 * 三条硬纪律（决定缓存能否命中，成本差 50 倍）：
 *   1. 这段文本必须逐字节稳定 —— 所以组装结果落盘缓存（book_context 表），
 *      下次直接取用，不重新抽取、不重新拼接（抽取顺序、空白折叠都可能引入抖动）；
 *   2. 请求结构固定为 [system] + [全书] + [历史] + [问题]，变化的部分永远在最后；
 *   3. 不塞时间戳、不随机重排章节、不用「第 N 章」这种会随会话变化的计数。
 *
 * 降级：估算 token 超过 CONTEXT_BUDGET_TOKENS 时只装载前 N 章（mode = "partial"），
 * 并在 <book> 头里声明「仅收录前 N 章」，让模型知道自己看到的不是全部。
 * 完整的 L0/L1 降级（目录 + 章节摘要 + 按需取正文）要等 P2.3 的工具层。
 *
 * 章节标记里的 cfi 是实测出来的（见 内部设计笔记）：
 *   - 引擎给的章节基 CFI 形如 epubcfi(/6/50)，直接 goTo 会抛
 *     "Cannot read properties of undefined (reading 'length')"
 *     （book.resolveCFI 把整段路径 shift 掉后 CFI.toRange 拿到空数组）；
 *   - 补上 !/4 指向章节文档的 <body> 之后 goTo 正常落到该章（在一本 60 万字的长篇上实测通过）。
 */

import { getBookContext, saveBookContext } from "../store/db";

/** 估算 token 超过它就降级为部分装载（1M 上下文要给输出与历史留余量，约合 110 万字中文） */
export const CONTEXT_BUDGET_TOKENS = 800_000;
/** DeepSeek V4.1-Flash 的上下文窗口，只用于界面显示占比 */
export const CONTEXT_WINDOW_TOKENS = 1_000_000;
/**
 * 落盘缓存的版本号：抽取逻辑或 token 估算口径一变就 +1，旧缓存自动失效重建。
 * （缓存里存的是组装好的成品与算好的 token，不重建就会显示旧口径的数字。）
 */
export const CONTEXT_CACHE_VERSION = "v3";

export type BookContextData = {
  /** 全书章节数（section 数，含封面等无正文章节） */
  chapters: number;
  /** 实际装载的章节数 */
  loadedChapters: number;
  /** 装载文本的字符数 */
  chars: number;
  /** 估算 token（见 estimateTokens） */
  tokens: number;
  mode: "full" | "partial";
  /** 带 <<CH ...>> 结构标记的正文块（就是发给模型的东西，逐字节稳定） */
  text: string;
  /** 全书章节清单（含未装载的尾部章节），工具层 get_toc 用它列完整目录 */
  manifest: ManifestEntry[];
  builtAt: number;
  fromCache: boolean;
};

/**
 * token 估算：三档字符模型，系数用 DeepSeek 官方 V4 tokenizer 在真实书上量出来的
 * （tools/calibrate-token-estimate.py，见 内部设计笔记 的对账表）：
 *
 *   中文（含全角标点）0.65 token/字符   实测一本 60 万字的长篇正文 0.6461、P0 语料 0.6494
 *   英文/数字/半角标点 0.45
 *   空白（空格/换行/全角空格）0.07      换行几乎不花钱，按字算会显著高估
 *
 * 注意：内部设计笔记 里 P0 记的「0.73 token/中文字符」口径偏高（差约 12%），
 * 那是拿整份语料直接除以字数得到的，没有把空白与 ASCII 分开。按现在这套分档，
 * 一本 60 万字的长篇678,972 字符估 43.4 万 token，官方 tokenizer 实测 43.3 万（偏差 +0.3%）。
 *
 * 界面上的「约 X token」用它；真实用量以 API 返回的 usage 为准。
 */
const CJK_MIN = 0x2e80;
const CJK_MAX = 0xffef;
const CJK_RATIO = 0.65;
const OTHER_RATIO = 0.45;
const SPACE_RATIO = 0.07;

/** 空白的 charCode：空格 / 换行 / 回车 / 制表 / 全角空格 / 不换行空格 */
const isSpace = (c: number) => c === 32 || c === 10 || c === 13 || c === 9 || c === 0x3000 || c === 0xa0;

type CharCounts = { cjk: number; other: number; space: number };

const emptyCounts = (): CharCounts => ({ cjk: 0, other: 0, space: 0 });

function countInto(text: string, acc: CharCounts): void {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (isSpace(c)) acc.space++;
    else if (c >= CJK_MIN && c <= CJK_MAX) acc.cjk++;
    else acc.other++;
  }
}

const tokensOf = (acc: CharCounts): number =>
  Math.round(acc.cjk * CJK_RATIO + acc.other * OTHER_RATIO + acc.space * SPACE_RATIO);

export function estimateTokens(text: string): number {
  const acc = emptyCounts();
  countInto(text, acc);
  return tokensOf(acc);
}

// ---------- 章节文本抽取 ----------

const BLOCK_TAGS = new Set([
  "P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "UL", "OL", "BLOCKQUOTE",
  "PRE", "TR", "TD", "TH", "TABLE", "SECTION", "ARTICLE", "ASIDE", "HEADER",
  "FOOTER", "FIGCAPTION", "FIGURE", "DD", "DT", "DL", "HR", "BR", "NAV",
]);
/** 注音（rt/rp）与脚本不进上下文：前者是排版噪声，后者是代码 */
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "RT", "RP", "HEAD", "TITLE", "SVG"]);

/**
 * 章节文档 → 保留段落结构的纯文本。
 *
 * 不能像建检索索引那样直接把 textContent 压成一行（indexBook 是那么干的）：
 * 全书进上下文时，段落边界是模型理解文本结构的唯一线索，压平会显著降低回答质量。
 */
export function docToText(doc: Document): string {
  return doc?.body ? nodesToText(doc.body.childNodes) : "";
}

/** 与 docToText 同一套规则，但吃一组节点（P3.7 按锚点切段后逐段渲染用） */
export function nodesToText(nodes: ArrayLike<Node>): string {
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      out.push(node.nodeValue ?? "");
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return;
    if (tag === "BR") {
      out.push("\n");
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) out.push("\n");
    for (const child of Array.from(el.childNodes)) walk(child);
    if (block) out.push("\n");
  };
  for (const node of Array.from(nodes)) walk(node);
  return out
    .join("")
    .replace(/[ \t\u00a0\u3000]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 标题里的引号/换行会破坏标记语法，统一折叠掉 */
const cleanLabel = (s: unknown): string =>
  String(s ?? "").replace(/\s+/g, " ").replace(/["<>]/g, "'").trim().slice(0, 60);

/** 标题之外，href 也会进标记（P3.7）：引号/尖括号同样会把属性打断 */
const cleanHref = (s: unknown): string => String(s ?? "").replace(/["<>]/g, "").trim();

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const normHref = (h: unknown): string =>
  safeDecode(String(h ?? ""))
    .split("#")[0]
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .toLowerCase();

/**
 * section 的原始 href（**不做小写化**，跳转要用它）。
 * book.sections[i].id 就是 OPF 里的 item href（如 OEBPS/text00000.html），
 * 与 book.resolveHref() 认的键一模一样 —— 所以直接把节 id 交给引擎就能跳。
 */
const sectionHrefOf = (id: unknown): string =>
  cleanHref(safeDecode(String(id ?? "")).split("#")[0].replace(/^\.\//, "").replace(/^\/+/, ""));

/** 目录里带锚点的一条（P3.7 按锚点切章的依据） */
export type TocAnchor = { label: string; fragment: string };

type TocIndex = {
  /** section → 该节标题（第一条落到这一节的目录项，含带锚点的） */
  title: Map<string, string>;
  /** section → 该节内的锚点条目（目录顺序） */
  anchors: Map<string, TocAnchor[]>;
};

/**
 * 目录 → 「每节标题」+「每节内的锚点」两张表。
 *
 * 原来只拍成 href → 标题 一张表（且 href 先 split("#")[0]），
 * 于是一本单文件中文 EPUB里 46 条指向同一文件不同锚点的目录项全落在一节上，只剩 1 章。
 */
function buildTocIndex(toc: any[]): TocIndex {
  const title = new Map<string, string>();
  const anchors = new Map<string, TocAnchor[]>();
  const walk = (items: any[]) => {
    for (const item of items ?? []) {
      const raw = safeDecode(String(item?.href ?? ""));
      const hash = raw.indexOf("#");
      const fragment = hash >= 0 ? raw.slice(hash + 1) : "";
      const key = normHref(raw);
      const label = cleanLabel(item?.label);
      if (key && label && !title.has(key)) title.set(key, label);
      if (key && fragment) {
        const list = anchors.get(key) ?? [];
        // 同一个锚点被两条目录项引用时只留第一条（例如"目录"这条也指到了正文）
        if (!list.some((a) => a.fragment === fragment)) list.push({ label, fragment });
        anchors.set(key, list);
      }
      if (item?.subitems?.length) walk(item.subitems);
    }
  };
  walk(toc ?? []);
  return { title, anchors };
}

/** 目录 href 与 section href 可能一个带目录前缀、一个不带，用后缀匹配兜底 */
function lookupValue<T>(map: Map<string, T>, sectionHref: string): T | undefined {
  const direct = map.get(sectionHref);
  if (direct !== undefined) return direct;
  if (!sectionHref) return undefined;
  for (const [href, value] of map) {
    if (sectionHref.endsWith("/" + href) || href.endsWith("/" + sectionHref)) return value;
  }
  return undefined;
}

/** 该节被切成的一段（= 一章） */
export type SectionPiece = {
  title: string;
  text: string;
  /** 跳到这一章的 href（含 #锚点）。切分后 n 不再等于 spine index，只能靠它跳 */
  href: string;
  /**
   * 该段在「本节点纯文本去空白后」的起止偏移。
   * 用途：全文检索是按**节**建索引的，命中要落到哪一章只能靠这套坐标对齐
   * （见 toolHost.search）。口径必须与 indexBook 写库的 plain 一致：
   * 两者都来自同一个 body.textContent，只是把空白全部去掉。
   */
  plainFrom: number;
  plainTo: number;
};

/** 节点自己或后代里第一个命中的锚点 id（文档顺序） */
function anchorIdOf(node: any, ids: Map<string, string>): string | null {
  if (!node) return null;
  if (node.nodeType === 1) {
    const id = String(node.id ?? node.getAttribute?.("id") ?? "");
    if (id && ids.has(id)) return id;
  }
  for (const child of Array.from(node.childNodes ?? [])) {
    const hit = anchorIdOf(child, ids);
    if (hit) return hit;
  }
  return null;
}

/** 一段里的第一个 <h1..h6> 文本（目录标签缺失时的兜底标题） */
function firstHeading(nodes: any[]): string {
  const walk = (node: any): string => {
    if (!node || node.nodeType !== 1) return "";
    if (/^H[1-6]$/.test(String(node.tagName ?? "").toUpperCase())) return cleanLabel(node.textContent);
    for (const child of Array.from(node.childNodes ?? [])) {
      const t = walk(child);
      if (t) return t;
    }
    return "";
  };
  for (const node of nodes) {
    const t = walk(node);
    if (t) return t;
  }
  return "";
}

/**
 * 按锚点把一个 section 的正文切成若干段（P3.7 待办 A 的核心，纯 DOM 逻辑、可脱浏览器测）。
 *
 * 规则（照 内部设计笔记 §4.1 待办 A）：
 *   - 只在 body 的**子节点**这一层切：节点自己或后代命中某个锚点 id 就开一个新桶 ——
 *     锚点若埋在某个大元素内部，那一段整体归给命中的那一章（**粒度限制，如实记录**）；
 *   - 第一个锚点**之前**的内容并入第一段（书名页/版权页，不丢内容）；
 *   - 最后一个锚点**之后**的内容并进最后一段（同上）；
 *   - 一个锚点都没命中就返回空数组，调用方回退成"整节一章"。
 */
export function splitSectionDocument(
  doc: any,
  sectionHref: string,
  anchors: TocAnchor[],
  fallbackTitle = "",
): SectionPiece[] {
  const body: any = doc?.body;
  if (!body) return [];
  const labelOf = new Map<string, string>();
  for (const a of anchors ?? []) {
    if (a?.fragment && !labelOf.has(a.fragment)) labelOf.set(a.fragment, cleanLabel(a.label));
  }
  if (!labelOf.size) return [];

  const children: any[] = Array.from(body.childNodes ?? []);
  // 每个子节点的"去空白长度"：累加即得到该节纯文本里的去空白坐标
  const lens = children.map((c) => String(c?.textContent ?? "").replace(/\s+/g, "").length);
  const starts: number[] = [];
  let acc = 0;
  for (const len of lens) {
    starts.push(acc);
    acc += len;
  }

  const buckets: { id: string; from: number; to: number }[] = [];
  for (let i = 0; i < children.length; i++) {
    const hit = anchorIdOf(children[i], labelOf);
    if (hit) {
      buckets.push({ id: hit, from: i, to: i });
      continue;
    }
    const last = buckets[buckets.length - 1];
    if (last) last.to = i;
  }
  if (!buckets.length) return [];
  buckets[0].from = 0; // 第一个锚点之前的内容并进第一段

  const pieces: SectionPiece[] = [];
  for (const b of buckets) {
    const nodes = children.slice(b.from, b.to + 1);
    pieces.push({
      title: labelOf.get(b.id) || firstHeading(nodes) || fallbackTitle,
      text: nodesToText(nodes),
      href: sectionHref ? sectionHref + "#" + b.id : "",
      plainFrom: starts[b.from],
      plainTo: starts[b.to] + lens[b.to],
    });
  }
  return pieces;
}

type SectionDraft = {
  n: number;
  title: string;
  cfi: string;
  /** 跳这一章用的 href（含锚点）。整节一章时就是节 href */
  href: string;
  text: string;
  /** 所属 spine 节（0 起） */
  section: number;
  /** 只有"一节被切成多章"时才给：该章在该节纯文本里的去空白坐标 */
  plainFrom?: number;
  plainTo?: number;
};

type Extracted = { total: number; sections: SectionDraft[] };

/**
 * 用离屏引擎实例抽取全书正文（与阅读实例互不干扰，抽完即弃）。
 *
 * P3.7 起：**一章不再等于一节**。某节有 ≥2 条带锚点的目录项时按锚点切段，
 * 于是 total 是**章数**（不再等于 sections.length），空章节仍保留占位（n 连续）。
 * 跳转必须用 draft.href，不能再假设 goToSection(n - 1)。
 */
async function extractSections(
  source: Blob | string,
  onProgress?: (done: number, total: number) => void,
): Promise<Extracted> {
  await import("foliate-js/view.js");
  const view = document.createElement("foliate-view") as any;
  view.style.cssText = "position:absolute;left:-99999px;top:0;width:800px;height:600px;";
  document.body.appendChild(view);
  try {
    await view.open(source);
    const sections: any[] = view.book?.sections ?? [];
    const toc = buildTocIndex(view.book?.toc ?? []);
    const drafts: SectionDraft[] = [];
    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i];
      const key = normHref(sec?.id);
      const href = sectionHrefOf(sec?.id);
      let doc: any = null;
      let text = "";
      let heading = "";
      try {
        doc = await sec.createDocument?.();
        text = doc ? docToText(doc) : "";
        const h = doc?.body?.querySelector?.("h1,h2,h3,h4,h5,h6");
        heading = cleanLabel(h?.textContent);
      } catch {
        doc = null;
        text = "";
      }
      // 章节基 CFI + !/4：直接 goTo 基 CFI 会失败（见文件头注释）
      let cfi = "";
      try {
        const base = String(view.getCFI?.(i) ?? "");
        if (base.startsWith("epubcfi(")) cfi = base.includes("!") ? base : base.replace(/\)$/, "!/4)");
      } catch {
        cfi = "";
      }
      const title = lookupValue(toc.title, key) || heading || "第 " + (i + 1) + " 节";
      const anchors = lookupValue(toc.anchors, key) ?? [];
      const pieces = splitSectionDocument(doc, href, anchors, title);
      if (pieces.length >= 2) {
        // 一节多章：cfi 只精确到"这一节"，跳转交给 href（引擎的 resolveHref 认 #锚点）
        for (const p of pieces) {
          drafts.push({
            n: drafts.length + 1,
            title: p.title || title,
            cfi: "",
            href: p.href,
            text: p.text,
            section: i,
            plainFrom: p.plainFrom,
            plainTo: p.plainTo,
          });
        }
      } else {
        drafts.push({
          n: drafts.length + 1,
          title,
          cfi,
          href,
          text: pieces.length === 1 ? pieces[0].text : text,
          section: i,
        });
      }
      if (i % 25 === 0 || i === sections.length - 1) onProgress?.(i + 1, sections.length);
    }
    return { total: drafts.length, sections: drafts };
  } finally {
    try {
      view.close?.();
    } catch {
      /* 忽略 */
    }
    view.remove();
  }
}

// ---------- 组装 ----------

function bookHeader(title: string, author: string, total: number): string {
  return (
    '<book title="' + cleanLabel(title || "未命名") + '"' +
    (author ? ' author="' + cleanLabel(author) + '"' : "") +
    ' chapters="' + total + '">'
  );
}

/** 章节清单的一条（落盘在 book_context.manifest，工具层 get_toc 用它） */
export type ManifestEntry = {
  n: number;
  title: string;
  cfi: string;
  /** 跳转用的 href（含锚点）。P3.7 起跳转一律优先用它 */
  href: string;
  chars: number;
  /** 所属 spine 节（0 起）。检索命中的 section_index 靠它对应到章 */
  section: number;
  /** 只有"一节多章"时才有：该章在该节纯文本里的去空白坐标 */
  plainFrom?: number;
  plainTo?: number;
};

/**
 * 组装全书文本块。单趟累加 token，超过预算就停（mode = partial）。
 * 注意：任何字段都必须是这本书的稳定属性，绝不能带会话/时间信息。
 */
export function assembleBookText(
  title: string,
  author: string,
  extracted: Extracted,
  budgetTokens = CONTEXT_BUDGET_TOKENS,
): {
  text: string;
  chars: number;
  tokens: number;
  loadedChapters: number;
  mode: "full" | "partial";
  manifest: ManifestEntry[];
} {
  const parts: string[] = [bookHeader(title, author, extracted.total)];
  const acc = emptyCounts();
  countInto(parts[0], acc);
  let loaded = 0;
  let partial = false;
  for (const sec of extracted.sections) {
    const chunk =
      "\n<<CH n=" + sec.n + ' title="' + sec.title + '"' +
      (sec.cfi ? ' cfi="' + sec.cfi + '"' : "") +
      (sec.href ? ' href="' + cleanHref(sec.href) + '"' : "") +
      " chars=" + sec.text.length + ">>\n" + sec.text + "\n<<END>>";
    countInto(chunk, acc);
    if (tokensOf(acc) > budgetTokens && loaded > 0) {
      partial = true;
      break;
    }
    parts.push(chunk);
    loaded++;
  }
  if (partial) parts.push("\n(本书过长，上面只收录了前 " + loaded + " 章，共 " + extracted.total + " 章。)");
  parts.push("\n</book>");
  const text = parts.join("");
  const chars = text.length;
  const manifest: ManifestEntry[] = extracted.sections.map((s) => ({
    n: s.n,
    title: s.title,
    cfi: s.cfi,
    href: s.href,
    chars: s.text.length,
    section: s.section,
    ...(s.plainFrom === undefined ? {} : { plainFrom: s.plainFrom, plainTo: s.plainTo }),
  }));
  return { text, chars, tokens: tokensOf(acc), loadedChapters: loaded, mode: partial ? "partial" : "full", manifest };
}

// ---------- 对外入口 ----------

export type BuildOptions = {
  /** 源文件标识（路径）。与缓存里记录的不一致就重新抽取 */
  sourceKey: string;
  title: string;
  author: string;
  onProgress?: (done: number, total: number) => void;
  /** 忽略落盘缓存（调试用） */
  force?: boolean;
};

/**
 * 取得一本书的全书上下文：命中缓存直接返回，否则用离屏引擎抽取并落盘。
 *
 * 落盘的不只是正文，还有 token 估算 —— 界面上的「已装载 N 章 · 约 X token · 预计 ¥Y」
 * 在打开面板时就要显示，不能等抽取跑完。
 */
export async function buildBookContext(
  bookId: string,
  source: Blob | string,
  opts: BuildOptions,
): Promise<BookContextData> {
  const sourceKey = opts.sourceKey + "|" + CONTEXT_CACHE_VERSION;
  if (!opts.force) {
    const cached = await getBookContext(bookId);
    if (cached && cached.source_key === sourceKey && cached.text) {
      let manifest: BookContextData["manifest"] = [];
      try {
        manifest = JSON.parse(String(cached.manifest ?? "[]"));
      } catch {
        manifest = [];
      }
      return {
        chapters: Number(cached.chapters),
        loadedChapters: Number(cached.loaded_chapters),
        chars: Number(cached.chars),
        tokens: Number(cached.tokens),
        mode: cached.mode === "partial" ? "partial" : "full",
        text: String(cached.text),
        manifest,
        builtAt: Number(cached.built_at),
        fromCache: true,
      };
    }
  }
  const extracted = await extractSections(source, opts.onProgress);
  const built = assembleBookText(opts.title, opts.author, extracted);
  const builtAt = Date.now();
  try {
    await saveBookContext({
      book_id: bookId,
      source_key: sourceKey,
      text: built.text,
      chapters: extracted.total,
      loaded_chapters: built.loadedChapters,
      chars: built.chars,
      tokens: built.tokens,
      mode: built.mode,
      built_at: builtAt,
      manifest: JSON.stringify(built.manifest),
    });
  } catch {
    /* 缓存写失败不影响本次使用（下次重新抽取） */
  }
  return { ...built, chapters: extracted.total, builtAt, fromCache: false };
}

// ---------- 结构标记的解析（P2.3 工具层复用同一份格式定义） ----------

export type ChapterEntry = {
  n: number;
  title: string;
  cfi: string;
  /** 跳转用的 href（含锚点）；老缓存（v2 以前）里没有这一项，回退用 cfi/节号 */
  href: string;
  chars: number;
  /** 正文在上下文文本里的起止偏移：按需切片，不复制整段文本 */
  start: number;
  end: number;
};

const CH_RE = /<<CH n=(\d+) title="([^"]*)"(?: cfi="([^"]*)")?(?: href="([^"]*)")? chars=(\d+)>>\n/g;

/**
 * 把已装载的上下文解析成章节索引。
 *
 * 工具层（get_chapter / get_toc）直接吃这份索引：全书本来就已经在内存里，
 * 取章节不需要再开引擎、不需要查库 —— 这是"整本书进上下文"带来的额外好处。
 */
export function parseChapterIndex(text: string): ChapterEntry[] {
  const out: ChapterEntry[] = [];
  CH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CH_RE.exec(text))) {
    const start = m.index + m[0].length;
    const endMark = text.indexOf("\n<<END>>", start);
    out.push({
      n: Number(m[1]),
      title: m[2],
      cfi: m[3] ?? "",
      href: m[4] ?? "",
      chars: Number(m[5]),
      start,
      end: endMark < 0 ? text.length : endMark,
    });
  }
  return out;
}

/**
 * 把「某节纯文本里的一个**去空白**偏移」定位到章（P3.7）。
 *
 * 全文索引是按**节**建的，而单文件 EPUB 一节里有多章。命中位置在 norm(plain) 里的
 * 偏移与 manifest 上的 plainFrom/plainTo 是同一套坐标（两者都来自同一个
 * body.textContent，只差空白处理方式），所以这个映射是精确的。
 * 定位不到（老缓存没有坐标 / 偏移越界）就返回 undefined，调用方如实退。
 */
export function chapterAtPlainOffset(
  manifest: ManifestEntry[],
  section: number,
  offset: number,
): ManifestEntry | undefined {
  if (offset < 0) return undefined;
  return manifest.find(
    (m) =>
      m.section === section &&
      typeof m.plainFrom === "number" &&
      typeof m.plainTo === "number" &&
      offset >= m.plainFrom &&
      offset < m.plainTo,
  );
}

/** 文本的去空白形式：检索命中定位与切分坐标共用的同一把尺子 */
export const stripSpaces = (s: string): string => String(s ?? "").replace(/\s+/g, "");

/** 检索命中摊到章之后的一条 */
export type ChapterHit = { n: number; title: string; snippet: string; offset: number };

/**
 * 把一个**节级**的检索命中摊到**章级**（P3.7 待办 A 的配套）。
 *
 * 为什么需要：全文索引是按节建的，而单文件 EPUB 一节里可能有几十章；一个词在节里
 * 往往出现多次 —— 实测某本书里反复出现的同一个词：书首那份目录列表里一次、正文里两次。
 * 只报 indexOf 的第一次会把命中一律算进第 1 章（而那正是目录列表所在的那一章）。
 * 这里逐处定位、按章去重，每处给出**自己的**上下文片段。
 *
 * 上限 max 条（默认 3）：一个高频词在某节里出现几十次时不要把工具结果灌满。
 */
export function locateHits(
  manifest: ManifestEntry[],
  section: number,
  plain: string,
  query: string,
  max = 3,
): ChapterHit[] {
  const text = String(plain ?? "");
  const raw = String(query ?? "").trim();
  if (!text || !raw) return [];
  const hits: ChapterHit[] = [];
  const seen = new Set<number>();
  const push = (rawAt: number) => {
    // 章的坐标是"去空白"口径，所以这里要把原文偏移折算成去空白偏移
    const strippedAt = stripSpaces(text.slice(0, rawAt)).length;
    const m = chapterAtPlainOffset(manifest, section, strippedAt);
    if (!m || seen.has(m.n)) return;
    seen.add(m.n);
    const from = Math.max(0, rawAt - 30);
    hits.push({
      n: m.n,
      title: m.title,
      offset: strippedAt,
      snippet: (from > 0 ? "…" : "") + text.slice(from, rawAt + raw.length + 50) + "…",
    });
  };
  let from = 0;
  let at = text.indexOf(raw, from);
  while (at >= 0 && hits.length < max) {
    push(at);
    from = at + Math.max(1, raw.length);
    at = text.indexOf(raw, from);
  }
  if (!hits.length) {
    // 原文里找不到（词被换行/空白切开）：退回"去空白"定位一次
    const at2 = stripSpaces(text).indexOf(stripSpaces(raw));
    const m = at2 < 0 ? undefined : chapterAtPlainOffset(manifest, section, at2);
    if (m) hits.push({ n: m.n, title: m.title, offset: at2, snippet: text.slice(0, 120) + "…" });
  }
  return hits;
}

/** 按偏移切一段章节正文（大章节分次取，避免一次把整章塞进工具返回值） */
export function sliceChapter(
  text: string,
  entry: ChapterEntry,
  offset = 0,
  maxChars = 6000,
): { chunk: string; from: number; nextOffset: number; truncated: boolean } {
  const body = text.slice(entry.start, entry.end);
  const from = Math.max(0, Math.min(Math.trunc(offset), body.length));
  const chunk = body.slice(from, from + Math.max(200, Math.trunc(maxChars)));
  const nextOffset = from + chunk.length;
  return { chunk, from, nextOffset, truncated: nextOffset < body.length };
}

