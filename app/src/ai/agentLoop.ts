/**
 * Agent 循环（P2.3）：调用模型 → 执行工具 → 回填结果 → 再调用，直到没有工具调用或到步数上限。
 *
 * 对标 dsh-agent-loop 的"一个步骤做什么"：
 *   - 每个步骤发送：系统提示 + 可见工具 schema + 派生历史；
 *   - **并行安全调用可以重叠（maxParallelToolCalls），独占调用单独跑并形成排序屏障**，
 *     但结果始终按模型发出的顺序回填（tool-calls.ts 的语义）；
 *   - 取消是协作式的；**每个 tool_call 都必须有对应的 tool 结果**——取消时未派发的调用
 *     补一条合成的 ABORTED_BEFORE_DISPATCH，否则消息序列不合法。
 *
 * 工具结果回填的形状（两条纪律的合体）：
 *   - 成功：JSON 化的工具返回值；
 *   - 失败：`{ error: { code, message, hint } }`。DSH 那条线只回 `Error: <message>`，
 *     结构化 code 留在 HarnessError 里不外露；我们把 code 与修正建议一起给模型，
 *     因为阅读器的失败大多可由模型自修复（章节号越界、没选中文字、目录还没装载）。
 *   - 过大结果按"确定性字符预算 + 首尾保留 + 省略标记"裁剪（对齐 dsh-output-retention /
 *     tool-result-pruner）；**get_chapter 例外**——它自带 offset/maxChars 窗口，
 *     再裁会形成"取回结果又被裁掉"的死循环（DSH 里 read 工具被 spill-policy 显式跳过）。
 */

import { t } from "../i18n";
import { streamChat, type ChatMessage, type ProviderConfig, type ToolCall, type Usage } from "./provider";
import type { ToolRegistry } from "./tools/registry";
import type { ToolCallRecord, ToolPresentation } from "./tools/types";

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "step"; step: number }
  | { type: "tool-start"; callId: string; name: string; args: unknown }
  | { type: "tool-end"; record: ToolCallRecord; presentation: ToolPresentation }
  | { type: "usage"; usage: Usage; step: number }
  /**
   * 这一轮输出被 max_tokens 截断（finish_reason = "length"）。
   * 单独报一声，是因为**它看起来像别的问题**：工具调用被截 → "arguments 不是合法 JSON"，
   * 纯文本被截 → 答案戛然而止。用户与模型都需要知道"是被上限拦了，不是写错了"。
   */
  | { type: "truncated"; message: string }
  /** P5：宿主侧插话（steer）—— 例如"你刚才挂上去的界面渲染失败了"，界面上提示一下 */
  | { type: "notice"; message: string }
  | { type: "error"; message: string };

export type AgentRunResult = {
  /** 所有步骤里模型输出的文本（最终答案通常就在最后一段） */
  text: string;
  records: ToolCallRecord[];
  usages: Usage[];
  steps: number;
  stopped: "done" | "max-steps" | "aborted" | "error";
  error?: string;
};

export type AgentRunOptions = {
  cfg: ProviderConfig;
  /** 已组装好的消息（system + 全书 + 确认 + 历史 + 本轮问题） */
  messages: ChatMessage[];
  registry: ToolRegistry;
  thinking: boolean;
  signal: AbortSignal;
  /** 最多几步（一次问答里最多让模型用几轮工具） */
  maxSteps?: number;
  /** 并行安全工具的同时在途数上限 */
  maxParallelToolCalls?: number;
  /** 单个工具结果回填给模型的字符上限（确定性单位：字符） */
  maxResultChars?: number;
  /** 工具可见性作用域（P3.0）：可见掩码与执行都按它解析，默认 "default" */
  scopeId?: string;
  onEvent?: (e: AgentEvent) => void;
  /**
   * P5 steer 通道：每一步开始前调一次，返回的文本会作为 **user 消息**插进这一轮
   * （DSH 的 steer 同理：把宿主侧失败推回给模型，让它当场自己修）。
   * 目前用于"插件界面渲染失败" —— 写插件的 AI 必须知道它写崩了。
   */
  steer?: () => string[];
};

/** 首尾保留 + 省略标记；保证 head + marker + tail ≤ maxChars（每次裁剪都严格变小） */
export function capResultText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "\n\n[... 结果中间省略 " + text.length + " 字符中的 " + (text.length - maxChars) + " 字符 ...]\n\n";
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.floor(budget * 0.7);
  const tail = budget - head;
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

/**
 * 工具结果 → 模型看到的文本。
 *
 * `maxChars` 传 `Infinity` = 不裁剪（结果本来就短且有界的那种工具用，见 ToolDefinition.keepFullResult）。
 * **裁剪 JSON 会把结果剪成半截**：模型拿到 `{"slots":[...` 这种残片就只能瞎猜 —— P3.7 实测踩到
 * （让 AI 写插件时它说"JSON 被截断了，超长了"）。
 */
