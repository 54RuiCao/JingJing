/**
 * 规范化的 <skill_content> 渲染（P2.5）。形态**逐字**照 DSH（内部设计笔记 §2.5）：
 *
 *   <skill_content name="…">
 *   <skill_resources>
 *   …资源指引…
 *   </skill_resources>
 *
 *   <skill_instructions>
 *   …正文原样…
 *   </skill_instructions>
 *   </skill_content>
 *
 * 转义的不对称也是照抄的：名字走属性转义（& " <），资源文本走文本转义（& < >），
 * **正文原样嵌入不转义**（DSH 注释：skills are trusted local content）。
 *
 * 但我们比 DSH 多一道防线：正文里如果出现 </skill_instructions> / </skill_content>，
 * 会被中和掉 —— 这两个技能可能来自用户目录甚至由 AI 生成，正文里的这几个字能把
 * 我们精心划出的边界提前闭合。DSH 不处理是因为它的技能只来自可信的本地/随包目录。
 */

import type { SkillDefinition } from "./types";

export function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 把正文里的结束标签中和掉（\`<\/skill_instructions>\` 在 HTML 里等价、在文本里无害） */
export function neutralizeBlockMarkers(body: string): string {
  return body
    .replace(/<\/skill_instructions\s*>/gi, "<\\/skill_instructions>")
    .replace(/<\/skill_content\s*>/gi, "<\\/skill_content>");
}

/** 资源指引：四种形态裁成两种（目录 / 不透明），并给出可读的相对路径清单 */
export function resourceGuidance(def: SkillDefinition, resources: string[] = []): string {
  const base = def.resourceBase;
  if (!base || base.kind === "opaque") {
    return base?.kind === "opaque" ? base.description : "（无附带资源）";
  }
  const lines = [
    "Base directory for this skill: " + base.path,
    "Resolve relative paths mentioned by this skill against the base directory before using them.",
  ];
  if (resources.length) {
    lines.push("可用资源（用 load_skill 的 file 参数取相对路径）：" + resources.join("、"));
  }
  return lines.join("\n");
}

export function renderSkillContent(def: SkillDefinition, resources: string[] = def.resources ?? []): string {
  return [
    '<skill_content name="' + escapeAttr(def.name) + '">',
    "<skill_resources>",
    resourceGuidance(def, resources),
    "</skill_resources>",
    "",
    "<skill_instructions>",
    neutralizeBlockMarkers(def.content),
    "</skill_instructions>",
    "</skill_content>",
  ].join("\n");
}
