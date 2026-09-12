/**
 * AI Provider 薄适配层（P2.1）。
 *
 * 设计取舍（见 内部设计笔记 §4）：
 *   - **不用任何 AI 框架**（LangChain 那一套会带来体积、延迟和失控的抽象）；
 *   - 直接 fetch + SSE，每个 provider 一百多行，行为完全可控；
 *   - 统一成流式事件，上层不关心是哪家。
 *
 * DeepSeek 是主力（1M 上下文 + 硬盘缓存），同时支持任意 OpenAI 兼容端点与本地 Ollama。
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** 模型发起的工具调用（回填历史时原样带上） */
export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: ChatRole;
  content: string;
  /** assistant 消息里的工具调用 */
  tool_calls?: ToolCall[];
  /** role = "tool" 时必须给，指向对应的调用 */
  tool_call_id?: string;
};

export type Usage = {
  promptTokens?: number;
  completionTokens?: number;
  /** DeepSeek 的硬盘缓存命中 token 数（命中时单价只有未命中的 1/50） */
  cacheHitTokens?: number;
  cacheMissTokens?: number;
};

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  /** 流结束时一次性给出本轮完整的工具调用（增量分片已在 provider 内合并） */
  | { type: "tool_calls"; calls: ToolCall[] }
  | { type: "usage"; usage: Usage }
  /**
   * 流结束。reason 是 OpenAI/DeepSeek 的 finish_reason：
   * **"length" = 被 max_tokens 截断**（P3.7 实测：写插件的工具调用 JSON 被拦腰截断，
   * 上层只看到"arguments 不是合法 JSON"，模型完全不知道自己是被谁截的）。
   */
  | { type: "done"; reason?: string }
  | { type: "error"; message: string };

export type ProviderId = "deepseek" | "openai-compatible" | "ollama";

export type ProviderConfig = {
  id: ProviderId;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 是否支持关闭思考模式（DeepSeek V4 默认开启思考，关掉明显更快） */
  supportsThinkingToggle: boolean;
  /**
   * 单次响应的输出上限（max_tokens）。
   *
   * **必须给足**：这个值原来硬编码 1200，于是"让 AI 写一个插件"这种要吐一大段代码的
   * 场景，工具调用的 JSON 每次都被截在半路 —— 模型反复重试、越写越短，最后放弃
   *（P3.7 实测：5 次 plugin_define 全是 INVALID_ARGUMENTS）。1200 token ≈ 3 千字符。
   */
  maxOutputTokens?: number;
};

export const PROVIDER_PRESETS: Record<ProviderId, Omit<ProviderConfig, "apiKey">> = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    supportsThinkingToggle: true,
    // DeepSeek 的 max_tokens 上限就是 8192；写插件/长代码时需要它
    maxOutputTokens: 8192,
  },
  "openai-compatible": {
    id: "openai-compatible",
    label: "OpenAI 兼容接口",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    supportsThinkingToggle: false,
    maxOutputTokens: 8192,
  },
  ollama: {
    id: "ollama",
    label: "本地 Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5:7b",
    supportsThinkingToggle: false,
    // 本地小模型上下文小，给太大反而会顶掉输入
    maxOutputTokens: 4096,
  },
};

export type ChatRequest = {
  messages: ChatMessage[];
  /** DeepSeek：默认开启思考模式会显著增加延迟，快速问答建议关掉 */
  thinking?: boolean;
  maxTokens?: number;
  signal?: AbortSignal;
  /** 工具 schema（由 ToolRegistry 投影而来，顺序必须稳定以保前缀缓存） */
  tools?: unknown[];
  toolChoice?: "auto" | "none";
};

/** 流式返回的 tool_calls 是分片增量：按 index 合并成完整调用 */
type ToolCallDraft = { id: string; name: string; args: string };

const trimSlash = (s: string) => s.replace(/\/+$/, "");

function buildBody(cfg: ProviderConfig, req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: req.messages,
    stream: true,
    max_tokens: req.maxTokens ?? cfg.maxOutputTokens ?? 4096,
  };
  // DeepSeek：{ thinking: { type: "disabled" } }
  if (cfg.supportsThinkingToggle && req.thinking === false) {
    body.thinking = { type: "disabled" };
  }
  // Ollama 的 OpenAI 兼容层不接受 stream_options
  if (cfg.id !== "ollama") {
    body.stream_options = { include_usage: true };
  }
  if (req.tools?.length) {
    body.tools = req.tools;
    body.tool_choice = req.toolChoice ?? "auto";
  }
  return body;
}

