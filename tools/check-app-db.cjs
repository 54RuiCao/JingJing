// 直接读应用的 SQLite（不需要启动应用、也不需要 CDP）——排查"设置到底存进去没有"时最省事。
//   node tools/check-app-db.cjs            # 看 ai.* 设置与最近几条会话
// Key 只打印前 3 位与长度，不打印明文。

const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const dbFile = path.join(process.env.APPDATA, "app.aireader.desktop", "aireader.db");
const db = new DatabaseSync(dbFile, { readOnly: true });
const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'ai.%' ORDER BY key").all();
for (const r of rows) {
  let v = r.value;
  if (r.key === "ai.apiKey") {
    let s = ""; try { s = JSON.parse(r.value); } catch {}
    v = s ? JSON.stringify(s.slice(0, 3) + "…" + s.slice(-2) + " (长度 " + s.length + ")") : "(空)";
  }
  console.log(r.key.padEnd(16), v);
}
const msg = db.prepare("SELECT role, substr(content,1,60) AS c, created_at FROM ai_messages ORDER BY created_at DESC LIMIT 4").all();
console.log("最近消息:", JSON.stringify(msg));
db.close();
