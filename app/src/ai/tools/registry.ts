/**
 * 工具注册表（P2.3）。形状对标 DSH 的 `ctx.tools`：
 *   register（注册）→ restrict（按 agent/场景裁剪）→ schemas（投影给模型）→ execute（受守卫的流水线）。
 *
 * 与 DSH 的差异（刻意的）：
 *   - DSH 的 pre-execute 是 cordis 的 waterfall 事件、守卫是单调的；我们用一个显式的守卫数组 +
 *     一条固定流水线，语义相同但不引入事件系统；
 *   - DSH 里 `timeoutMs` 只是声明，真正强制要靠 `dsh-tool-call-timeout-policy` 包装层；
 *     我们由注册表直接兜住（超时 → TOOL_TIMEOUT 结果），少一个包。
 */

import {
  type ProtocolTool,
  type ToolCallRecord,
  type ToolDefinition,
  type ToolError,
  type ToolExecContext,
  type ToolOutcome,
  type ToolPresentation,
} from "./types";
import { validateArgs } from "../../core/jsonSchema";
import type { Disposer } from "../../core/service/types";

export { validateArgs };

/**
 * 守卫：返回理由即拒绝（对齐 DSH 的单调守卫——一旦拒绝，后面的监听器不能再放行）。
 * P3 的权限模型（文件范围/网络域名/一次或永久授权）会挂在这里。
 */
export type ToolGuard = (call: { name: string; args: unknown }) => string | null;

const err = (code: ToolError["code"], message: string, hint?: string): ToolOutcome => ({
  ok: false,
  error: { code, message, hint },
});

/** 默认作用域（没有传 scopeId 的调用都落在这里） */
export const DEFAULT_TOOL_SCOPE = "default";

export class ToolRegistry {
  private defs = new Map<string, ToolDefinition>();
  /**
   * 按作用域的可见性掩码（对齐 DSH 的 ctx.tools.restrict(filter)：掩码是**对单个 agent** 的，
   * 不是一个全局开关）。null = 该作用域不裁剪。
   */
  private masks = new Map<string, Set<string> | null>();
  private guards: ToolGuard[] = [];
  /** 每次调用的记录都会回调一次（UI 呈现 + 审计） */
  onRecord?: (rec: ToolCallRecord) => void;

  /**
   * 注册工具。**返回 disposer**（P3.0 改的第一条纪律，registry.ts 原来的注释就意识到前缀问题了）：
   * 插件卸载必须能摘掉自己注册的工具，否则 schemas() 残留 → 提示词前缀变化 + KV 缓存失效。
   */
  register(def: ToolDefinition): Disposer {
    if (this.defs.has(def.name)) throw new Error("工具名重复：" + def.name);
    this.defs.set(def.name, def);
    return () => {
      if (this.defs.get(def.name) === def) this.defs.delete(def.name);
    };
  }

  registerAll(defs: ToolDefinition[]): Disposer {
    const offs = defs.map((d) => this.register(d));
    return () => {
      for (const off of [...offs].reverse()) off();
    };
  }

  /** 作用域裁剪（对齐 DSH 的 ctx.tools.restrict）：传 null 恢复该作用域的全部；返回 disposer 解除掩码 */
  restrict(names: string[] | null, scopeId: string = DEFAULT_TOOL_SCOPE): Disposer {
    const prev = this.masks.get(scopeId);
    const had = this.masks.has(scopeId);
    this.masks.set(scopeId, names ? new Set(names) : null);
    return () => {
      if (!had) this.masks.delete(scopeId);
      else this.masks.set(scopeId, prev ?? null);
    };
  }

  /** 丢弃整个作用域（会话/书关闭时用） */
  releaseScope(scopeId: string): void {
    this.masks.delete(scopeId);
  }

  registerGuard(guard: ToolGuard): Disposer {
    this.guards.push(guard);
    return () => {
      const at = this.guards.indexOf(guard);
      if (at >= 0) this.guards.splice(at, 1);
    };
  }

  /** 该作用域里这个名字是否可见 */
  allows(name: string, scopeId: string = DEFAULT_TOOL_SCOPE): boolean {
    const mask = this.masks.get(scopeId);
    return !mask || mask.has(name);
  }

