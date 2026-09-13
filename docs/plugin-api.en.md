# Write a JingJing Plugin

> This is the English translation of [docs/plugin-api.md](plugin-api.md). The Chinese version is authoritative if they disagree.

A plugin is a directory: a `manifest.json` + a host half `main.js` + an optional UI half `ui.js`.
Both halves run in **quickjs-ng** (WASM, no JIT); the host exposes only whitelisted functions — no `fetch`, `require`, `setTimeout`, `document`.

Where to put it: drop the directory into the plugin root (the in-app "Settings → Plugins"（设置 → 插件） shows the path), then click "Rescan plugin folder"（重新扫描插件目录） to take effect.
The AI can write it too: tell it "add a panel showing the pages left in this chapter"（加一块显示本章剩余页数的界面）, and it writes it with `plugin_define` / `plugin_run` and mounts it; once you are happy, click "Keep in plugin folder"（保留到插件目录） in the plugin panel to persist it to disk.

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

- `id` never changes (grants and rollbacks are bound to it); `version` is immutable — changing code means changing the version number.
- `capabilities` is the **single source of truth for permission declarations**, see the table below. Declaring too little makes calls fail; declaring too much costs an extra grant prompt.
- At least one of `main` and `ui.entry` must be present.
- The author-supplied `hash` is not needed for now (the loader computes one and keeps it in memory).

## The two halves

The host half registers tools / services / side effects; the UI half mounts UI into declared slots. Both export `apply(ctx, config)`:

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

## What ctx can do

| Call | Required capability | Description |
|---|---|---|
| `ctx.log(...)` | `log.write` | Write plugin logs |
| `ctx.reader.progress()` | `reader.read` | **Synchronous**. `{ fraction, chapter, location, sectionIndex, sectionTotal, sectionFraction, sectionStartFraction, sectionEndFraction, locations:{current,total} }` |
| `ctx.reader.chapters()` | `reader.read` | Synchronous. Chapter index; an empty array when no whole-book context is loaded |
| `ctx.reader.chapter(n, offset, maxChars)` | `reader.read` | Synchronous. Chapter body slice |
| `ctx.reader.selection()` | `reader.read` | Synchronous. Current selection |
| `await ctx.reader.search(q, limit)` | `reader.read` | Full-text search |
| `await ctx.reader.annotations()` | `reader.read` | Annotations for this book |
| `await ctx.reader.addAnnotation({kind,cfi,text,note,color})` | `reader.annotate` | Write an annotation |
| `await ctx.reader.gotoChapter/gotoCfi/gotoFraction` | `reader.navigate` | Change the reading position |
| `await ctx.storage.get/set/remove/keys` | `storage.plugin` | The plugin's own storage (isolated per plugin) |
| `ctx.tools.register(def, execute)` | — | Register a tool |
| `ctx.effect(fn)` | — | Register cleanup; the callback must be synchronous; the returned function is called on unload |
| `ctx.slots.register(opts, render)` | `ui.slot` | Mount a UI block (see below) |
| `ctx.slots.refresh()` | `ui.slot` | Re-render that UI block |
| `await ctx.reader.activity()` | `reader.read` | The **reading activity** the host collects (seconds and page turns per day): `{ today, todaySeconds, todayTurns, days, totalSeconds, activeDays, streak, longestStreak, bestDay }` |
| `await ctx.net.fetch(url, opts)` | `net.fetch` | HTTP **sent by the host**. The domain must be declared in the manifest's `network.origins` and granted by the user |
| (declared together with `net.fetch`) | `ai.credentials` | On GET/HEAD to the AI service **you configured**, the host fills in `Authorization` (the key never enters the sandbox) |
| `ctx.timeout(fn, ms) / ctx.interval(fn, ms) / ctx.clear(handle)` | — | Host timers (there is **no** `setTimeout` in the sandbox); the host clears them all on unload |
| `ctx.env() / ctx.crypto.randomUUID() / ctx.text.*` | — | Host environment facts (platform / touch / viewport / theme), random ids, filename and truncation helpers |
| `ctx.theme.overrideTokens({...})` | `ui.theme` | Override theme colors (`--air-bg/panel/text/sub/border/hover/accent/cover-from/cover-to` plus the **three book tokens** `--air-book-bg / --air-book-text / --air-book-link`; values may be written as `{ light, sepia, dark }`). A value must be a **single** value such as a color (semicolons or braces are rejected) |
| `ctx.styles.insert(css, { scope })` | `ui.styles` | Inject CSS: `scope:'app'` styles the shell, `scope:'book'` styles the **book text** (typography, margins, reading background). Removed automatically on unload; `ctx.styles.clear()` removes your own sheets |
| `ctx.get('plugin.name')` · `ctx.services()` | the manifest's `inject` | Read a service **another plugin** provides (plain data). Only names written in `inject: ['plugin.stats']` can be read, and only the `plugin.` prefix (host capabilities go through the `ctx.*` facades). A missing dependency is not a failure: the container parks your plugin until the provider shows up |