/** 把 OpenAI 风格的 usage 映射成我们的结构（同时兼容 DeepSeek 的缓存字段） */
function mapUsage(raw: any): Usage {
  return {
    promptTokens: raw?.prompt_tokens ?? raw?.promptTokens,
    completionTokens: raw?.completion_tokens ?? raw?.completionTokens,
    cacheHitTokens: raw?.prompt_cache_hit_tokens ?? raw?.prompt_tokens_details?.cached_tokens,
    cacheMissTokens: raw?.prompt_cache_miss_tokens,
  };
}

export async function* streamChat(
  cfg: ProviderConfig,
  req: ChatRequest,
): AsyncGenerator<StreamEvent> {
  const url = `${trimSlash(cfg.baseUrl)}/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(buildBody(cfg, req)),
      signal: req.signal,
    });
  } catch (e) {
    yield { type: "error", message: "请求失败：" + String(e) };
    return;
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 400);
    } catch {
      /* 忽略 */
    }
    yield { type: "error", message: `HTTP ${res.status} ${res.statusText} ${detail}` };
    return;
  }
  if (!res.body) {
    yield { type: "error", message: "响应没有 body（无法流式读取）" };
    return;
  }

  const decoder = new TextDecoder();
  let buf = "";
  /** finish_reason：只有 "length" 需要特别对待（= 被 max_tokens 截断） */
  let finishReason = "";
  // 工具调用是分片增量：按 index 合并（DeepSeek / OpenAI 兼容端点都是这个形状）
  const drafts = new Map<number, ToolCallDraft>();
  const flush = (): StreamEvent | null => {
    if (!drafts.size) return null;
    const calls: ToolCall[] = [...drafts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, d]) => ({
        id: d.id || "call_" + i,
        type: "function" as const,
        function: { name: d.name, arguments: d.args || "{}" },
      }))
      .filter((c) => c.function.name);
    drafts.clear();
    return calls.length ? { type: "tool_calls", calls } : null;
  };
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (payload === "[DONE]") {
        const flushed = flush();
        if (flushed) yield flushed;
        yield { type: "done", reason: finishReason || undefined };
        return;
      }
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const choice = json.choices?.[0];
      if (choice?.finish_reason) finishReason = String(choice.finish_reason);
      const delta = choice?.delta;
      if (delta?.reasoning_content) yield { type: "reasoning", text: String(delta.reasoning_content) };
      if (delta?.content) yield { type: "text", text: String(delta.content) };
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = Number(tc?.index ?? 0);
          const cur = drafts.get(idx) ?? { id: "", name: "", args: "" };
          if (tc?.id) cur.id = String(tc.id);
          if (tc?.function?.name) cur.name = String(tc.function.name);
          if (tc?.function?.arguments) cur.args += String(tc.function.arguments);
          drafts.set(idx, cur);
        }
      }
      if (json.usage) yield { type: "usage", usage: mapUsage(json.usage) };
    }
  }
  const flushed = flush();
  if (flushed) yield flushed;
  yield { type: "done", reason: finishReason || undefined };
}

/**
 * 装载全书上下文的预计花费（元）：首次（缓存未命中）与之后每次提问（缓存命中）。
 * 输入按 800 token 输出估算。单价是 DeepSeek 空闲时段（高峰翻倍）。
 */
export function estimateContextCost(
  contextTokens: number,
  providerId: ProviderId,
): { first: number; each: number } {
  if (providerId !== "deepseek") return { first: 0, each: 0 };
  const miss = (contextTokens / 1e6) * 1;
  const hit = (contextTokens / 1e6) * 0.02;
  const out = (800 / 1e6) * 4;
  return { first: miss + out, each: hit + out };
}

/** 估算成本（DeepSeek 空闲时段单价，单位：元 / 百万 token） */
export function estimateCost(u: Usage, providerId: ProviderId): number {
  if (providerId !== "deepseek") return 0;
  const hit = u.cacheHitTokens ?? 0;
  const miss = u.cacheMissTokens ?? Math.max(0, (u.promptTokens ?? 0) - hit);
  const out = u.completionTokens ?? 0;
  return (hit / 1e6) * 0.02 + (miss / 1e6) * 1 + (out / 1e6) * 4;
}
