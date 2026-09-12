/**
 * P0-8：DeepSeek 实测脚本
 *
 * 用法（PowerShell）：
 *   $env:DEEPSEEK_API_KEY="sk-..."；node tools\deepseek-p0.mjs
 *
 * 验证三件事：
 *   1. 30 万字书全量入上下文时的真实 token 数、耗时与花费
 *   2. 「不变内容在前、问题在最后」是否能稳定命中上下文硬盘缓存
 *   3. 关闭思考模式（thinking.type=disabled）对 TTFT 与总时长的影响
 */
import { readFileSync } from "node:fs";

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) {
  console.error("缺少环境变量 DEEPSEEK_API_KEY。用法：$env:DEEPSEEK_API_KEY=\"sk-...\"; node tools\\deepseek-p0.mjs");
  process.exit(1);
}

// 可用 DEEPSEEK_BASE_URL 覆盖，便于用本地 mock 服务验证脚本本身
const BASE = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-flash";

// 取 30 万字作为"典型出版书"（约 21.9 万 token）
const full = readFileSync("fixtures/huge.txt", "utf8");
const BOOK = full.slice(0, 300_000);
console.log("书稿字符数:", BOOK.length.toLocaleString());

const SYSTEM = "你是一位严谨的阅读助手。回答必须基于用户提供的书稿内容，不得编造。";

function buildMessages(question) {
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: "<书>\n" + BOOK + "\n</书>" },
    { role: "user", content: question },
  ];
}

async function call({ question, thinking, label }) {
  const body = {
    model: MODEL,
    messages: buildMessages(question),
    stream: true,
    max_tokens: 512,
  };
  if (thinking === false) body.thinking = { type: "disabled" };

  const t0 = performance.now();
  const res = await fetch(BASE + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.log(label, "HTTP", res.status, text.slice(0, 300));
    return null;
  }

  let ttft = null;
  let outChars = 0;
  let usage = null;
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (payload === "[DONE]") continue;
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
      const delta = json.choices?.[0]?.delta;
      if (delta && (delta.content || delta.reasoning_content)) {
        if (ttft === null) ttft = performance.now() - t0;
        outChars += (delta.content ?? "").length + (delta.reasoning_content ?? "").length;
      }
      if (json.usage) usage = json.usage;
    }
  }
  const totalMs = performance.now() - t0;
  const result = {
    label,
    thinking: thinking !== false,
    ttftMs: ttft === null ? null : Math.round(ttft),
    totalMs: Math.round(totalMs),
    outChars,
    usage,
  };
  console.log(label, JSON.stringify({
    ttftMs: result.ttftMs,
    totalMs: result.totalMs,
    prompt_tokens: usage?.prompt_tokens,
    cache_hit: usage?.prompt_cache_hit_tokens,
    cache_miss: usage?.prompt_cache_miss_tokens,
    completion_tokens: usage?.completion_tokens,
  }));
  return result;
}

const Q1 = "请用三句话概括这本书开头讲的是什么场景。";
const Q2 = "这段文字里出现了哪些人物称呼？只列出来。";

const results = [];
results.push(await call({ question: Q1, thinking: false, label: "[1] 首次装载（非思考）" }));
results.push(await call({ question: Q2, thinking: false, label: "[2] 同前缀换问题（非思考，应命中缓存）" }));
results.push(await call({ question: Q2, thinking: true, label: "[3] 同前缀（思考模式，对比延迟）" }));
results.push(await call({ question: Q2, thinking: false, label: "[4] 再问一次（非思考，应命中缓存）" }));

// 成本估算（空闲时段：命中 ¥0.02/M，未命中 ¥1/M，输出 ¥4/M）
let cost = 0;
for (const r of results) {
  if (!r?.usage) continue;
  const hit = r.usage.prompt_cache_hit_tokens ?? 0;
  const miss = r.usage.prompt_cache_miss_tokens ?? Math.max(0, (r.usage.prompt_tokens ?? 0) - hit);
  const out = r.usage.completion_tokens ?? 0;
  cost += (hit / 1e6) * 0.02 + (miss / 1e6) * 1 + (out / 1e6) * 4;
}
console.log("\n空闲时段累计花费估算: ¥" + cost.toFixed(4));
