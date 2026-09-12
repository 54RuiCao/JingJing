import { clearSearchIndex, countIndexedSections, insertSearchRows } from "../store/db";

/**
 * 为一本书建立 FTS5 全文索引。
 *
 * 做法：用一个离屏引擎实例打开书籍，逐章节 `section.createDocument()` 取出纯文本，
 * 按「逐字空格化」写入 search_index（P0-7 实测：中文用 unicode61 直接建索引会失效，
 * 必须逐字空格化后用短语查询，实测亚毫秒）。
 *
 * 索引与阅读互不干扰（离屏实例），建完即丢弃。
 */
export async function indexBook(
  bookId: string,
  source: Blob | string,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  await import("foliate-js/view.js");
  const view = document.createElement("foliate-view") as any;
  view.style.cssText = "position:absolute;left:-99999px;top:0;width:800px;height:600px;";
  document.body.appendChild(view);
  try {
    await view.open(source);
    const sections: any[] = view.book?.sections ?? [];
    await clearSearchIndex(bookId);
    let buffer: { index: number; plain: string }[] = [];
    for (let i = 0; i < sections.length; i++) {
      let plain = "";
      try {
        const doc = await sections[i].createDocument?.();
        plain = String(doc?.body?.textContent ?? "").replace(/\s+/g, " ").trim();
      } catch {
        plain = "";
      }
      buffer.push({ index: i, plain });
      if (buffer.length >= 200) {
        await insertSearchRows(bookId, buffer);
        buffer = [];
      }
      if (i % 25 === 0 || i === sections.length - 1) onProgress?.(i + 1, sections.length);
    }
    if (buffer.length) await insertSearchRows(bookId, buffer);
    return sections.length;
  } finally {
    try {
      view.close?.();
    } catch {
      /* 忽略 */
    }
    view.remove();
  }
}

/** 没有索引就建一次 */
export async function ensureIndexed(
  bookId: string,
  source: Blob | string,
  onProgress?: (done: number, total: number) => void,
): Promise<boolean> {
  const existing = await countIndexedSections(bookId);
  if (existing > 0) return false;
  await indexBook(bookId, source, onProgress);
  return true;
}
