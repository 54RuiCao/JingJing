/**
 * 内置技能（P2.5）。形态照 dsh-skill-badge：**提供方自持常量**，不落盘、不读文件。
 *
 * 为什么不做成"随包的 skills/ 目录"：内置技能是产品的一部分，跟着代码走版本最省事
 * （没有资源路径解析、没有打包白名单、没有"目录丢了技能静默消失"这一类问题）。
 * 用户自己的技能走 %APPDATA%/aireader/skills（见 loader.ts），rank 更低所以能覆盖内置同名技能。
 *
 * 三条编写纪律（照 DSH 的 SKILL.md 抄的）：
 *   1. 描述是**路由用**的常量字符串：书无关、会话无关、时间无关（digest 只算 name+description）；
 *   2. 正文里点名工具是**提示词层引导**，不是机制 —— 真要限制某个技能下的工具，改的是
 *      ai/tools/index.ts 的 scopeFor，不是这里的文字；
 *   3. 正文不写"你是…"这类人格设定（那是 system 提示词的事），只写这件事**怎么做**。
 */

import { SKILL_RANK, type SkillDefinition, type SkillProvider, type SkillSummary } from "./types";
import { WRITING_PLUGINS_SKILL } from "./builtinWritingPlugins";

type BuiltinSkill = {
  name: string;
  description: string;
  whenToUse?: string;
  body: string;
};

