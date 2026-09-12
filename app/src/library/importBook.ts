import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import { bytesToBase64 } from "./bytes";
import { extractMetadata } from "./extractMetadata";
import { getBook, importBookFile, saveDerivedEpub, upsertBook } from "../store/db";

/**
 * 导入一本书（书架按钮、拖拽、原生对话框都走这里）。
 *
 * 两条入口，落盘与去重口径完全一致（内容寻址：sha256 前 16 位 + 扩展名）：
 *   - `importBookFromPath`：桌面（拖拽、dialog 插件给的是真实路径）；
 *   - `importBookFromFile`：**移动端唯一路径** —— Android 的文件选择器给的是
 *     `content://` URI，Rust 侧读不了（要走 ContentResolver），所以用
 *     `<input type="file">` 拿到 File，读成字节 base64 传给 `import_book_bytes`。
 * 步骤：复制到应用数据目录 → 用引擎提取元数据 → 写入 books 表。
 * TXT 需要先转成 EPUB 才能交给引擎解析。
 */
export type ImportResult = { id: string; title: string; format: string };

/** Tauri 命令 import_book_file / import_book_bytes 的返回形状 */
type ImportedFile = {
  sha: string;
  path: string;
  originalName: string;
  ext: string;
  size: number;
};

const isPdf = (s: string) => /\.pdf($|\?)/i.test(s);

/** 落盘之后的共同后半段：提元数据 → TXT 转 EPUB → 写 books 表 */
async function finishImport(imported: ImportedFile, blob?: Blob): Promise<ImportResult> {
  // 移动端走 Blob（字节已经在手里，不必再去读一次文件，也不依赖 asset 协议）；
  // 桌面走 asset 协议的 URL。
  const objectUrl = blob ? URL.createObjectURL(blob) : null;
  const url = objectUrl ?? convertFileSrc(imported.path);
  const existing = await getBook(imported.sha);

  let meta;
  let derivedPath: string | null = null;
  try {
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
      const epubUrl = URL.createObjectURL(res.file);
      try {
        meta = await extractMetadata(epubUrl);
      } finally {
        URL.revokeObjectURL(epubUrl);
      }
    } else {
      meta = await extractMetadata(url);
    }
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
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

/** 桌面：从磁盘路径导入 */
export async function importBookFromPath(srcPath: string): Promise<ImportResult> {
  if (/^content:\/\//i.test(srcPath)) {
    // 真机上传进来的 content:// URI —— 让上层改用 importBookFromFile
    throw new Error(t("lib.contentUriUnsupported"));
  }
  // PDF 提前拦下：引擎能解析、能打开，但画布始终 0×0（渲染没跑起来），
  // 导入进来只会得到一本打不开的书。宁可明确拒绝，也不要给用户一个空白页。
  if (isPdf(srcPath)) {
    throw new Error(t("lib.pdfUnsupported"));
  }
  const imported = (await importBookFile(srcPath)) as ImportedFile;
  return finishImport(imported);
}

/** 移动端（以及桌面上走 <input type="file"> 的场景）：从 File 对象导入 */
export async function importBookFromFile(file: File): Promise<ImportResult> {
  const name = file.name || "book";
  if (isPdf(name)) throw new Error(t("lib.pdfUnsupported"));
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) throw new Error(t("lib.emptyFile"));
  const base64 = bytesToBase64(bytes);
  const imported = (await invoke("import_book_bytes", { name, base64 })) as ImportedFile;
  return finishImport(imported, new Blob([bytes]));
}
