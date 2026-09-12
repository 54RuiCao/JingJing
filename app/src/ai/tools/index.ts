/**
 * 工具集装配（P2.3）：把只读工具与动作工具注册进一个注册表，并按场景裁剪可见集。
 *
 * 对齐 DSH 的 `ctx.tools.restrict(filter)`：可见性是一条**纯函数裁决**，
 * 不在工具内部写 if（例如不在"没打开书"时把工具藏起来——那样模型连错误都拿不到）。
 * 我们只在两种场景下裁剪：书没打开时去掉写工具（避免模型把批注写到不存在的书上），
 * 以及"简要模式"（没装全书）时同样保留全部只读工具，因为检索与进度依然可用。
 */

import { ToolRegistry } from "./registry";
import { createReadingTools } from "./reading";
import { createActionTools } from "./actions";
import { createSkillTools, type SkillToolDeps } from "./skills";
import type { ToolHost } from "./host";
import type { ToolDefinition } from "./types";

export { ToolRegistry } from "./registry";
export type { ToolHost } from "./host";

export const ALL_TOOL_NAMES = [
  "get_toc",
  "get_chapter",
  "search_book",
  "get_selection",
  "get_reading_progress",
  "add_highlight",
  "add_note",
  "goto_location",
  "list_annotations",
  // P2.5：技能工具追加在最后 —— 顺序进前缀，追加是**一次性**前缀变更（§3.4）
  "load_skill",
  "create_skill",
  // P3.4：AI 写插件闭环（inspect / define / run / diagnose）
  "plugin_inspect",
  "plugin_define",
  "plugin_run",
  "plugin_diagnose",
] as const;

/** 只读工具（未打开书时也能调用：它们会回一个结构化的 NOT_AVAILABLE）
 *  技能工具与书无关，所以没打开书时同样可见。 */
export const READ_TOOL_NAMES = [
  "get_toc",
  "get_chapter",
  "search_book",
  "get_selection",
  "get_reading_progress",
  "list_annotations",
  "load_skill",
  "create_skill",
  // 写插件与书无关：没打开书时也该能做（"给阅读器加一块界面"不需要先打开一本书）
  "plugin_inspect",
  "plugin_define",
  "plugin_run",
  "plugin_diagnose",
];

/**
 * 装出一套工具。skillDeps 给了才注册技能工具 —— 契约测试与"没接技能"的场景因此不受影响，
 * 装出来的可见集也因此是确定的（前缀稳定）。
 */
export function createBookToolRegistry(host: ToolHost, skillDeps?: SkillToolDeps): ToolRegistry {
  const reg = new ToolRegistry();
  const defs = [
    ...createReadingTools(host),
    ...createActionTools(host),
    ...(skillDeps ? createSkillTools(skillDeps) : []),
  ] as ToolDefinition[];
  reg.registerAll(defs);
  // 写工具在"没有书"的场景下先拦在守卫层，理由写清楚（模型能看懂为什么被拒）
  reg.registerGuard(({ name }) => {
    if (!name.startsWith("add_") && name !== "goto_location") return null;
    if (host.bookId()) return null;
    return "当前没有打开书库里的书，写操作被拒绝（先让用户从书架打开一本书）";
  });
  return reg;
}

/** 按当前场景产出可见工具名（None 表示全部可见） */
export function scopeFor(host: ToolHost): string[] | null {
  return host.bookId() ? null : READ_TOOL_NAMES;
}
