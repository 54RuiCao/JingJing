// 发布构建前只清掉开发/验收用的测试素材，保留 app/public/pdfjs 这类真实运行时资源。
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const pub = join("app", "public");
for (const f of ["huge.txt", "zh-sample.epub"]) {
  const p = join(pub, f);
  if (existsSync(p)) {
    rmSync(p, { force: true });
    console.log("removed", p);
  }
}
console.log("public 现有:", existsSync(pub) ? "ok" : "missing");
