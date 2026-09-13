# 写一个鲸鲸插件

插件是一个目录：一个 `manifest.json` + 宿主半 `main.js` + 可选的 UI 半 `ui.js`。
两半都跑在 **quickjs-ng**（WASM，无 JIT）里，宿主只放白名单函数——里面没有 `fetch`、`require`、`setTimeout`、`document`。

放哪里：把目录丢进插件根目录即可（应用内「设置 → 插件」能看到路径），点「重新扫描插件目录」生效。
也可以让 AI 写：跟它说「加一块显示本章剩余页数的界面」，它会用 `plugin_define` / `plugin_run` 写出来并挂上，
满意后在插件面板点「保留到插件目录」就落盘了。

## manifest.json

```json
{
  "id": "com.example.left-pages",
  "name": "本章剩余页数",
  "purpose": "在阅读区尾部显示当前章节还剩多少页。",
  "version": "1.0.0",
  "apiVersion": "aireader-plugin-1",
  "main": "index.js",
  "ui": { "entry": "ui.js" },
  "capabilities": ["reader.read", "ui.slot"],
  "config": { "type": "object", "properties": { "charsPerPage": { "type": "integer", "minimum": 100 } } }
}
```

- `id` 稳定不变（授权与回滚都绑它），`version` 不可变——改代码 = 换版本号。
- `capabilities` 是**权限声明的唯一真源**，见下表。少声明会调用失败，多声明会多要一次授权。
- `main` 与 `ui.entry` 至少有一个。
- 作者自己填的 `hash` 目前不用写（加载器会算一个记在内存里）。

## 两半

宿主半注册工具 / 服务 / 副作用；UI 半往已声明的插槽里挂界面。都交出 `apply(ctx, config)`：

```js
// index.js（宿主半）
function apply(ctx, config) {
  ctx.log("启动了");                       // 需要 log.write；日志在「设置 → 插件日志」里
  ctx.tools.register({
    name: "left_pages",
    description: "当前章节还剩多少页",
    parameters: { type: "object", properties: {} },
    capabilities: ["reader.read"],          // 必须是 manifest 的子集
  }, async function () {
    const p = ctx.reader.progress();
    return { chapter: p.chapter, fraction: p.fraction };
  });
}
```

## ctx 能做什么

