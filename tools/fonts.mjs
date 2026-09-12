// 通过 CDP 查询「实际渲染使用的字体」，判断字体回退链是否真的命中中文字体。
const res = await fetch("http://127.0.0.1:9222/json");
const targets = await res.json();
const page = targets.find((t) => t.type === "page") ?? targets[0];
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
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
await new Promise((r) => ws.addEventListener("open", r));
await send("DOM.enable");
await send("CSS.enable");
await send("Runtime.enable");

const families = [
  '"Source Han Serif SC","Noto Serif CJK SC",serif',
  '"Source Han Sans SC","Noto Sans CJK SC",sans-serif',
  '"Microsoft YaHei"',
  "SimSun",
  "KaiTi",
  "serif",
  "system-ui",
];

const setup = `(() => {
  document.querySelectorAll('.fontprobe').forEach(n => n.remove());
  const fams = ${JSON.stringify(families)};
  fams.forEach((f, i) => {
    const d = document.createElement('div');
    d.className = 'fontprobe';
    d.id = 'fontprobe-' + i;
    d.style.cssText = 'font-size:24px;font-family:' + f + ';';
    d.textContent = '中文字体测试 ABC 123';
    document.body.appendChild(d);
  });
  return fams.length;
})()`;
await send("Runtime.evaluate", { expression: setup, returnByValue: true });

const doc = await send("DOM.getDocument", { depth: -1 });
const rootId = doc.result.root.nodeId;

const out = [];
for (let i = 0; i < families.length; i++) {
  const q = await send("DOM.querySelector", { nodeId: rootId, selector: "#fontprobe-" + i });
  const nodeId = q.result?.nodeId;
  if (!nodeId) { out.push({ family: families[i], fonts: null }); continue; }
  const pf = await send("CSS.getPlatformFontsForNode", { nodeId });
  out.push({
    family: families[i],
    fonts: (pf.result?.fonts ?? []).map((f) => f.familyName + " x" + f.glyphCount),
  });
}
console.log(JSON.stringify(out, null, 2));
ws.close();
