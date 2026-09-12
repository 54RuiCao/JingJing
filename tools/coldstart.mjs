import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// exe 路径从脚本位置推出来，不写死本机盘符
const EXE = join(dirname(dirname(fileURLToPath(import.meta.url))), "app", "src-tauri", "target", "release", "jingjing.exe");
const t0 = performance.now();

const child = spawn(EXE, [], { detached: true, stdio: "ignore" });
child.unref();

const elapsed = () => Math.round(performance.now() - t0);

async function tryFetch() {
  try {
    const res = await fetch("http://127.0.0.1:9222/json", { signal: AbortSignal.timeout(500) });
    return await res.json();
  } catch {
    return null;
  }
}

let targets = null;
while (!targets && elapsed() < 30000) {
  targets = await tryFetch();
  if (!targets) await new Promise((r) => setTimeout(r, 60));
}
const tCdp = elapsed();
const page = targets?.find((t) => t.type === "page");
if (!page) {
  console.log(JSON.stringify({ error: "no page target within 30s" }));
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");

const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
  return r.result?.result?.value;
};

let tDom = null;
let tRendered = null;
while (elapsed() < 40000) {
  const state = await evalJs(
    "(() => { const v = document.querySelector('foliate-view'); return { ready: !!v, pages: v?.renderer?.getContents?.()?.length ?? 0, title: v?.book?.metadata?.title ?? null }; })()",
  );
  if (state?.ready && tDom === null) tDom = elapsed();
  if (state?.pages > 0) { tRendered = elapsed(); break; }
  await new Promise((r) => setTimeout(r, 80));
}

console.log(JSON.stringify({
  cdpReadyMs: tCdp,
  domReadyMs: tDom,
  bookRenderedMs: tRendered,
}, null, 2));
try { child.kill(); } catch {}
process.exit(0);
