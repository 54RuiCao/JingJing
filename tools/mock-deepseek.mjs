import { createServer } from "node:http";

// 本地 mock：模拟 OpenAI 兼容的流式响应，用于在没有真实 API Key 的情况下验证 AI 链路。
// 必须带 CORS 头，否则 Tauri 页面（http://tauri.localhost）的跨域 fetch 会被 WebView 拦掉。
//
// 两块能力：
//  1) **前缀缓存模拟**（P2.2）：逐字符比较两次请求，算出公共前缀（= 能命中缓存的 token 数），
//     并检查「system + 全书 + 装载确认」三条是否逐字节相同。
//  2) **工具调用模拟**（P2.3）：按问题里的关键词挑一个工具发起 tool_calls（参数**分片**发送，
//     用来验证 provider 的增量合并），下一轮拿到 role:"tool" 的结果后回一段带结果的文本。
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const flat = (msgs) => (msgs ?? []).map((m) => m.role + "\u0000" + String(m.content ?? "")).join("\u0001");
const commonPrefix = (a, b) => {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
};

/** 按关键词挑工具（确定性，便于回归） */
function pickTool(question) {
  const q = String(question ?? "");
  const chapter = q.match(/第\s*(\d+)\s*章/);
  // P2.5 技能：/名字 手势 或「加载技能 X」→ load_skill；「存成技能」→ create_skill（纯数据）
  const loadName = q.match(/加载技能\s*([a-z0-9]+(?:-[a-z0-9]+)*)/);
  if (loadName) return { name: "load_skill", args: { name: loadName[1] } };
  const gesture = q.match(/(?:^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/);
  if (gesture) return { name: "load_skill", args: { name: gesture[1] } };
  if (/存成技能|保存成技能/.test(q)) {
    return {
      name: "create_skill",
      args: {
        name: "probe-generated",
        description: "探针生成的技能：验证 AI 只生成数据、不生成代码",
        body: "# 探针技能\n1. 这条技能由 mock 生成，用于验证 create_skill 的落盘路径",
      },
    };
  }
  if (/目录|章节列表|toc/i.test(q)) return { name: "get_toc", args: { limit: 10 } };
  if (/检索|搜索|搜一下|查找/.test(q)) return { name: "search_book", args: { query: "记忆", limit: 3 } };
  if (chapter && /跳|翻|带我|定位/.test(q)) return { name: "goto_location", args: { n: Number(chapter[1]) } };
  if (chapter) return { name: "get_chapter", args: { n: Number(chapter[1]) } };
  if (/选中|这句|这段/.test(q)) return { name: "get_selection", args: {} };
  if (/进度|读到哪|看到哪/.test(q)) return { name: "get_reading_progress", args: {} };
  // 写类工具：问题里带 CFI 时直接用它（没有 CFI 就走"当前选区"，用于验证失败回传）
  const cfi = q.match(/epubcfi\([^\s，。]*\)/);
  if (/划|标记|高亮/.test(q)) return { name: "add_highlight", args: cfi ? { cfi: cfi[0], text: "测试划线", color: "yellow" } : {} };
  if (/笔记|记一笔/.test(q)) return { name: "add_note", args: { note: "mock 写的笔记", ...(cfi ? { cfi: cfi[0] } : {}) } };
  return null;
}

let call = 0;
let prevFlat = "";
let prevStable = "";

createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const started = Date.now();
    call++;
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* 忽略 */ }
    const messages = parsed.messages ?? [];
    const thinking = parsed.thinking?.type ?? "enabled";
    const chars = messages.reduce((s, m) => s + String(m.content ?? "").length, 0);
    const curFlat = flat(messages);
    const curStable = flat(messages.slice(0, 3));
    const prefix = call === 1 ? 0 : commonPrefix(prevFlat, curFlat);
    const stablePart = call === 1 ? "n/a" : (prevStable === curStable ? "identical" : "CHANGED");
    const promptTokens = Math.round(chars * 0.73);
    const hit = Math.round(prefix * 0.73);
    const toolMsgs = messages.filter((m) => m.role === "tool");
    const toolSchemas = (parsed.tools ?? []).map((t) => t.function?.name);

    // P2.5：技能目录是否进了请求、有几个条目（模型看到的事实）
    const catalogMsg = messages.find((m) => String(m.content ?? "").includes("<available_skills>"));
    const catalogNames = catalogMsg
      ? [...String(catalogMsg.content).matchAll(/^- `([a-z0-9-]+)`:/gm)].map((m) => m[1])
      : [];
    console.log(
      "call#" + call,
      "chars=" + chars,
      "prefix_pct=" + (chars ? ((prefix / chars) * 100).toFixed(1) : "0") + "%",
      "stable_part=" + stablePart,
      "tools_offered=" + (toolSchemas.length ? toolSchemas.join(",") : "none"),
      "catalog=" + (catalogNames.length ? catalogNames.length + "[" + catalogNames.join("|") + "]" : "none"),
    );
    prevFlat = curFlat;
    prevStable = curStable;

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...CORS });
    const send = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
    const usage = {
      prompt_tokens: promptTokens,
      prompt_cache_hit_tokens: hit,
      prompt_cache_miss_tokens: promptTokens - hit,
      completion_tokens: 42,
    };
    const finish = (delay) =>
      setTimeout(() => {
        res.write("data: [DONE]\n\n");
        res.end();
        console.log("  served in " + (Date.now() - started) + "ms");
      }, delay);

    // 第 1 轮之外的调用：如果已经带回工具结果，就直接总结它
    if (toolMsgs.length) {
      const last = String(toolMsgs[toolMsgs.length - 1].content ?? "");
      console.log("  tool-result[" + toolMsgs.length + "]: " + last.slice(0, 160).replace(/\n/g, " "));
      send({ choices: [{ delta: { content: "【工具结果已收到】" + last.slice(0, 120) } }] });
      send({ choices: [{ delta: {}, finish_reason: "stop" }], usage });
      finish(40);
      return;
    }

    // 有工具可选时：按关键词发起一次工具调用
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const picked = parsed.tools?.length ? pickTool(lastUser?.content) : null;
    if (picked) {
      console.log("  tool-call: " + picked.name + " " + JSON.stringify(picked.args));
      const json = JSON.stringify(picked.args);
      const mid = Math.ceil(json.length / 2);
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_mock_" + call, type: "function", function: { name: picked.name, arguments: "" } }] } }] });
      // 参数分两片发，验证 provider 的增量合并
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(0, mid) } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(mid) } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage });
      finish(40);
      return;
    }

    // 普通回答
    const delay = thinking === "enabled" ? 200 : 40;
    send({ choices: [{ delta: { content: "这是本地 mock 的" } }] });
    setTimeout(() => {
      send({ choices: [{ delta: { content: "流式回答，用于验证 aireader 的 SSE 解析与用量统计。" } }] });
      send({ choices: [{ delta: {}, finish_reason: "stop" }], usage });
      finish(0);
    }, delay);
  });
}).listen(8899, "127.0.0.1", () => console.log("mock openai-compatible server on http://127.0.0.1:8899"));
