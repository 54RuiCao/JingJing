import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  PROVIDER_PRESETS,
  estimateContextCost,
  estimateCost,
  type ChatMessage,
  type ProviderConfig,
  type ProviderId,
  type Usage,
} from "./provider";
import { drainSteer, reportSlotFailure } from "./steer";
import { runAgentLoop } from "./agentLoop";
import { splitCitations } from "./citations";
import { READ_TOOL_NAMES, type ToolRegistry } from "./tools";
import { CONTEXT_WINDOW_TOKENS, type BookContextData } from "./bookContext";
import { buildRequestMessages, buildSkillInvocationMessage } from "./prompt";
import { addAiMessage, clearAiMessages, deleteAiMessage, getSetting, listAiMessages, setSetting, type AiMessage } from "../store/db";
import { matchSkillSlash, parseSkillGestures } from "../skills/registry";
import { renderSkillContent } from "../skills/render";
import type { CatalogSnapshot } from "../skills/types";
import type { SkillHost } from "../skills/host";
import type { AiService } from "../core/app/runtime";
import { SlotView } from "../ui/slots";
import type { SlotEntry, SlotsService } from "../ui/slots";
import type { ToolCallRecord } from "./tools/types";
import { getLang, t } from "../i18n";
import { useT } from "../i18n/react";

export type BookContext = {
  title: string;
  author?: string;
  /** 当前章节标题 */
  chapter?: string;
  /** 当前章节在全书清单里的序号 n（合订本里同名章只有它能消歧，见 prompt.ts 的 BookBrief） */
  chapterN?: number;
  toc?: string[];
  /** 当前页码 / 位置描述 */
  location?: string;
};

/** 全书上下文的装载状态（由 App 侧的后台任务驱动） */
export type ContextLoad = {
  status: "idle" | "loading" | "ready" | "error";
  data: BookContextData | null;
  progress: { done: number; total: number } | null;
  error?: string;
};

type Props = {
  /** 当前书籍 id；为空表示通用对话 */
  bookId: string | null;
  context: BookContext;
  load: ContextLoad;
  /** 重新抽取全书上下文（调试/缓存过期用） */
  onReload?: () => void;
  /** 工具注册表（P2.3）。可见集由这里裁剪：书没打开时只留只读工具 */
  registry: ToolRegistry;
  /** 技能宿主（P2.5）：目录注入 + load_skill + /name 直呼 */
  skills: SkillHost;
  /** 当前 AI 配置服务（P3.0）：把面板里的配置汇报给容器，插件才能读到 */
  ai?: AiService;
  /** 插槽服务（P3.2）：每条消息旁的插件动作席位 chat.message.action */
  slots?: SlotsService;
  /** 点回答里的 [CH n] 跳回原文（P2.4） */
  onJumpToChapter?: (n: number) => void;
};

/**
 * 插件挂在消息旁的 UI 崩了：内核已把它摘掉，这里**报给用户 + 推回给写它的 AI**。
 *
 * P5：以前只 `console.error` —— 用户看到空白格子，写插件的 AI 却以为成功（DSH 的
 * steerRenderFailure 就是解决这个：消息里直接带修复指令）。按 插件+槽位+错因 去重，避免刷屏。
 */
function onChatSlotError(slot: string, entry: SlotEntry, error: unknown) {
  console.error("[slot] " + slot + " 的「" + (entry.label ?? entry.owner) + "」渲染失败，已从格子里摘掉", error);
  reportSlotFailure(slot, entry.owner, entry.label, error);
}

/** 回答正文：把 [CH n] 渲染成可点击的锚点 */
function MessageBody({ text, onJump }: { text: string; onJump?: (n: number) => void }) {
  const t = useT();
  const segs = splitCitations(text);
  if (!onJump || (segs.length === 1 && "text" in segs[0])) return <>{text}</>;
  return (
    <>
      {segs.map((s, i) =>
        "text" in s ? (
          <span key={i}>{s.text}</span>
        ) : (
          <button key={i} className="air-cite" title={t("chat.jumpToChapter", { n: s.n })} onClick={() => onJump(s.n)}>
            [CH {s.n}]
          </button>
        ),
      )}
    </>
  );
}

/** 一次工具调用在界面上的呈现（执行层与呈现层分离，UI 只吃这几个字段） */
type ToolTrailItem = {
  callId: string;
  name: string;
  title: string;
  summary?: string;
  tone?: "ok" | "warn" | "error";
  ms: number;
  /**
   * 原始调用记录（P3.6）：`tool.call.card` 是 chain 槽位，插件要**看着参数与结果**
   * 才能决定"这张卡我来渲染吗"，所以把 record 一起交给宿主 props。
   */
  record?: ToolCallRecord;
};

