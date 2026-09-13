/**
 * P2.2 请求组装：把 [system] + [全书] + [历史] + [问题] 拼成一次请求。
 *
 * 这是「成本差 50 倍」的地方（见 内部设计笔记 §2.1）：
 *   不变的在前面、变化的在最后 —— DeepSeek 的上下文硬盘缓存按**前缀**匹配，
 *   只要 system 与全书块逐字节不变，后面追加多少历史与新问题都仍然命中缓存。
 *
 * 因此：
 *   - system 提示词里不许出现书名、章节、时间等任何会变的内容；
 *   - 全书块取自 bookContext 的落盘缓存（不是每次现拼）；
 *   - 书名/作者这类「每本书固定」的信息放在全书块里，重复也没关系（它本来就是前缀的一部分）；
 *   - 当前阅读位置、用户问题放在最后一条 user 消息里（每次都变，但它在末尾）。
 *
 * 结构里插了一条固定的 assistant 回复（确认装载），有两个作用：
 *   1. 让 user/assistant 交替更自然；
 *   2. 顺带把「你看到的是这本书」这件事再说一遍，模型对长正文的注意力更稳。
 * 它必须逐字节稳定，所以只允许引用这本书的固定属性（书名、章数）。
 */

import type { ChatMessage } from "./provider";
import type { BookContextData } from "./bookContext";
import type { CatalogSnapshot } from "../skills/types";

/**
 * 插件分片（P3.4）：告诉模型"你能改这个阅读器本身，以及怎么改"。
 *
 * 位置与技能目录一样是**稳定前缀**的一部分：工具名与流程是常量，会变的东西
 *（当前有哪些槽位、哪些能力接了门面）一律让模型现查 plugin_inspect，绝不写进这里 ——
 * 一旦写进来，槽位变一次就要让全书前缀失效一次。
 */
export const PLUGIN_SHARD = [
  "插件：鲸鲸的界面与工具都是插件挂上去的，你也能写插件（宿主半注册工具/服务，UI 半往已声明的插槽里挂界面）。",
  "用户说「加一块界面」「让它显示…」「做个工具」「你能扩展自己吗」时，按这条流程走：",
  "load_skill(writing-plugins) 拿完整写法与示例 → plugin_inspect 查现场（槽位名、能力词表、ctx API、VDOM 白名单）→ plugin_define 定义包 → plugin_run 运行 → 失败就 plugin_diagnose 看源码再修。",
  "两条硬纪律：**不要凭空编造插件 API 与槽位名**（plugin_inspect 能查到全部）；**包不可变**（改代码要追加新版本，不要指望改旧包）。",
  "**第三条硬纪律：不许凭记忆复述流程。** 只要回答里说了「已定义 / 已运行 / 已挂上」，就必须真的调用过 plugin_define / plugin_run ——",
  "先把工具调用发出去、拿到结果，再说话。不确定现场就先 plugin_inspect 查一遍。",
  "（实测：长会话里模型会顺着历史写一段很像成功的描述，实际一个工具都没调；用户看到的是「什么都没发生」。）",
  "",
  "ctx 上**只有**下面这些（写错名字 = 插件 apply 直接失败；实测模型会凭空发明 ctx.vdom / ctx.services / ctx.log.info / res.text()）：",
  "· ctx.log(...) ／ ctx.provide('plugin.名字', 纯数据) ／ ctx.effect(同步函数)",
  "· ctx.reader.progress() chapters() chapter(n,offset,maxChars) selection() ／ await ctx.reader.search(q) annotations() activity() addAnnotation(..) gotoChapter(n)",
  "· await ctx.storage.get/set/remove/keys（插件自己的存储）",
  "· await ctx.net.fetch(url, { method?, headers?, body? }) → **直接给 { ok, status, url, contentType, text, truncated }**（不是 Response，别调 res.text()）；只能访问 manifest 的 network.origins 里声明且被授权的域名",
  "· ctx.slots.register({ slot, id, label }, function (props, ui) {…})：list/keyed 槽位**必须给 id**；render 必须**同步**返回声明式 JSON 节点 { type, props, children } —— 不是 React，**没有 h() / JSX / ctx.vdom**；事件写成 ui.handler(fn)，而 **ui 是 render 的第二个参数**（不是 ctx.ui，实测模型在这里连撞两轮）",
  "· ctx.slots.refresh() ／ ctx.theme.overrideTokens({ '--air-accent': '#c00' })",
  "上面是速查；**动手前仍要先 load_skill(writing-plugins)**（里面有完整示例与坑），槽位名/能力词表/白名单以 plugin_inspect 的现场为准。",
].join("\n");

