# 鲸鲸 设计规范（design.md）

> **这份文档是界面风格的真源。**
> 每做一个新页面 / 新组件，**先读它**，再动手；实现里能用 token 就不要写死数值。
> 规范来自参考设计（Apple Books 的三屏 + 安卓阅读器四屏），数值是**量出来的**（像素分析 + DOM 实测），
> 不是凭感觉写的。代码里的落点是 `app/src/ui/theme/mobile.css`（手机端）与
> `app/src/reader/themes.ts`（主题色）。
>
> 适用范围：**手机端（`[data-mobile="true"]`）**。桌面端保持一致但密度更高，不在本规范内。

---

## 0. 一条总原则

**内容优先，控件让路。** 参考设计的共同点是：能藏的都藏起来（阅读界面默认没有任何控件，
点一次才出现）、能去掉的描边都去掉（靠留白与极淡的投影分层）、
**只有一个强调色**（其余全是中性灰阶）。任何"为了显眼而加的东西"都是错的。

---

## 1. 配色

### 1.1 主色 / 强调色（tint）

强调色**只用于**：选中的页签与分段控件、主行动按钮（导入 / 完成 / 发送）、进度条、
滑块已填充部分、链接、开关、当前阅读位置。**一屏里出现强调色的元素不超过 3 处。**

| 主题 | 强调色 | 淡底（选中/悬浮态） |
|---|---|---|
| 浅色 | `--m-tint: #eb712d` | `--m-tint-soft: rgba(235,113,45,0.12)` |
| 米黄 | `--m-tint: #b8791f` | `rgba(184,121,31,0.14)` |
| 深色 | `--m-tint: #ff8a4c` | `rgba(255,138,76,0.16)` |

> 强调色**跟着纸色走**（参考阅读器就是这样：白纸=银灰、米黄=琥珀金、黑纸=系统蓝）。
> 换主题时不要留下"上一套主题的橙"。

### 1.2 中性色（背景 / 面板 / 文字 / 分隔）

| 语义 | 浅色 | 米黄 | 深色 | 用途 |
|---|---|---|---|---|
| `--m-bg` 页面底 | `#ffffff` | `#f7f1e4` | `#0e0e0e` | 页面背景（参考量到 #FDFDFD，取纯白） |
| `--m-panel` 面板 | `#ffffff` | `#fbf6ea` | `#161618` | 卡片、抽屉、弹出层 |
| `--m-grouped` 次级填充 | `#f2f2f7` | `#efe8d8` | `#1c1c1e` | 搜索框、分段控件轨道、未选中按钮、次级卡片 |
| `--m-text` 主文字 | `#1c1c1e` | `#3b3226` | `#f2f2f5` | 标题与正文 |
| `--m-sub` 次要文字 | `#8a8a8e` | `#8a7c66` | `#9a9aa0` | 作者、计数、说明、占位符 |
| `--m-line` 分隔线 | `rgba(60,60,67,0.14)` | `rgba(90,74,51,0.16)` | `rgba(255,255,255,0.14)` | 发丝线（1px） |
| `--m-cover-from/to` | `#2b3240 → #4a5568` | `#5a4a33 → #7d6a4c` | `#232830 → #39414d` | 无封面时的占位渐变 |

**规则**
- 分隔线一律 `1px solid var(--m-line)`，**不要虚线、不要深色边**（参考里的线几乎看不见，只用来分组）。
- 正文不用纯黑（`#000`），用 `--m-text`；纯黑只在阅读正文由引擎渲染时出现。
- 语义色：危险/删除 `#c0392b`、成功 `#16794c`，只在真正需要时用。

---

## 2. 字体

系统字体栈（跟随系统；中文由系统回落）：`system-ui, "Microsoft YaHei", "PingFang SC", sans-serif`。

