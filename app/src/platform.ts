/**
 * 平台判定（P4 移动端）。
 *
 * 三件事要说清：
 *   1. **是不是手机版**：Android/iOS 的 WebView 里 `navigator.userAgent` 带 Android/iPhone，
 *      另外**窄视口也算**（分屏、平板、把桌面窗口拖窄都该进同一套布局）。
 *   2. **能不能用触摸**：有 `ontouchstart` 或有触摸点就用触摸手势；桌面仍然用滚轮/键盘。
 *   3. **能不能在桌面预览手机版**：`localStorage["aireader.mobilePreview"] = "1"`（或 URL 加
 *      `?mobile=1`）强制走手机布局 —— 不然每次改移动端样式都要装一次 APK 才能看，
 *      CDP 探针也没法在桌面上验证（实测这么干快得多）。
 */
import { useEffect, useState } from "react";

/** 手机布局的断点：<= 720px 当手机（iPad 竖屏 768 走桌面布局也还行） */
export const MOBILE_MAX_WIDTH = 720;

export type PlatformOverride = "auto" | "mobile" | "desktop";

const OVERRIDE_KEY = "aireader.mobilePreview";

export function getPlatformOverride(): PlatformOverride {
  if (typeof window === "undefined") return "auto";
  try {
    const q = new URLSearchParams(window.location.search).get("mobile");
    if (q === "1" || q === "true") return "mobile";
    if (q === "0" || q === "false") return "desktop";
    const v = window.localStorage.getItem(OVERRIDE_KEY);
    if (v === "1") return "mobile";
    if (v === "0") return "desktop";
  } catch {
    /* 隐私模式读不到 localStorage：按 auto 走 */
  }
  return "auto";
}

/** 真机（Android / iOS），不看视口大小 */
export function isAndroid(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android/i.test(navigator.userAgent);
}

export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && (navigator.maxTouchPoints ?? 0) > 1);
}

/** 移动端（真机 or 窄视口 or 手动强制） */
export function isMobile(): boolean {
  const override = getPlatformOverride();
  if (override === "mobile") return true;
  if (override === "desktop") return false;
  if (isAndroid() || isIOS()) return true;
  if (typeof window === "undefined") return false;
  return window.innerWidth <= MOBILE_MAX_WIDTH;
}

/** 有触摸就用触摸手势（桌面触屏笔记本也算） */
export function isTouch(): boolean {
  if (typeof window === "undefined") return false;
  return "ontouchstart" in window || (navigator.maxTouchPoints ?? 0) > 0;
}

/** 应用是否在前台可见 —— Android 会把后台的 WebView 挂起，
 *  用 visibilityState 判断比 hasFocus() 准（弹软键盘/系统对话框时 hasFocus 会假阴性）。 */
export function isForeground(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

/** React：视口变化/旋转会跟着更新 */
export function useMobile(): boolean {
  const [mobile, setMobile] = useState(() => isMobile());
  useEffect(() => {
    const update = () => setMobile(isMobile());
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  return mobile;
}
