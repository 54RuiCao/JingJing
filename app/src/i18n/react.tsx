/**
 * React 侧的取词入口。
 *
 * 用 useSyncExternalStore 订阅语言：切语言时所有用到 useT() 的组件自动重渲染，
 * 不需要各自去监听 aireader:reload-settings。
 */
import { useSyncExternalStore } from "react";
import { getLang, subscribe, t } from ".";
import type { Lang } from "./types";

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

/** 组件里 `const t = useT()`，之后 t("key", { n }) 与全局 t 一模一样 */
export function useT(): typeof t {
  useLang();
  return t;
}
