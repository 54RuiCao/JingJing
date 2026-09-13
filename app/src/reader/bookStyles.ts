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

/**
 * 生成书内样式表。
 *
 * P5「外观权限」起多收一个 `tokens`：插件主题覆盖层解出来的 `--air-*` 值。
 * 之所以必须由调用方**传进来**（而不是在书里读 documentElement）：正文跑在书自己的
 * iframe 里，那是另一个 document，外层变量一个字节都过不去 ——
 * 这正是"插件改不了阅读背景"的根因。
 */
export function buildBookCSS(
  o: TypographyOptions,
  theme?: ThemeTokens,
  tokens?: Record<string, string>,
): string {
  const t = theme?.book;
  const pick = (name: string, fallback: string | undefined) => tokens?.[name] ?? fallback;
  const isDark = theme?.id === "dark";
  const bg = pick("--air-book-bg", t?.bg);
  const text = pick("--air-book-text", t?.text);
  const link = pick("--air-book-link", t?.link);
  /**
   * 书内文档自己的一份变量表：让注入正文的插件 CSS 也能写 `var(--air-accent)`，
   * 与外壳用同一套名字（作者不用记两套）。
   */
  const vars: Record<string, string | undefined> = {
    "--air-bg": pick("--air-bg", theme?.app.bg),
    "--air-panel": pick("--air-panel", theme?.app.panel),
    "--air-text": pick("--air-text", theme?.app.text),
    "--air-sub": pick("--air-sub", theme?.app.sub),
    "--air-border": pick("--air-border", theme?.app.border),
    "--air-hover": pick("--air-hover", theme?.app.hover),
    "--air-accent": pick("--air-accent", theme?.app.accent),
    "--air-cover-from": pick("--air-cover-from", t?.coverFrom),
    "--air-cover-to": pick("--air-cover-to", t?.coverTo),
    "--air-book-bg": bg,
    "--air-book-text": text,
    "--air-book-link": link,
  };
  const varBlock = Object.entries(vars)
    .filter(([, v]) => typeof v === "string" && v !== "")
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `
@namespace epub "http://www.idpf.org/2007/ops";

/* 正文文档自己的变量表（外壳的变量不过 iframe 边界） */
:root {
${varBlock}
}

html {
  color-scheme: ${theme?.id === "dark" ? "dark" : "light"};
}

body {
  ${bg ? `background: ${bg};` : ""}${text ? ` color: ${text};` : ""}
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

${link ? `a:link, a:visited { color: ${link}; }` : ""}

/* 引用段落（blockquote / aside / 常见引用类名）在深色纸下经常读不清 ——
   书自己的 CSS 会给它们一个"适合白纸"的深色，白纸没问题，黑纸上就糊了。
   P16：黑色纸下把这些容器强制回正文色（保留缩进与斜体，只改颜色）。 */
${isDark ? `
blockquote, blockquote *, aside, aside *, figure, figure *, cite,
.quote, .quote *, .epigraph, .epigraph *,
[class*="quote" i], [class*="quote" i] * {
  color: ${text ?? "#e6e6ea"} !important;
}
` : ""}

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
