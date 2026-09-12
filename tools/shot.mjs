// 用 CDP 给应用窗口截图（写 README、写问题报告都用得上）。
//
// 用法：
//   node tools/shot.mjs out.png                        # 直接截当前窗口
//   node tools/shot.mjs out.png --file tools/step.js   # 先跑一段脚本（切页/点按钮），再截
//   node tools/shot.mjs out.png --file step.js --wait 2500
//
// 应用要带调试端口启动：
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const out = args[0];
if (!out) {
  console.error("用法：node tools/shot.mjs <输出.png> [--file 步骤.js] [--wait ms]");
  process.exit(1);
}
const fileAt = args.indexOf("--file");
const waitAt = args.indexOf("--wait");
const stepFile = fileAt >= 0 ? args[fileAt + 1] : null;
const waitMs = waitAt >= 0 ? Number(args[waitAt + 1]) : 900;

/** 找一个带调试端口的页面（应用没开就说清楚，别卡住） */
let targets = null;
const t0 = Date.now();
while (!targets && Date.now() - t0 < 8000) {
  try {
    const r = await fetch("http://127.0.0.1:9222/json", { signal: AbortSignal.timeout(400) });
    targets = await r.json();
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
const page = targets?.find((t) => t.type === "page");
if (!page) {
  console.error("连不上 127.0.0.1:9222 —— 应用没开？启动时要给 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'");
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(m.error.message));
    else res(m.result);
  }
});
await new Promise((r) => ws.addEventListener("open", r));
await send("Page.enable");
await send("Runtime.enable");

if (stepFile) {
  if (!existsSync(stepFile)) {
    console.error("找不到步骤脚本：" + stepFile);
    process.exit(1);
  }
  const expr = readFileSync(stepFile, "utf8");
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    console.error("步骤脚本抛错：" + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    process.exit(3);
  }
  console.log("步骤脚本返回：" + JSON.stringify(r.result?.value ?? null).slice(0, 300));
}

await new Promise((r) => setTimeout(r, waitMs));
const shot = await send("Page.captureScreenshot", { format: "png" });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log("已保存 " + out + "（" + Math.round(Buffer.from(shot.data, "base64").length / 1024) + " KB）");
ws.close();
process.exit(0);
