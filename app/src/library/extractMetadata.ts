/**
 * 用引擎本身提取书籍元数据（标题/作者/语言/章节数/封面）。
 *
 * 做法是挂一个离屏的 <foliate-view>，open 之后读 book.metadata 再关掉。
 * 不自己解析 OPF，避免在引擎之外再养一套解析逻辑。
 */

export type ExtractedMetadata = {
  title: string;
  author: string;
  language: string;
  chapters: number;
  coverDataUrl: string | null;
};

const pickString = (v: unknown): string => {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return pickString(v[0]);
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).map(pickString).find(Boolean) ?? "";
  return "";
};

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

export async function extractMetadata(url: string): Promise<ExtractedMetadata> {
  await import("foliate-js/view.js");
  const view = document.createElement("foliate-view") as any;
  view.style.cssText = "position:absolute;left:-99999px;top:0;width:800px;height:600px;";
  document.body.appendChild(view);
  try {
    await view.open(url);
    const book = view.book;
    const md = book?.metadata ?? {};
    let coverDataUrl: string | null = null;
    try {
      const cover = await book?.getCover?.();
      // 只保留 200KB 以内的封面，避免把数据库撑大
      if (cover && cover.size > 0 && cover.size < 200 * 1024) {
        coverDataUrl = await blobToDataUrl(cover);
      }
    } catch {
      /* 没有封面就算了 */
    }
    return {
      title: pickString(md.title),
      author: pickString(md.author),
      language: pickString(md.language),
      chapters: book?.sections?.length ?? 0,
      coverDataUrl,
    };
  } finally {
    try {
      view.close?.();
    } catch {
      /* 忽略 */
    }
    view.remove();
  }
}
