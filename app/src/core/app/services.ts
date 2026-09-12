/**
 * 应用向插件暴露的**服务契约**（P3.0 起就在用，P3.1 拆到这里是为了避免
 * runtime.ts 与 builtinPlugins.ts 互相 import）。
 *
 * 插件只认这几个接口，不认识 foliate-js、SQLite、React —— 与工具层的 ToolHost 同一个思路：
 * 能力缝越窄，插件能造成的意外越小，也越容易在 node 里做契约测试。
 */

import type { Annotation, AnnotationKind } from "../../store/db";
import type { Disposer } from "../service/types";
import type { ThemeId } from "../../reader/themes";

/** 数据层门面：只暴露插件真正需要的那几个动作（不是把 db.ts 整个搬进来） */
export type DbService = {
  listAnnotations(bookId: string): Promise<Annotation[]>;
  addAnnotation(a: {
    bookId: string;
    kind: AnnotationKind;
    cfi: string;
    text?: string;
    note?: string;
    color?: string;
  }): Promise<Annotation>;
  searchBook(bookId: string, query: string, limit?: number): Promise<{ sectionIndex: number; snippet: string }[]>;
  getSetting<T>(key: string, fallback: T): Promise<T>;
  setSetting(key: string, value: unknown): Promise<void>;
};

export type ThemeService = {
  current(): ThemeId;
  set(id: ThemeId): void;
  list(): ThemeId[];
  /**
   * 覆盖主题 token（P3.6）：返回的 disposer 由宿主挂到**调用者自己的 fiber** 上，
   * source 也会被强制成插件 id（不能冒充别人的层）。只能覆盖 THEME_TOKENS 里那几个。
   */
  overrideTokens?(source: string, tokens: Record<string, string | Partial<Record<ThemeId, string>>>): Disposer;
};

/** 当前 AI 配置的只读快照（由 ChatPanel 汇报；插件不该自己去读 settings 表） */
export type AiInfo = {
  provider: string;
  model: string;
  baseUrl: string;
  hasKey: boolean;
  thinking: boolean;
};

export type AiService = {
  current(): AiInfo | null;
  set(info: AiInfo): void;
};

export type PathsService = {
  skillsDir(): string;
  pluginsDir(): string;
};

/**
 * 阅读活动（P3.7）：每天读了多少秒、翻了多少页。
 *
 * 宿主采集（它才知道路由/焦点/空闲），插件只读 —— 动态包连定时器都没有，
 * 让它自己测时长既不现实也不准。返回的是 summarizeActivity 那份快照。
 */
export type ReadingActivityService = {
  snapshot(): Promise<import("../../reader/readingActivity").ActivitySnapshot>;
};

/**
 * 宿主自己的 AI 凭据（P3.11）。
 *
 * **只在宿主侧使用**：net 门面拿它在请求上代填一个 Authorization 头。
 * 它**不进沙箱**（插件拿不到 Key 本身，也就没法把它带走），也不出现在 plugin_inspect 的输出里。
 */
export type AiCredentials = {
  /** 当前配置的 AI 服务 origin（如 https://api.deepseek.com） */
  origin: string;
  /** 有没有配 Key（没配就没法代填，只能如实告诉插件） */
  hasKey: boolean;
  /** 宿主内部用的请求头值（"Bearer sk-…"）；没有 Key 时为 null */
  authorization: string | null;
};

export type AiCredentialService = {
  current(): AiCredentials | null;
};

/** 阅读统计服务（内置插件提供的样板：别人可以 inject 它，卸载时依赖方自动 park） */
export type ReadingStatsService = {
  /** 一句话状态，例如「已读 42.0% · 共 25 章」 */
  summary(): string;
  chapters(): number;
  fraction(): number;
};