const DEFAULTS = {
  provider: "deepseek" as ProviderId,
  apiKey: "",
  baseUrl: PROVIDER_PRESETS.deepseek.baseUrl,
  model: PROVIDER_PRESETS.deepseek.model,
  thinking: false,
  /** 默认策略：整本书进上下文（见 内部设计笔记 §1） */
  fullBook: true,
  /** 允许 AI 调用工具（P2.3） */
  tools: true,
  /** 把技能目录注入请求（P2.5）。关掉后模型看不到任何技能，/名字 也不再注入 */
  skillsOn: true,
  /**
   * 单次响应输出上限（max_tokens）。**别调小**：这个值原来写死 1200，
   * 结果"让 AI 写一个插件"时工具调用的 JSON 每次都在半路被截断（P3.7 实测）。
   */
  maxTokens: 8192,
};

/** 设置指向本机 mock（127.0.0.1 / localhost）——探针留下的配置，用户很容易踩，要显眼提示 */
const looksLikeLocalMock = (baseUrl: string) => /127\.0\.0\.1|localhost/i.test(baseUrl);

const fmtInt = (n: number) => n.toLocaleString("en-US");
/** 字符数：中文按「万」，英文按 k（这个量级两边读起来差得远） */
const fmtWan = (chars: number) =>
  t("chat.charCount", { n: getLang() === "en" ? Math.round(chars / 1000) : (chars / 10000).toFixed(1) });
/** token 数：一万以下照原样给，免得小数字被压成 "0.0 万" */
const fmtTokens = (n: number) =>
  n >= 10000
    ? t("chat.tokenCountWan", { n: getLang() === "en" ? Math.round(n / 1000) : (n / 10000).toFixed(1) })
    : String(n);