  /** 当前可见（未被裁剪掉）的工具定义 */
  visible(scopeId: string = DEFAULT_TOOL_SCOPE): ToolDefinition[] {
    return [...this.defs.values()].filter((d) => this.allows(d.name, scopeId));
  }

  /**
   * 投影给模型的东西：只有 name / description / parameters。
   * 顺序固定为注册顺序 —— DSH 特意强调过「可见定义及其顺序不变，前缀才稳定」，
   * 这条直接影响 DeepSeek 的前缀缓存命中。
   */
  schemas(scopeId: string = DEFAULT_TOOL_SCOPE): ProtocolTool[] {
    return this.visible(scopeId).map((d) => ({
      type: "function" as const,
      function: { name: d.name, description: d.description, parameters: d.parameters },
    }));
  }

  get(name: string): ToolDefinition | undefined {
    return this.defs.get(name);
  }

  /** 受守卫的执行流水线；永远返回记录，不抛异常（DSH：调用失败而不是结束轮次） */
  async execute(name: string, rawArgs: unknown, ctx: ToolExecContext): Promise<ToolCallRecord> {
    const started = performance.now();
    const rec = (outcome: ToolOutcome): ToolCallRecord => {
      const resultChars = JSON.stringify(outcome).length;
      const record: ToolCallRecord = { callId: ctx.callId, name, args: rawArgs, outcome, ms: Math.round(performance.now() - started), resultChars };
      try {
        this.onRecord?.(record);
      } catch {
        /* 呈现失败不影响执行 */
      }
      return record;
    };

    if (ctx.signal.aborted) return rec(err("ABORTED_BEFORE_DISPATCH", "调用在派发前被取消"));

    const scopeId = ctx.scopeId ?? DEFAULT_TOOL_SCOPE;
    const def = this.allows(name, scopeId) ? this.defs.get(name) : undefined;
    if (!def) {
      return rec(
        err("UNKNOWN_TOOL", "没有名为 " + name + " 的工具",
          "可用工具：" + this.visible(scopeId).map((d) => d.name).join(" / ")),
      );
    }

    const checked = validateArgs(def.parameters, rawArgs);
    if (!checked.ok) {
      return rec(
        err("INVALID_ARGUMENTS", "参数不合法：" + checked.issues.join("；"),
          "请按 schema 修正后重试（" + Object.keys((def.parameters as any).properties ?? {}).join(" / ") + "）"),
      );
    }

    for (const guard of this.guards) {
      const reason = guard({ name, args: rawArgs });
      if (reason) return rec(err("NOT_AVAILABLE", reason));
    }

    const timeoutMs = def.timeoutMs ?? 15000;
    let timer = 0;
    try {
      const outcome = await Promise.race<ToolOutcome>([
        def.execute((rawArgs ?? {}) as never, ctx),
        new Promise<ToolOutcome>((resolve) => {
          timer = window.setTimeout(
            () => resolve(err("TOOL_TIMEOUT", name + " 超过 " + timeoutMs + "ms 未返回", "可以缩小范围后重试")),
            timeoutMs,
          );
        }),
      ]);
      if (ctx.signal.aborted && outcome.ok) return rec(err("ABORTED", "调用完成后被取消，结果作废"));
      return rec(outcome);
    } catch (e) {
      return rec(err("INTERNAL", name + " 执行失败：" + String(e)));
    } finally {
      if (timer) window.clearTimeout(timer);
    }
  }

  /** 给 UI 的兜底呈现（工具自己没写 present 时用） */
  present(def: ToolDefinition | undefined, rec: ToolCallRecord): ToolPresentation {
    try {
      const custom = def?.present?.(rec.args as never, rec.outcome);
      if (custom) return custom;
    } catch {
      /* 忽略 */
    }
    return {
      title: def?.name ?? rec.name,
      summary: rec.outcome.ok ? rec.resultChars + " 字符" : rec.outcome.error.code,
      tone: rec.outcome.ok ? "ok" : "error",
    };
  }
}
