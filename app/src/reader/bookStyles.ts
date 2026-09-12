/**
 * 注入到书籍 iframe 里的 CSS。
 *
 * 这里同时是 P0-3「中文排版评估」的实验台：
 * 每个候选属性都可以单独开关，用来判断 WebView2（Chromium）原生支持到什么程度，
 * 以及剩下的部分需要改 foliate-js 的 paginator.js 到什么程度。
 */

import type { ThemeTokens } from "./themes";

export type TypographyOptions = {
  fontSize: number;
  lineHeight: number;
  /** 首行缩进（em） */
  indent: number;
  justify: boolean;
  /** 中英混排自动间距（text-autospace） */
  autospace: boolean;
  /** 标点挤压 / 行首行尾半角（text-spacing-trim） */
  spacingTrim: boolean;
  /** 严格禁则 */
  strictLineBreak: boolean;
  /** 标点悬挂（hanging-punctuation，Chromium 目前不支持，留作对照） */
  hangingPunctuation: boolean;
  /** 允许西文断词 */
  hyphenate: boolean;
  /** 正文字体：serif / sans / 跟随原书 */
  fontFamily: "serif" | "sans" | "publisher";
};

export const defaultTypography: TypographyOptions = {
  fontSize: 18,
  lineHeight: 1.75,
  indent: 2,
  justify: true,
  autospace: true,
  spacingTrim: true,
  strictLineBreak: true,
  hangingPunctuation: false,
  hyphenate: false,
  fontFamily: "serif",
};

export function buildBookCSS(o: TypographyOptions, theme?: ThemeTokens): string {
  const t = theme?.book;
  return `
@namespace epub "http://www.idpf.org/2007/ops";

html {
  color-scheme: ${theme?.id === "dark" ? "dark" : "light"};
}

body {
  ${t ? `background: ${t.bg}; color: ${t.text};` : ""}
  ${o.fontFamily === "publisher" ? "" : `font-family: var(--air-${o.fontFamily});`}
  font-size: ${o.fontSize}px;
  line-height: ${o.lineHeight};
  margin: 0;
  padding: 0;
  text-align: ${o.justify ? "justify" : "start"};
  ${o.autospace ? "text-autospace: normal;" : ""}
  ${o.spacingTrim ? "text-spacing-trim: space-first;" : ""}
  ${o.hyphenate ? "-webkit-hyphens: auto; hyphens: auto;" : "-webkit-hyphens: manual; hyphens: manual;"}
  word-break: normal;
  overflow-wrap: break-word;
}

p, li, dd {
  margin: 0 0 0.6em;
  text-indent: ${o.indent}em;
  ${o.strictLineBreak ? "line-break: strict;" : "line-break: normal;"}
  ${o.hangingPunctuation ? "hanging-punctuation: allow-end last;" : ""}
  widows: 2;
  orphans: 2;
}

/* 已有对齐属性的元素不被覆盖 */
[align="left"] { text-align: left; }
[align="right"] { text-align: right; }
[align="center"] { text-align: center; }
[align="justify"] { text-align: justify; }

h1, h2, h3, h4, h5, h6 {
  text-indent: 0;
  line-height: 1.4;
  margin: 1.2em 0 0.8em;
  break-after: avoid;
}

blockquote p,
aside p,
figcaption,
caption,
p.no-indent,
p.first {
  text-indent: 0;
}

pre {
  white-space: pre-wrap !important;
}

img, svg, video {
  max-width: 100%;
  height: auto;
}

${t ? `a:link, a:visited { color: ${t.link}; }` : ""}

ruby rt {
  font-size: 0.5em;
}

/* 脚注默认隐藏，由阅读器以弹注呈现 */
aside[epub|type~="endnote"],
aside[epub|type~="footnote"],
aside[epub|type~="note"],
aside[epub|type~="rearnote"] {
  display: none;
}

/* 中文常见字体回退链 */
:root {
  --air-serif: "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", "SimSun", serif;
  --air-sans: "Source Han Sans SC", "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif;
}
`;
}
