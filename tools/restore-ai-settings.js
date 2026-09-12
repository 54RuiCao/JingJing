// 把应用的 AI 配置恢复成一份干净的默认值（provider=DeepSeek、清空 Key、回到 DeepSeek 预设端点），
// 并通知面板重新读设置。用途：探针为了脱离真实 Key 跑链路，会直接写 ai.*；
// cdp.mjs 现在会自动复原（见它开头那段注释），但万一配置被写脏了，用这个脚本一键回到干净状态。
//
//   node tools/cdp.mjs --file tools/restore-ai-settings.js
//
// cdp:no-restore  —— 这是管理员脚本，故意要覆盖探针留下的值
(async () => {
  (async () => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  const set = (k, v) => inv("db_execute", {
    sql: "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    params: [k, JSON.stringify(v)],
  });
  await set("ai.provider", "deepseek");
  await set("ai.baseUrl", "https://api.deepseek.com");
  await set("ai.model", "deepseek-flash");
  await set("ai.apiKey", "");
  window.dispatchEvent(new CustomEvent("aireader:reload-settings"));
  await new Promise((r) => setTimeout(r, 500));
  const rows = await inv("db_select", { sql: "SELECT key, value FROM settings WHERE key LIKE 'ai.%'", params: [] });
  return rows.map((r) => r.key + " = " + r.value).join("\n");
  })()
})()
