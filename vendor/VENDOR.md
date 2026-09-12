# 第三方源码（vendored）

## foliate-js

- 上游：https://github.com/johnfactotum/foliate-js
- 许可：**MIT**（见 `foliate-js/LICENSE`，Copyright (c) 2022 John Factotum）
- 获取方式：`https://codeload.github.com/johnfactotum/foliate-js/tar.gz/refs/heads/main`（本机 git 协议无法直连 github.com，走 codeload）
- 获取日期：2026-09
- 默认分支 HEAD 提交：见下方「基线提交」

### 为什么在这里而不是 node_modules

上游 `package.json` 的 version 为 `0.0.0`、没有正式 npm 发布，且**中文排版需要修改 `paginator.js`**。
因此本目录是**我们自己的 fork 的基线**，通过 `"foliate-js": "file:../vendor/foliate-js"` 被 app 引用。
任何本地修改都必须在 `foliate-js/LOCAL-CHANGES.md` 中记录（尚未创建），并在升级上游基线时逐一复核。

### 与 ReadAny 副本的差异（已知情报）

| 文件 | 上游 | ReadAny 副本 |
|---|---|---|
| `paginator.js` | **43.2KB** | **140KB**（约为上游 3.2 倍） |
| `epub.js` | 42.7KB | 50KB |
| `mobi.js` | 46.6KB | 43KB |
| `overlay/overlayer.js` | 6.9KB | 11KB |
| `tts.js` | 9.3KB | 15KB |

`paginator.js` 的巨大差异说明**分页器是他们的主要改造点**（很可能与 CJK 排版、翻页模式相关）。
**注意**：ReadAny 的副本以 GPL-3.0 分发，本项目为 Apache-2.0，**不得取其修改后的代码**；差异仅作为「哪里需要改」的情报使用。