export function renderToolResultForModel(rec: ToolCallRecord, maxChars: number): string {
  if (!rec.outcome.ok) {
    const e = rec.outcome.error;
    return JSON.stringify({ error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) } });
  }
  let text: string;
  try {
    text = JSON.stringify(rec.outcome.value) ?? "null";
  } catch (e) {
    // DSH 会直接判 INVALID_TOOL_OUTPUT；我们降级成可读文本，绝不把成功调用变成失败
    text = JSON.stringify({ note: "工具返回值无法序列化，已降级为文本", text: String(rec.outcome.value) });
  }
  // get_chapter 自己就是"有界取回"通道，不再二次裁剪（DSH 里 read 工具被 spill-policy 显式跳过）
  if (rec.name === "get_chapter") return text;
  return capResultText(text, maxChars);
}

function parseArgs(raw: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const s = (raw ?? "").trim();
  if (!s) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return { ok: false, message: "arguments 不是合法 JSON：" + String(e) };
  }
}

/**
 * 重复调用计数（对齐 dsh-repeat-tool-reminder）：参数规范化后作 key，
 * 第 3 次及以后在结果尾部追加一句提醒 —— 只提醒不改写结果。
 */
function canonKey(name: string, args: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, norm(x)]),
      );
    }
    return v;
  };
  return name + " " + JSON.stringify(norm(args));
}

