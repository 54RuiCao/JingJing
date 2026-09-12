/**
 * i18n 运行时（不依赖 React，core / 插件层也能直接用）。
 *
 * 用法：
 *   - React 组件里：`const t = useT();` 然后 t("app.openFile")；
 *   - 普通模块里：`import { t } from "../i18n";` 直接调用；
 *   - 语言：`setLangPref("auto" | "zh" | "en")`，持久化由 App 负责（settings 键 ui.language）。
 *
 * "auto" 在模块加载时就按 navigator.language 定下来，所以英文系统首帧就是英文，
 * 不会先闪一下中文；用户显式选过语言的话，App 读到设置后再覆盖（几十毫秒）。
 */
import { isAndroid, isIOS } from "../platform";
import { messages, type MessageKey } from "./messages";
import type { Lang, LangPref, Params } from "./types";

export type { Lang, LangPref, MessageKey, Params };

/**
 * 标签 → 语言：中文系（zh / zh-CN / zh-Hant / zh-HK…）给中文，其它给英文
 * （德语系统给英文比给中文更合理），**拿不到系统语言时默认中文**（这是中文软件）。
 */
export function langFromTag(tag: string | undefined | null): Lang {
  if (!tag) return "zh";
  return tag.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function systemLang(): Lang {
  if (typeof navigator === "undefined") return "zh";
  return langFromTag(navigator.language || (navigator.languages && navigator.languages[0]));
}

let pref: LangPref = "auto";
let lang: Lang = systemLang();
const listeners = new Set<() => void>();

export function resolveLang(p: LangPref): Lang {
  return p === "auto" ? systemLang() : p;
}

export function getLangPref(): LangPref {
  return pref;
}

export function getLang(): Lang {
  return lang;
}

/** 订阅语言变化（React 用 useSyncExternalStore，非 React 可直接 subscribe） */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 切语言。pref 是"跟随系统"时按当前系统语言重算。 */
export function setLangPref(next: LangPref): void {
  pref = next;
  const resolved = resolveLang(next);
  lang = resolved;
  applyDocLang();
  for (const fn of [...listeners]) fn();
}

/** App 启动时把数据库里的 ui.language 灌进来 */
export function initI18n(p: LangPref): void {
  setLangPref(p);
}

/** `{name}` 占位符替换；没给参数就原样留着，方便一眼看出漏传 */
export function format(template: string, params: Params): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in params ? String(params[key]) : whole,
  );
}

/** 取词：当前语言缺这条就退回中文，再缺就退回 key 本身（不静默吞掉） */
export function t(key: MessageKey, params?: Params): string {
  const table = messages[lang] as Partial<Record<MessageKey, string>>;
  const text = table[key] ?? messages.zh[key] ?? key;
  return params ? format(text, params) : text;
}

/** 同步 <html lang>、网页标题和窗口标题（英文系统上任务栏不该写"鲸鲸"） */
export function applyDocLang(): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  const name = t("app.name");
  document.title = name;
  void setWindowTitle(name);
}

async function setWindowTitle(title: string): Promise<void> {
  // 手机（Android / iOS）没有"窗口标题"这个概念，调了也是抛错
  if (isAndroid() || isIOS()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(title);
  } catch {
    // 浏览器里跑（vite dev、契约测试）没有 Tauri，忽略
  }
}
