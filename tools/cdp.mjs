// 通过 WebView2 的 DevTools 协议（CDP）读取应用真实 DOM 与控制台错误。
// 用法: node tools/cdp.mjs "表达式" [--listen ms]
//       node tools/cdp.mjs --file tools/probe.js [--listen ms]
//
// **探针会改应用的设置，所以默认帮它复原**：跑之前把 settings 里 ai.* 那一行存一份，
// 跑完（含抛错路径）原样写回。为什么要这么做：早期探针为了脱离真实 Key 跑通链路，
// 直接 setSetting("ai.apiKey","test-key") —— 于是**用户自己填的 API Key 被悄悄覆盖**。
// 现在探针照旧可以随便改，但用户的配置会回来。
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
let expr = "document.body.innerText";
let listenMs = 0;
if (args[0] === "--file") {
  expr = readFileSync(args[1], "utf8");
  if (args[2] === "--listen") listenMs = Number(args[3]);
} else {
  expr = args[0] ?? expr;
  if (args[1] === "--listen") listenMs = Number(args[2]);
}

/** 把探针包一层：快照 ai.* 设置 → 跑 → 复原（无论成功失败） */
const GUARD_PREFIX = `(async () => {
  const __inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  let __snap = null;
  if (__inv) {
    try {
      // P3.10：还要罩住**插件配置与插件存储** —— 实测踩到：探针往插件 config 里写了个
      // 假的 API Key 验证"请求真的发得出去"，用户后来看到的是那个插件一直 401，
      // 以为软件坏了（配置按 pluginId 存，重写同 id 的插件还会继承它）。
      __snap = await __inv("db_select", {
        sql: "SELECT key, value FROM settings WHERE key LIKE 'ai.%' OR key = 'plugins.options' OR key LIKE 'plugin.storage.%' OR key = 'ui.language'",
        params: [],
      });
    } catch (e) { __snap = null; }
  }
  try {
    return await (`;
const GUARD_SUFFIX = `);
  } finally {
    if (__inv && __snap) {
      try {
        const now = await __inv("db_select", {
          sql: "SELECT key, value FROM settings WHERE key LIKE 'ai.%' OR key = 'plugins.options' OR key LIKE 'plugin.storage.%' OR key = 'ui.language'",
          params: [],
        });
        const same = now.length === __snap.length && JSON.stringify(now) === JSON.stringify(__snap);
        if (!same) {
          for (const row of __snap) {
            await __inv("db_execute", {
              sql: "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              params: [row.key, row.value],
            });
          }
          // 通知面板重新读设置：否则它内存里那份旧配置会在下次交互时把旧值写回数据库
          window.dispatchEvent(new CustomEvent("aireader:reload-settings"));
          console.log("[cdp] 探针改过设置（ai.* / plugins.options / plugin.storage.*），已复原并通知面板重读：" + __snap.map((r) => r.key).join(", "));
        }
      } catch (e) {
        console.log("[cdp] 复原 ai.* 设置失败：" + String(e));
      }
    }
  }
})()`;

// 只有"看起来像一段可求值的表达式"时才包（避免把随便贴的语句弄坏）。
// P3.8 修：**先把开头的注释去掉再看** —— 探针文件基本都以 // 说明开头，
// 原来那样判断会把保护整个跳过（实测：探针改了 ai.thinking 却没被复原）。
const withoutLeadingComments = expr
  .replace(/^(\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/))*/, "")
  .trim();
const skipGuard = expr.includes("cdp:no-restore");
const looksLikeExpression =
  withoutLeadingComments.startsWith("(async") || withoutLeadingComments.startsWith("(function");
const wrapped = looksLikeExpression && !skipGuard ? GUARD_PREFIX + expr + GUARD_SUFFIX : expr;

const res = await fetch("http://127.0.0.1:9222/json");
const targets = await res.json();
const page = targets.find((t) => t.type === "page") ?? targets[0];
if (!page) {
  console.log(JSON.stringify({ error: "no page target" }, null, 2));
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === "Runtime.consoleAPICalled") {
    logs.push(msg.params.type + ": " + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
  } else if (msg.method === "Runtime.exceptionThrown") {
    logs.push("EXCEPTION: " + (msg.params.exceptionDetails?.exception?.description ?? ""));
  } else if (msg.method === "Log.entryAdded") {
    logs.push("LOG[" + msg.params.entry.level + "]: " + msg.params.entry.text);
  }
});

await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");
await send("Log.enable");
if (listenMs > 0) await new Promise((r) => setTimeout(r, listenMs));

const out = await send("Runtime.evaluate", { expression: wrapped, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify({ url: page.url, result: out.result?.result?.value ?? out.result, logs }, null, 2));
ws.close();