export async function runAgentLoop(o: AgentRunOptions): Promise<AgentRunResult> {
  const emit = (e: AgentEvent) => {
    try {
      o.onEvent?.(e);
    } catch {
      /* 呈现失败不影响执行 */
    }
  };
  const messages: ChatMessage[] = [...o.messages];
  const records: ToolCallRecord[] = [];
  const usages: Usage[] = [];
  const maxSteps = Math.max(1, o.maxSteps ?? 6);
  const maxParallel = Math.max(1, o.maxParallelToolCalls ?? 4);
  const maxResultChars = o.maxResultChars ?? 8000;
  const scopeId = o.scopeId;
  const tools = o.registry.schemas(scopeId);

  let answer = "";
  let stopped: AgentRunResult["stopped"] = "done";
  let error: string | undefined;
  let steps = 0;

  const runOne = async (call: ToolCall, index: number, truncatedStep = false): Promise<ToolCallRecord> => {
    const callId = call.id || "call_" + index;
    const parsed = parseArgs(call.function.arguments);
    emit({ type: "tool-start", callId, name: call.function.name, args: parsed.ok ? parsed.value : call.function.arguments });
    if (!parsed.ok) {
      // 截断导致的"JSON 不合法"必须与原生的参数写错区分开：
      // 前者要模型**把事情拆小**，后者才要它按 schema 重写。P3.7 实测踩到。
      const error = truncatedStep
        ? {
            code: "INVALID_ARGUMENTS" as const,
            message: "这次调用的参数 JSON 不完整：它在写到一半时被**输出上限**截断了（finish_reason=length）",
            hint:
              "不是你写错了 JSON，是这一次的输出装不下。把这次调用改小再发：把大段代码分多次写" +
              "（例如先只定义必需字段，跑通后再追加一版补上其余部分），单次参数控制在两三千字符以内。",
          }
        : {
            code: "INVALID_ARGUMENTS" as const,
            message: parsed.message,
            hint: "按参数 schema 重新生成 JSON",
          };
      const record: ToolCallRecord = {
        callId,
        name: call.function.name,
        args: call.function.arguments,
        outcome: { ok: false, error },
        ms: 0,
        resultChars: 0,
      };
      emit({ type: "tool-end", record, presentation: o.registry.present(o.registry.get(record.name), record) });
      return record;
    }
    const record = await o.registry.execute(call.function.name, parsed.value, {
      signal: o.signal,
      callId,
      scopeId,
      throwIfAborted: () => {
        if (o.signal.aborted) throw new DOMException("aborted", "AbortError");
      },
    });
    emit({ type: "tool-end", record, presentation: o.registry.present(o.registry.get(record.name), record) });
    return record;
  };

  /** 同一参数重复调用：第 3 次起在结果后追加提醒（只提醒，不改写结果本身） */
  const seen = new Map<string, number>();
  const withRepeatNotice = (rec: ToolCallRecord, counts: Map<string, number>, maxChars: number): string => {
    // 有界结果不裁：宁可多花点 token，也不要让模型拿到半截 JSON
    const def = o.registry.get(rec.name);
    const text = renderToolResultForModel(rec, def?.keepFullResult ? Infinity : maxChars);
    const key = canonKey(rec.name, rec.args);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n < 3 || rec.name === "get_chapter") return text;
    return (
      text +
      "\n\n（提示：这是你第 " + n + " 次用完全相同的参数调用 " + rec.name +
      "。如果结果没有新信息，请改变参数、换个工具，或直接基于已有信息回答。）"
    );
  };

  const abortedRecord = (call: ToolCall, index: number): ToolCallRecord => ({
    callId: call.id || "call_" + index,
    name: call.function.name,
    args: call.function.arguments,
    outcome: {
      ok: false,
      error: {
        code: "ABORTED_BEFORE_DISPATCH",
        message: t("chat.errCancelledBeforeDispatch"),
        hint: t("chat.errCancelledBeforeDispatchHint"),
      },
    },
    ms: 0,
    resultChars: 0,
  });

  for (let step = 1; step <= maxSteps; step++) {
    if (o.signal.aborted) {
      stopped = "aborted";
      break;
    }
    steps = step;
    emit({ type: "step", step });

    /**
     * P5：把"宿主侧的失败"插进这一轮（DSH 的 steer）。
     * 目前只有一条来源：插件界面渲染失败（写插件的 AI 必须知道自己写崩了，
     * 否则它会以为成功、用户看到空白格子）。取走即清空，不会重复打扰。
     */
    if (o.steer) {
      const steered = o.steer();
      if (steered.length) {
        messages.push({ role: "user", content: steered.join("\n\n") });
        emit({ type: "notice", message: steered.join(" ") });
      }
    }

    let stepText = "";
    let calls: ToolCall[] = [];
    let streamError: string | null = null;
    /** finish_reason = "length"：这一轮被输出上限截断（见 StreamEvent 的 done） */
    let truncated = false;
    for await (const ev of streamChat(o.cfg, {
      messages,
      thinking: o.thinking,
      signal: o.signal,
      tools: tools.length ? tools : undefined,
    })) {
      if (ev.type === "text") {
        stepText += ev.text;
        emit({ type: "text", text: ev.text });
      } else if (ev.type === "reasoning") {
        emit({ type: "reasoning", text: ev.text });
      } else if (ev.type === "usage") {
        usages.push(ev.usage);
        emit({ type: "usage", usage: ev.usage, step });
      } else if (ev.type === "tool_calls") {
        calls = ev.calls;
      } else if (ev.type === "done") {
        truncated = ev.reason === "length";
      } else if (ev.type === "error") {
        streamError = ev.message;
      }
    }
    if (streamError) {
      error = streamError;
      stopped = "error";
      emit({ type: "error", message: streamError });
      break;
    }
    if (truncated) {
      emit({
        type: "truncated",
        message: t("chat.loopTruncated", { args: calls.length ? t("chat.loopTruncatedArgs") : "" }),
      });
    }
    answer += stepText;
    if (!calls.length) break;

    // 模型发出的参数原样回填（DSH：日志快照必须等于模型以为自己写入的形状）
    messages.push({ role: "assistant", content: stepText, tool_calls: calls });

    // 执行：并行安全的批量重叠，独占的单独跑并形成屏障；结果按模型顺序回填
    let idx = 0;
    while (idx < calls.length) {
      if (o.signal.aborted) {
        for (let k = idx; k < calls.length; k++) {
          const rec = abortedRecord(calls[k], k);
          records.push(rec);
          messages.push({ role: "tool", tool_call_id: rec.callId, content: renderToolResultForModel(rec, maxResultChars) });
        }
        stopped = "aborted";
        break;
      }
      const def = o.registry.allows(calls[idx].function.name, scopeId)
        ? o.registry.get(calls[idx].function.name)
        : undefined;
      if ((def?.executionMode ?? "exclusive") === "exclusive") {
        const rec = await runOne(calls[idx], idx, truncated);
        records.push(rec);
        messages.push({ role: "tool", tool_call_id: rec.callId, content: withRepeatNotice(rec, seen, maxResultChars) });
        idx++;
        continue;
      }
      const batch: { call: ToolCall; index: number }[] = [];
      while (
        idx + batch.length < calls.length &&
        batch.length < maxParallel &&
        (o.registry.allows(calls[idx + batch.length].function.name, scopeId)
          ? o.registry.get(calls[idx + batch.length].function.name)?.executionMode
          : undefined) === "parallel-safe"
      ) {
        batch.push({ call: calls[idx + batch.length], index: idx + batch.length });
      }
      const done = await Promise.all(batch.map((b) => runOne(b.call, b.index, truncated)));
      for (let k = 0; k < done.length; k++) {
        records.push(done[k]);
        messages.push({
          role: "tool",
          tool_call_id: done[k].callId,
          content: withRepeatNotice(done[k], seen, maxResultChars),
        });
      }
      idx += batch.length;
    }
    if (o.signal.aborted) {
      if (stopped !== "aborted") stopped = "aborted";
      break;
    }
    if (step === maxSteps) stopped = "max-steps";
  }

  return { text: answer, records, usages, steps, stopped, error };
}