| 级别 | 字号 | 字重 | 行高 | 用途 |
|---|---|---|---|---|
| Hero 大标题 | `30px` | `700` | 1.15 | 页面标题（首页 / 书库 / AI），字距 `-0.6px` |
| 分区标题 | `20px` | `650` | 1.25 | 「继续阅读」「接下来」这类分区头，字距 `-0.3px` |
| 导航标题 | `16px` | `600` | 1.2 | 顶栏中间的书名、半屏卡片标题 |
| 正文 | `15.5px` | `400` | 1.6 | 对话正文、列表正文、设置项 |
| 强调正文 | `15.5px` | `600` | 1.3 | 按钮文字、卡片标题 |
| 次要文字 | `13.5px` | `400` | 1.5 | 作者、章节数、说明、计数 |
| 卡片标题 | `14px` | `600` | 1.3 | 封面下方的书名（最多 2 行） |
| 极小字 | `12px` | `400/600` | 1.4 | 位置信息、页码、标签 |
| 页签文字 | `10.5px` | `600` | 1.1 | 底部导航格、阅读底栏格 |

**层级对比**：Hero 与正文的比例约 **2:1**（30 vs 15.5），分区标题是 **1.3:1**。
**一屏里字重不要超过 3 种**（400 / 600 / 700）。

**阅读正文**（书内，由 `buildBookCSS` 生成，用户可调）：默认 `18px / 1.75 / 首行缩进 2em / 两端对齐`；
参考里的行距约 1.9–2.0 倍，所以排版面板允许 1.2–2.6。

---

## 3. 间距

| Token | 值 | 用途 |
|---|---|---|
| `--m-pad` | `18px` | 页面左右内边距（所有页面内容一律用它，不要各写各的） |
| `--m-gap` | `14px` | 网格横纵间距、并排元素间距 |

**常用值（不在 token 里的按这套取）**
- 元素内边距：药丸按钮 `8px 14px`；图标按钮 `6px 10px`；卡片 `12px`；区块 `12–16px`
- 垂直节奏：紧邻元素之间 `6–8px`；同一分区内 `12px`；**分区之间 `26px`**；页面顶部（标题之上）`4px`
- 触控目标：**最小 40×40px**，主要按钮 `46–50px` 高，列表行 `44px`
- 安全区：顶栏 `padding-top: calc(6px + env(safe-area-inset-top))`；底栏 `padding-bottom: calc(10px + env(safe-area-inset-bottom))`
- 底部浮动导航会盖住内容，**页面容器要留 `padding-bottom: calc(92px + safe-area)`**

**留白的取舍**：参考设计的"呼吸感"来自**大标题上方留白** + **分区之间 26px**，不是把每处 padding 都调大。
宁可少放一个元素，也不要把间距压到 8px 以下。

---

## 4. 组件样式

### 4.1 圆角

| 组件 | 圆角 |
|---|---|
| 封面 | `6px`（`--m-r-cover`） |
| 卡片 / 弹出层 | `12px`（`--m-r-card`） |
| 输入框 / 小块 | `10px`（`--m-r-field`） |
| 底部卡片（sheet） | `18px 18px 0 0`（`--m-r-sheet`） |
| 按钮 / 胶囊 / 圆形按钮 / 头像 | `999px`（药丸） |

### 4.2 阴影（**不用边框，用阴影分层**）

| Token | 值 | 用途 |
|---|---|---|
| `--m-shadow-card` | `0 1px 2px rgba(0,0,0,.05), 0 6px 16px rgba(0,0,0,.06)` | 封面、卡片 |
| `--m-shadow-sheet` | `0 -8px 30px rgba(0,0,0,.16)` | 底部弹出的卡片 |
| `--m-shadow-pop` | `0 10px 30px rgba(0,0,0,.16)` | 下拉菜单、气泡 |

深色主题下把卡片阴影压到 `0 1px 2px rgba(0,0,0,.5)`（深色里放不出"柔光"）。

### 4.3 毛玻璃（glass）

参考 App 的导航、底栏、弹出层都是**半透明 + 背景模糊**。规范值：

| Token | 值 |
|---|---|
| `--m-glass` | `color-mix(in srgb, var(--m-panel) 74%, transparent)` |
| `--m-glass-strong` | `color-mix(in srgb, var(--m-panel) 90%, transparent)` |
| `--m-glass-blur` | `saturate(180%) blur(24px)` |
| `--m-hairline` | `0 0 0 0.5px var(--m-line)`（玻璃边缘那道极细线） |

