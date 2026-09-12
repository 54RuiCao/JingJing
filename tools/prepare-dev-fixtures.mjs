// 把 dev-fixtures 里的测试素材复制进 app/public，仅供开发/验收构建使用。
// 发布构建前必须清空 app/public，否则测试素材会被打进安装包。
import { cpSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const src = join("app", "dev-fixtures");
const dst = join("app", "public");
if (!existsSync(src)) {
  console.error("缺少 app/dev-fixtures；先运行 node tools/make-fixtures.mjs fixtures");
  process.exit(1);
}
mkdirSync(dst, { recursive: true });
for (const f of readdirSync(src)) cpSync(join(src, f), join(dst, f));
console.log("已复制到 app/public:", readdirSync(dst).join(", "));
