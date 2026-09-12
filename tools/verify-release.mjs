import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// exe 路径从脚本位置推出来，不写死本机盘符
const EXE = join(dirname(dirname(fileURLToPath(import.meta.url))), "app", "src-tauri", "target", "release", "jingjing.exe");
const t0 = performance.now();
const child = spawn(EXE, [], { detached: true, stdio: "ignore" });
child.unref();
const elapsed = () => Math.round(performance.now() - t0);

let targets = null;
while (!targets && elapsed() < 30000) {
  try {
    const r = await fetch("http://127.0.0.1:9222/json", { signal: AbortSignal.timeout(400) });
    targets = await r.json();
  } catch { await new Promise((r) => setTimeout(r, 40)); }
}
const page = targets?.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");
const evalJs = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result?.result?.value;

let boot = null;
while (elapsed() < 20000) {
  boot = await evalJs("window.__boot ?? null");
  if (boot) break;
  await new Promise((r) => setTimeout(r, 40));
}
const connectedMs = elapsed();
console.log(JSON.stringify({ processToDevtoolsMs: null, connectedAtMs: connectedMs, boot }, null, 2));
try { child.kill(); } catch {}
process.exit(0);