**用在哪**：顶栏、底部导航、阅读底栏、底部弹出的卡片（半屏 AI、抽屉、排版面板）、
搜索框与输入框、悬浮在内容之上的任何工具条。
**不用在**：普通卡片、封面、正文区（模糊背景要"背后有内容"才有意义）。

实现要点：`backdrop-filter: var(--m-glass-blur); -webkit-backdrop-filter: ...`（WebView 两个都要写）。

### 4.4 按钮

| 类型 | 样式 | 用途 |
|---|---|---|
| 主行动 | 底色 `--m-tint`，白字，`600`，药丸，高 `46px` | 导入书籍、完成、发送 |
| 次级 | 底色 `--m-grouped`，字色 `--m-text`，药丸 | 普通操作 |
| 图标按钮 | 透明底、`--m-tint` 字色、`40×40` | 顶栏的返回 / 书签 / 打开 |
| 圆形按钮 | `--m-grouped` 底、`34–54px` 圆 | 设置齿轮、搜索圆钮 |
| 选中态 | 底 `--m-tint-soft`、字 `--m-tint` | 主题按钮、分段控件选中项 |

**按钮一律无边框**；按下时 `transform: scale(0.97)`（`.08s`），不要做位移动画。

### 4.5 卡片

- 结构：封面 → **一行"左角标胶囊 + 右 •••"** → 书名（`14px/600`，最多 2 行）→ 次要行（作者 · 章节数）
- 封面：`3:4`、圆角 6px、`--m-shadow-card`；**封面上不压任何按钮**
- 危险/次要操作全部收进 `•••` 菜单，不要摊在卡片上
- "继续阅读"这类**主推卡片**：通栏、深色渐变底（`linear-gradient(135deg,#3a3a3c,#1c1c1e)`）、白字、圆角 14px

### 4.6 导航

- **顶部**：`48px` 高（+ 安全区），毛玻璃底 + 底部发丝线，左返回、中标题（`16px/600`，屏幕居中）、右图标。
  **标题用绝对居中**（不要靠 flex 分空间，否则左右按钮数量一变标题就偏）。阅读页顶栏**不放书名**（会被按钮挤到重叠）。
- **底部导航**：浮动药丸（左右各 12px、距底 10px + 安全区），毛玻璃；三格 `图标 + 10.5px 文字`，
  选中格是 `--m-grouped` 圆角块；右侧**独立的圆形搜索钮**（54px）。内容容器要留出它的高度。
- **底部卡片（sheet）**：圆角 18px 顶角 + `36×5` 抓手 + 遮罩（`rgba(0,0,0,.22)`，点一下关闭）；
  阅读页里的面板（AI / 目录 / 批注 / 排版）一律是这个形态，**不整页替换正文**。

### 4.7 列表

- 行高 `44px`，行间 `1px solid var(--m-line)`
- 行内：主文字 `15.5px`，右侧值为 `--m-sub`
- 分组头：`13.5px/600`、`--m-sub`、上方 `12px` 间距

### 4.8 分段控件（排序 / 分页-滚动）

轨道 `--m-grouped` + `10px` 圆角 + `2px` 内边距；
选中项白底（`--m-panel`）+ `8px` 圆角 + `0 1px 3px rgba(0,0,0,.12)`；文字 `13.5px/600`。

---

## 5. 动效

- 时长：`.12s`（按下反馈）、`.18–.2s`（显隐 / 弹出）、**不超过 .25s**
- 曲线：`ease`（iOS 用弹簧曲线，WebView 里 ease 已经够）
- 只动 `transform` 与 `opacity`，不动 `width/height/top/left`

---

## 6. 检查清单（新页面提交前逐条过）

