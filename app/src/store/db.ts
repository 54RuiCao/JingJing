import { invoke } from "@tauri-apps/api/core";

/**
 * 数据层：薄封装 Rust 侧的 SQLite。
 *
 * 设计取舍：Rust 只暴露通用 exec/select，schema 与业务 SQL 全部放在 TS 里。
 * 这样加表/改字段不用重编译 Rust（本机 cargo 是 -j1 串行编译，代价很高）。
 */

export type Row = Record<string, unknown>;

export const exec = (sql: string, params: unknown[] = []) =>
  invoke<number>("db_execute", { sql, params });

export const execBatch = (sql: string) => invoke<void>("db_execute_batch", { sql });

export const select = <T = Row>(sql: string, params: unknown[] = []) =>
  invoke<T[]>("db_select", { sql, params });

/** 批量写入（Rust 侧单事务），rows 是"每行的参数数组" */
export const execMany = (sql: string, rows: unknown[][]) =>
  invoke<number>("db_execute_many", { sql, rows });

/** 建表 + 迁移。用 user_version 记录版本，迁移写成幂等的 IF NOT EXISTS 形式。 */
export async function initDb(): Promise<void> {
  const [row] = await select<{ user_version: number }>("PRAGMA user_version");
  const current = Number(row?.user_version ?? 0);

  if (current < 1) {
    await execBatch(`
      CREATE TABLE IF NOT EXISTS books (
        id           TEXT PRIMARY KEY,          -- 内容 sha（前 16 位）
        title        TEXT NOT NULL DEFAULT '',
        author       TEXT NOT NULL DEFAULT '',
        language     TEXT NOT NULL DEFAULT '',
        format       TEXT NOT NULL DEFAULT '',  -- epub / txt
        path         TEXT NOT NULL,             -- 应用数据目录内的绝对路径
        original_name TEXT NOT NULL DEFAULT '',
        size         INTEGER NOT NULL DEFAULT 0,
        added_at     INTEGER NOT NULL,
        opened_at    INTEGER,
        cover_path   TEXT,
        chapters     INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS reading_progress (
        book_id     TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
        location    TEXT NOT NULL,              -- foliate-js 的 lastLocation（JSON）
        fraction    REAL NOT NULL DEFAULT 0,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS annotations (
        id          TEXT PRIMARY KEY,
        book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL,              -- highlight / bookmark / note
        cfi         TEXT NOT NULL,
        text        TEXT NOT NULL DEFAULT '',
        note        TEXT NOT NULL DEFAULT '',
        color       TEXT NOT NULL DEFAULT 'yellow',
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_annotations_book ON annotations(book_id);

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS library_groups (
        id    TEXT PRIMARY KEY,
        name  TEXT NOT NULL,
        sort  INTEGER NOT NULL DEFAULT 0
      );
    `);
    await exec("PRAGMA user_version = 1");
  }

  if (current < 2) {
    // 全文检索：P0-7 实测结论——中文必须走「逐字空格化 + unicode61 短语查询」，
    // 直接对中文用 unicode61 会把整句当成一个 token，MATCH 永远命中 0 行。
    await execBatch(`
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
        book_id UNINDEXED,
        section_index UNINDEXED,
        plain UNINDEXED,
        spaced,
        tokenize = 'unicode61'
      );
    `);
    await exec("PRAGMA user_version = 2");
  }

  if (current < 3) {
    // TXT 转换出来的 EPUB 落盘，避免每次打开都重转（实测每次 0.6–1.2s）
    await execBatch("ALTER TABLE books ADD COLUMN derived_path TEXT;");
    await exec("PRAGMA user_version = 3");
  }

  if (current < 4) {
    // AI 会话消息（按书隔离；book_id 为空表示与书无关的通用对话）
    await execBatch(`
      CREATE TABLE IF NOT EXISTS ai_messages (
        id         TEXT PRIMARY KEY,
        book_id    TEXT,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_messages_book ON ai_messages(book_id, created_at);
    `);
    await exec("PRAGMA user_version = 4");
  }

  if (current < 5) {
    // P2.2 全书上下文：整本书带结构标记的正文块，落盘缓存。
    // 必须逐字节稳定（DeepSeek 硬盘缓存按前缀匹配），所以存的是"组装好的成品"而不是每次现拼。
    await execBatch(`
      CREATE TABLE IF NOT EXISTS book_context (
        book_id          TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
        source_key       TEXT NOT NULL,   -- 源文件路径；变了说明书换了，缓存失效
        text             TEXT NOT NULL,   -- <<CH ...>> 标记的正文块
        chapters         INTEGER NOT NULL,
        loaded_chapters  INTEGER NOT NULL,
        chars            INTEGER NOT NULL,
        tokens           INTEGER NOT NULL,
        mode             TEXT NOT NULL,   -- full / partial
        built_at         INTEGER NOT NULL
      );
    `);
    await exec("PRAGMA user_version = 5");
  }

  if (current < 6) {
    // P2.3：全书章节清单（n/title/cfi/chars 的 JSON）。partial 模式下正文只装了前 N 章，
    // 但目录应当是完整的——工具层 get_toc 需要它，界面也靠它显示总章数。
    await execBatch("ALTER TABLE book_context ADD COLUMN manifest TEXT NOT NULL DEFAULT '[]';");
    await exec("PRAGMA user_version = 6");
  }

  if (current < 7) {
    // P3.7：**阅读活动**（每天读了多少秒、翻了多少页）。
    //
    // 为什么放宿主而不是让插件自己记：插件沙箱里没有定时器，也没法知道
    // "阅读页是否可见 / 窗口有没有焦点" —— 那只有宿主知道。插件拿事实、负责呈现。
    await execBatch(`
      CREATE TABLE IF NOT EXISTS reading_activity (
        day        TEXT PRIMARY KEY,          -- 本地时区 YYYY-MM-DD
        seconds    INTEGER NOT NULL DEFAULT 0,
        turns      INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
    await exec("PRAGMA user_version = 7");
  }

  if (current < 8) {
    // P3.9：**书组**（书架上的归类）。library_groups 这张表 v1 就在了，但一直没有
    // "哪本书属于哪个组"的关系表，所以从来没用起来 —— 这里补上（多对多：一本书可以同时在
    // "在读"和"技术"里，比"一个文件夹"更实用），并给 group_id 建索引（侧栏要按组数书）。
    await execBatch(`
      CREATE TABLE IF NOT EXISTS book_groups (
        book_id  TEXT NOT NULL,
        group_id TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (book_id, group_id)
      );
      CREATE INDEX IF NOT EXISTS idx_book_groups_group ON book_groups(group_id);
    `);
    await exec("PRAGMA user_version = 8");
  }
}

// ---------- 阅读活动（P3.7） ----------

export type ReadingActivityRow = { day: string; seconds: number; turns: number };

/** 累加今天的阅读时长/翻页数（UPSERT 增量，不覆盖） */
export async function addReadingActivity(day: string, seconds: number, turns: number): Promise<void> {
  if (seconds <= 0 && turns <= 0) return;
  await exec(
    `INSERT INTO reading_activity (day, seconds, turns, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       seconds = seconds + excluded.seconds,
       turns = turns + excluded.turns,
       updated_at = excluded.updated_at`,
    [day, Math.max(0, Math.round(seconds)), Math.max(0, Math.round(turns)), Date.now()],
  );
}

/** 取最近 N 天的活动（升序，只给有记录的日期） */
export async function listReadingActivity(limitDays = 400): Promise<ReadingActivityRow[]> {
  return select<ReadingActivityRow>(
    "SELECT day, seconds, turns FROM reading_activity ORDER BY day DESC LIMIT ?",
    [Math.max(1, Math.round(limitDays))],
  ).then((rows) => rows.reverse());
}

// ---------- 全书上下文（P2.2） ----------

export type StoredBookContext = {
  book_id: string;
  source_key: string;
  text: string;
  chapters: number;
  loaded_chapters: number;
  chars: number;
  tokens: number;
  mode: "full" | "partial";
  built_at: number;
  /** 全书章节清单：[{n,title,cfi,chars}] */
  manifest: string;
};

export async function getBookContext(bookId: string): Promise<StoredBookContext | null> {
  const rows = await select<StoredBookContext>("SELECT * FROM book_context WHERE book_id = ?", [bookId]);
  return rows[0] ?? null;
}

export async function saveBookContext(row: StoredBookContext): Promise<void> {
  await exec(
    `INSERT INTO book_context (book_id, source_key, text, chapters, loaded_chapters, chars, tokens, mode, built_at, manifest)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(book_id) DO UPDATE SET
       source_key=excluded.source_key, text=excluded.text, chapters=excluded.chapters,
       loaded_chapters=excluded.loaded_chapters, chars=excluded.chars, tokens=excluded.tokens,
       mode=excluded.mode, built_at=excluded.built_at, manifest=excluded.manifest`,
    [row.book_id, row.source_key, row.text, row.chapters, row.loaded_chapters, row.chars,
     row.tokens, row.mode, row.built_at, row.manifest ?? "[]"],
  );
}

export async function deleteBookContext(bookId: string): Promise<void> {
  await exec("DELETE FROM book_context WHERE book_id = ?", [bookId]);
}

// ---------- AI 会话 ----------

export type AiMessage = {
  id: string;
  book_id: string | null;
  role: "system" | "user" | "assistant";
  content: string;
  created_at: number;
};

export async function listAiMessages(bookId: string | null, limit = 200): Promise<AiMessage[]> {
  return select<AiMessage>(
    bookId
      ? "SELECT * FROM ai_messages WHERE book_id = ? ORDER BY created_at ASC LIMIT ?"
      : "SELECT * FROM ai_messages WHERE book_id IS NULL ORDER BY created_at ASC LIMIT ?",
    bookId ? [bookId, limit] : [limit],
  );
}

export async function addAiMessage(
  bookId: string | null,
  role: AiMessage["role"],
  content: string,
): Promise<AiMessage> {
  const row: AiMessage = {
    id: crypto.randomUUID(),
    book_id: bookId,
    role,
    content,
    created_at: Date.now(),
  };
  await exec(
    "INSERT INTO ai_messages (id, book_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    [row.id, row.book_id, row.role, row.content, row.created_at],
  );
  return row;
}

/** 删掉一条会话消息（P3.7：不必为了删几句话把整段对话清空） */
export async function deleteAiMessage(id: string): Promise<void> {
  await exec("DELETE FROM ai_messages WHERE id = ?", [id]);
}

export async function clearAiMessages(bookId: string | null): Promise<void> {
  if (bookId) await exec("DELETE FROM ai_messages WHERE book_id = ?", [bookId]);
  else await exec("DELETE FROM ai_messages WHERE book_id IS NULL");
}

/** 把派生文件（TXT 转出的 EPUB）存到应用数据目录，返回其绝对路径 */
export async function saveDerivedEpub(sha: string, bytes: Uint8Array): Promise<string> {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return invoke<string>("save_book_derived", { sha, ext: "epub", base64: btoa(binary) });
}

// ---------- 全文检索 ----------

/** 把一个字符串转成"逐字空格化"形式，供 FTS5 的 unicode61 分词器逐字建索引 */
const toSpaced = (s: string) => Array.from(s).join(" ");

/** 查询词 → FTS5 MATCH 表达式（多个词之间是 AND） */
export function toMatchQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => '"' + toSpaced(t) + '"')
    .join(" AND ");
}

export async function clearSearchIndex(bookId: string): Promise<void> {
  await exec("DELETE FROM search_index WHERE book_id = ?", [bookId]);
}

export async function countIndexedSections(bookId: string): Promise<number> {
  const rows = await select<{ n: number }>(
    "SELECT COUNT(*) AS n FROM search_index WHERE book_id = ?",
    [bookId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** 批量写入索引（每批建议 200 行以内） */
export async function insertSearchRows(
  bookId: string,
  rows: { index: number; plain: string }[],
): Promise<void> {
  if (!rows.length) return;
  await execMany(
    "INSERT INTO search_index (book_id, section_index, plain, spaced) VALUES (?, ?, ?, ?)",
    rows.map((r) => [bookId, r.index, r.plain, toSpaced(r.plain)]),
  );
}

export type SearchHit = { sectionIndex: number; snippet: string; plain: string };

export async function searchBook(bookId: string, query: string, limit = 60): Promise<SearchHit[]> {
  const match = toMatchQuery(query);
  if (!match) return [];
  const rows = await select<{ section_index: number; plain: string }>(
    `SELECT section_index, plain FROM search_index
     WHERE search_index MATCH ? AND book_id = ?
     ORDER BY rank LIMIT ?`,
    [match, bookId, limit],
  );
  const needle = query.trim();
  return rows.map((r) => {
    const plain = String(r.plain ?? "");
    const at = plain.toLowerCase().indexOf(needle.toLowerCase());
    const start = Math.max(0, at - 30);
    const snippet = at < 0 ? plain.slice(0, 90) : (start > 0 ? "…" : "") + plain.slice(start, at + needle.length + 50) + "…";
    return { sectionIndex: Number(r.section_index), snippet, plain };
  });
}

// ---------- 书籍 ----------

export type Book = {
  id: string;
  title: string;
  author: string;
  language: string;
  format: string;
  path: string;
  original_name: string;
  size: number;
  added_at: number;
  opened_at: number | null;
  cover_path: string | null;
  chapters: number;
  /** TXT 转换出来的 EPUB 路径（有则优先用它打开） */
  derived_path?: string | null;
};

export type ImportedFile = {
  sha: string;
  path: string;
  originalName: string;
  ext: string;
  size: number;
};

export const importBookFile = (src: string) =>
  invoke<ImportedFile>("import_book_file", { src });

export const deleteBookFile = (path: string) => invoke<void>("delete_book_file", { path });

export const getBooksDir = () => invoke<string>("get_books_dir");

export async function listBooks(): Promise<Book[]> {
  return select<Book>("SELECT * FROM books ORDER BY COALESCE(opened_at, added_at) DESC");
}

export async function upsertBook(book: Book): Promise<void> {
  await exec(
    `INSERT INTO books (id, title, author, language, format, path, original_name, size, added_at, opened_at, cover_path, chapters, derived_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, author=excluded.author, language=excluded.language,
       format=excluded.format, path=excluded.path, original_name=excluded.original_name,
       size=excluded.size, cover_path=excluded.cover_path, chapters=excluded.chapters,
       derived_path=COALESCE(excluded.derived_path, books.derived_path)`,
    [
      book.id, book.title, book.author, book.language, book.format, book.path,
      book.original_name, book.size, book.added_at, book.opened_at, book.cover_path, book.chapters,
      book.derived_path ?? null,
    ],
  );
}

export async function getBook(id: string): Promise<Book | null> {
  const rows = await select<Book>("SELECT * FROM books WHERE id = ?", [id]);
  return rows[0] ?? null;
}

export async function touchBook(id: string): Promise<void> {
  await exec("UPDATE books SET opened_at = ? WHERE id = ?", [Date.now(), id]);
}

export async function deleteBook(id: string): Promise<void> {
  const book = await getBook(id);
  if (book) {
    try {
      await deleteBookFile(book.path);
    } catch {
      /* 文件可能已被手动删除 */
    }
  }
  await exec("DELETE FROM books WHERE id = ?", [id]);
}

// ---------- 阅读进度 ----------

export async function saveProgress(bookId: string, location: unknown, fraction: number): Promise<void> {
  await exec(
    `INSERT INTO reading_progress (book_id, location, fraction, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(book_id) DO UPDATE SET location=excluded.location, fraction=excluded.fraction, updated_at=excluded.updated_at`,
    [bookId, JSON.stringify(location), fraction, Date.now()],
  );
}

export async function loadProgress(bookId: string): Promise<{ location: unknown; fraction: number } | null> {
  const rows = await select<{ location: string; fraction: number }>(
    "SELECT location, fraction FROM reading_progress WHERE book_id = ?",
    [bookId],
  );
  const row = rows[0];
  if (!row) return null;
  try {
    return { location: JSON.parse(row.location), fraction: row.fraction };
  } catch {
    return null;
  }
}

// ---------- 设置 ----------

// ---------- 书组（P3.9） ----------

export type BookGroup = {
  id: string;
  name: string;
  sort: number;
};

/** 书与组的关联（多对多） */
export type BookGroupLink = { book_id: string; group_id: string };

export async function listGroups(): Promise<BookGroup[]> {
  return select<BookGroup>("SELECT id, name, sort FROM library_groups ORDER BY sort ASC, name ASC", []);
}

export async function createGroup(name: string): Promise<BookGroup> {
  const rows = await select<{ maxSort: number | null }>(
    "SELECT MAX(sort) AS maxSort FROM library_groups",
    [],
  );
  const sort = Number(rows[0]?.maxSort ?? 0) + 1;
  const group: BookGroup = { id: crypto.randomUUID(), name, sort };
  await exec("INSERT INTO library_groups (id, name, sort) VALUES (?, ?, ?)", [group.id, group.name, group.sort]);
  return group;
}

export async function renameGroup(id: string, name: string): Promise<void> {
  await exec("UPDATE library_groups SET name = ? WHERE id = ?", [name, id]);
}

/** 删组：连关联一起删（否则会留下指向不存在组的孤儿行） */
export async function deleteGroup(id: string): Promise<void> {
  await execMany("DELETE FROM book_groups WHERE group_id = ?", [[id]]);
  await exec("DELETE FROM library_groups WHERE id = ?", [id]);
}

export async function listBookGroups(): Promise<BookGroupLink[]> {
  return select<BookGroupLink>("SELECT book_id, group_id FROM book_groups", []);
}

/** 整本书的组归属一次性替换（界面上的勾选就是"这份列表"） */
export async function setBookGroups(bookId: string, groupIds: string[]): Promise<void> {
  const unique = [...new Set(groupIds.filter(Boolean))];
  await exec("DELETE FROM book_groups WHERE book_id = ?", [bookId]);
  if (unique.length) {
    const now = Date.now();
    await execMany(
      "INSERT INTO book_groups (book_id, group_id, added_at) VALUES (?, ?, ?)",
      unique.map((gid) => [bookId, gid, now]),
    );
  }
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const rows = await select<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]);
  if (!rows[0]) return fallback;
  try {
    return JSON.parse(rows[0].value) as T;
  } catch {
    return fallback;
  }
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await exec(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [key, JSON.stringify(value)],
  );
}

// ---------- 批注（划线 / 书签 / 笔记） ----------

export type AnnotationKind = "highlight" | "bookmark" | "note";

export type Annotation = {
  id: string;
  book_id: string;
  kind: AnnotationKind;
  cfi: string;
  text: string;
  note: string;
  color: string;
  created_at: number;
};

/**
 * 从 EPUB CFI 里解析出章节序号：epubcfi(/6/412!/4,...) → 205
 *
 * 注意 CFI 里可能带 id 断言：我们自己生成的 TXT→EPUB 的 itemref 有 idref="ch0"，
 * 引擎产出的 CFI 形如 epubcfi(/6/2[ch0]!/4/2/2:5)。原正则要求 叹号 紧跟数字，
 * 遇到带 id 断言的书会一律返回 null → 批注重绘时找不到所属章节（实测踩到）。
 */
export function sectionIndexOfCfi(cfi: string): number | null {
  const m = /^epubcfi\(\/6\/(\d+)(?:\[[^\]]*\])?!/.exec(cfi);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return n / 2 - 1;
}

/**
 * 全部批注（跨书）：主页的「笔记」页用它。
 * 带书名是为了不用为每条批注再查一次书；书被删掉时 LEFT JOIN 给 null，界面照样列出来（不丢数据）。
 */
export type AnnotationWithBook = Annotation & { book_title: string | null; book_author: string | null };

export async function listAllAnnotations(limit = 500): Promise<AnnotationWithBook[]> {
  return select<AnnotationWithBook>(
    `SELECT a.*, b.title AS book_title, b.author AS book_author
       FROM annotations a LEFT JOIN books b ON b.id = a.book_id
      ORDER BY a.created_at DESC LIMIT ?`,
    [Math.max(1, Math.round(limit))],
  );
}

export type AnnotationCounts = { all: number; highlight: number; note: number; bookmark: number };

/** 批注按类型计数（侧栏标签上的数字用它，不必把全部行拉回界面再数） */
export async function countAnnotations(): Promise<AnnotationCounts> {
  const rows = await select<{ kind: string; n: number }>(
    "SELECT kind, COUNT(*) AS n FROM annotations GROUP BY kind",
    [],
  );
  const out: AnnotationCounts = { all: 0, highlight: 0, note: 0, bookmark: 0 };
  for (const r of rows) {
    const n = Number(r.n) || 0;
    out.all += n;
    if (r.kind === "highlight" || r.kind === "note" || r.kind === "bookmark") out[r.kind] = n;
  }
  return out;
}

export async function listAnnotations(bookId: string): Promise<Annotation[]> {
  return select<Annotation>(
    "SELECT * FROM annotations WHERE book_id = ? ORDER BY created_at ASC",
    [bookId],
  );
}

export async function addAnnotation(a: {
  bookId: string;
  kind: AnnotationKind;
  cfi: string;
  text?: string;
  note?: string;
  color?: string;
}): Promise<Annotation> {
  const row: Annotation = {
    id: crypto.randomUUID(),
    book_id: a.bookId,
    kind: a.kind,
    cfi: a.cfi,
    text: a.text ?? "",
    note: a.note ?? "",
    color: a.color ?? "yellow",
    created_at: Date.now(),
  };
  await exec(
    `INSERT INTO annotations (id, book_id, kind, cfi, text, note, color, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.book_id, row.kind, row.cfi, row.text, row.note, row.color, row.created_at],
  );
  return row;
}

export async function updateAnnotation(id: string, patch: { note?: string; color?: string }): Promise<void> {
  if (patch.note !== undefined) await exec("UPDATE annotations SET note = ? WHERE id = ?", [patch.note, id]);
  if (patch.color !== undefined) await exec("UPDATE annotations SET color = ? WHERE id = ?", [patch.color, id]);
}

export async function deleteAnnotation(id: string): Promise<void> {
  await exec("DELETE FROM annotations WHERE id = ?", [id]);
}

/** 找出与某个 CFI 完全相同的批注（用于"取消划线"） */
export async function findAnnotationByCfi(bookId: string, cfi: string): Promise<Annotation | null> {
  const rows = await select<Annotation>(
    "SELECT * FROM annotations WHERE book_id = ? AND cfi = ? LIMIT 1",
    [bookId, cfi],
  );
  return rows[0] ?? null;
}
