// 一把跑完全部契约测试（13 套，700+ 条断言）。
//
//   node tools/run-tests.mjs            # 全部
//   node tools/run-tests.mjs slots-test # 只跑一个
//
// 为什么要有这个脚本：每套测试都要先 esbuild 打包成 node 能跑的 ESM。
// react / react-dom 必须留成 external 再交给 node 解析 —— 打成 bundle 时
// react-dom/server 的 CJS require("util") 会炸；而包产物放在 app/node_modules/.cache/
// 下面，node 才能从 app/node_modules 里找到它们。这些坑写一次就够了。
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url))); // 仓库根
const app = join(root, "app");
const outDir = join(app, "node_modules", ".cache", "aireader-tests");
mkdirSync(outDir, { recursive: true });

const SUITES = [
  "contract-test",
  "book-context-test",
  "activity-test",
  "library-test",
  "net-test",
  "skills-test",
  "container-test",
  "plugin-loader-test",
  "slots-test",
  "dynamic-runtime-test",
  "plugin-ai-test",
  "plugin-ops-test",
  "i18n-test",
];
const only = process.argv[2];
const suites = only ? SUITES.filter((s) => s === only) : SUITES;
if (!suites.length) {
  console.error("没有这个测试：" + only + "（可用：" + SUITES.join(" / ") + "）");
  process.exit(1);
}

const run = (cmd) => spawnSync(cmd, { shell: true, stdio: "inherit", cwd: app });
let failed = 0;
for (const name of suites) {
  const out = join(outDir, name + ".mjs");
  const bundle = run(
    ["npx esbuild", join("..", "tools", name + ".ts"),
      "--bundle --platform=node --format=esm",
      "--external:react --external:react/jsx-runtime --external:react-dom/server",
      // typescript 留给 node 从 app/node_modules 解析：i18n-test 用它的解析器找硬编码中文（打进 bundle 太重）
      "--external:typescript",
      // quickjs 引擎带 wasm 文件，交给 node 从 app/node_modules 解析（打成 bundle 会找不到 wasm）
      '--external:@jitl/* --external:quickjs-emscripten-core',
      "--outfile=" + JSON.stringify(out)].join(" "),
  );
  if (bundle.status !== 0) {
    console.error("✗ " + name + " 打包失败");
    failed++;
    continue;
  }
  const res = run("node " + JSON.stringify(out));
  if (res.status !== 0) failed++;
}
console.log("");
console.log(failed ? "✗ 有 " + failed + " 套测试没过" : "✓ " + suites.length + " 套契约测试全部通过");
process.exit(failed ? 1 : 0);