Anything not listed does not exist: the event surface (`ctx.on`) is not wired up; `llm.chat` / `fs.read` / `fs.write` exist only in the vocabulary.

### Changing appearance: colors, reading background, typography

Pick the cheapest option that works:

1. **Colors only**: `ctx.theme.overrideTokens({ '--air-book-bg': '#f6f0e2' })`. `--air-*` drives the app shell; `--air-book-bg / --air-book-text / --air-book-link` drives the book text (the reading background lives here).
2. **Typography / margins / details inside the text**: `ctx.styles.insert('body { line-height: 2 }', { scope: 'book' })`. The text document can also use `var(--air-bg)` and friends.
3. **Your own UI block, or styles the product does not offer**: same function with `{ scope: 'app' }` (the default). Give your node a `className` and select it in CSS.

**The book text lives in the book's own iframe — a different document**: shell CSS and shell CSS variables cannot reach it. That is the root cause of "I changed the color and nothing happened", so do not write `body` in `scope:'app'` and expect it to hit the text. `@import` and remote `url(...)` are rejected (they would bypass the `net.fetch` origin grant): fetch with `ctx.net.fetch` and inline the result, or use a data: URI. At most 16 sheets and 64 KB per plugin.

## The UI half: declarative UI, not React

React elements cannot cross the sandbox, so `render` returns a pure-data virtual node tree:

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

Four hard rules (violations are rejected, that UI cell is removed, and the reason goes into `plugin_diagnose`):

1. Tags and props must be on the whitelist — there is no `script` / `iframe` / `svg` / custom components / `dangerouslySetInnerHTML`.
2. `render` **must return synchronously** (it cannot be async). Fetch async data first into the plugin's own variable, then call `ctx.slots.refresh()`.
3. Event values must be the token returned by `ui.handler(fn)` (a function does not fit in JSON); a token is valid only for the most recently rendered tree, and the handler re-renders automatically when it finishes.
4. Depth ≤ 12 levels, ≤ 200 nodes.

Available slots (the `slots` query of `plugin_inspect` returns the live list):

| Slot | Type | Position |
|---|---|---|
| `sidebar.footer.action` | list | Bottom of the sidebar |
| `settings.section` | list | Settings panel |
| `reader.view.tail` | list | Tail of the reading area |
| `reader.selection.action` | keyed | Floating bar when text is selected |
| `chat.message.action` | keyed | Actions on an AI message |
| `tool.call.card` | **chain** | AI tool-call card |

`root` is not wired up yet (it replaces the entire frame, the highest risk).

### chain slots: nominate yourself, first match wins

`list`/`keyed` are "everyone mounts, ordered by position"; `chain` is an **election at render time** — suited to cases where you "look at the data and decide whether to take over" (that is what `tool.call.card` does):

```js
ctx.slots.register({
  slot: "tool.call.card",   // 也接受 name（宿主面的字段名），但推荐 slot
  select: (props) => (props.card?.name === "search_book" ? { highlight: true } : null),  // null = 弃权
}, function SearchCard({ card, matched }) {
  return { type: "div", props: { className: "air-tool" }, children: ["我接管了检索卡：" + matched.highlight] };
});
```

- `select` returning `null`/`undefined` = abstain, ask the next one; returning anything else = I take it, and that value is passed to the component as `props.matched`.
- **A throw inside `select` also counts as abstention** (the next candidate steps up); a component that crashes while rendering is **not removed** (the next render moves to the next candidate, unlike list/keyed where a crash removes the cell).
- Equal priorities do not conflict (a chain is meant to coexist); when no entry takes over, the product's default card is used.
- When a child slot is a chain, use `props.renderSlotChain("child-name")`; using the wrong API throws.

## Capability vocabulary

`reader.read` · `reader.annotate` · `reader.navigate` · `storage.plugin` · `log.write` · `ui.slot` · `ui.theme` · `ui.styles` · `net.fetch` · `ai.credentials`
(facades are wired); `llm.chat` · `fs.read` · `fs.write` exist only in the vocabulary — declaring them grants nothing.

A grant is bound to `(plugin id, version, capability)`: "Grant (this version only)"（授权（只此版本）） in the panel covers the current version only, and a new version needs a fresh grant; "Include future versions"（含后续版本） spans versions.
After a grant is revoked the plugin **stops immediately**.

## Debugging

- "Settings → Plugin Log"（设置 → 插件日志） shows `ctx.log` output and UI render failures.
- "Settings → Plugins"（设置 → 插件） shows status, failure reason, declared and granted capabilities, and lets you enable / disable, change config, or delete.
- Have the AI call `plugin_diagnose`: it returns the version pointer, all packages, the **source of the failing version**, and render-time failures.
