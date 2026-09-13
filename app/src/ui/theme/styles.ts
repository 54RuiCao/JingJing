/**
 * 插件样式注入（P5「外观权限」）。
 *
 * 为什么要有它 —— 实测里插件作者（和 AI）撞到的原话是"**阅读背景改不了**"：
 * `ctx.theme.overrideTokens` 只能改 documentElement 上那 9 个 CSS 变量，而**正文跑在书自己的
 * iframe 里**（另一个 document），变量根本不过去；何况"改颜色"只是外观需求里最小的一类。
 *
 * 所以给外观插件两档能力，仍然守着"API 纪律"：
 *   1. `ctx.theme.overrideTokens({...})` —— 改已知 token（含新增的 `--air-book-*` 正文三色），
 *      值会被透传进书内 CSS，**阅读背景因此真的能改**；
 *   2. `ctx.styles.insert(css, { scope })` —— 直接给一段 CSS：
 *        scope:"app"  → 注入应用外壳（挂在自己的 <style> 上，卸载即撤）
 *        scope:"book" → 注入每本书的正文文档（随阅读位置变化重新应用）
 *
 * 四条硬限制（都是"最难查的问题提前变成会说话的报错"）：
 *   - **禁止 `@import` / `url(http…)`**：CSS 里的远程加载会绕开 net.fetch 的域名授权，
 *     等于给插件开了一条无授权的网络通道 —— 直接拒，并说清替代方案；
 *   - 每个插件 ≤ 16 张表、合计 ≤ 64 KB：外观是点缀，不是让插件塞一坨样式表；
 *   - 只能撤自己的（`clear()` 按 source 清）—— 没有"删别人的层"这种 API；
 *   - source 由宿主强制成插件 id（防冒充，与 theme 覆盖层同一个模式）。
 */

import { t } from "../../i18n";
import type { Disposer } from "../../core/service/types";

/** 注入位置：应用外壳 / 书籍正文 */
export type StyleScope = "app" | "book";

export const STYLE_SCOPES: StyleScope[] = ["app", "book"];

export type StyleSheet = {
  /** 谁插的（宿主强制成插件 id，插件自己说了不算） */
  source: string;
  scope: StyleScope;
  css: string;
};

export type PluginStyleSheets = {
  source: string;
  sheets: StyleSheet[];
};

/** 单插件上限：张数与总字符数 */
export const MAX_SHEETS_PER_PLUGIN = 16;
export const MAX_STYLE_CHARS_PER_PLUGIN = 64 * 1024;

export class StyleSheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StyleSheetError";
  }
}

/**
 * 会被拒的 CSS 结构。
 * 不是"安全边界"（沙箱本身就不是），而是**别让插件的样式偷偷联网**：
 * 授权模型里"能不能访问某个域名"是用户点过头的，而 @import 会绕过它。
 */
const FORBIDDEN_CSS: { re: RegExp; key: "plug.styles.import" | "plug.styles.remoteUrl" }[] = [
  { re: /@\s*import\b/i, key: "plug.styles.import" },
  { re: /url\(\s*['"]?\s*(?:https?:)?\/\//i, key: "plug.styles.remoteUrl" },
];

export function createStyleCore() {
  let sheets: StyleSheet[] = [];
  const listeners = new Set<() => void>();
  let versionValue = 0;

  const changed = () => {
    versionValue++;
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        /* 订阅者抛错不影响样式表 */
      }
    }
  };

  const mine = (source: string) => sheets.filter((s) => s.source === source);

  return {
    /** 插一张表。校验不过直接抛（不静默）—— 作者能从错误里看到边界在哪。 */
    insert(source: string, css: string, scope: StyleScope = "app"): Disposer {
      if (typeof css !== "string" || !css.trim()) throw new StyleSheetError(t("plug.styles.needCss"));
      if (!STYLE_SCOPES.includes(scope)) {
        throw new StyleSheetError(t("plug.styles.badScope", { scope: String(scope), available: STYLE_SCOPES.join(" / ") }));
      }
      for (const rule of FORBIDDEN_CSS) {
        if (rule.re.test(css)) throw new StyleSheetError(t(rule.key));
      }
      const existing = mine(source);
      if (existing.length >= MAX_SHEETS_PER_PLUGIN) {
        throw new StyleSheetError(
          t("plug.styles.tooMany", { max: MAX_SHEETS_PER_PLUGIN, given: existing.length + 1 }),
        );
      }
      const total = existing.reduce((n, s) => n + s.css.length, 0);
      if (total + css.length > MAX_STYLE_CHARS_PER_PLUGIN) {
        throw new StyleSheetError(
          t("plug.styles.tooLong", { max: MAX_STYLE_CHARS_PER_PLUGIN, chars: total + css.length }),
        );
      }
      const sheet: StyleSheet = { source, scope, css };
      sheets = [...sheets, sheet];
      changed();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        sheets = sheets.filter((s) => s !== sheet);
        changed();
      };
    },

    /** 撤掉自己插的全部表（别人的撤不掉） */
    clear(source: string): number {
      const before = sheets.length;
      sheets = sheets.filter((s) => s.source !== source);
      const removed = before - sheets.length;
      if (removed) changed();
      return removed;
    },

    /**
     * 某个位置叠加后的 CSS。source 顺序 = 插入顺序（后插的压先插的，与 CSS 直觉一致），
     * 每段前面留一行注释，出问题时在开发者工具里一眼看出是谁写的。
     */
    css(scope?: StyleScope): string {
      const parts = sheets
        .filter((s) => !scope || s.scope === scope)
        .map((s) => "/* " + s.source + " */\n" + s.css.trim());
      return parts.join("\n\n");
    },

    /** 诊断面板用：谁插了什么（css 只给前 80 字，免得把面板撑爆） */
    list(): { source: string; scope: StyleScope; chars: number; preview: string }[] {
      return sheets.map((s) => ({
        source: s.source,
        scope: s.scope,
        chars: s.css.length,
        preview: s.css.trim().slice(0, 80),
      }));
    },

    version: () => versionValue,
    onChange(fn: () => void): Disposer {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

export type StyleCore = ReturnType<typeof createStyleCore>;

/** 插件面（沙箱里 ctx.styles.* 落到宿主的就是这两个动作） */
export type StylesService = {
  insert(source: string, css: string, scope: StyleScope): Disposer;
  clear(source: string): number;
};