/** 带全书正文时的系统提示（稳定，不含任何会变的内容） */
export const SYSTEM_FULL = [
  "你是鲸鲸的阅读助手。用户正在读一本书，全书正文已经按章节放在你面前。",
  "",
  "正文格式：每章以 <<CH n=12 title=\"章标题\" cfi=\"书内定位符\" chars=4200>> 开头，以 <<END>> 结尾；n 是章节号，chars 是该章字数。",
  "",
  "规则：",
  "1. 引用书中内容时在句末附上章节号，写成 [CH n]（例：……[CH 12]）。只引用书里真实存在的句子，不要编造情节或原文。",
  "2. 默认简洁：先给 3–5 句结论；用户明确要求「详细分析/展开讲讲」时再写长。",
  "3. 书中没有提到、或你不确定的，直接说明，不要用常识填补。",
  "4. 用户消息里可能带一行 [当前阅读位置：…]，那是他此刻正在看的地方；他说「这里」「这段」「这句话」时指的就是那里。",
  "5. 用**用户这一句话**的语言回答（他写中文就用中文）。历史里出现过别的语言，不代表这次也要用那种语言。",
  "",
  PLUGIN_SHARD,
].join("\n");

/** 没有装载全书时的系统提示（只有目录与元信息） */
export const SYSTEM_BRIEF = [
  "你是鲸鲸的阅读助手。你现在只能看到这本书的元信息与目录，看不到正文。",
  "",
  "规则：",
  "1. 你能可靠回答的是与目录结构、阅读位置、书籍概况有关的问题。",
  "2. 需要正文才能回答时，明确告诉用户「需要打开全书上下文」或让他把那段文字发给你，不要凭猜测作答。",
  "3. 用**用户这一句话**的语言回答（他写中文就用中文）：历史里出现过别的语言不代表这次也要用那种语言。",
  "4. 默认简洁（3–5 句）。",
  "",
  PLUGIN_SHARD,
].join("\n");

/**
 * 书库页的通用对话（P3.7 待办 B）：没有打开任何书。
 *
 * 为什么单开一段而不是复用 SYSTEM_BRIEF：BRIEF 写的是"你只能看到这本书的元信息与目录"，
 * 在书库里会让模型以为面前有一本书、进而拒答通用问题（实测前就该想清楚这一段）。
 * 与之相对，书库页最该强调的是**别编造用户书里的内容**，以及"打开书才有正文"。
 */
export const SYSTEM_GENERAL = [
  "你是鲸鲸（JingJing）—— 用户本机阅读器里的 AI 助手。现在是**书库页**：用户没有打开任何书，也没有正文。",
  "",
  "规则：",
  "1. 通用问题直接答：整理笔记、写作、翻译、解释概念、推荐读什么、帮他规划阅读都可以。",
  "2. 需要书里的内容时，明确请他先从书架打开那本书（打开后全书正文会自动装载）；**不要编造他书里的内容**。",
  "3. 书内工具（取章节 / 检索 / 批注 / 跳转）此刻没有书可用，会返回结构化错误，别反复重试。",
  "4. 用**用户这一句话**的语言回答（他写中文就用中文）：历史里出现过别的语言不代表这次也要用那种语言。",
  "5. 默认简洁（3–5 句）。",
  "",
  PLUGIN_SHARD,
].join("\n");

/** 会话历史最多带多少条（长上下文里历史只是尾部，成本很低，但仍要设上限） */
export const HISTORY_LIMIT = 20;

