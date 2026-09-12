# 我们对 foliate-js 的本地修改

> 本目录是我们自己维护的 fork，基线为上游 `johnfactotum/foliate-js`（MIT，见 LICENSE）。
> 每次修改都在此登记；升级上游基线时逐条复核。

---

### [L1] view.js — 暂时禁用 PDF 支持

- 日期：2026-09-10
- 原因：两点。(1) PDF 在本项目路线图中属于 P4，P0/P1 不需要；(2) `pdf.js` 内使用
  `new URL(\`vendor/pdfjs/${path}\`, import.meta.url)`，模板字面量缺少 `./` 前缀，
  导致 Vite 构建直接失败：
  `[vite:import-glob] Invalid glob: "vendor/pdfjs/*" ... It must start with '/' or './'`。
- 改动：`view.js` 中 `isPDF(file)` 分支不再动态导入 `./pdf.js`，改为抛出
  `UnsupportedTypeError('PDF 暂未支持（计划于 P4 实现）')`。
- 撤销条件：P4 实现 PDF 时。届时需要同时解决 Vite glob 前缀问题，或改用 pdfium 等其它渲染路径。
- **2026-09-11 更新（一次完整的 PDF 攻坚尝试，结论：还差最后一步）**：
  按顺序解决了三个问题，PDF 已经能"识别 → 打开 → 进入 FOLIATE-FXL 渲染器"，但**画布始终 0×0**：
  1. ✅ Vite glob 前缀（见 L3）；
  2. ✅ 运行时资源路径：worker/cmaps/standard_fonts 改为放 `public/pdfjs/`，用 `new URL('pdfjs/'+p, document.baseURI)`
     —— 因为 `new URL('./dir/'+x, import.meta.url)` 对**目录**解析不出来，运行时抛
     `Invalid factory url: ".../assets/undefined"`；
  3. ✅ 补 `Map/WeakMap.getOrInsert(Computed)` polyfill —— pdf.js v155 用了 WebView2(Chromium 143) 还没有的
     TC39 upsert 提案方法，报 `this[#e].getOrInsertComputed is not a function`（polyfill 在 `app/src/polyfills.ts`）。
  **剩下的问题**：打开后 `foliate-view` 是 FOLIATE-FXL、`isFixedLayout=true`、view 尺寸 955×801、
  `pdfjsLib.GlobalWorkerOptions.workerSrc` 正确指向 `/pdfjs/pdf.worker.mjs`，但 `canvas` 是 0×0，
  控制台没有报错。下一步建议：在 `fixed-layout.js` 里给 canvas 尺寸/渲染调用打日志，
  或直接用 pdf.js 在页面里手动渲染一页做最小复现。

---

### [L2] paginator.js — 翻页锁改为可配置（默认不变）

- 日期：2026-09-10
- 原因：上游在 `#turnPage` 里硬编码 `await wait(100)`。P0 实测翻页总耗时稳定在
  **107–141ms**，而其中真实渲染只占约 8ms（同章节内）/ 40ms（跨章节），
  其余全是这 100ms 的人工锁。它会把翻页帧率压到约 9fps，直接影响"翻页是否跟手"。
- 改动：`if (shouldGo || !this.hasAttribute('animated')) await wait(Number(this.getAttribute('turn-lock') ?? 100))`
  —— 默认值保持 100（不改变上游行为），调用方可设 `turn-lock="0"` 获得即时翻页。
- 撤销条件：上游提供等效的可配置项时改为使用上游实现。

---

### [已否决] 相邻章节预加载（不改引擎，仅记录结论）

- 日期：2026-09-10
- 动机：跨章翻页比同章翻页慢（18–22ms vs 2ms），猜测是"章节数据要重新取"。
- 做法：在 app 层提前调用 `sections[i+1].load()`（该结果按 href 缓存）。
- **实测结论：无效，已移除。**
  - `sections[i].load()` 冷启动仅 **1.8ms**、热调用 **0ms**，占跨章开销不到 10%；
  - 第一版在每次 relocate 都触发，反而把跨章翻页从 23ms 恶化到 37ms；
  - 第二版只在章节切换时预取，实测 22ms vs 21ms，仍为零收益。