| 调用 | 需要的能力 | 说明 |
|---|---|---|
| `ctx.log(...)` | `log.write` | 写插件日志 |
| `ctx.reader.progress()` | `reader.read` | **同步**。`{ fraction, chapter, location, sectionIndex, sectionTotal, sectionFraction, sectionStartFraction, sectionEndFraction, locations:{current,total} }` |
| `ctx.reader.chapters()` | `reader.read` | 同步。章节索引；没装载全书上下文时是空数组 |
| `ctx.reader.chapter(n, offset, maxChars)` | `reader.read` | 同步。章节正文切片 |
| `ctx.reader.selection()` | `reader.read` | 同步。当前选区 |
| `await ctx.reader.search(q, limit)` | `reader.read` | 全文检索 |
| `await ctx.reader.annotations()` | `reader.read` | 本书批注 |
| `await ctx.reader.addAnnotation({kind,cfi,text,note,color})` | `reader.annotate` | 写批注 |
| `await ctx.reader.gotoChapter/gotoCfi/gotoFraction` | `reader.navigate` | 改阅读位置 |
| `await ctx.storage.get/set/remove/keys` | `storage.plugin` | 插件自己的存储（按插件隔离） |
| `ctx.tools.register(def, execute)` | — | 注册一个工具 |
| `ctx.effect(fn)` | — | 注册清理；回调必须同步，卸载时调用返回的函数 |
| `ctx.slots.register(opts, render)` | `ui.slot` | 挂一块界面（见下） |
| `ctx.slots.refresh()` | `ui.slot` | 让这块界面重渲染 |
| `await ctx.reader.activity()` | `reader.read` | 宿主采集的**阅读活动**（每天读了多少秒 / 翻了多少页）：`{ today, todaySeconds, todayTurns, days, totalSeconds, activeDays, streak, longestStreak, bestDay }` |
| `await ctx.net.fetch(url, opts)` | `net.fetch` | **宿主代发** HTTP。域名必须在 manifest 的 `network.origins` 里声明并被授权 |
| （与 `net.fetch` 一起声明） | `ai.credentials` | 对你**已配置的 AI 服务**发 GET/HEAD 时宿主自动代填 `Authorization`（Key 不进沙箱） |
| `ctx.timeout(fn, ms) / ctx.interval(fn, ms) / ctx.clear(handle)` | — | 宿主定时器（沙箱里**没有** `setTimeout`）；卸载时宿主统一清掉 |
| `ctx.env() / ctx.crypto.randomUUID() / ctx.text.*` | — | 宿主环境事实（平台 / 触摸 / 视口 / 主题）、随机 id、文件名与截断小工具 |
| `ctx.theme.overrideTokens({...})` | `ui.theme` | 覆盖主题颜色（可覆盖 `--air-bg/panel/text/sub/border/hover/accent/cover-from/cover-to` 与**正文三色** `--air-book-bg / --air-book-text / --air-book-link`；值可写成 `{ light, sepia, dark }`）。值只能是颜色这类**单值**（带分号 / 花括号会被拒） |
| `ctx.styles.insert(css, { scope })` | `ui.styles` | 注入一段 CSS：`scope:'app'` 改外壳、`scope:'book'` 改**书籍正文**（排版 / 页边 / 阅读背景）。卸载时自动撤；`ctx.styles.clear()` 主动撤掉自己插的 |
| `ctx.get('plugin.名字')` · `ctx.services()` | manifest 的 `inject` | 读**别的插件**提供的服务（纯数据）。要先在 manifest 里写 `inject: ['plugin.stats']` 才读得到；只认 `plugin.` 前缀（宿主能力走 `ctx.*` 门面）。依赖没到不算失败：容器让插件先 park，提供方挂上后自动继续 |

没有列的就不存在：事件面（`ctx.on`）还没接；`llm.chat` / `fs.read` / `fs.write` 只有词表。

### 改外观：颜色、阅读背景、排版

按代价从低到高选：

1. **只改颜色**：`ctx.theme.overrideTokens({ '--air-book-bg': '#f6f0e2' })`。`--air-*` 管应用外壳，`--air-book-bg / --air-book-text / --air-book-link` 管正文（阅读背景就在这里）。
2. **改排版 / 页边 / 正文细节**：`ctx.styles.insert('body { line-height: 2 }', { scope: 'book' })`。正文里也能用 `var(--air-bg)` 这些变量。
3. **自己那块界面 / 产品没提供的样式**：同一个函数，`{ scope: 'app' }`（默认）。给自己挂的节点一个 `className`，再用 CSS 选中它。

**正文在书自己的 iframe 里，是另一个 document**：外壳的 CSS 与 CSS 变量都进不去 —— 这就是「改了颜色没反应」的根因，所以别在 `scope:'app'` 里写 `body` 指望改到正文。样式里不许 `@import`、也不许远程 `url(...)`（会绕开 `net.fetch` 的域名授权，宿主直接拒）：要图标 / 字体请先 `ctx.net.fetch` 取回再内联，或用 data: URI。单插件 ≤16 张表、合计 ≤64KB。

## UI 半：声明式界面，不是 React

跨沙箱传不了 React 元素，所以 `render` 返回一棵纯数据的虚拟节点树：

