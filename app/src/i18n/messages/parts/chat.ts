/** chat 区域的界面文案。key 用 `chat.` 前缀。 */
const zh = {
  // 消息正文里的引用锚点
  "chat.jumpToChapter": "跳回第 {n} 章",

  // 状态行与报错
  "chat.skillScanFailed": "技能目录扫描失败：{err}",
  "chat.apiKeyRequired": "请先填写 API Key",
  "chat.unknownSkill": "没有名为 {names} 的技能（本轮按普通消息发送）",
  "chat.skillCatalogUpdated": "技能目录已更新：现有 {n} 个技能，从本轮起生效（此后的缓存前缀会重算）",
  "chat.confirmClearConversation": "清空这段对话的全部消息？已装载的正文不受影响。",
  "chat.deleteSkillFailed": "删除技能失败：{err}",

  // 全书上下文状态行
  "chat.contextOnlyToc": "只发目录与当前章节（未装载正文）",
  "chat.contextLoading": "正在装载全书…",
  "chat.contextLoadingProgress": "正在装载全书… {done}/{total}",
  "chat.contextLoadFailed": "全书装载失败：{err}",
  "chat.contextNotLoaded": "尚未装载（打开书籍后自动进行）",
  "chat.contextNone": "通用对话：没有打开书籍，没有全书正文（书内工具会回结构化的 NOT_AVAILABLE）",
  "chat.contextPartial": "已装载 {loaded}/{total} 章（书太长，超出预算）",
  "chat.contextFull": "已装载全书 {n} 章",
  "chat.contextStats": "{chars} · 约 {tokens} token（占 1M 的 {pct}%）",
  "chat.contextCostEstimate": " · 首问约 ¥{first}，之后每问约 ¥{each}",
  "chat.charCount": "{n} 万字",
  "chat.tokenCountWan": "{n} 万",
  "chat.contextRefreshed": "全书上下文刚重新抽取（{n} 章）。上面的旧回答可能是在旧上下文下写的，",
  "chat.clearAndRestart": "清空对话重开一段",

  // 本机 mock 警告
  "chat.mockWarningBefore": "当前服务指向本机 mock（{url}）：只有在跑 tools/mock-deepseek.mjs 时才有响应，否则会一直\"请求失败\"。要用真实模型，请在",
  "chat.mockWarningAfter": "里把「服务」换成 DeepSeek（或你自己的 OpenAI 兼容端点）。",

  // 顶部按钮与提示条
  "chat.settings": "设置",
  "chat.hideSettings": "收起设置",
  "chat.clearConversationTitle": "清空本会话的所有消息（已经装载的全书正文不受影响，随时可以继续问）",
  "chat.clearConversation": "清空对话",
  "chat.reloadContextTitle": "重新抽取并覆盖缓存",
  "chat.reloadContext": "重新装载",
  "chat.skillsDirTitle": "技能目录：{dir}",
  "chat.rescanSkillsTitle": "重新扫描技能目录",
  "chat.refreshSkills": "刷新技能",
  "chat.gotIt": "知道了",
  "chat.skillWarningsTitle": "技能目录里有些文件没被采用",
  "chat.skillWarnings": "技能告警：{list}",
  "chat.skillWarningSep": "；",

  // 技能状态行
  "chat.skillsOff": "技能已关闭（目录不注入，/名字 不生效）",
  "chat.skillsNone": "暂无可用技能（技能目录：{dir}）",
  "chat.skillsScanning": "扫描中…",
  "chat.skillsSummary": "技能 {n} 个{users} · 目录已注入请求前缀",
  "chat.skillsSummaryUsers": "（含用户技能 {n}）",
  "chat.noSkills": "（还没有技能）",
  "chat.userSkillTag": "(用户)",
  "chat.deleteSkillTitle": "删除用户技能 {name}",
  "chat.addSkillBefore": "放一个",
  "chat.addSkillAfter": "到技能目录即可新增；目录：",
  "chat.skillsDirLoading": "（读取中…）",

  // 设置区
  "chat.provider": "服务",
  "chat.model": "模型",
  "chat.apiKeyPlaceholderLocal": "本地模型无需填写",
  "chat.maxTokens": "单次最大输出 token",
  "chat.maxTokensHint": "写插件/长代码时别调小：太小会把工具调用的 JSON 截在半路（模型只会看到\"参数不是合法 JSON\"）",
  "chat.thinking": "深度思考（更准但更慢）",
  "chat.fullBook": "全书进上下文（推荐；关掉后只发目录）",
  "chat.allowTools": "允许 AI 调用工具（取章节 / 检索 / 划线 / 跳转）",
  "chat.enableSkills": "启用技能包（目录进前缀；{n} 个可用）",

  // 空会话引导
  "chat.emptyAskAboutBook": "可以针对《{title}》提问",
  "chat.emptyNoBook": "打开一本书后提问更有效",
  "chat.emptyLibrary": "书库通用对话：可以问任何问题；要针对某本书提问，先从书架打开它",
  "chat.emptyExamples": "例：",
  "chat.exampleChapter": "这一章讲了什么？",
  "chat.exampleCharacters": "帮我理一下这里的人物关系",
  "chat.exampleMainline": "全书的主线是怎么推进的？",

  // 单条消息的操作
  "chat.deleteMessageTitle": "删除这一条（正文上下文不受影响）",
  "chat.confirmDeleteMessage": "删掉这一条消息？全书上下文不会被清掉。",

  // 用量与成本
  "chat.usageInput": "输入 {n} tok",
  "chat.usageCacheHit": "（缓存命中 {n} · {pct}%）",
  "chat.usageOutput": "输出 {n} tok",
  "chat.usageCost": "约 ¥{cost}",

  // 输入区
  "chat.inputPlaceholderShort": "问点什么…（/ 调用技能）",
  "chat.inputPlaceholder": "问点什么…（Enter 发送，Shift+Enter 换行；/名字 直接调用技能）",
  "chat.send": "发送",
  "chat.stop": "停止",

  // agentLoop 直接显示在面板上的提示 / 错误（工具结果里给模型看的那些不抽）
  "chat.loopTruncated":
    "这一轮回答被输出上限截断了（max_tokens）。{args}可以在设置里调大「单次最大输出」，或让它分几次做完。",
  "chat.loopTruncatedArgs": "工具参数也因此不完整。",
  "chat.errCancelledBeforeDispatch": "调用在派发前被取消",
  "chat.errCancelledBeforeDispatchHint": "用户中止了本次对话；如仍需要，请重新提问",
};

