/**
 * 契约测试：**中英双语文案表**（i18n）。
 *
 * 为什么单独测：双语最容易烂在"加了新功能忘了补英文"和"改文案时手滑删了占位符"，
 * 这两种错误在界面上都不会报错，只会默默显示中文或 `{name}`。
 * 所以这里既检查**数据**（key 对齐、英文没汉字、占位符一致），
 * 也检查**源码**（界面层不许再留硬编码中文）—— 后者才是防退化的那道闸。
 *
 * 跑法：node tools/run-tests.mjs i18n-test
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { messages } from "../app/src/i18n/messages";
import { format, getLang, langFromTag, setLangPref, t } from "../app/src/i18n";

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) pass++;
  else failures.push(name + (detail ? " —— " + detail : ""));
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const zhKeys = Object.keys(messages.zh).sort();
const enKeys = Object.keys(messages.en).sort();

// ---------- 1) 双语 key 对齐 ----------

check("文案条数够多（表没被清空）", zhKeys.length >= 200, String(zhKeys.length));
check("zh / en 条数一致", zhKeys.length === enKeys.length, zhKeys.length + " vs " + enKeys.length);
const missingInEn = zhKeys.filter((k) => !(k in messages.en));
const extraInEn = enKeys.filter((k) => !(k in messages.zh));
check("没有漏翻的条目", missingInEn.length === 0, missingInEn.slice(0, 8).join(", "));
check("没有多余的英文条目", extraInEn.length === 0, extraInEn.slice(0, 8).join(", "));

// ---------- 2) 英文里不许出现汉字 ----------

const cjkKeys = enKeys.filter((k) => CJK.test(messages.en[k]));
check(
  "英文文案里没有汉字（品牌名写 JingJing）",
  cjkKeys.length === 0,
  cjkKeys.slice(0, 8).map((k) => k + "=" + messages.en[k]).join(" | "),
);

const emptyZh = zhKeys.filter((k) => !messages.zh[k].trim());
const emptyEn = enKeys.filter((k) => !messages.en[k].trim());
check("没有空的中文条目", emptyZh.length === 0, emptyZh.slice(0, 8).join(", "));
check("没有空的英文条目", emptyEn.length === 0, emptyEn.slice(0, 8).join(", "));

// ---------- 3) 插值占位符必须两边一致 ----------

const holders = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort().join(",");
const badHolders = zhKeys.filter((k) => holders(messages.zh[k]) !== holders(messages.en[k]));
check(
  "占位符 zh/en 一致",
  badHolders.length === 0,
  badHolders.slice(0, 8).map((k) => k + " zh=[" + holders(messages.zh[k]) + "] en=[" + holders(messages.en[k]) + "]").join(" | "),
);

// ---------- 4) 语言判定 ----------

check("zh-CN → 中文", langFromTag("zh-CN") === "zh");
check("zh-Hant → 中文", langFromTag("zh-Hant") === "zh");
check("en-US → 英文", langFromTag("en-US") === "en");
check("de-DE → 英文（不认识的给英文）", langFromTag("de-DE") === "en");
check("系统语言缺失 → 中文（中文软件兜底）", langFromTag(undefined) === "zh");
check("空串 → 中文", langFromTag("") === "zh");

// ---------- 5) t() 真按语言取词 ----------

setLangPref("zh");
check("中文取词", t("app.name") === "鲸鲸", t("app.name"));
setLangPref("en");
check("英文取词", t("app.name") === "JingJing", t("app.name"));
setLangPref("auto");
check("auto 解析出有效语言", getLang() === "zh" || getLang() === "en", getLang());
check("插值替换", format("共 {n} 条", { n: 3 }) === "共 3 条", format("共 {n} 条", { n: 3 }));
check("缺参数原样留着（一眼看出漏传）", format("共 {n} 条", {}) === "共 {n} 条");
check("位置参数按名替换", format("{a}-{b}", { a: "x", b: "y" }) === "x-y");

// ---------- 6) 界面层不许再留硬编码中文 ----------
//
// 做法：**用 TypeScript 自己的解析器**找出所有"用户能看到的字符串节点"
// （字符串字面量 / 模板字面量 / JSX 文本），逐个查有没有汉字。
// 为什么不自己写词法扫描：试过，被 `/"/g` 这种正则里的引号、模板里的 `\${}`
// 和模板里的 CSS 注释反复带偏，误报多到没法当闸门 —— 解析器不会有这些毛病。
// 例外：`console.*` 的开发诊断日志允许中文（那是给我们自己看的）。

/** 一个文件里所有"含汉字的用户可见文本" */
function cjkLiterals(file: string, src: string): { line: number; text: string }[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const out: { line: number; text: string }[] = [];
  const at = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const take = (node: ts.Node, text: string) => {
    // 模板字面量里常塞 CSS：CSS 注释不是文案（实测 bookStyles.ts 全是这种）
    const clean = text.replace(/\/\*[\s\S]*?\*\//g, "");
    if (CJK.test(clean)) out.push({ line: at(node), text: clean.replace(/\s+/g, " ").trim().slice(0, 100) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) {
      take(node, node.text);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      take(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** 整个文件不扫：只在 DEV_TOOLS 构建里跑的自检探针（中文是排版测量样本） */
const SKIP_FILES = new Set(["reader/p0Report.ts"]);

/** 文件 → 允许保留中文的行特征（只放**故意不翻**的东西，别当灭火器用） */
const ALLOW: Record<string, string[]> = {
  // 分章正则：汉字是"第 X 章 / 节 / 回"这些书名格式本身
  "reader/txtToEpub.ts": ["CHAPTER_RE"],
};

// 界面层：这些文件里的中文必须全在文案表里
const srcRoot = existsSync(join(process.cwd(), "src")) ? process.cwd() : join(process.cwd(), "app");
const app = join(srcRoot, "src");
const UI_ROOTS = [join(app, "App.tsx"), join(app, "ai", "ChatPanel.tsx"), join(app, "library"), join(app, "reader"), join(app, "ui")];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const files: string[] = [];
for (const r of UI_ROOTS) {
  if (statSync(r).isDirectory()) walk(r, files);
  else files.push(r);
}
check("扫到了界面文件", files.length >= 8, String(files.length));

const offenders: string[] = [];
for (const f of files) {
  const rel = f.slice(app.length + 1).replace(/\\/g, "/");
  if (SKIP_FILES.has(rel)) continue;
  const allowed = ALLOW[rel] ?? [];
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  for (const hit of cjkLiterals(f, src)) {
    if ((lines[hit.line - 1] ?? "").includes("console.")) continue; // 开发诊断日志允许中文
    if (allowed.some((a) => (lines[hit.line - 1] ?? "").includes(a))) continue;
    offenders.push(rel + ":" + hit.line + "  " + hit.text);
  }
}

if (offenders.length) {
  // 按文件分组打印：哪个文件最脏、脏在哪一行，一眼能照着改
  const perFile = new Map<string, string[]>();
  for (const o of offenders) {
    const f = o.slice(0, o.indexOf(":"));
    perFile.set(f, [...(perFile.get(f) ?? []), o]);
  }
  console.error("界面层还有 " + offenders.length + " 处硬编码中文：");
  for (const [f, list] of [...perFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.error("  # " + String(list.length).padStart(4) + "  " + f);
    for (const o of list.slice(0, 5)) console.error("      " + o);
    if (list.length > 5) console.error("      … 还有 " + (list.length - 5) + " 处");
  }
}
check("界面层没有硬编码中文", offenders.length === 0, offenders.length + " 处");

// ---------- 汇总 ----------

console.log("i18n 契约测试：" + pass + " 条通过" + (failures.length ? "，" + failures.length + " 条失败" : ""));
if (failures.length) {
  for (const f of failures) console.error("✗ " + f);
  process.exit(1);
}
console.log("✓ 文案条数：" + zhKeys.length + "（zh/en 各一份）；界面文件 " + files.length + " 个已扫");