export type BookBrief = {
  title: string;
  author?: string;
  /** 当前章节标题 */
  chapter?: string;
  /**
   * 当前章节在**全书清单里的序号 n**（P5 实测加的）。
   * 合订本/套装里两卷章标题逐字节相同（实测《堂吉诃德：全2册》有 52 组同名章、
   * 两条候选相隔 30 万字符），只给标题时模型只能二选一 —— 用户看到的就是"问第一本答第二本"。
   * 这个 n 与正文标记 `<<CH n=…>>` 是同一口径，模型能直接对上。
   */
  chapterN?: number;

  /** 位置描述，如「位置 199」「第 3/25 页」 */
  location?: string;
  /** 全书目录（简要模式用） */
  toc?: string[];
};

const briefBlock = (b: BookBrief): string => {
  const head = "《" + (b.title || "未打开书籍") + "》" + (b.author ? " 作者：" + b.author : "");
  const toc = b.toc?.length
    ? "\n目录（共 " + b.toc.length + " 项" + (b.toc.length > 80 ? "，此处前 80 项" : "") + "）：\n" +
      b.toc.slice(0, 80).map((t, i) => i + 1 + ". " + t).join("\n")
    : "";
  return head + toc;
};

/** 全书块：data.text 就是带标记的正文（逐字节稳定），这里只加一句收尾说明 */
export function buildBookMessage(data: BookContextData, brief: BookBrief): ChatMessage {
  const tail = data.mode === "partial"
    ? "\n\n以上是《" + brief.title + "》的前 " + data.loadedChapters + " 章（全书共 " +
      data.chapters + " 章，因体量限制未全部收录）。"
    : "\n\n以上是《" + brief.title + "》的全部正文。";
  return { role: "user", content: data.text + tail };
}

/** 书库页那一条固定说明（逐字节稳定，不含任何会变的内容） */
const GENERAL_BRIEF = "（当前没有打开任何书籍：这是书库里的通用对话，我没有书里的正文。）";

/** 固定的装载确认（必须逐字节稳定，只引用这本书的固定属性） */
export function buildAckMessage(data: BookContextData | null, brief: BookBrief): ChatMessage {
  const content = !data && !brief.title
    ? "当前没有打开书，问什么都行；要谈某本书就先从书架把它打开。"
    : data
    ? "已装载《" + brief.title + "》" +
      (data.mode === "partial"
        ? "的前 " + data.loadedChapters + " 章（共 " + data.chapters + " 章）。"
        : "全文，共 " + data.chapters + " 章。") +
      "你问吧。"
    : "暂时没有装载《" + brief.title + "》的正文，我只能依据目录与元信息回答。";
  return { role: "assistant", content };
}

/**
 * 技能目录（P2.5）：**稳定前缀的第四段**，位置在全书块与装载确认之后、历史之前。
 *
 * 为什么不能进 system（内部设计笔记 §6.1）：system 与全书块必须逐字节稳定，
 * 而目录会随用户装/删技能而变 —— 一旦进 system，每次技能变更都会让 20 万 token 的
 * 全书前缀失效，输入价差 50 倍。放在全书块之后，代价只有「目录 → 结尾」这一小段。
 *
 * 目录是**派生前缀**，不写进 ai_messages 表（§5.3）：历史只带最后 HISTORY_LIMIT 条，
 * 存成历史消息的话 20 轮后会被裁掉、技能无声消失；而每轮现算的内容是确定性的
 * （技能集不变 → 逐字节相同），所以它仍然是可缓存前缀。
 *
 * 排序用**名字代码序**（对齐 DSH），永不用「最近使用」——否则每用一次技能就打乱前缀。
 * 描述里不许出现书名/章节/进度/时间（§6.3）：digest 只由 [name, description] 决定，
 * 会变的内容会让每一轮都追加一条替换目录。
 */
export function buildSkillCatalogMessage(catalog: CatalogSnapshot): ChatMessage {
  const lines = catalog.entries.map((e) => "- \`" + e.name + "\`: " + e.description);
  return {
    role: "user",
    content: [
      "<system-reminder>",
      "技能（skill）是一组可复用的任务指令。本会话可用的技能如下：",
      "",
      "<available_skills>",
      ...lines,
      "</available_skills>",
      "",
      "当用户点名某个技能，或当前任务明显匹配某个技能的描述时，先用 load_skill 工具按**准确名字**加载它，再动手。",
      "可以一次加载多个相关技能；加载后按它的完整指令执行。",
      "这份目录只有概要：**在加载之前不要猜测或执行技能的指令**。",
      "用户也可能直接输入 /名字 调用技能；那种情况下技能正文会作为一条消息出现在对话里，照着做即可，不要再调 load_skill。",
      "</system-reminder>",
    ].join("\n"),
  };
}

