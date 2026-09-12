import { convertFileSrc } from "@tauri-apps/api/core";
import { t } from "../i18n";
import { extractMetadata } from "./extractMetadata";
import { getBook, importBookFile, saveDerivedEpub, upsertBook } from "../store/db";

/**
 * 从磁盘路径导入一本书（书架按钮、拖拽、原生对话框都走这里）。
 *
 * 步骤：复制到应用数据目录（内容寻址，天然去重）→ 用引擎提取元数据 → 写入 books 表。
 * TXT 需要先转成 EPUB 才能交给引擎解析。
 */
export type ImportResult = { id: string; title: string; format: string };

export async function importBookFromPath(srcPath: string): Promise<ImportResult> {
  // PDF 提前拦下：引擎能解析、能打开，但画布始终 0×0（渲染没跑起来），
  // 导入进来只会得到一本打不开的书。宁可明确拒绝，也不要给用户一个空白页。
  if (/\.pdf$/i.test(srcPath)) {
    throw new Error(t("lib.pdfUnsupported"));
  }
  const imported = await importBookFile(srcPath);
  const existing = await getBook(imported.sha);
  const url = convertFileSrc(imported.path);

  let meta;
  let derivedPath: string | null = null;
  if (imported.ext === "txt") {
    const { txtToEpubFile } = await import("../reader/txtToEpub");
    const text = await (await fetch(url)).text();
    const res = await txtToEpubFile(text, imported.originalName.replace(/\.txt$/i, ""));
    // 转换结果落盘：否则每次打开都要重转（实测 0.6–1.2s）
    try {
      derivedPath = await saveDerivedEpub(imported.sha, new Uint8Array(await res.file.arrayBuffer()));
    } catch {
      derivedPath = null;
    }
    const objectUrl = URL.createObjectURL(res.file);
    try {
      meta = await extractMetadata(objectUrl);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } else {
    meta = await extractMetadata(url);
  }

  const title = meta.title || imported.originalName;
  await upsertBook({
    id: imported.sha,
    title,
    author: meta.author,
    language: meta.language,
    format: imported.ext || "epub",
    path: imported.path,
    original_name: imported.originalName,
    size: imported.size,
    added_at: existing?.added_at ?? Date.now(),
    opened_at: existing?.opened_at ?? null,
    cover_path: meta.coverDataUrl,
    chapters: meta.chapters,
    derived_path: derivedPath,
  });

  return { id: imported.sha, title, format: imported.ext || "epub" };
}