- 真正瓶颈：`#createView()` + `view.load()` + 首次 columnize（视图重建）。
  要消除需做**视图池 / 多视图**（ReadAny 的 `#primaryView`/`#sortedViews` 路线），列为后续可选项。

---

### [L3] pdf.js — 资源 URL 前缀修正

- 日期：2026-09-11
- 原因：`new URL(\`vendor/pdfjs/${path}\`, import.meta.url)` 缺少 `./` 前缀，Vite 报
  `[vite:import-glob] Invalid glob: "vendor/pdfjs/*"`，直接构建失败。
- 改动：第 1 行改为 `new URL(\`pdfjs/${path}\`, document.baseURI)` —— 运行时静态资源
  统一放前端根目录的 `pdfjs/`（`app/public/pdfjs`）。
- 现状：修正后 PDF **已能解析并打开**（见 L1 的更新说明），但**渲染仍是空白画布**，
  所以 `view.js` 暂时仍对 PDF 抛 `UnsupportedTypeError`，`app/public/pdfjs` 也已移除（省 3.94MB）。
  渲染打通后把资源放回来即可。

---

### [L4] polyfills — Map/WeakMap upsert

- 日期：2026-09-11
- 位置：`app/src/polyfills.ts`（严格说不是引擎改动，但它服务的对象是引擎内置的 pdf.js）
- 原因：pdf.js v155 使用了 `Map.prototype.getOrInsertComputed`，而 WebView2（Chromium 143）
  尚未实现该 TC39 提案方法，报 `TypeError: this[#e].getOrInsertComputed is not a function`。
- 撤销条件：WebView2 升级到实现该提案的版本后（函数已存在，polyfill 不会覆盖）。

---

### [L5] 未改代码，但必须知道：章节级 CFI 不能直接 goTo

- 日期：2026-09-11（P2.2 期间发现）
- 现象：`view.getCFI(index)`（不带 range）返回的章节基 CFI 形如 `epubcfi(/6/50)`，
  直接 `view.goTo(那个 CFI)` 会抛 `TypeError: Cannot read properties of undefined (reading 'length')`，
  然后被 view.js 的 try/catch 吞掉，只留两行 `console.error`，表现为「什么都没发生」。
- 原因：`book.resolveCFI` 里 `CFI.parse(cfi)` 得到的是「单段路径」，
  `(parts.parent ?? parts).shift()` 把唯一一段取走后，剩下的 `parts` 是空数组，
  再传给 `CFI.toRange` 时 `partsToNode` 拿不到最后一个 part（`parts[parts.length-1]` 的 `parts` 是 undefined）。
- 绕法（未改引擎）：给基 CFI 补一段间接路径，指向章节文档的 body，即 `epubcfi(/6/50!/4)`。
  实测 `goTo("epubcfi(/6/50!/4)")` 正确落到第 24 章（《2666》，25 节）。
  **P2.2 的章节标记就是按这个形态生成的**，P2.4 的「引用跳回原文」可直接复用。
- 若将来要改引擎：应在 `resolveCFI` 里对「无间接段」的 CFI 返回 `anchor = () => doc.body`
  这样的退化锚点，而不是让它抛错。

---

## 待办（记录但尚未修改）

- `vendor/zip.js`、`vendor/fflate.js` 是上游 tarball 自带的，view.js 依赖它们（`await import('./vendor/zip.js')`）。
  升级上游时需要确认这两个文件仍然存在。
- `vendor/pdfjs/` 目录随 tarball 一起下载（体积占大头）。既然当前禁用 PDF，可在打包阶段排除以减小产物体积。
- 全文搜索性能：`view.search()` 会逐节加载并解析，实测 210 万字全书搜索耗时 **7.4s**，
  远达不到"<1s"的目标。计划改为自研索引（SQLite FTS5 或预建倒排索引），不依赖引擎搜索。
