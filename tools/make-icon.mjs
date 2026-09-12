import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
};

const S = 1024;
const px = Buffer.alloc(S * S * 4);

const set = (x, y, [r, g, b, a]) => {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const sa = a / 255;
  px[i] = Math.round(px[i] * (1 - sa) + r * sa);
  px[i + 1] = Math.round(px[i + 1] * (1 - sa) + g * sa);
  px[i + 2] = Math.round(px[i + 2] * (1 - sa) + b * sa);
  px[i + 3] = Math.max(px[i + 3], Math.round(a));
};

const BG = [0x16, 0x1b, 0x2b, 255];
const PAPER = [0xf5, 0xf1, 0xe8, 255];
const PAPER_EDGE = [0xd8, 0xd0, 0xbe, 255];
const SPINE = [0xc9, 0xbf, 0xa8, 255];
const RIBBON = [0xf5, 0x9e, 0x0b, 255];
const INK = [0x8a, 0x93, 0xa8, 255];

// 圆角矩形填充
const roundRect = (x0, y0, x1, y1, r, color) => {
  for (let y = Math.floor(y0); y < y1; y++) {
    for (let x = Math.floor(x0); x < x1; x++) {
      const dx = Math.max(x0 + r - x, x - (x1 - r), 0);
      const dy = Math.max(y0 + r - y, y - (y1 - r), 0);
      if (dx * dx + dy * dy <= r * r) set(x, y, color);
    }
  }
};

// 背景
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) set(x, y, BG);
// 圆角外框
roundRect(0, 0, S, S, 200, BG);

const cx = S / 2;
const top = 250;
const bottom = 800;
const halfW = 250;

// 左页 / 右页
roundRect(cx - halfW - 12, top, cx - 10, bottom, 26, PAPER);
roundRect(cx + 10, top, cx + halfW + 12, bottom, 26, PAPER);
// 书脊
for (let y = top + 10; y < bottom - 10; y++) for (let x = cx - 10; x < cx + 10; x++) set(x, y, SPINE);
// 页边
for (let y = top; y < bottom; y++) {
  set(cx - halfW - 12, y, PAPER_EDGE);
  set(cx + halfW + 11, y, PAPER_EDGE);
}
// 文字行
for (let line = 0; line < 7; line++) {
  const ly = top + 70 + line * 62;
  const lw = line % 3 === 2 ? 150 : 190;
  roundRect(cx - halfW + 34, ly, cx - halfW + 34 + lw, ly + 18, 9, INK);
  roundRect(cx + 34, ly, cx + 34 + (line % 4 === 3 ? 130 : 190), ly + 18, 9, INK);
}
// 书签带
for (let y = top - 40; y < top + 210; y++) for (let x = cx + 90; x < cx + 140; x++) set(x, y, RIBBON);
for (let y = 0; y < 40; y++) {
  const w = 25 - y * 0.6;
  for (let x = Math.round(cx + 115 - w); x < Math.round(cx + 115 + w); x++) set(x, top + 210 + y, BG);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync("app/src-tauri", { recursive: true });
writeFileSync("app/src-tauri/icon-source.png", png);
console.log("icon written:", png.length, "bytes");