const en: Record<keyof typeof zh, string> = {
  "chat.jumpToChapter": "Jump back to chapter {n}",

  "chat.skillScanFailed": "Skill directory scan failed: {err}",
  "chat.apiKeyRequired": "Enter an API Key first",
  "chat.unknownSkill": "No skill named {names} (sent as a normal message this turn)",
  "chat.skillCatalogUpdated": "Skill directory updated: {n} skill available now, effective from this turn (the cached prefix is recomputed from here)",
  "chat.confirmClearConversation": "Clear all messages in this conversation? The loaded book text is not affected.",
  "chat.deleteSkillFailed": "Failed to delete the skill: {err}",

  "chat.contextOnlyToc": "Sending only the table of contents and the current chapter (book text not loaded)",
  "chat.contextLoading": "Loading the whole book…",
  "chat.contextLoadingProgress": "Loading the whole book… {done}/{total}",
  "chat.contextLoadFailed": "Failed to load the whole book: {err}",
  "chat.contextNotLoaded": "Not loaded yet (starts automatically once a book is open)",
  "chat.contextNone": "General chat: no book is open, so there is no book text (in-book tools return a structured NOT_AVAILABLE)",
  "chat.contextPartial": "Loaded chapter {loaded}/{total} (book too long, over budget)",
  "chat.contextFull": "Loaded the whole book: {n} chapter",
  "chat.contextStats": "{chars} · about {tokens} token ({pct}% of 1M)",
  "chat.contextCostEstimate": " · about ¥{first} for the first question, about ¥{each} for each one after that",
  "chat.charCount": "{n}k chars",
  "chat.tokenCountWan": "{n}k",
  "chat.contextRefreshed": "The whole-book context was just extracted again ({n} chapter). The older answers above may have been written with the old context,",
  "chat.clearAndRestart": "Clear Chat and Start Over",

  "chat.mockWarningBefore": "The service points to a local mock ({url}): it only answers while tools/mock-deepseek.mjs is running, otherwise every request fails. To use a real model, open",
  "chat.mockWarningAfter": "and switch Service to DeepSeek (or your own OpenAI-compatible endpoint).",

  "chat.settings": "Settings",
  "chat.hideSettings": "Hide Settings",
  "chat.clearConversationTitle": "Clear every message in this session (the loaded book text is not affected, and you can keep asking anytime)",
  "chat.clearConversation": "Clear Chat",
  "chat.reloadContextTitle": "Extract the book text again and overwrite the cache",
  "chat.reloadContext": "Reload",
  "chat.skillsDirTitle": "Skill directory: {dir}",
  "chat.rescanSkillsTitle": "Scan the skill directory again",
  "chat.refreshSkills": "Refresh Skills",
  "chat.gotIt": "Got It",
  "chat.skillWarningsTitle": "Some files in the skill directory were not used",
  "chat.skillWarnings": "Skill warning: {list}",
  "chat.skillWarningSep": "; ",

  "chat.skillsOff": "Skill is off (the directory is not injected and /name does not work)",
  "chat.skillsNone": "No skill available (skill directory: {dir})",
  "chat.skillsScanning": "scanning…",
  "chat.skillsSummary": "Skill: {n}{users} · directory injected into the request prefix",
  "chat.skillsSummaryUsers": " (including {n} user skill)",
  "chat.noSkills": "(no skill yet)",
  "chat.userSkillTag": "(user)",
  "chat.deleteSkillTitle": "Delete the user skill {name}",
  "chat.addSkillBefore": "Drop a",
  "chat.addSkillAfter": "into the skill directory to add one; directory:",
  "chat.skillsDirLoading": "(reading…)",

  "chat.provider": "Service",
  "chat.model": "Model",
  "chat.apiKeyPlaceholderLocal": "Not needed for a local model",
  "chat.maxTokens": "Max output token per response",
  "chat.maxTokensHint": "Do not lower this when writing plugins or long code: a value that is too small cuts tool-call JSON in half (the model only sees that the arguments are not valid JSON)",
  "chat.thinking": "Deep Thinking (more accurate, but slower)",
  "chat.fullBook": "Put the whole book in context (recommended; when off, only the table of contents is sent)",
  "chat.allowTools": "Let the AI call tools (get chapter / search / highlight / jump)",
  "chat.enableSkills": "Enable skill pack (the directory goes into the prefix; {n} available)",

  "chat.emptyAskAboutBook": "You can ask about \"{title}\"",
  "chat.emptyNoBook": "Asking works better after you open a book",
  "chat.emptyLibrary": "Library-wide chat: ask anything; to ask about a specific book, open it from the shelf first",
  "chat.emptyExamples": "Example:",
  "chat.exampleChapter": "What is this chapter about?",
  "chat.exampleCharacters": "Help me sort out the character relationships here",
  "chat.exampleMainline": "How does the main storyline of the book develop?",

  "chat.deleteMessageTitle": "Delete this message (the book context is not affected)",
  "chat.confirmDeleteMessage": "Delete this message? The whole-book context will not be cleared.",

  "chat.usageInput": "Input {n} tok",
  "chat.usageCacheHit": " (cache hit {n} · {pct}%)",
  "chat.usageOutput": "Output {n} tok",
  "chat.usageCost": "about ¥{cost}",

  "chat.inputPlaceholderShort": "Ask something… (/ for skills)",
  "chat.inputPlaceholder": "Ask something… (Enter to send, Shift+Enter for a new line; /name calls a skill directly)",
  "chat.send": "Send",
  "chat.stop": "Stop",

  "chat.loopTruncated":
    "This reply was cut off by the output limit (max_tokens). {args}Raise \"Max output token per response\" in settings, or let it finish over a few turns.",
  "chat.loopTruncatedArgs": "Tool arguments are incomplete as a result. ",
  "chat.errCancelledBeforeDispatch": "The call was cancelled before it was dispatched",
  "chat.errCancelledBeforeDispatchHint": "You stopped this conversation; ask again if you still need it",
};

export const chatPart = { zh, en };
