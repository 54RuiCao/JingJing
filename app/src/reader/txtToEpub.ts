/**
 * TXT → EPUB 转换（P0-4）
 *
 * foliate-js 不支持裸 TXT，所以采用「导入时转成 EPUB」的策略（与 另一个同类阅读器 相同思路）。
 * 这里刻意不引入任何 zip 依赖：自研最小 ZIP 写入器 + 浏览器原生 CompressionStream 做 deflate。
 */

// 这个文件里有几处局部变量就叫 `t`（CRC 表、trim 结果），所以导入时改名
import { t as tr } from "../i18n";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") return data;
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

type Entry = { name: string; data: Uint8Array; store?: boolean };

async function buildZip(entries: Entry[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = encoder.encode(e.name);
    const raw = e.data;
    const body = e.store ? raw : await deflateRaw(raw);
    const method = e.store ? 0 : 8;
    const crc = crc32(raw);

    const lh = new Uint8Array(30);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBuf.length, true);
    lv.setUint16(28, 0, true);
    locals.push(lh, nameBuf, body);

    const ch = new Uint8Array(46);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBuf.length, true);
    cuint16(ch, 30, 0); cuint16(ch, 32, 0); cuint16(ch, 34, 0); cuint16(ch, 36, 0); cuint32(ch, 38, 0);
    cv.setUint32(42, offset, true);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const localBuf = concat(locals);
  const centralBuf = concat(centrals);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralBuf.length, true);
  ev.setUint32(16, localBuf.length, true);
  return concat([localBuf, centralBuf, eocd]);
}

// 小工具：写 Uint8Array 的辅助（避免 DataView 与 push 混用出错）
function cuint16(arr: Uint8Array, off: number, v: number) {
  arr[off] = v & 0xff; arr[off + 1] = (v >> 8) & 0xff;
}
function cuint32(arr: Uint8Array, off: number, v: number) {
  arr[off] = v & 0xff; arr[off + 1] = (v >> 8) & 0xff; arr[off + 2] = (v >> 16) & 0xff; arr[off + 3] = (v >> 24) & 0xff;
}
function concat(list: Uint8Array[]): Uint8Array {
  const total = list.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of list) { out.set(a, p); p += a.length; }
  return out;
}

// ---------- 分章 ----------

const CHAPTER_RE =
  /^[\s　]*(第[零一二三四五六七八九十百千万0-9]+[章节節回卷篇部集]|序章|序言|序|楔子|引子|前言|尾声|后记|尾聲|番外|Chapter\s+[0-9IVXLC]+|[卷][零一二三四五六七八九十百千万0-9]+)[^\n]{0,50}$/;

export type TxtChapter = { title: string; lines: string[] };

export function splitChapters(text: string): TxtChapter[] {
  const rawLines = text.split(/\r?\n/);
  const chapters: TxtChapter[] = [];
  let current: TxtChapter | null = null;

  for (const line of rawLines) {
    const t = line.trim();
    if (CHAPTER_RE.test(t)) {
      if (current) chapters.push(current);
      current = { title: t, lines: [] };
    } else {
      if (!current) current = { title: tr("reader.bodyChapter"), lines: [] };
      if (t) current.lines.push(t);
    }
  }
  if (current) chapters.push(current);
  return chapters;
}

// ---------- EPUB 组装 ----------

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `body { line-height: 1.75; }
h1 { font-size: 1.4em; text-align: center; margin: 1.2em 0 1em; }
p { margin: 0 0 0.7em; text-indent: 2em; }
`;

export type TxtImportStats = {
  chars: number;
  lines: number;
  chapters: number;
  convertMs: number;
  epubBytes: number;
  heapMB: number | null;
};

export async function txtToEpubFile(
  text: string,
  bookTitle: string,
): Promise<{ file: File; stats: TxtImportStats }> {
  const t0 = performance.now();
  const chapters = splitChapters(text);
  const encoder = new TextEncoder();

  const chapterFiles = chapters.map((c, i) => {
    const id = String(i + 1).padStart(4, "0");
    const body = c.lines.map((l) => `    <p>${escapeXml(l)}</p>`).join("\n");
    const html = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN">
<head><title>${escapeXml(c.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
  <h1>${escapeXml(c.title)}</h1>
${body}
</body>
</html>
`;
    return { id, title: c.title, name: `OEBPS/ch${id}.xhtml`, data: encoder.encode(html) };
  });

  const manifest = chapterFiles
    .map((c) => `    <item id="ch${c.id}" href="ch${c.id}.xhtml" media-type="application/xhtml+xml"/>`)
    .join("\n");
  const spine = chapterFiles.map((c) => `    <itemref idref="ch${c.id}"/>`).join("\n");
  const navList = chapterFiles
    .map((c) => `        <li><a href="ch${c.id}.xhtml">${escapeXml(c.title)}</a></li>`)
    .join("\n");
  const ncxNav = chapterFiles
    .map(
      (c, i) =>
        `    <navPoint id="np${c.id}" playOrder="${i + 1}"><navLabel><text>${escapeXml(c.title)}</text></navLabel><content src="ch${c.id}.xhtml"/></navPoint>`,
    )
    .join("\n");

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:aireader-txt-${Date.now()}</dc:identifier>
    <dc:title>${escapeXml(bookTitle)}</dc:title>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
${manifest}
  </manifest>
  <spine toc="ncx">
${spine}
  </spine>
</package>
`;

  // 生成的目录页标题跟着界面语言走（导入时定型；以后换语言不改已生成的书）
  const tocTitle = tr("reader.tocTitle");
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>${tocTitle}</title></head>
<body><nav epub:type="toc" id="toc"><h1>${tocTitle}</h1><ol>
${navList}
</ol></nav></body>
</html>
`;

  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:aireader-txt"/></head>
  <docTitle><text>${escapeXml(bookTitle)}</text></docTitle>
  <navMap>
${ncxNav}
  </navMap>
</ncx>
`;

  const entries: Entry[] = [
    { name: "mimetype", data: encoder.encode("application/epub+zip"), store: true },
    {
      name: "META-INF/container.xml",
      data: encoder.encode(
        `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`,
      ),
    },
    { name: "OEBPS/content.opf", data: encoder.encode(opf) },
    { name: "OEBPS/nav.xhtml", data: encoder.encode(nav) },
    { name: "OEBPS/toc.ncx", data: encoder.encode(ncx) },
    { name: "OEBPS/style.css", data: encoder.encode(CSS) },
    ...chapterFiles.map((c) => ({ name: c.name, data: c.data })),
  ];

  const zipBytes = await buildZip(entries);
  const convertMs = performance.now() - t0;
  const file = new File([zipBytes as unknown as BlobPart], bookTitle + ".epub", {
    type: "application/epub+zip",
  });

  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return {
    file,
    stats: {
      chars: text.length,
      lines: chapters.reduce((s, c) => s + c.lines.length, 0),
      chapters: chapters.length,
      convertMs: Math.round(convertMs),
      epubBytes: zipBytes.length,
      heapMB: mem ? Math.round((mem.usedJSHeapSize / 1048576) * 10) / 10 : null,
    },
  };
}