export function ChatPanel({ bookId, context, load, onReload, registry, skills, ai, slots, onJumpToChapter }: Props) {
  const t = useT();
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [input, setInput] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUsage, setLastUsage] = useState<Usage | null>(null);
  const [lastCost, setLastCost] = useState(0);
  const [showConfig, setShowConfig] = useState(false);
  const [cfg, setCfg] = useState(DEFAULTS);
  const [toolTrail, setToolTrail] = useState<ToolTrailItem[]>([]);
  /** 技能目录快照（界面显示用；注入用的是 registry 里的同一份） */
  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(null);
  /** 扫描告警（写坏的 SKILL.md 等）——DSH 只写日志，我们说出来 */
  const [skillWarnings, setSkillWarnings] = useState<string[]>([]);
  /** 技能目录在本会话里变化时的提示（§5.6） */
  const [skillNotice, setSkillNotice] = useState<string | null>(null);
  const [skillsDir, setSkillsDir] = useState("");
  /** 一次性提示（输出被截断、技能目录变化…）：不是错误，但必须让用户看见 */
  const [notice, setNotice] = useState<string | null>(null);
  /** 上一次注入给模型的目录 digest（按书隔离：换书等于换会话） */
  const lastCatalogRef = useRef<{ bookId: string | null; digest: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  /**
   * 配置自动保存用（防抖 400ms，见下面的 effect）。
   * 两个 ref 必须**先于 loadCfg 声明**：读完设置要立刻把基线更新掉，
   * 否则面板会把"刚从库里读到的值"当成"用户改的值"再写回去 ——
   * 外部写入（探针/CDP/将来的别的窗口）会被它悄悄盖回旧值（实测踩到三次）。
   */
  const cfgLoaded = useRef(false);
  const lastSaved = useRef("");

  // 载入配置（也用于"设置被外部改动后重新读"）
  const loadCfg = useCallback(async () => {
      const [provider, apiKey, baseUrl, model, thinking, fullBook, tools, skillsOn, maxTokens] = await Promise.all([
        getSetting<ProviderId>("ai.provider", DEFAULTS.provider),
        getSetting<string>("ai.apiKey", DEFAULTS.apiKey),
        getSetting<string>("ai.baseUrl", DEFAULTS.baseUrl),
        getSetting<string>("ai.model", DEFAULTS.model),
        getSetting<boolean>("ai.thinking", DEFAULTS.thinking),
        getSetting<boolean>("ai.fullBook", DEFAULTS.fullBook),
        getSetting<boolean>("ai.tools", DEFAULTS.tools),
        getSetting<boolean>("ai.skills", DEFAULTS.skillsOn),
        getSetting<number>("ai.maxTokens", DEFAULTS.maxTokens),
      ]);
      const loaded = {
        provider,
        apiKey,
        baseUrl,
        model,
        thinking,
        fullBook,
        tools,
        skillsOn,
        maxTokens: Number(maxTokens) > 0 ? Number(maxTokens) : DEFAULTS.maxTokens,
      };
      // 基线跟着走：这几项是从库里读出来的，不需要再写回去
      lastSaved.current = JSON.stringify(loaded);
      cfgLoaded.current = true;
      setCfg(loaded);
      // 指向本机 mock 时也把设置面板摊开（探针留下的配置最容易在这里坑人）
      setShowConfig(!apiKey || looksLikeLocalMock(baseUrl));
  }, []);

  useEffect(() => {
    void loadCfg();
  }, [loadCfg]);


  /**
   * 设置被**外部**改过之后重新读：探针/CDP 直接写数据库、或将来别的窗口改了设置时用。
   * 没有这条通路的话，面板里那份内存状态会在下一次交互时把旧值写回数据库
   *（实测：探针复原了数据库，面板又把 mock 配置写回来了）。
   */
  useEffect(() => {
    const onReload = () => void loadCfg();
    window.addEventListener("aireader:reload-settings", onReload);
    return () => window.removeEventListener("aireader:reload-settings", onReload);
  }, [loadCfg]);

  // 载入当前书的会话
  useEffect(() => {
    void (async () => {
      try {
        setMessages(await listAiMessages(bookId));
      } catch {
        setMessages([]);
      }
      setStreamingText("");
      setError(null);
    })();
  }, [bookId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streamingText]);

  /**
   * 底部那一摞（工具轨迹 / 提示 / 用量 / 输入框）高度是会变的 —— 例如
   * **token 与花费那行字数一多就折成两行**，消息区随之变矮，而列表并不会自动重新贴底，
   * 于是"正在生成"的那条被顶出可视区（用户实测反馈就是这个）。
   * 这里监听容器尺寸：只要在生成中、或本来就在底部附近，就把列表重新贴到底。
   */
  useEffect(() => {
    const list = scrollRef.current;
    const host = list?.parentElement;
    if (!list || !host || typeof ResizeObserver === "undefined") return;
    const keepPinned = () => {
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 160;
      if (busy || nearBottom) list.scrollTo({ top: list.scrollHeight });
    };
    const ro = new ResizeObserver(keepPinned);
    ro.observe(host);
    ro.observe(list);
    return () => ro.disconnect();
  }, [busy]);

  /**
   * 技能目录：启动扫一次（异步，但用户的第一次提问之前一定已经完成），
   * 之后只在点「重新扫描」、或 AI 写完技能（create_skill 内部会 refresh）时重扫。
   * 不做文件监听 —— 目录什么时候变，在界面上是可见的（§5.5 的取舍）。
   */
  const refreshSkills = useCallback(async () => {
    try {
      await skills.refresh();
    } catch (e) {
      setError(t("chat.skillScanFailed", { err: String(e) }));
    }
    setCatalog(skills.registry.catalog());
    setSkillWarnings(skills.warnings());
    void skills
      .dir()
      .then(setSkillsDir)
      .catch(() => {});
  }, [skills]);

  useEffect(() => {
    void refreshSkills();
  }, [refreshSkills]);

  /** 把当前 AI 配置汇报给容器里的 ai 服务（只读快照；P3.4 的 llm.chat 能力会读它） */
  useEffect(() => {
    ai?.set({
      provider: cfg.provider,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      hasKey: Boolean(cfg.apiKey),
      thinking: cfg.thinking,
    });
  }, [ai, cfg]);

  // 注册表失效（AI 写完技能、用户改了目录）→ 刷新界面上的目录快照
  useEffect(
    () => skills.registry.onChange(() => setCatalog(skills.registry.catalog())),
    [skills],
  );

  const saveCfg = useCallback(async (patch: Partial<typeof DEFAULTS>) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    if (patch.provider) {
      const preset = PROVIDER_PRESETS[patch.provider];
      // 换 provider 时把 baseUrl/model 复位到该家的默认值，避免串味
      next.baseUrl = preset.baseUrl;
      next.model = preset.model;
      setCfg(next);
      await setSetting("ai.baseUrl", preset.baseUrl);
      await setSetting("ai.model", preset.model);
    }
    await Promise.all([
      setSetting("ai.provider", next.provider),
      setSetting("ai.apiKey", next.apiKey),
      setSetting("ai.baseUrl", next.baseUrl),
      setSetting("ai.model", next.model),
      setSetting("ai.thinking", next.thinking),
      setSetting("ai.fullBook", next.fullBook),
      setSetting("ai.tools", next.tools),
      setSetting("ai.skills", next.skillsOn),
      setSetting("ai.maxTokens", next.maxTokens),
    ]);
  }, [cfg]);

  /**
   * 配置自动保存（防抖 400ms）。为什么必须有：所有字段原来只在 **onBlur** 时保存 ——
   * 用户在 API Key 里打完字直接去提问（或直接关掉面板），blur 可能根本没触发，配置就丢了。
   * 实测踩到过"填了 Key 但库里还是旧值"。
   * 用 lastSaved 比对，避免 setCfg 造出新对象 → 反复写库。
   */
  useEffect(() => {
    const key = JSON.stringify(cfg);
    if (!cfgLoaded.current) {
      cfgLoaded.current = true;
      lastSaved.current = key;
      return;
    }
    if (key === lastSaved.current) return;
    const id = window.setTimeout(() => {
      lastSaved.current = key;
      void saveCfg({});
    }, 400);
    return () => window.clearTimeout(id);
  }, [cfg, saveCfg]);

  const providerConfig: ProviderConfig = {
    id: cfg.provider,
    label: PROVIDER_PRESETS[cfg.provider].label,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    supportsThinkingToggle: PROVIDER_PRESETS[cfg.provider].supportsThinkingToggle,
    maxOutputTokens: cfg.maxTokens,
  };

  /** 只有开关打开、且确实装载好了，才把全书塞进请求 */
  const activeContext: BookContextData | null =
    cfg.fullBook && load.status === "ready" ? load.data : null;

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!cfg.apiKey && cfg.provider !== "ollama") {
      setShowConfig(true);
      setError(t("chat.apiKeyRequired"));
      return;
    }
    setError(null);
    setNotice(null);
    setInput("");
    setBusy(true);
    setStreamingText("");
    setLastUsage(null);
    setLastCost(0);

    const userRow = await addAiMessage(bookId, "user", text);
    // 历史里不含本轮这条：最后一条 user 消息由 buildRequestMessages 带上「当前阅读位置」
    const history: ChatMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages([...messages, userRow]);

    // ---- 技能（P2.5）：先处理 /名字 手势，再决定目录要不要作为「替换」注入 ----
    const skillMessages: ChatMessage[] = [];
    const unknownGestures: string[] = [];
    if (cfg.skillsOn) {
      // 正文在加载时才读（list 只有概要），所以这里必须是 async 的一步
      for (const g of parseSkillGestures(text)) {
        const candidate = skills.registry.userInvocable().find((s) => s.name === g);
        const def = candidate ? await skills.registry.get(g) : undefined;
        if (!def) {
          unknownGestures.push(g);
          continue;
        }
        skillMessages.push(buildSkillInvocationMessage(g, renderSkillContent(def, def.resources ?? [])));
      }
    }
    if (unknownGestures.length) {
      setError(t("chat.unknownSkill", { names: unknownGestures.join(" / ") }));
    }

    // 目录是**派生前缀**：每轮现算，技能集不变则逐字节相同（仍是可缓存前缀）。
    // 变过（装/删/改描述）就用「全量替换」形态，并顺手在界面上说一句。
    const snapshot = skills.registry.catalog();
    const prevCatalog = lastCatalogRef.current;
    const isUpdate = prevCatalog?.bookId === bookId && prevCatalog.digest !== snapshot.digest;
    const catalogParam =
      cfg.skillsOn && snapshot.entries.length ? { snapshot, isUpdate } : null;
    lastCatalogRef.current = { bookId, digest: snapshot.digest };
    if (isUpdate) {
      setSkillNotice(t("chat.skillCatalogUpdated", { n: snapshot.entries.length }));
    }

    const payload = buildRequestMessages({
      data: activeContext,
      brief: {
        title: context.title,
        author: context.author,
        chapter: context.chapter,
        location: context.location,
        toc: context.toc,
      },
      history,
      question: text,
      catalog: catalogParam,
      skillMessages,
    });

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let acc = "";
    // 每一步都会报一次 usage：按步累加（DSH 的 token meter 也是这个口径）
    const totals: Usage = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
    const trail: ToolTrailItem[] = [];
    setToolTrail([]);
    // 可见工具集在这里裁剪：关掉开关则一个都不给；没打开书时只留只读工具。
    // P3.0 起掩码按**作用域**存（DSH 的 restrict 是对单个 agent 的掩码，不是一个全局开关），
    // 作用域取这本书 —— 换书各留各的掩码，互不影响。
    const scopeId = bookId ? "book:" + bookId : "adhoc";
    registry.restrict(cfg.tools ? (bookId ? null : READ_TOOL_NAMES) : [], scopeId);

    try {
      await runAgentLoop({
        // P5：每步开始前把宿主侧插话（渲染失败等）交给模型，让它当场自己修
        steer: drainSteer,
        cfg: providerConfig,
        messages: payload,
        registry,
        thinking: cfg.thinking,
        signal: ctrl.signal,
        scopeId,
        // P3.10：写插件是"查现场 → 定义 → 运行 → 看回执 → 改 → 再定义"的流程，
        // 6 步实测会在"运行失败、还没来得及改"的地方被掐断（模型只查了 4 次现场就用完了）。
        maxSteps: 10,
        maxParallelToolCalls: 4,
        onEvent: (ev) => {
          if (ev.type === "text") {
            acc += ev.text;
            setStreamingText(acc);
          } else if (ev.type === "usage") {
            totals.promptTokens = (totals.promptTokens ?? 0) + (ev.usage.promptTokens ?? 0);
            totals.completionTokens = (totals.completionTokens ?? 0) + (ev.usage.completionTokens ?? 0);
            totals.cacheHitTokens = (totals.cacheHitTokens ?? 0) + (ev.usage.cacheHitTokens ?? 0);
            totals.cacheMissTokens = (totals.cacheMissTokens ?? 0) + (ev.usage.cacheMissTokens ?? 0);
            setLastUsage({ ...totals });
            setLastCost(estimateCost(totals, cfg.provider));
          } else if (ev.type === "tool-end") {
            trail.push({
              record: ev.record,
              callId: ev.record.callId,
              name: ev.record.name,
              title: ev.presentation.title,
              summary: ev.presentation.summary,
              tone: ev.presentation.tone,
              ms: ev.record.ms,
            });
            setToolTrail([...trail]);
          } else if (ev.type === "truncated") {
            setNotice(ev.message);
          } else if (ev.type === "error") {
            setError(ev.message);
          }
        },
      });
    } catch (e) {
      setError(String(e));
    } finally {
      abortRef.current = null;
      setBusy(false);
      setStreamingText("");
      if (acc) {
        const row = await addAiMessage(bookId, "assistant", acc);
        setMessages((list) => [...list, row]);
      }
    }
  }, [input, busy, cfg, bookId, messages, context, providerConfig, activeContext, registry, skills]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /** 清空当前会话（顶部按钮与"上下文刚重抽"提示共用） */
  const clearConversation = useCallback(async () => {
    if (!window.confirm(t("chat.confirmClearConversation"))) return;
    await clearAiMessages(bookId);
    setMessages([]);
    setToolTrail([]);
  }, [bookId]);

  const Field = ({
    label,
    value,
    onChange,
    type = "text",
    placeholder,
  }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    type?: string;
    placeholder?: string;
  }) => (
    <label style={{ display: "block", marginBottom: 6, fontSize: 12 }}>
      <span style={{ color: "var(--air-sub, #7b8494)" }}>{label}</span>
      <input
        className="air-search"
        style={{ width: "100%", marginTop: 2 }}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => void saveCfg({})}
      />
    </label>
  );

  const contextLine = (() => {
    if (!cfg.fullBook) {
      return { text: t("chat.contextOnlyToc"), tone: "muted" as const };
    }
    if (load.status === "loading") {
      return {
        text: load.progress
          ? t("chat.contextLoadingProgress", { done: load.progress.done, total: load.progress.total })
          : t("chat.contextLoading"),
        tone: "muted" as const,
      };
    }
    if (load.status === "error") {
      return { text: t("chat.contextLoadFailed", { err: load.error ?? "" }), tone: "error" as const };
    }
    const d = load.data;
    if (!d) {
      return {
        // P3.7 待办 B：书库页（没有书）与"书打开了但还没装载完"要说清楚，别让用户以为卡住了
        text: bookId ? t("chat.contextNotLoaded") : t("chat.contextNone"),
        tone: "muted" as const,
      };
    }
    const cost = estimateContextCost(d.tokens, cfg.provider);
    const pct = ((d.tokens / CONTEXT_WINDOW_TOKENS) * 100).toFixed(1);
    const head = d.mode === "partial"
      ? t("chat.contextPartial", { loaded: d.loadedChapters, total: d.chapters })
      : t("chat.contextFull", { n: d.chapters });
    const money = cfg.provider === "deepseek"
      ? t("chat.contextCostEstimate", { first: cost.first.toFixed(2), each: cost.each.toFixed(3) })
      : "";
    return {
      text: head + t("chat.contextStats", { chars: fmtWan(d.chars), tokens: fmtTokens(d.tokens), pct }) + money,
      tone: "ok" as const,
    };
  })();

  /** 指向本地 mock 的显眼警告：要么在跑 mock，要么去设置里换成真实服务 */
  const mockWarning =
    cfg.provider === "openai-compatible" && looksLikeLocalMock(cfg.baseUrl) ? (
      <div className="air-chat-warn">
        {t("chat.mockWarningBefore", { url: cfg.baseUrl })}
        <button className="air-chat-ctx-btn" onClick={() => setShowConfig(true)}>
          {t("chat.settings")}
        </button>
        {t("chat.mockWarningAfter")}
      </div>
    ) : null;

  const hit = lastUsage?.cacheHitTokens ?? 0;
  const prompt = lastUsage?.promptTokens ?? 0;
  const hitPct = prompt > 0 ? Math.round((hit / prompt) * 100) : 0;

  // ---- 技能（P2.5）----
  /** "/" 触发器：整条输入恰好是 /xxx 时才给候选（更保守：有空格就说明已经在写正文了） */
  const slashQuery = /^\/([a-z0-9-]*)$/.exec(input)?.[1] ?? null;
  const slashCandidates =
    slashQuery === null ? [] : matchSkillSlash(skills.registry.userInvocable(), slashQuery);
  const applySlash = (name: string) => {
    setInput("/" + name + " ");
    inputRef.current?.focus();
  };

  const skillLine = (() => {
    if (!cfg.skillsOn) return t("chat.skillsOff");
    if (!catalog || !catalog.entries.length) {
      return t("chat.skillsNone", { dir: skillsDir || t("chat.skillsScanning") });
    }
    const userCount = skills.registry.candidates().filter((c) => c.source === "user").length;
    return t("chat.skillsSummary", {
      n: catalog.entries.length,
      users: userCount ? t("chat.skillsSummaryUsers", { n: userCount }) : "",
    });
  })();

  return (
    <div className="air-chat">
      <div className="air-chat-head">
        <span>
          {PROVIDER_PRESETS[cfg.provider].label} · {cfg.model}
        </span>
        <span className="air-spacer" />
        <button onClick={() => setShowConfig((v) => !v)}>{showConfig ? t("chat.hideSettings") : t("chat.settings")}</button>
        <button
          title={t("chat.clearConversationTitle")}
          onClick={() => void clearConversation()}
        >
          {t("chat.clearConversation")}
        </button>
      </div>

      <div className={"air-chat-ctx air-chat-ctx-" + contextLine.tone} data-status={load.status}>
        {contextLine.text}
        {onReload && cfg.fullBook && load.status !== "loading" && (
          <button className="air-chat-ctx-btn" onClick={onReload} title={t("chat.reloadContextTitle")}>
            {t("chat.reloadContext")}
          </button>
        )}
      </div>

      <div className="air-chat-skills" data-on={String(cfg.skillsOn)} title={skillsDir ? t("chat.skillsDirTitle", { dir: skillsDir }) : undefined}>
        <span>{skillLine}</span>
        <span className="air-spacer" />
        <button className="air-chat-ctx-btn" onClick={() => void refreshSkills()} title={t("chat.rescanSkillsTitle")}>
          {t("chat.refreshSkills")}
        </button>
      </div>

      {/* P3.7：正文刚**重新抽取**过（不是命中缓存），而这段对话里已经有旧消息 ——
          旧回答很可能是在"看不到正文"的状态下写出来的（一本单文件中文 EPUB实测：模型会照着
          历史里那句"我读不到正文"复述，哪怕这一次 46 章正文就在前缀里）。
          与其让模型自己纠偏，不如把状态说清楚并给一个一键重开。 */}
      {load.data && !load.data.fromCache && messages.length > 0 && (
        <div className="air-chat-notice">
          {t("chat.contextRefreshed", { n: load.data.chapters })}
          <button className="air-chat-ctx-btn" onClick={() => void clearConversation()}>
            {t("chat.clearAndRestart")}
          </button>
        </div>
      )}

      {skillNotice && (
        <div className="air-chat-notice">
          {skillNotice}
          <button className="air-chat-ctx-btn" onClick={() => setSkillNotice(null)}>
            {t("chat.gotIt")}
          </button>
        </div>
      )}

      {cfg.skillsOn && skillWarnings.length > 0 && (
        <div className="air-chat-warn" title={t("chat.skillWarningsTitle")}>
          {t("chat.skillWarnings", { list: skillWarnings.join(t("chat.skillWarningSep")) })}
        </div>
      )}

      {showConfig && (
        <div className="air-chat-config">
          <label style={{ display: "block", marginBottom: 6, fontSize: 12 }}>
            <span style={{ color: "var(--air-sub, #7b8494)" }}>{t("chat.provider")}</span>
            <select
              style={{ width: "100%", marginTop: 2 }}
              value={cfg.provider}
              onChange={(e) => void saveCfg({ provider: e.target.value as ProviderId })}
            >
              {Object.values(PROVIDER_PRESETS).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <Field
            label="API Key"
            type="password"
            value={cfg.apiKey}
            placeholder={cfg.provider === "ollama" ? t("chat.apiKeyPlaceholderLocal") : "sk-..."}
            onChange={(v) => setCfg((c) => ({ ...c, apiKey: v }))}
          />
          <Field label="Base URL" value={cfg.baseUrl} onChange={(v) => setCfg((c) => ({ ...c, baseUrl: v }))} />
          <Field label={t("chat.model")} value={cfg.model} onChange={(v) => setCfg((c) => ({ ...c, model: v }))} />
          <label style={{ display: "block", marginBottom: 6, fontSize: 12 }}>
            <span style={{ color: "var(--air-sub, #7b8494)" }}>{t("chat.maxTokens")}</span>
            <input
              className="air-search"
              style={{ width: "100%", marginTop: 2 }}
              type="number"
              min={512}
              max={32768}
              step={512}
              value={cfg.maxTokens}
              onChange={(e) =>
                setCfg((c) => ({
                  ...c,
                  maxTokens: Math.max(512, Math.min(32768, Number(e.target.value) || DEFAULTS.maxTokens)),
                }))
              }
            />
            <span style={{ color: "var(--air-sub, #7b8494)", fontSize: 11 }}>
              {t("chat.maxTokensHint")}
            </span>
          </label>
          {PROVIDER_PRESETS[cfg.provider].supportsThinkingToggle && (
            <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={cfg.thinking}
                onChange={(e) => void saveCfg({ thinking: e.target.checked })}
              />
              {t("chat.thinking")}
            </label>
          )}
          <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={cfg.fullBook}
              onChange={(e) => void saveCfg({ fullBook: e.target.checked })}
            />
            {t("chat.fullBook")}
          </label>
          <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={cfg.tools}
              onChange={(e) => void saveCfg({ tools: e.target.checked })}
            />
            {t("chat.allowTools")}
          </label>
          <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={cfg.skillsOn}
              onChange={(e) => void saveCfg({ skillsOn: e.target.checked })}
            />
            {t("chat.enableSkills", { n: catalog?.entries.length ?? 0 })}
          </label>
          {cfg.skillsOn && (
            <div style={{ fontSize: 11, color: "var(--air-sub, #7b8494)", lineHeight: 1.6 }}>
              {skills.registry.candidates().length === 0 && t("chat.noSkills")}
              {skills.registry.candidates().map((c) => (
                <span key={c.name} style={{ marginRight: 6, whiteSpace: "nowrap" }}>
                  {c.name}
                  {c.source === "user" ? t("chat.userSkillTag") : ""}
                  {c.source === "user" && (
                    <button
                      className="air-skill-del"
                      title={t("chat.deleteSkillTitle", { name: c.name })}
                      onClick={() => {
                        void (async () => {
                          try {
                            await skills.remove(c.name);
                            await refreshSkills();
                          } catch (e) {
                            setError(t("chat.deleteSkillFailed", { err: String(e) }));
                          }
                        })();
                      }}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
              <br />
              {t("chat.addSkillBefore")} <code>SKILL.md</code> {t("chat.addSkillAfter")}
              <br />
              <code style={{ wordBreak: "break-all" }}>{skillsDir || t("chat.skillsDirLoading")}</code>
            </div>
          )}
        </div>
      )}

      <div className="air-chat-list" ref={scrollRef}>
        {messages.length === 0 && !streamingText && (
          <div style={{ color: "var(--air-sub, #7b8494)", fontSize: 12, lineHeight: 1.7 }}>
            {bookId
              ? context.title
                ? t("chat.emptyAskAboutBook", { title: context.title })
                : t("chat.emptyNoBook")
              : t("chat.emptyLibrary")}
            <br />
            <br />
            {t("chat.emptyExamples")}
            <br />· {t("chat.exampleChapter")}
            <br />· {t("chat.exampleCharacters")}
            <br />· {t("chat.exampleMainline")}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={"air-chat-msg air-chat-" + m.role}>
            {/* P3.7：删掉**这一条**（不用把整段对话清空，也不动已经装载的正文） */}
            <button
              className="air-chat-del"
              title={t("chat.deleteMessageTitle")}
              onClick={() => {
                if (!window.confirm(t("chat.confirmDeleteMessage"))) return;
                void (async () => {
                  await deleteAiMessage(m.id);
                  setMessages((list) => list.filter((x) => x.id !== m.id));
                })();
              }}
            >
              ×
            </button>
            <MessageBody text={m.content} onJump={m.role === "assistant" ? onJumpToChapter : undefined} />
            {/* P3.2：消息旁的插件动作（keyed，key = 动作名）；没插件占用时什么都不渲染 */}
            {slots && (
              <SlotView
                slots={slots}
                name="chat.message.action"
                className="air-chat-msg-actions"
                hostProps={{ role: m.role, message: m.content, messageId: m.id }}
                onError={onChatSlotError}
              />
            )}
          </div>
        ))}
        {streamingText && (
          <div className="air-chat-msg air-chat-assistant">
            <MessageBody text={streamingText} onJump={onJumpToChapter} />
          </div>
        )}
        {busy && !streamingText && <div className="air-chat-msg air-chat-assistant">…</div>}
      </div>

      {toolTrail.length > 0 && (
        <div className="air-chat-tools">
          {toolTrail.map((t) => {
            const card = (
              <div className={"air-tool air-tool-" + (t.tone ?? "ok")} title={t.name + " · " + t.ms + "ms"}>
                <span className="air-tool-title">{t.title}</span>
                {t.summary && <span className="air-tool-sum">{t.summary}</span>}
                <span className="air-tool-ms">{t.ms}ms</span>
              </div>
            );
            // tool.call.card 是 chain 槽位：插件用 select(card) 自提名，没人接手就用产品默认卡
            return slots ? (
              <SlotView
                key={t.callId}
                slots={slots}
                name="tool.call.card"
                hostProps={{ card: t }}
                onError={onChatSlotError}
                fallback={card}
              />
            ) : (
              <Fragment key={t.callId}>{card}</Fragment>
            );
          })}
        </div>
      )}

      {notice && (
        <div className="air-chat-warn">
          {notice}
          <button className="air-chat-ctx-btn" onClick={() => setNotice(null)}>
            {t("chat.gotIt")}
          </button>
        </div>
      )}
      {mockWarning}
      {error && <div className="air-chat-error">{error}</div>}
      {lastUsage && (
        <div className="air-chat-usage">
          {t("chat.usageInput", { n: fmtInt(prompt) })}
          {hit > 0 ? t("chat.usageCacheHit", { n: fmtInt(hit), pct: hitPct }) : ""} · {t("chat.usageOutput", { n: fmtInt(lastUsage.completionTokens ?? 0) })} · {t("chat.usageCost", { cost: lastCost.toFixed(4) })}
        </div>
      )}

      {slashCandidates.length > 0 && (
        <div className="air-skill-menu">
          {slashCandidates.map((s) => (
            <button key={s.name} className="air-skill-item" onClick={() => applySlash(s.name)} title={s.description}>
              <span className="air-skill-name">/{s.name}</span>
              <span className="air-skill-desc">{s.description}</span>
            </button>
          ))}
        </div>
      )}

      <div className="air-chat-input">
        <textarea
          ref={inputRef}
          rows={2}
          placeholder={t("chat.inputPlaceholder")}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (slashCandidates.length > 0 && e.key === "Enter" && !e.shiftKey) {
              // 候选菜单优先于发送：Enter = 选中第一个候选（与 DSH 的输入触发器一致）
              e.preventDefault();
              applySlash(slashCandidates[0].name);
              return;
            }
            if (slashCandidates.length > 0 && e.key === "Escape") {
              e.preventDefault();
              setInput("");
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {busy ? <button onClick={stop}>{t("chat.stop")}</button> : <button onClick={() => void send()}>{t("chat.send")}</button>}
      </div>
    </div>
  );
}
