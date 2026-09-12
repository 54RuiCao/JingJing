/** reader 区域的界面文案。key 用 `reader.` 前缀。 */
const zh = {
  "reader.pluginName": "阅读状态条（尾部）",
  "reader.pluginPurpose": "在阅读区尾部显示当前章节、位置、百分比与上下文装载情况，并提供回开头动作。",
  "reader.slotLabel": "阅读状态条",
  "reader.tailProvidedBy": "由 {id} 插件提供",
  "reader.noChapter": "（未定位到章节）",
  "reader.contextLoaded": "上下文：{loaded}/{total} 章",
  "reader.noContext": "未装载全书上下文",
  "reader.goToStart": "跳到本书开头",
  "reader.backToStart": "回开头",
  "reader.themeLight": "日间",
  "reader.themeSepia": "护眼",
  "reader.themeDark": "夜间",
  "reader.bodyChapter": "正文",
  "reader.tocTitle": "目录",
} as const;

const en: Record<keyof typeof zh, string> = {
  "reader.pluginName": "Reading Status Bar (Tail)",
  "reader.pluginPurpose":
    "Shows the current chapter, position, percentage and context loading state at the end of the reading area, and offers a back-to-start action.",
  "reader.slotLabel": "Reading Status Bar",
  "reader.tailProvidedBy": "Provided by plugin {id}",
  "reader.noChapter": "(No chapter located)",
  "reader.contextLoaded": "Context chapters: {loaded}/{total}",
  "reader.noContext": "Full-book context not loaded",
  "reader.goToStart": "Jump to the start of this book",
  "reader.backToStart": "Back to start",
  "reader.themeLight": "Day",
  "reader.themeSepia": "Sepia",
  "reader.themeDark": "Night",
  "reader.bodyChapter": "Text",
  "reader.tocTitle": "Contents",
};

export const readerPart = { zh, en };
