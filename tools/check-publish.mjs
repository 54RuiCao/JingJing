// **push 之前的自检**：要进仓库的文件里有没有不该外露的东西。
//
// 起因：源码里会顺手写进"本机路径 / 我装过的插件 id / 我在读的书"，一次 push 就变成
// 公开可查的历史（事后再删也来不及：历史里还在）。所以每次 push 前跑一遍。
//
//   node tools/check-publish.mjs            # 只查"相对 origin/main 新增或改动的文件"
//   node tools/check-publish.mjs --all      # 全仓库都查一遍
//
// 个人关键词写在 tools/publish-denylist.local.txt（本地文件，**不进仓库** ——
// 把书名/插件 id 写进这个脚本本身，就等于换个地方泄露）。
//
// 装成 git 钩子（一次性）：cp tools/hooks/pre-push .git/hooks/pre-push
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

// 反斜杠：从字符码取，免得在源码里写转义（写错过一次，正则会变成"字母+冒号+任意字符"，
// 于是 "s:\"" 这种普通代码也会被当成盘符路径）
const BS = String.fromCharCode(92);

/** 通用规则：跟"是谁"无关，任何项目都不该有 */
const GENERIC = [
  [new RegExp("sk-[A-Za-z0-9_-]{20,}"), "疑似真实 API Key"],
  // 只认"转义后的盘符"（字母 + 冒号 + 两个反斜杠）—— 代码里的绝对路径基本都是这个形态；
  // 写成宽松的 "字母:反斜杠" 会误报 /id:\s*"/ 这种正则（踩过两次，宁严不宽）
  [new RegExp("[A-Za-z]:" + BS + BS + BS + BS), "写死了本机盘符路径"],
  [new RegExp("/Users/[a-z0-9._-]+/", "i"), "写死了 macOS 家目录"],
  [new RegExp("[A-Za-z0-9._%+-]+@(gmail|qq|163|outlook|hotmail)\\.[A-Za-z]{2,}", "i"), "私人邮箱"],
  [new RegExp("docs/\\d\\d-[a-z0-9-]+\\.md"), "引用了未公开的内部笔记"],
];

/** 本地个人关键词（可选）：一行一条正则，# 开头是注释 */
const LOCAL_FILE = join(root, "tools", "publish-denylist.local.txt");
const LOCAL = existsSync(LOCAL_FILE)
  ? readFileSync(LOCAL_FILE, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        try {
          return [new RegExp(l, "i"), "本地关键词：" + l];
        } catch {
          return null; // 写坏的正则不该让整次检查失败
        }
      })
      .filter(Boolean)
  : [];

const RULES = [...GENERIC, ...LOCAL];

/** 第三方 / 大数据目录跳过；只扫文本文件 */
const SKIP_PATH = /^(vendor\/|tools\/deepseek-tokenizer\/|app\/src-tauri\/gen\/)/;
const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".css", ".html",
  ".rs", ".toml", ".py", ".sh", ".yml", ".yaml", ".txt", "",
]);
const MAX_BYTES = 1500000;

const all = process.argv.includes("--all");

/** 已经跟踪的文件 */
const tracked = () => git(["ls-files"]).split("\n");
/** 还没提交但会被提交的：已暂存 + 改了没暂存 + 未跟踪（.gitignore 挡住的自动排除，本地关键词清单不会被扫） */
const pending = () => {
  const staged = git(["diff", "--cached", "--name-only"]).split("\n");
  const modified = git(["diff", "--name-only"]).split("\n");
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n");
  return [...staged, ...modified, ...untracked];
};
/** 相对 origin/main 的改动（已提交的） */
const sinceRemote = () => {
  try {
    return git(["diff", "--name-only", "origin/main..HEAD"]).split("\n");
  } catch {
    return tracked();
  }
};

const files = [...new Set((all ? [...tracked(), ...pending()] : [...sinceRemote(), ...pending()]).filter(Boolean))];

const problems = [];
for (const rel of files.filter(Boolean)) {
  if (SKIP_PATH.test(rel)) continue;
  // 文件名本身也是内容（探针名、内部笔记名都会露信息）
  for (const [re, why] of RULES) {
    if (re.test(rel)) problems.push({ file: rel, line: 0, why, text: "(文件名)" });
  }
  const abs = join(root, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) continue;
  if (statSync(abs).size > MAX_BYTES) continue;
  if (!TEXT_EXT.has(extname(rel).toLowerCase())) continue;
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\u0000")) continue; // 二进制
  text.split("\n").forEach((line, i) => {
    for (const [re, why] of RULES) {
      if (re.test(line)) problems.push({ file: rel, line: i + 1, why, text: line.trim().slice(0, 120) });
    }
  });
}

console.log("要检查的文件：" + files.filter(Boolean).length + " 个" + (all ? "（全仓库）" : "（相对 origin/main 的新增/改动）"));
if (LOCAL.length === 0) console.log("提示：没有 tools/publish-denylist.local.txt，只用了通用规则");
if (!problems.length) {
  console.log("✓ 没发现不该外露的内容，可以 push");
  process.exit(0);
}
console.error("✗ 发现 " + problems.length + " 处不该外露的内容：");
for (const p of problems.slice(0, 40)) {
  console.error("  · " + p.file + (p.line ? ":" + p.line : "") + "  [" + p.why + "]  " + p.text);
}
if (problems.length > 40) console.error("  … 还有 " + (problems.length - 40) + " 处");
process.exit(1);
