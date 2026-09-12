/**
 * 工具层的契约（P2.3）。对标 DSH 的 `@deepseek-ai/dsh-tools`。
 *
 * 从 DSH 抄来的四条纪律（README.zh.md「使用本包 / 设计理念」）：
 *   1. **注册表持有类型化定义，向模型投影的是另一份东西**：
 *      `output` / `execute` / 呈现回调绝不泄漏到协议上，模型只看到 name + description + parameters。
 *   2. **调用走一条固定流水线**：pre-execute（允许/拒绝/询问）→ 守卫 → execute → 结果归一化。
 *      我们的实现保留了这条形状，但把 DSH 的事件瀑布换成显式数组（我们用不上 cordis 的事件系统）。
 *   3. **失败也要回传**，而且是结构化的：DSH 用 `Error: <message>`；我们额外带上错误码与修正建议，
 *      因为阅读器的失败大多是"模型可自修复"的（章节号越界、没选中文本、书还没装载完）。
 *   4. **执行与呈现分离**：`present` 只决定 UI 显示什么，不参与模型看到的内容。
 *
 * 另有一条来自 dsh-agent-loop 的纪律：**每个 tool_call 都必须有对应的 tool 结果**，
 * 取消时未派发的调用要补一个合成的结果（ABORTED_BEFORE_DISPATCH），否则消息序列不合法。
 */

/**
 * 我们支持的 JSON Schema 子集（够用即止：DeepSeek Tools API 接受的常见形态）。
 * P3.0 起实现搬到 core/jsonSchema.ts（插件 config 校验共用一份），这里只做转出。
 */
import type { JsonSchemaNode } from "../../core/jsonSchema";

export type { JsonSchemaNode };

/** 工具失败的错误码：前四个与 DSH 同名，后几个是阅读器领域自己的 */
export type ToolErrorCode =
  | "UNKNOWN_TOOL"
  | "TOOL_TIMEOUT"
  | "ABORTED_BEFORE_DISPATCH"
  | "ABORTED"
  | "INVALID_ARGUMENTS"
  | "NOT_FOUND"
  | "NOT_AVAILABLE"
  | "INTERNAL";

export type ToolError = {
  code: ToolErrorCode;
  message: string;
  /** 给模型的修正建议（DSH 的纪律 2：失败必须能自修复） */
  hint?: string;
};

export type ToolOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: ToolError };

/** 执行上下文：取消信号 + 宿主能力（由 UI 层注入，工具本身不认识 foliate/SQLite） */
export type ToolExecContext = {
  signal: AbortSignal;
  /** 本次调用的序号，用于日志与 UI 呈现 */
  callId: string;
  /** 已派发前的取消检查点 */
  throwIfAborted?: () => void;
  /** 作用域（P3.0）：可见性掩码按作用域生效，默认 "default" */
  scopeId?: string;
};

/** 给 UI 的呈现意图（与模型看到的内容无关） */
export type ToolPresentation = {
  /** 一行标题，如「读取第 12 章」 */
  title: string;
  /** 一行摘要，如「4,200 字 · 已在上下文中」 */
  summary?: string;
  tone?: "ok" | "warn" | "error";
};

export type ToolDefinition<A = Record<string, unknown>> = {
  name: string;
  description: string;
  parameters: JsonSchemaNode;
  /**
   * 并行安全 vs 独占（对齐 DSH 的 executionMode）：
   * 只读工具可以并发；独占工具单独跑并形成排序屏障（写批注、跳转阅读位置都属于独占）。
   */
  executionMode: "parallel-safe" | "exclusive";
  /** 声明式超时；由注册表强制执行（DSH 里 timeoutMs 只是声明，要靠包装层兜底——我们直接兜住） */
  timeoutMs?: number;
  /**
   * 结果**不裁剪**（P3.7）。给"返回的结构化数据本来就短且有界"的工具用：
   * 默认 8000 字符的裁剪会把 JSON 剪成半截，模型只能瞎猜（实测：AI 说"JSON 被截断了"写不出插件）。
   * 用它的工具必须自己保证结果有界。
   */
  keepFullResult?: boolean;
  execute(args: A, ctx: ToolExecContext): Promise<ToolOutcome>;
  /** 呈现意图；缺省时注册表给一个通用兜底 */
  present?(args: A, outcome: ToolOutcome): ToolPresentation;
};

/** 一次调用的完整记录（日志 + UI 用；DSH 里对应会话日志里的 tool/call + 结果对） */
export type ToolCallRecord = {
  callId: string;
  name: string;
  args: unknown;
  outcome: ToolOutcome;
  /** 墙钟耗时 */
  ms: number;
  /** 结果序列化后的字符数（用于观察"结果过大"） */
  resultChars: number;
};

/** 协议侧的工具描述（会原样进请求体的 `tools` 字段） */
export type ProtocolTool = {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchemaNode };
};