const BUILTIN: BuiltinSkill[] = [
  // P3.4：写插件的做法（体型最大的一份 —— 它按需加载，不进 system 前缀）
  WRITING_PLUGINS_SKILL,
  {
    name: "close-reading",
    description:
      "逐句精读一段文字：拆句子、点出修辞与语气，并引用原文。用户说「精读」「逐句讲讲」「这段话什么意思」时使用。",
    whenToUse: "用户选中或指出具体段落，要求逐句解释时",
    body: [
      "# 逐句精读",
      "",
      "目标：让用户看懂**这一段为什么这样写**，而不是复述内容。",
      "",
      "步骤：",
      "1. 先用一句话说这段在整章里的位置与作用（承接了什么、铺垫了什么）。",
      "2. 按句群拆开（不是每句都拆，按语义分组），每组给出：",
      "   - 原句（用引号原样引用，句末附 [CH n]）；",
      "   - 它在说什么（直白白话，不超过两句）；",
      "   - 值得注意的地方：用词、句式、节奏、视角、留白，任选其一，不要面面俱到。",
      "3. 最后给一段整体判断：这段话的写法服务于什么效果。",
      "",
      "纪律：",
      "- 只引用书里真实存在的句子；不确定就说不确定。",
      "- 不要用文学理论术语堆砌（「互文性」「能指」这类），除非用户自己用了。",
      "- 用户没指出段落时，用 get_selection 拿当前选区；没有选区就用 get_reading_progress 定位当前章节，",
      "  再用 get_chapter 取那一章的开头，并说明你精读的是哪一段。",
      "",
      "篇幅：默认 400–600 字；用户要「详细」时再展开。",
    ].join("\n"),
  },
  {
    name: "chapter-summary",
    description:
      "总结一章或连续几章的内容：事件、人物、关键转折，并保留章节号。用户说「这章讲了什么」「帮我理一下前三章」时使用。",
    whenToUse: "用户要求概括章节内容或推进脉络时",
    body: [
      "# 章节摘要",
      "",
      "步骤：",
      "1. 用 get_toc 确认章节标题与范围；不确定用户指哪一章时，用 get_reading_progress 定位当前章节。",
      "2. 正文已在上下文时直接读；没在上下文（简要模式）时用 get_chapter 取，每次不超过一章。",
      "3. 每章输出三段式：",
      "   - **发生了什么**：按时间顺序 3–5 句。",
      "   - **谁在推动**：本章的关键人物/视角，各一句。",
      "   - **埋了什么**：新出现的悬念、伏笔、概念（没有就写「无」）。",
      "4. 多章一起总结时，最后补一段「跨章主线」：这几章合起来推进了什么。",
      "",
      "纪律：",
      "- 每处具体事实后附 [CH n]。",
      "- 不评价好坏，不做「本书告诉我们」式的升华，除非用户要求。",
      "- 章数多（>5）时先摘要最后两章，再问用户要不要补前面的。",
    ].join("\n"),
  },
  {
    name: "character-map",
    description:
      "梳理书中人物关系：身份、立场、彼此关系与变化，并用列表或层级关系呈现。适合小说、传记、历史类读物。用户问「这几个人什么关系」时使用。",
    whenToUse: "用户询问人物关系、身份或阵营时",
    body: [
      "# 人物关系梳理",
      "",
      "步骤：",
      "1. 用 get_toc 了解结构；用 search_book 按人名检索，确认每个人物**实际出场**的位置。",
      "   人名不确定时先问用户，不要猜。",
      "2. 对每个人物输出：",
      "   - 身份（书里给的说法，不是你推断的）；",
      "   - 首次出场与关键场景（附 [CH n]）；",
      "   - 与其他人物的关系（谁对谁做了什么，方向不要搞反）。",
      "3. 用一段缩进的层级列表画出关系网（谁在谁之下、谁与谁对立）。",
      "4. 单独列「未解 / 有歧义」：书里前后说法不一致的地方，如实说明。",
      "",
      "纪律：",
      "- 不要用同名人物合并成一个人；发现同名先确认。",
      "- 不补充书外的历史背景，除非用户要求。",
      "- 超过 10 个人物时，只画主线人物，其余折叠成一句「另有…」。",
    ].join("\n"),
  },
  {
    name: "quote-collect",
    description:
      "把书里的句子摘录成批注：挑选、去重、写入划线或笔记。用户说「帮我摘出金句」「把这段记下来」时使用。",
    whenToUse: "用户要求把原文摘录进批注时",
    body: [
      "# 摘录成批注",
      "",
      "**这是本技能里唯一会写数据的动作，动手前必须先确认。**",
      "",
      "步骤：",
      "1. 先只**列出候选**：每条给出原文（可截断到关键一句）+ [CH n] + 一句挑选理由。",
      "2. 问用户：「这几条都写进去，还是只留哪几条？」",
      "3. 用户确认后，逐条调用 add_highlight（要一句话点评时用 add_note）。",
      "   - add_highlight 的 cfi 必须来自 get_chapter 或 get_selection 给出的真实定位，不要手写。",
      "   - text 传原文本身；note 传点评，不要混在一起。",
      "4. 写完回报：写了几条、在哪几章；再调 list_annotations 核对一次。",
      "",
      "纪律：",
      "- **未经确认绝不写库**。",
      "- 同一句不要重复写；写入前用 list_annotations 查重。",
      "- 一次最多 8 条；用户要更多时分批做。",
    ].join("\n"),
  },
  {
    name: "reading-review",
    description:
      "复盘这本书的阅读过程：进度、已划的线与笔记、读到哪里卡住。用户说「我读到哪了」「回顾一下我的批注」时使用。",
    whenToUse: "用户询问自己的进度或批注时",
    body: [
      "# 阅读复盘",
      "",
      "步骤：",
      "1. get_reading_progress 取当前位置与百分比；get_toc 取总章数。",
      "2. list_annotations 取全部批注，按章节归类。",
      "3. 输出：",
      "   - 进度：读到第几章 / 共几章，百分比；",
      "   - 批注分布：哪几章划得多（说明注意力在哪），哪几章一条都没有；",
      "   - 从批注内容里提炼 2–3 句「你关心的是什么」；",
      "   - 如果用户还没读完：给出下一步的**具体**建议（例如「接着读第 12 章，那章回到主线」）。",
      "4. 用户没读过或批注为空时，如实说明，不要编。",
      "",
      "纪律：",
      "- 只统计真实数据，不做心理分析式的过度解读。",
      "- 用户要「帮我继续读」时，用 get_chapter 取下一章并先给一段导读，再问是否继续。",
    ].join("\n"),
  },
  {
    name: "socratic-reading",
    description:
      "用提问代替讲解：围绕当前这一段连续追问，引导用户自己得出结论。用户说「别直接告诉我」「带我思考一下」时使用。",
    whenToUse: "用户希望被引导而不是被讲解时",
    body: [
      "# 苏格拉底式共读",
      "",
      "步骤：",
      "1. 先用 get_selection（或 get_reading_progress + get_chapter）锁定讨论范围，复述一句「我们讨论的是这段」。",
      "2. **一次只问一个问题**，问题要能回答「是/不是」以外的东西：",
      "   - 先问事实层：这里发生了什么？谁在说话？",
      "   - 再问动机层：他为什么这样做？书里给了理由吗？",
      "   - 最后问判断层：你同意吗？换成你会怎么做？",
      "3. 用户回答后：先承认他答对的部分，指出与原文不符的部分（附 [CH n]），再问下一个。",
      "4. 用户明确说「直接告诉我答案」时立刻给出结论，不要继续追问。",
      "",
      "纪律：",
      "- 不一次抛三个问题。",
      "- 不把用户的答案当错误答案纠正，只标出与原文的出入。",
      "- 连续 3 轮没有进展就改为直接讲解。",
    ].join("\n"),
  },
];

/** 内置技能提供方：list 只回概要，get 回完整定义（正文是常量，天然稳定） */
export function createBuiltinSkillProvider(): SkillProvider {
  const byName = new Map(BUILTIN.map((s) => [s.name, s]));
  const summaryOf = (s: BuiltinSkill): SkillSummary => ({
    name: s.name,
    description: s.description,
    whenToUse: s.whenToUse,
    invocation: { modelInvocable: true, userInvocable: true },
    source: "builtin",
    provider: "builtin",
  });
  return {
    id: "builtin",
    rank: SKILL_RANK.builtin,
    list: () => BUILTIN.map(summaryOf),
    get: (name) => {
      const s = byName.get(name);
      if (!s) return undefined;
      const def: SkillDefinition = {
        ...summaryOf(s),
        content: s.body,
        resourceBase: { kind: "opaque", description: "内置技能：正文即全部内容，没有附带资源文件" },
      };
      return def;
    },
  };
}

/** 内置技能名清单（契约测试与设置界面用） */
export const BUILTIN_SKILL_NAMES = BUILTIN.map((s) => s.name);
