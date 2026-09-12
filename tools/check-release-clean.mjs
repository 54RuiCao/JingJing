// 发布前检查：**这个包里有没有夹带"本机后加的插件"**。
//
// 用户关心的那件事：阅读贡献图之类的插件是运行期让 AI 写的、只落在
// %APPDATA%/app.aireader.desktop/plugins/ 下 —— 打包给别人的版本不该带它们。
// 这个脚本把三件事一次说清：
//   1. 本机用户插件目录里有哪些包（**不会被打包**，别人装完是空的）；
//   2. 编译进前端的内置插件有哪些（这些才是"出厂自带"）；
//   3. 逐个在 app/dist 里搜：用户插件的 id 一个字都不该出现。
//
//   node tools/check-release-clean.mjs
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const app = join(root, "app");
const userPluginsDir = join(process.env.APPDATA ?? "", "app.aireader.desktop", "plugins");
const distDir = join(app, "dist");

const listDirs = (dir) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory());
};

/** dist 下所有 js/css/html 的合并文本（发布产物就是它 + exe） */
const distText = (() => {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|css|html|json)$/i.test(name)) out.push(readFileSync(p, "utf8"));
    }
  };
  walk(distDir);
  return out.join("\n");
})();

// 内置插件 id：从源码里读（它们是产品的一部分，编译进前端是应该的）
const builtinSrc = ["src/core/app/builtinPlugins.ts", "src/ui/builtin/uiLayout.ts", "src/ui/builtin/pluginLogs.ts", "src/ui/builtin/pluginSettings.tsx", "src/ui/builtin/statusBadge.tsx", "src/ui/builtin/readerTail.tsx"]
  .filter((f) => existsSync(join(app, f)))
  .map((f) => readFileSync(join(app, f), "utf8"))
  .join("\n");
const builtinIds = [...new Set([...builtinSrc.matchAll(/id:\s*"([a-z0-9][a-z0-9.-]*)"/g)].map((m) => m[1]))].sort();

const userPlugins = listDirs(userPluginsDir);
const report = { builtin: builtinIds, userPlugins, leaked: [], nameHits: [], distBytes: distText.length };

for (const id of userPlugins) {
  // pluginId 是**决定性**判据：它只会出现在"这个包真的被编译进产物"的时候
  if (distText.includes(id)) report.leaked.push(id);
  // 插件的中文名只作为**线索**报出来：产品自带的文案里完全可能出现同样的字
  // （实测：用户插件叫「API 余额」，而内置技能里正写着"查 API 余额…" —— 纯撞车，不是泄露）
  const manifest = join(userPluginsDir, id, "manifest.json");
  if (existsSync(manifest)) {
    try {
      const name = JSON.parse(readFileSync(manifest, "utf8")).name;
      if (name && String(name).length >= 4 && distText.includes(String(name))) {
        report.nameHits.push({ id, name, note: "名字在产物里出现过 —— 先确认是不是产品文案撞车（例如内置技能/界面里的同名字样）" });
      }
    } catch {
      /* manifest 坏了不影响结论 */
    }
  }
}

console.log(JSON.stringify(report, null, 2));
if (!existsSync(distDir)) {
  console.error("✗ 还没有 app/dist（先 npm run build）");
  process.exit(1);
}
if (report.leaked.length) {
  console.error("✗ 用户插件被打进了发布产物：" + report.leaked.join(" / "));
  process.exit(1);
}
console.log("✓ 发布产物里没有本机后加的插件（别人装完的插件目录是空的）");
