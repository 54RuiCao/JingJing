import { readFileSync } from "node:fs";

const text = readFileSync("fixtures/huge.txt", "utf8");
console.log("文本长度:", text.length.toLocaleString(), "字符");

// 1) 无索引：直接线性扫描
const queries = ["记忆", "雨声", "路灯", "不存在的词"];
const linear = [];
for (const q of queries) {
  const t = performance.now();
  let idx = 0, n = 0;
  while ((idx = text.indexOf(q, idx)) !== -1) { n++; idx += q.length; }
  linear.push({ q, hits: n, ms: Math.round((performance.now() - t) * 100) / 100 });
}
console.log("线性扫描:", JSON.stringify(linear));

// 2) bigram 倒排索引（中文无需分词）
const t0 = performance.now();
const index = new Map();
for (let i = 0; i < text.length - 1; i++) {
  const g = text.slice(i, i + 2);
  if (g.charCodeAt(0) === 10) continue;
  let arr = index.get(g);
  if (!arr) { arr = []; index.set(g, arr); }
  arr.push(i);
}
const buildMs = performance.now() - t0;
const mem = process.memoryUsage();
console.log("bigram 索引: 条目 " + index.size.toLocaleString() + "，构建 " + Math.round(buildMs) + " ms，RSS " + Math.round(mem.rss / 1048576) + " MB");

const indexed = [];
for (const q of queries) {
  const t = performance.now();
  let hits = 0;
  if (q.length >= 2) {
    const list = index.get(q.slice(0, 2)) ?? [];
    for (const pos of list) if (text.startsWith(q, pos)) hits++;
  } else {
    let idx = 0;
    while ((idx = text.indexOf(q, idx)) !== -1) { hits++; idx += 1; }
  }
  indexed.push({ q, hits, ms: Math.round((performance.now() - t) * 100) / 100 });
}
console.log("索引查询:", JSON.stringify(indexed));