/**
 * 目录变更：全量替换（对齐 DSH renderCatalogUpdate）。
 * 技能被删除 = 从替换目录里消失 + 那句话「别用旧名字」。
 */
export function buildSkillCatalogUpdateMessage(catalog: CatalogSnapshot): ChatMessage {
  const lines = catalog.entries.map((e) => "- \`" + e.name + "\`: " + e.description);
  const head = "可用的技能目录变了。下面这份**完整目录替换**本会话此前出现过的所有技能列表：";
  const body = catalog.entries.length
    ? lines
    : ["（当前没有任何可用技能。不要再使用此前技能目录里的名字。）"];
  return {
    role: "user",
    content: [
      "<system-reminder>",
      head,
      "",
      "<available_skills>",
      ...body,
      "</available_skills>",
      "",
      "用法不变：任务匹配某个技能时先用 load_skill 按准确名字加载。",
      "</system-reminder>",
    ].join("\n"),
  };
}

/** 用户 /name 直呼：注入的就是技能正文（位置：历史之后、当前问题之前） */
export function buildSkillInvocationMessage(name: string, rendered: string): ChatMessage {
  return { role: "user", content: "（用户直接调用了技能 " + name + "）\n\n" + rendered };
}

/** 最后一条：当前阅读位置（可变）+ 用户问题（可变） */
export function buildQuestionMessage(question: string, brief: BookBrief): ChatMessage {
  const where = brief.chapter
    ? brief.chapterN
      ? "第 " + brief.chapterN + " 章（n=" + brief.chapterN + "）" + brief.chapter
      : brief.chapter
    : null;
  const at = [where, brief.location].filter(Boolean).join(" · ");
  const hint = brief.chapterN ? "（n= 就是正文标记里的 n，用它对齐章节）" : "";
  return { role: "user", content: (at ? "[当前阅读位置：" + at + "]" + hint + "\n\n" : "") + question };
}

export function buildRequestMessages(opts: {
  /** 全书上下文；null 表示未装载（简要模式） */
  data: BookContextData | null;
  brief: BookBrief;
  /** 已有会话（按时间正序，含本轮刚写入的用户消息） */
  history: ChatMessage[];
  question: string;
  /**
   * 技能目录（P2.5）。null/缺省 = 不注入（没装技能，或用户关掉了技能）。
   * **只在技能集变化时用 update 形态**：首次注入用目录，之后同一个 digest 就什么都不发。
   */
  catalog?: { snapshot: CatalogSnapshot; isUpdate: boolean } | null;
  /** 用户 /name 直呼注入的技能正文（位置：历史之后、问题之前） */
  skillMessages?: ChatMessage[];
}): ChatMessage[] {
  const { data, brief, history, question, catalog, skillMessages } = opts;
  // 书库页（连书名都没有）走第三套提示：那不是"简要模式"，而是"根本没有书"
  const general = !data && !brief.title;
  const system: ChatMessage = {
    role: "system",
    content: data ? SYSTEM_FULL : general ? SYSTEM_GENERAL : SYSTEM_BRIEF,
  };
  const book: ChatMessage = data
    ? buildBookMessage(data, brief)
    : { role: "user", content: general ? GENERAL_BRIEF : briefBlock(brief) };
  const catalogMsg: ChatMessage[] =
    catalog && catalog.snapshot.entries.length
      ? [
          catalog.isUpdate
            ? buildSkillCatalogUpdateMessage(catalog.snapshot)
            : buildSkillCatalogMessage(catalog.snapshot),
        ]
      : [];
  return [
    system,
    book,
    buildAckMessage(data, brief),
    ...catalogMsg,
    ...history.slice(-HISTORY_LIMIT),
    ...(skillMessages ?? []),
    buildQuestionMessage(question, brief),
  ];
}
