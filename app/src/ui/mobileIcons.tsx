/**
 * 手机端底栏/阅读底栏用的图标（P7）。
 *
 * 为什么自己画 SVG 而不是引图标库：这一版只要 6 个图标，引一个图标包（几百 KB + 一套主题约定）
 * 不划算；参考设计用的是 SF Symbols 那种"细线条 + 圆头"的观感，用 1.8 描边的 path 就够近。
 * 统一 24×24 视图框、currentColor 上色 —— 颜色由 CSS 决定（选中态是强调色）。
 */

const base = {
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** 首页：房子 */
export function HomeIcon() {
  return (
    <svg {...base}>
      <path d="M4 10.5 12 4l8 6.5" />
      <path d="M6 9.8V19a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9.8" />
      <path d="M10 20v-5h4v5" />
    </svg>
  );
}

/** 书库：三本书 */
export function LibraryIcon() {
  return (
    <svg {...base}>
      <rect x="4" y="5" width="4" height="14" rx="1" />
      <rect x="10" y="5" width="4" height="14" rx="1" />
      <path d="M16.6 6.2l3.1.9a1 1 0 0 1 .7 1.2l-2.6 9.6" />
    </svg>
  );
}

/** AI：对话气泡 + 一点星光（"AI 在这里"） */
export function AiIcon() {
  return (
    <svg {...base}>
      <path d="M20 13.2c0 3.1-3.1 5.6-7 5.6-1 0-2-.2-2.9-.5L6 20l.9-3.1A5.5 5.5 0 0 1 5 13.2C5 10.1 8.1 7.6 12 7.6s8 2.5 8 5.6Z" />
      <path d="M12 3.2l.7 1.6L14.3 5.5l-1.6.7-.7 1.6-.7-1.6L9.7 5.5l1.6-.7z" />
    </svg>
  );
}

/** 搜索：放大镜 */
export function SearchIcon() {
  return (
    <svg {...base}>
      <circle cx="11" cy="11" r="6" />
      <path d="M15.5 15.5 20 20" />
    </svg>
  );
}

/** 目录：列表 */
export function TocIcon() {
  return (
    <svg {...base}>
      <path d="M5 7h14M5 12h10M5 17h7" />
    </svg>
  );
}

/** 批注：铅笔 */
export function NoteIcon() {
  return (
    <svg {...base}>
      <path d="M15.5 5.5l3 3-9 9-3.6.6.6-3.6z" />
      <path d="M13.8 7.2l3 3" />
    </svg>
  );
}

/** 设置：齿轮（手机端头部右上角那个圆钮） */
export function GearIcon() {
  return (
    <svg {...base}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 4.6v2.1M12 17.3v2.1M4.6 12h2.1M17.3 12h2.1M6.8 6.8l1.5 1.5M15.7 15.7l1.5 1.5M17.2 6.8l-1.5 1.5M8.3 15.7l-1.5 1.5" />
    </svg>
  );
}


/** 书签：参考阅读器顶栏右侧那个 */
export function BookmarkIcon() {
  return (
    <svg {...base}>
      <path d="M7 4.8h10a1 1 0 0 1 1 1V20l-6-3.6L6 20V5.8a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

/** 字号：顶栏那个 Aa */
export function FontIcon() {
  return (
    <svg {...base}>
      <path d="M3.6 19 8 6l4.4 13" />
      <path d="M5.2 14.6h5.6" />
      <path d="M14.6 19l2.6-7.6L19.8 19" />
    </svg>
  );
}
