/**
 * 界面文案总表（zh / en）。
 *
 * 每个 part 文件自己管一个区域（App、对话、书库、阅读器、插件、VDOM、core），
 * 这样多人/多轮改文案不会互相冲突。part 的形状固定为：
 *
 *   const zh = { "area.key": "中文" } as const;
 *   const en: Record<keyof typeof zh, string> = { "area.key": "English" };
 *   export const areaPart = { zh, en };
 *
 * 于是 **少写一条英文 = 类型报错**（Record<keyof typeof zh, string>），
 * 而 key 是字面量类型，t() 传错 key 也会被 tsc 拦下。
 */
import { appPart } from "./parts/app";
import { chatPart } from "./parts/chat";
import { corePart } from "./parts/core";
import { libraryPart } from "./parts/library";
import { pluginsPart } from "./parts/plugins";
import { readerPart } from "./parts/reader";
import { vdomPart } from "./parts/vdom";

const zh = {
  ...appPart.zh,
  ...chatPart.zh,
  ...libraryPart.zh,
  ...readerPart.zh,
  ...pluginsPart.zh,
  ...vdomPart.zh,
  ...corePart.zh,
} as const;

const en: Record<keyof typeof zh, string> = {
  ...appPart.en,
  ...chatPart.en,
  ...libraryPart.en,
  ...readerPart.en,
  ...pluginsPart.en,
  ...vdomPart.en,
  ...corePart.en,
};

export type MessageKey = keyof typeof zh;
export type Catalog = Record<MessageKey, string>;

export const messages: Record<"zh" | "en", Catalog> = { zh, en };
