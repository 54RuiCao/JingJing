/**
 * 主题：同时作用于「应用外壳」与「书内渲染」两处。
 *
 * 应用外壳用 CSS 变量（挂到 documentElement 上）；
 * 书内渲染由 buildBookCSS 生成 body 的背景/前景色，通过引擎的 setStyles 注入。
 */

export type ThemeId = "light" | "sepia" | "dark";

export type ThemeTokens = {
  id: ThemeId;
  /**
   * 显示名走 i18n：**存 key、渲染时 `t(nameKey)`**。
   * 这个对象是模块级常量，直接写 `t(...)` 会在加载那一刻把语言定死，切语言不会变。
   */
  nameKey: "reader.themeLight" | "reader.themeSepia" | "reader.themeDark";
  /** 应用外壳 */
  app: {
    bg: string;
    panel: string;
    text: string;
    sub: string;
    border: string;
    hover: string;
    accent: string;
  };
  /** 书内正文 */
  book: {
    bg: string;
    text: string;
    link: string;
    /** 封面/占位等深色块 */
    coverFrom: string;
    coverTo: string;
  };
};

export const THEMES: Record<ThemeId, ThemeTokens> = {
  light: {
    id: "light",
    nameKey: "reader.themeLight",
    app: {
      bg: "#eef0f4",
      panel: "#ffffff",
      text: "#1f2430",
      sub: "#7b8494",
      border: "#dfe3ea",
      hover: "#eceff4",
      accent: "#1f2430",
    },
    book: { bg: "#ffffff", text: "#1f2430", link: "#1668b3", coverFrom: "#2b3240", coverTo: "#4a5568" },
  },
  sepia: {
    id: "sepia",
    nameKey: "reader.themeSepia",
    app: {
      bg: "#e8e0cf",
      panel: "#f6f0e2",
      text: "#3b3226",
      sub: "#8a7c66",
      border: "#d8cdb6",
      hover: "#efe7d6",
      accent: "#6b5a3e",
    },
    book: { bg: "#f6f0e2", text: "#3b3226", link: "#8a6a2f", coverFrom: "#5a4a33", coverTo: "#7d6a4c" },
  },
  dark: {
    id: "dark",
    nameKey: "reader.themeDark",
    app: {
      bg: "#14171d",
      panel: "#1c2027",
      text: "#dfe3ea",
      sub: "#8b93a1",
      border: "#2b3138",
      hover: "#232830",
      accent: "#dfe3ea",
    },
    book: { bg: "#1a1d23", text: "#c8cdd6", link: "#7fb3e8", coverFrom: "#232830", coverTo: "#39414d" },
  },
};

export const THEME_LIST: ThemeTokens[] = [THEMES.light, THEMES.sepia, THEMES.dark];

export function applyAppTheme(theme: ThemeTokens): void {
  const r = document.documentElement.style;
  r.setProperty("--air-bg", theme.app.bg);
  r.setProperty("--air-panel", theme.app.panel);
  r.setProperty("--air-text", theme.app.text);
  r.setProperty("--air-sub", theme.app.sub);
  r.setProperty("--air-border", theme.app.border);
  r.setProperty("--air-hover", theme.app.hover);
  r.setProperty("--air-accent", theme.app.accent);
  r.setProperty("--air-cover-from", theme.book.coverFrom);
  r.setProperty("--air-cover-to", theme.book.coverTo);
  document.documentElement.style.colorScheme = theme.id === "dark" ? "dark" : "light";
}
