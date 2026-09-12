import { deflateRawSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ---------- 最小 ZIP 写入器（EPUB 需要 mimetype 为第一个且不压缩） ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const method = e.store ? 0 : 8;
    const body = method === 0 ? raw : deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + body.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

// ---------- 生成中文测试书 ----------
const CHAPTERS = [
  { t: "第一章　记忆的可靠性", body: [
    "人的记忆并不是一台录像机。它更像是一位不断重写稿件的编辑：每一次回忆，都会把旧稿取出来，按照当下的心境与期待重新誊抄一遍，然后再放回原处。",
    "心理学家伊丽莎白·洛夫特斯（Elizabeth Loftus）做过一个著名的实验。她给被试观看一段交通事故的短片，随后用不同的措辞提问：「两车相撞时车速大约多少？」与「两车接触时车速大约多少？」——仅仅一个动词的差别，就让人们对车速的估计相差近十英里。",
    "这意味着什么？意味着提问本身就在塑造答案。我们以为是「回忆」，其实常常是「重建」。",
    "「可是，我明明记得很清楚。」你或许会这样反驳。问题恰恰出在这里：记忆的清晰程度，与它的准确程度之间，并没有我们以为的那种强相关。",
    "一个细节被反复讲述，它就会变得越来越具体、越来越生动、越来越「真实」——哪怕它从未发生过。",
  ]},
  { t: "第二章　从「更快」到「更慢」", body: [
    "现代社会对速度的崇拜，几乎已经成了一种默认的价值观。更快的网络、更快的响应、更快的迭代——仿佛慢下来就是失败。",
    "但有些事情的节律，是无法被压缩的。一杯茶需要三分钟才能泡开；一段友谊需要几个月才能成形；一个人对一本书的理解，往往需要数年。",
    "作者卡尔·奥诺雷（Carl Honoré）在《慢活》中提出了一个悖论：当我们把每一件事都加速到极限，我们最终失去的，恰恰是那些让生活值得一过的部分。",
    "这并不意味着要放弃效率。它意味着要区分：哪些事情值得加速，哪些事情一旦加速就失去了意义。",
  ]},
  { t: "第三章　注意力是一种资源", body: [
    "注意力与金钱不同。金钱可以存储、可以借贷、可以转移；注意力只能被消耗，而且它的总量每天都在重置。",
    "更麻烦的是，注意力具有「切换成本」。从一项任务切到另一项，再切回来，需要重新加载上下文——这个过程所消耗的时间，往往比我们意识到的要多得多。",
    "研究表明，一次典型的干扰之后，人平均需要约 23 分钟才能完全回到原来的状态。这解释了为什么「随时响应」的工作方式，会让人一整天都在忙碌，却什么也没做成。",
    "并非所有的注意力都等价。深度工作（Deep Work）与浅层响应之间的差别，不在于投入的时间多少，而在于认知负荷的性质。",
  ]},
  { t: "第四章　语言如何塑造思维", body: [
    "「如果语言不同，我们思考世界的方式也会不同吗？」这个问题争论了一百多年。",
    "本杰明·李·沃尔夫（Benjamin Lee Whorf）提出，语言的结构会影响使用者注意什么、忽略什么。他的观点一度被夸大为「语言决定思维」，后来又被严厉批评。",
    "但温和版本的语言相对论，如今获得了不少实证支持。例如，使用绝对方位词（东南西北）的语言使用者，方向感显著更好；而使用相对方位词（左右前后）的人，则更依赖自身视角。",
    "有趣的是中文。汉语在表达时间时常用垂直隐喻——「上午」「下午」「上个月」「下个星期」——把时间想象成一条竖轴。而英语使用者更倾向于把时间铺成一条水平线。",
  ]},
  { t: "第五章　关于「理解」的错觉", body: [
    "读一遍就懂，是一种常见而危险的错觉。真正检验理解的方式只有一个：把它讲给别人听。",
    "费曼技巧的核心就在这里：当你说不出某个概念的通俗解释时，你其实并没有真正理解它——你只是熟悉了它的措辞。",
    "熟悉感与理解力的差别，在学习中反复制造陷阱。反复阅读同一段文字，会带来强烈的「我已经掌握了」的感觉，但研究表明，这种方法的长期记忆效果远不如主动回想。",
  ]},
];

function xhtml(title, paragraphs) {
  const body = paragraphs
    .map((p, i) => {
      if (i === 0) {
        return `      <p class="first">${p}</p>`;
      }
      return `      <p>${p}</p>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
  <head>
    <title>${title}</title>
    <link rel="stylesheet" type="text/css" href="style.css"/>
  </head>
  <body>
    <h1>${title}</h1>
    <p class="ruby-line">日本語の<ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>、以及中文的<ruby>注音<rp>(</rp><rt>zhù yīn</rt><rp>)</rp></ruby>都要能正常显示。</p>
${body}
    <blockquote>
      <p>「引用段落：标点符号的正确处理——包括逗号、顿号、句号、问号、感叹号、分号、冒号、破折号——是中文排版的基本功。」</p>
    </blockquote>
    <p class="mixed">中英混排测试：这是一个包含 English words 与 数字 12345 的段落，检验字间距与断行是否正确。</p>
    <hr/>
    <p class="note">脚注与注释测试：<a href="#fn1" epub:type="noteref">[1]</a></p>
    <aside id="fn1" epub:type="footnote"><p>这是脚注内容，用于检验弹注与回跳。</p></aside>
  </body>
</html>
`;
}

const css = `:root { color-scheme: light dark; }
body { font-family: "Source Han Serif SC", "Noto Serif CJK SC", serif; line-height: 1.75; margin: 1.5em; }
h1 { font-size: 1.5em; line-height: 1.4; margin: 0 0 1.2em; text-align: center; letter-spacing: 0.05em; }
p { margin: 0 0 0.9em; text-indent: 2em; text-align: justify; }
p.first { text-indent: 2em; }
p.mixed { text-indent: 0; }
p.note { text-indent: 0; font-size: 0.9em; color: #666; }
p.ruby-line { text-indent: 0; text-align: center; font-size: 0.95em; color: #444; }
blockquote { margin: 1.2em 2em; padding-left: 1em; border-left: 3px solid #ccc; color: #333; }
blockquote p { text-indent: 0; }
ruby rt { font-size: 0.5em; }
aside[epub|type~="footnote"] { font-size: 0.85em; color: #555; }
`;

const chapters = CHAPTERS.map((c, i) => ({
  name: `OEBPS/ch${String(i + 1).padStart(2, "0")}.xhtml`,
  title: c.t,
  html: xhtml(c.t, c.body),
}));

const manifest = chapters
  .map((c, i) => `    <item id="ch${i + 1}" href="ch${String(i + 1).padStart(2, "0")}.xhtml" media-type="application/xhtml+xml"/>`)
  .join("\n");
const spine = chapters.map((_, i) => `    <itemref idref="ch${i + 1}"/>`).join("\n");
const navList = chapters.map((c, i) => `        <li><a href="ch${String(i + 1).padStart(2, "0")}.xhtml">${c.title}</a></li>`).join("\n");
const ncxNav = chapters
  .map((c, i) => `    <navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${c.title}</text></navLabel><content src="ch${String(i + 1).padStart(2, "0")}.xhtml"/></navPoint>`)
  .join("\n");

const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:aireader-p0-fixture-zh</dc:identifier>
    <dc:title>排版测试用中文样书</dc:title>
    <dc:language>zh-CN</dc:language>
    <dc:creator>aireader P0 fixture</dc:creator>
    <meta property="dcterms:modified">2026-09-10T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>
${manifest}
  </manifest>
  <spine toc="ncx">
${spine}
  </spine>
</package>
`;

const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc"><h1>目录</h1><ol>
${navList}
  </ol></nav>
  <nav epub:type="landmarks" hidden="hidden"><ol><li><a epub:type="bodymatter" href="ch01.xhtml">正文</a></li></ol></nav>
</body>
</html>
`;

const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:aireader-p0-fixture-zh"/></head>
  <docTitle><text>排版测试用中文样书</text></docTitle>
  <navMap>
${ncxNav}
  </navMap>
</ncx>
`;

// 1x1 透明 PNG（封面占位）
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const entries = [
  { name: "mimetype", data: "application/epub+zip", store: true },
  { name: "META-INF/container.xml", data: `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
` },
  { name: "OEBPS/content.opf", data: opf },
  { name: "OEBPS/nav.xhtml", data: nav },
  { name: "OEBPS/toc.ncx", data: ncx },
  { name: "OEBPS/style.css", data: css },
  { name: "OEBPS/cover.png", data: png },
  ...chapters.map((c) => ({ name: c.name, data: c.html })),
];

const outDir = process.argv[2] ?? "fixtures";
mkdirSync(outDir, { recursive: true });
const epubPath = `${outDir}/zh-sample.epub`;
writeFileSync(epubPath, zip(entries));

// ---------- 生成超长 TXT（默认约 20 万字，--big 生成约 200 万字） ----------
const targetChars = process.argv.includes("--big") ? 2_000_000 : 200_000;
const para = [
  "他站在窗前，看着楼下的街道被暮色一点点浸透。路灯次第亮起来，像一条被人慢慢拉直的珠链。",
  "「你确定要走吗？」她问。声音很轻，几乎被雨声盖过去。",
  "他没有立刻回答。有些事情，一旦说出口，就再也收不回去了。",
  "风把窗帘吹起来又放下，反复几次，像某种笨拙的挽留。",
  "「总要有人去做这件事。」他终于开口，「不是我也行，但既然是我，那就我去。」",
];
const lines = [];
let n = 0;
// 段落游标必须独立计数：此前用 n % para.length，而 n 每次增量约 40（是 5 的倍数），
// 结果永远是 para[0] —— 整份语料退化成同一段重复，会让搜索类测试产生误判。
let pi = 0;
while (n < targetChars) {
  const t = para[pi++ % para.length];
  n += t.length;
  lines.push(t);
  if (lines.length % 40 === 0) {
    const idx = Math.floor(lines.length / 40);
    lines.push(`\n第${idx}章　${["夜行", "旧信", "潮汐", "回声", "断桥", "归途"][idx % 6]}\n`);
  }
}
const txtPath = `${outDir}/huge.txt`;
writeFileSync(txtPath, lines.join("\n"), "utf8");

console.log(JSON.stringify({
  epub: epubPath,
  epubEntries: entries.length,
  txt: txtPath,
  txtChars: n,
}, null, 2));