```js
function apply(ctx) {
  ctx.slots.register(
    { slot: "reader.view.tail", id: "left-pages", order: 5, label: "本章剩余页数" },
    function (props, ui) {
      const p = ctx.reader.progress();
      const span = Math.max(1e-6, p.sectionEndFraction - p.sectionStartFraction);
      const pages = Math.max(1, Math.round(span * p.locations.total));
      const left = Math.max(0, Math.round(pages * (1 - p.sectionFraction)));
      return {
        type: "div",
        props: { className: "air-slot-tail" },
        children: [
          { type: "span", props: {}, children: ["本章约剩 " + left + " 页 / 共 " + pages + " 页"] },
          { type: "button", props: { onClick: ui.handler(() => ctx.slots.refresh()) }, children: ["刷新"] },
        ],
      };
    },
  );
}
```

四条硬规则（违反会被拒绝，那一格界面会被摘掉，原因写进 `plugin_diagnose`）：

1. 标签与属性必须在白名单里——没有 `script` / `iframe` / `svg` / 自定义组件 / `dangerouslySetInnerHTML`。
2. `render` **必须同步返回**（不能 async）。异步数据先取好存进插件自己的变量，再 `ctx.slots.refresh()`。
3. 事件的值必须是 `ui.handler(fn)` 返回的令牌（JSON 里放不下函数）；令牌只对最近一次渲染出来的树有效，处理器跑完会自动重渲染。
4. 深度 ≤ 12 层、节点 ≤ 200 个。

可用槽位（`plugin_inspect` 的 `slots` 查询能拿到实时清单）：

| 槽位 | 类型 | 位置 |
|---|---|---|
| `sidebar.footer.action` | list | 侧栏底部 |
| `settings.section` | list | 设置面板 |
| `reader.view.tail` | list | 阅读区尾部 |
| `reader.selection.action` | keyed | 选中文字时的浮动条 |
| `chat.message.action` | keyed | AI 消息上的动作 |
| `tool.call.card` | **chain** | AI 的工具调用卡片 |

`root` 还没接线（替换整个框架，风险最高）。

### chain 槽位：自己报名，第一个匹配者上

`list`/`keyed` 是"谁都挂着、按位置排"；`chain` 是**渲染时选举**——适合"看着数据决定我要不要接管"的场合（`tool.call.card` 就是这样）：

```js
ctx.slots.register({
  slot: "tool.call.card",   // 也接受 name（宿主面的字段名），但推荐 slot
  select: (props) => (props.card?.name === "search_book" ? { highlight: true } : null),  // null = 弃权
}, function SearchCard({ card, matched }) {
  return { type: "div", props: { className: "air-tool" }, children: ["我接管了检索卡：" + matched.highlight] };
});
```

- `select` 返回 `null`/`undefined` = 弃权，继续问下一个；返回别的值 = 我上，那个值作为 `props.matched` 交给组件。
- **`select` 抛错也算弃权**（下一个候选顶上）；组件渲染崩了**不摘格**（下次渲染换下一个候选，与 list/keyed 的"崩了就摘"不同）。
- 同 priority 不冲突（chain 本来就要并存）；没有条目接手时用产品默认卡片。
- 子槽位是 chain 时要用 `props.renderSlotChain("子名")`，用错 API 会抛错。

## 能力词表

`reader.read` · `reader.annotate` · `reader.navigate` · `storage.plugin` · `log.write` · `ui.slot` · `ui.theme` · `ui.styles` · `net.fetch` · `ai.credentials`
（已接门面）；`llm.chat` · `fs.read` · `fs.write` 只有词表，声明了也不会被授予。

授权绑 `(插件 id, 版本, 能力)`：面板里「授权（只此版本）」只覆盖当前版本，换版本要重新点头；「含后续版本」跨版本。
撤销授权后插件**立刻停**。

## 调试

- 「设置 → 插件日志」看 `ctx.log` 与界面渲染失败。
- 「设置 → 插件」看状态、失败原因、声明与已授予的能力，并可以开关 / 改配置 / 删除。
- 让 AI 调 `plugin_diagnose`：给出版本指针、全部包、**出错那一版的源码**与渲染期失败。
