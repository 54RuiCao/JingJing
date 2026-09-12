/**
 * 主题 token 覆盖（P3.6）：让插件在不改产品代码的前提下调整配色。
 *
 * 照 DSH 的做法（内部设计笔记 §3.4）：插件调
 * `ctx.theme.overrideTokens(source, tokens)`，宿主把**各层叠加后的结果**写进
 * documentElement 的 CSS 变量；返回的 disposer 自动挂在调用者的 fiber 上，
 * source 由宿主强制成插件 id（防冒充、防驱逐别人的层）。
 *
 * 三条刻意的限制（都是"API 纪律"的一部分）：
 *   1. **只能覆盖已知的 `--air-*` token**（想加新变量要先在产品里定义它）——
 *      打错一个字就静默无效，是最难查的一类问题，所以这里直接抛错并列出可用 token；
 *   2. 单层 token 数 ≤ 32、值长度 ≤ 64：主题是**点缀**，不是让插件塞一坨样式表；
 *   3. 不提供"删除别人的层"——只能覆盖，且**后注册的层压先注册的**（与 CSS 层叠直觉一致）。
 */

import { t } from "../../i18n";
import type { Disposer } from "../../core/service/types";
import type { ThemeId } from "../../reader/themes";

/** 允许覆盖的 token（来自 reader/themes.ts，与 applyAppTheme 写的是同一批） */
export const THEME_TOKENS = [
  "--air-bg",
  "--air-panel",
  "--air-text",
  "--air-sub",
  "--air-border",
  "--air-hover",
  "--air-accent",
  "--air-cover-from",
  "--air-cover-to",
] as const;

export type ThemeTokenName = (typeof THEME_TOKENS)[number];

/** 一个 token 的值：给字符串 = 所有主题都用它；给对象 = 按主题分别给 */
export type ThemeTokenValue = string | Partial<Record<ThemeId, string>>;

export type ThemeOverrideLayer = {
  source: string;
  tokens: Partial<Record<ThemeTokenName, ThemeTokenValue>>;
};

export class ThemeOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThemeOverrideError";
  }
}

const MAX_TOKENS = 32;
const MAX_VALUE_CHARS = 64;

export function createThemeOverrideCore() {
  let layers: ThemeOverrideLayer[] = [];
  const listeners = new Set<() => void>();
  let versionValue = 0;

  const changed = () => {
    versionValue++;
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        /* 订阅者抛错不影响主题 */
      }
    }
  };

  return {
    /**
     * 加一层覆盖。校验不过直接抛（不静默）——插件作者能从错误里看到可用 token 与限制。
     */
    override(source: string, tokens: Record<string, ThemeTokenValue>): Disposer {
      const clean: Partial<Record<ThemeTokenName, ThemeTokenValue>> = {};
      const entries = Object.entries(tokens ?? {});
      if (!entries.length) throw new ThemeOverrideError(t("plug.theme.needOneToken"));
      if (entries.length > MAX_TOKENS) {
        throw new ThemeOverrideError(t("plug.theme.tooManyTokens", { max: MAX_TOKENS, given: entries.length }));
      }
      for (const [name, value] of entries) {
        if (!(THEME_TOKENS as readonly string[]).includes(name)) {
          throw new ThemeOverrideError(
            t("plug.theme.unknownToken", { name, available: THEME_TOKENS.join(" / ") }),
          );
        }
        const values = typeof value === "string" ? [value] : Object.values(value ?? {});
        if (!values.length) throw new ThemeOverrideError(t("plug.theme.emptyValue", { name }));
        for (const v of values) {
          if (typeof v !== "string" || !v.trim()) {
            throw new ThemeOverrideError(t("plug.theme.valueNotString", { name }));
          }
          if (v.length > MAX_VALUE_CHARS) {
            throw new ThemeOverrideError(t("plug.theme.valueTooLong", { name, max: MAX_VALUE_CHARS }));
          }
        }
        clean[name as ThemeTokenName] = value;
      }
      const layer: ThemeOverrideLayer = { source, tokens: clean };
      layers = [...layers, layer];
      changed();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        layers = layers.filter((l) => l !== layer);
        changed();
      };
    },

    /** 叠加后的结果：后注册的层压先注册的；没给某个主题的值就跳过这一项 */
    resolve(themeId: ThemeId): Record<string, string> {
      const out: Record<string, string> = {};
      for (const layer of layers) {
        for (const [name, value] of Object.entries(layer.tokens)) {
          if (typeof value === "string") out[name] = value;
          else if (value && typeof value === "object") {
            const v = (value as Partial<Record<ThemeId, string>>)[themeId];
            if (typeof v === "string") out[name] = v;
          }
        }
      }
      return out;
    },

    /** 诊断/设置面板用：谁盖了什么 */
    list(): ThemeOverrideLayer[] {
      return layers.map((l) => ({ source: l.source, tokens: { ...l.tokens } }));
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

export type ThemeOverrideCore = ReturnType<typeof createThemeOverrideCore>;