1. 页面左右内边距是不是 `--m-pad`（18px）？有没有哪块贴边？
2. 字号是不是只用规范里的那几档？一屏字重 ≤ 3 种？
3. 强调色是不是 ≤ 3 处？有没有"到处都强调"？
4. 分隔线是不是发丝级、低对比？有没有多余的边框？
5. 卡片是不是"封面干净 + 操作收进 •••"？有没有把按钮压在封面上？
6. 触控目标都 ≥ 40px 吗？
7. 底部有浮动导航时，内容底部留出 92px + 安全区了吗？
8. 悬在内容之上的工具条，是不是毛玻璃？背后没内容的区域是不是**没有**滥用模糊？
9. 换主题（浅色/米黄/深色）看一遍：强调色、文字对比、阴影都对吗？
10. 手机视口 390×844 下量一遍（`tools/shot.mjs --emulate 390x844 --dpr 3`），再看真机截图。

---

## 7. 反例（踩过的坑，别再犯）

- ❌ 阅读页顶栏放书名 → 居中标题压住右侧按钮（实测"书签"被盖住）
- ❌ 收起状态的抽屉留着 54px 页签条 → 和浮动底栏叠成两条 bar
- ❌ 阅读页里同时出现底栏与阅读底栏 → 点"目录"其实点在底栏上，人被弹回书库
- ❌ 卡片上压"移除/归类"按钮 → 封面被压得看不清（参考里这些都在 ••• 里）
- ❌ 详情/面板整页替换正文 → 阅读位置与上下文被打断（改成半屏卡片）
- ❌ 输入框与文本贴边（AI 半屏卡片第一版就是这样）→ 一律 18px 内边距

---

## 8. 参考：Apple HIG 要点（本轮查证后落地的部分）

来源：Apple Developer Documentation — Human Interface Guidelines 的
[Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)、
[Materials](https://developer.apple.com/design/human-interface-guidelines/materials)、
[Layout](https://developer.apple.com/design/human-interface-guidelines/layout)。

### 8.1 材料（Materials）：控件层浮在内容层之上

> "A material is a visual effect that creates a sense of depth, layering, and hierarchy between
> foreground and background elements."
> "…forms a distinct functional layer for controls and navigation elements — like tab bars and
> sidebars — that **floats above the content layer**… allows content to **scroll and peek through
> from beneath** these elements."

**落到我们这里**：
- 阅读页的顶栏/底栏是**绝对定位、浮在正文之上**的，**不占文档流**——
  点一下出现时正文一动不动（曾经是"顶栏挤下去 61px"，连阅读位置都会跳）。
- 内容从下面"透"过去：栏是毛玻璃的，底部再接一条发丝线。
- **不要在内容层用毛玻璃**（普通卡片、封面、正文不加模糊）；"Use Liquid Glass effects sparingly"。

### 8.2 卡片（Sheets）：一次只开一个，且有"档位"

> "A sheet helps people perform a scoped task that's closely related to their current context."
> "Display only one sheet at a time from the main interface."
> "When people close a sheet, they expect to return to the parent view."

**落到我们这里**：
- 阅读页里的面板（AI / 目录 / 批注 / 排版）一律是**半屏卡片**，不整页替换正文；关闭后回到原处。
- 卡片有**两档**：medium（62dvh）/ large（88dvh）；抓手可**拖**（上拖放大、下拖关闭）也可**点**（切档）。
- 点遮罩关闭；进场 `.22s ease`。
- 半屏里**压缩辅助信息**（技能条收起、上下文条限一行），把高度留给消息区（实测多出 55px）。

### 8.3 布局与触控（Layout）

> "People often start by viewing content in reading order… place the most important items near the
> top and leading side."
> "Align elements to make them easier to scan, and use indentation to convey hierarchy."
> 尊重系统 safe area 与边距。

**落到我们这里**：
- 触控目标 **≥ 44×44pt**（顶栏按钮、圆形按钮、列表行都按这条；小图标靠 padding 撑命中区）。
- 一切内容对齐到 **`--m-pad` 18px** 这条竖线；层级的差别用**字重与字号**表达，不用缩进堆叠。
- 阅读页正文顶部留出安全区，浮起来的顶栏压在页边（foliate 自己的 48px 页边）上，不盖正文。

