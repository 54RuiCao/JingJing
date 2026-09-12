// 评测集跑法（需要：应用在跑 + CDP 9222 + 真实或 mock 的 AI 服务已配置好）
//   node tools/run-eval.mjs            # 跑 tools/eval-toolset.json 的全部任务
//   node tools/run-eval.mjs toc-basic  # 只跑某个任务
// 评测结果打到 stdout，同时写 fixtures/eval-report.json（gitignored）。
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const suite = JSON.parse(readFileSync(new URL("./eval-toolset.json", import.meta.url), "utf8"));
const only = process.argv[2];
const tasks = only ? suite.tasks.filter((t) => t.id === only) : suite.tasks;
const evalProbe = new URL("./eval-probe.js", import.meta.url).pathname.replace(/^\//, "");

const results = [];
for (const task0 of tasks) {
  // 需要"不可复制"的任务（写插件）在运行时生成随机 id：
  // 长会话里重复同一个请求，模型会照着历史把整条流程复述一遍而不真的调工具（P3.5 实测）
  const nonce = Math.random().toString(36).slice(2, 6);
  const pluginId = task0.pluginId ? task0.pluginId.replace("{{nonce}}", nonce) : undefined;
  const task = pluginId
    ? { ...task0, pluginId, question: task0.question.replace("{{pluginId}}", pluginId) }
    : task0;
  process.stdout.write("→ " + task.id + (pluginId ? " (" + pluginId + ")" : "") + " … ");
  // cdp.mjs 不支持给探针传参：先把任务塞进 localStorage，再跑探针
  execFileSync("node", ["tools/cdp.mjs", "localStorage.setItem('eval.task', " + JSON.stringify(JSON.stringify(task)) + "), 'ok'"], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const out = execFileSync("node", ["tools/cdp.mjs", "--file", evalProbe], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = JSON.parse(out);
  const r = parsed.result ?? {};
  const fails = [];
  const tools = (r.trail ?? []).map((t) => t.name);
  if (task.mustCallTools && !task.mustCallTools.every((n) => tools.includes(n))) fails.push("没调用 " + task.mustCallTools.join("/") + "（实际 " + tools.join(",") + "）");
  if (task.mustNotCallTools && tools.length) fails.push("不该调用工具，却调了 " + tools.join(","));
  const answer = r.answer ?? "";
  for (const s of task.answerMustContain ?? []) if (!answer.includes(s)) fails.push("答案缺少「" + s + "」");
  for (const s of task.answerMustNotContain ?? []) if (answer.includes(s)) fails.push("答案不该出现「" + s + "」");
  if (task.mustCite && !/\[CH \d+\]/.test(answer)) fails.push("没有章节引用 [CH n]");
  if (r.err) fails.push("界面报错：" + String(r.err).slice(0, 80));
  if (typeof task.maxSteps === "number" && (r.requests ?? 0) > task.maxSteps) fails.push("请求数 " + r.requests + " 超过 " + task.maxSteps);
  // 顺序纪律：先查现场再动手（tools 数组保持调用顺序）
  for (const [a, b] of task.mustCallBefore ?? []) {
    const ia = tools.indexOf(a);
    const ib = tools.indexOf(b);
    if (ia < 0 || ib < 0 || ia > ib) fails.push("顺序不对：" + a + " 应当在 " + b + " 之前（实际 " + tools.join(",") + "）");
  }
  // 写插件这类任务：**断言落在运行时状态上**——点名的 id 有没有真的出现
  if (task.mustExistPlugin) {
    if (!r.plugin) fails.push("没有真的定义出 " + task.pluginId + "（回答里的描述不算数）");
    else if (!["PENDING_PERMISSION", "ACTIVE"].includes(r.plugin.state)) fails.push("插件状态是 " + r.plugin.state + "（应当挂起来或在等授权）");
    else if (!r.plugin.dynamic) fails.push("插件不是内存里的动态包");
  }
  results.push({ id: task.id, ok: fails.length === 0, fails, tools, plugin: r.plugin ?? undefined, answerHead: answer.slice(0, 120), usage: r.usage });
  console.log(fails.length ? "✗ " + fails.join("；") : "✓");
}

const passed = results.filter((r) => r.ok).length;
writeFileSync("fixtures/eval-report.json", JSON.stringify({ when: new Date().toISOString(), suite: suite.version, passed, total: results.length, results }, null, 2));
console.log("\n评测：" + passed + "/" + results.length + " 通过，明细见 fixtures/eval-report.json");
process.exit(passed === results.length ? 0 : 1);
