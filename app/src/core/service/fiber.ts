/**
 * Fiber：插件的一次实例化（P3.0）。对标 cordis/src/fiber.ts。
 *
 * **转移动力只有一个 —— epoch**（fiber.ts:611-639）：
 *
 *     epoch = '' ；遍历 inject 的每个服务
 *       缺服务        → 'INACTIVE'（等待）
 *       有服务        → epoch += ':' + 提供它的 fiber 的 uid
 *     epoch 从 INACTIVE 变成有值 = 加载；从有值变回 INACTIVE = 卸载（park）；
 *     有值变另一个有值（依赖换了实现）= 卸载后重载。
 *
 * 这就是"依赖等待"的全部机制：没有事件订阅、没有轮询，只有一次字符串比较。
 *
 * 与 DSH 的两处差异（都是刻意的，写在这里免得被当成 bug）：
 *   1. **失败的 fiber 停在 FAILED，不自动重试**。DSH 的 _reload 失败后会回到 INACTIVE，
 *      于是依赖一抖动就会反复重试坏插件；我们要的是 P3.1 的验收语义
 *      「故意写坏一个插件：它 FAILED，其他插件不受影响」，恢复走显式 restart()。
 *   2. **ready 在 ACTIVE / PENDING / FAILED 三种落点都 resolve/reject**，而不是只等 ACTIVE。
 *      否则 await 一个依赖还没就绪的插件会永远挂住（我们的插件大多要靠工具才被用到，
 *      启动流程不能被一个等待中的插件卡死）。
 */

import {
  FIBER_STATE_EVENT,
  FiberState,
  INACTIVE,
  type Context,
  type Disposable,
  type Disposer,
  type Fiber as FiberShape,
  type Plugin,
  type PluginObject,
  type StandardSchemaV1,
} from "./types";
import type { Reflect } from "./reflect";

export class ValidationError extends Error {
  readonly issues: readonly { message: string; path?: readonly (string | number)[] }[];
  constructor(name: string, issues: readonly { message: string; path?: readonly (string | number)[] }[]) {
    const detail = issues
      .map((i) => (i.path?.length ? "(" + "at " + i.path.join(".") + ") " + i.message : i.message))
      .join("；");
    super("插件 " + name + " 的配置不合法：" + detail);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

/** 规范化后的插件（函数形态与对象形态合流到这里） */
export type NormalizedPlugin = {
  name: string;
  inject: string[];
  provide: string[];
  schema?: StandardSchemaV1;
  apply: (ctx: Context, config: unknown) => Disposable;
  /** 原始形态（诊断用） */
  kind: "function" | "object";
};

export type EffectRecord = { label: string; fn: Disposer; active: boolean };

export type FiberHost = {
  reflect: Reflect;
  /**
   * 为 fiber 造 Context（由容器提供，避免 fiber ↔ context 的循环依赖）。
   * parent 是**不透明**的父上下文（容器自己知道它是 ContextImpl），用来接父子原型链。
   */
  createContext(fiber: Fiber, parent: unknown, namespace: string): Context;
  notify(name: string): void;
  forget(fiber: Fiber): void;
  emit(event: string, ...args: unknown[]): void;
  log(level: "info" | "warn" | "error", message: string, error?: unknown): void;
};

let uidSeq = 0;

/** 把 apply/effect 的返回值（很宽：函数 / 数组 / Promise / async iterable）摊平成 disposer 列表 */
export async function collectDisposables(input: Disposable): Promise<Disposer[]> {
  if (input === null || input === undefined) return [];
  if (typeof input === "function") return [input as Disposer];
  if (typeof (input as { then?: unknown }).then === "function") {
    const resolved: unknown = await (input as PromiseLike<unknown>);
    return collectDisposables(resolved as Disposable);
  }
  const asyncIter = input as AsyncIterable<Disposable>;
  if (typeof asyncIter[Symbol.asyncIterator] === "function") {
    const out: Disposer[] = [];
    for await (const item of asyncIter) out.push(...(await collectDisposables(item)));
    return out;
  }
  const iter = input as Iterable<Disposable>;
  if (typeof iter[Symbol.iterator] === "function") {
    const out: Disposer[] = [];
    for (const item of iter) out.push(...(await collectDisposables(item)));
    return out;
  }
  throw new Error("插件返回了不支持的形态（只接受 函数 / 函数数组 / Promise / async iterable）");
}

export class Fiber implements FiberShape {
  readonly uid = ++uidSeq;
  readonly name: string;
  readonly injectNames: readonly string[];
  readonly provideNames: readonly string[];
  readonly namespace: string;
  readonly plugin: NormalizedPlugin;
  readonly parent: Fiber | null;
  readonly ctx: Context;
  readonly ready: Promise<void>;

  private host: FiberHost;
  private _state: FiberState = FiberState.PENDING;
  private _error: unknown = null;
  private epoch: string = INACTIVE;
  private effectList: EffectRecord[] = [];
  private children = new Set<Fiber>();
  private queue: Promise<void> = Promise.resolve();
  private settled = false;
  private resolveReady!: () => void;
  private rejectReady!: (e: unknown) => void;
  private config: unknown;
  /** 卸载时被吞掉的 disposer 异常计数（诊断：不等于 0 说明有插件的清理在报错） */
  disposerFailures = 0;

  constructor(
    host: FiberHost,
    plugin: NormalizedPlugin,
    config: unknown,
    parent: Fiber | null,
    namespace: string,
    parentContext: unknown = null,
  ) {
    this.host = host;
    this.plugin = plugin;
    this.config = config;
    this.parent = parent;
    this.namespace = namespace;
    this.name = plugin.name;
    this.injectNames = [...plugin.inject];
    this.provideNames = [...plugin.provide];
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // 没人 await 时不要让 FAILED 变成 unhandled rejection（行为不变，只是标记为已处理）
    this.ready.catch(() => {});
    parent?.children.add(this);
    this.ctx = host.createContext(this, parentContext, namespace);
  }

  get state(): FiberState {
    return this._state;
  }

  get error(): unknown {
    return this._error;
  }

  /** 由容器在构造后立刻调用：校验 config → 首次 epoch 判定 → 加载或等待 */
  begin(): Promise<void> {
    try {
      if (this.plugin.schema) {
        const result = this.plugin.schema["~standard"].validate(this.config ?? {});
        if (typeof (result as unknown as PromiseLike<unknown>).then === "function") {
          throw new TypeError(
            "插件 " + this.name + " 的 config schema.validate 返回了 Promise：容器只支持**同步**校验（DSH 同）",
          );
        }
        const res = result as { value?: unknown } | { issues: readonly { message: string; path?: readonly (string | number)[] }[] };
        if ("issues" in res && res.issues) {
          this.fail(new ValidationError(this.name, res.issues));
          return this.ready;
        }
        this.config = (res as { value?: unknown }).value;
      }
    } catch (e) {
      this.fail(e);
      return this.ready;
    }
    this.refresh();
    return this.ready;
  }

  private fail(e: unknown): void {
    this._error = e;
    this.setState(FiberState.FAILED);
    this.settle();
  }

  private setState(state: FiberState): void {
    if (this._state === state) return;
    this._state = state;
    this.host.emit(FIBER_STATE_EVENT, { uid: this.uid, name: this.name, state, error: this._error });
  }

  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    if (this._state === FiberState.FAILED) this.rejectReady(this._error);
    else this.resolveReady();
  }

  /** epoch 比对；这是唯一的转移动力（服务变化、依赖出现/消失、依赖换实现都会走到这里） */
  refresh(): void {
    if (this._state === FiberState.DISPOSED || this._state === FiberState.FAILED) return;
    const epoch = this.computeEpoch();
    if (epoch === this.epoch) {
      // 依赖没变：如果还在等待，说明确实缺依赖（ready 可以先落地）
      if (this._state === FiberState.PENDING) this.settle();
      return;
    }
    const prev = this.epoch;
    this.epoch = epoch;
    if (epoch === INACTIVE) {
      if (this._state === FiberState.ACTIVE || this._state === FiberState.LOADING) {
        void this.schedule(() => this.deactivate(FiberState.PENDING));
      }
      return;
    }
    if (prev === INACTIVE) {
      void this.schedule(() => this.activate());
      return;
    }
    // 依赖换了实现（epoch 串变了）→ 卸载重载，这正是"服务被替换"的语义
    void this.schedule(() => this.reload());
  }

  computeEpoch(): string {
    let epoch = "";
    for (const name of this.injectNames) {
      const entry = this.host.reflect.get(this.namespace, name);
      if (!entry) return INACTIVE;
      epoch += ":" + entry.fiber.uid;
    }
    return epoch;
  }

  private schedule(op: () => Promise<void>): Promise<void> {
    const run = this.queue.then(op, op);
    this.queue = run.catch((e) => {
      this.host.log("error", "fiber #" + this.uid + "（" + this.name + "）状态切换失败", e);
    });
    return run;
  }

  private async activate(): Promise<void> {
    if (this._state === FiberState.DISPOSED) return;
    this.setState(FiberState.LOADING);
    try {
      const result = await this.plugin.apply(this.ctx, this.config);
      const fns = await collectDisposables(result);
      for (const fn of fns) this.effectList.push({ label: "apply", fn, active: true });
      this._error = null;
      this.setState(FiberState.ACTIVE);
    } catch (e) {
      // 启动失败绝不留下半挂 fiber：先把自己已经注册的东西撤干净（lifecycle.js:25-35 的立场）
      this._error = e;
      await this.runEffects();
      this.setState(FiberState.FAILED);
      this.host.log("error", "插件 " + this.name + " 启动失败", e);
    }
    this.settle();
  }

  private async deactivate(next: FiberState): Promise<void> {
    if (this._state === FiberState.DISPOSED) return;
    this.setState(FiberState.UNLOADING);
    await this.runEffects();
    this.setState(next);
  }

  private async reload(): Promise<void> {
    await this.deactivate(FiberState.PENDING);
    await this.activate();
  }

  /** 逆序执行并**逐个吞掉异常**（fiber.ts:675-696）：一个坏 disposer 不能阻断其余 */
  private async runEffects(): Promise<void> {
    const list = this.effectList.splice(0).reverse();
    for (const record of list) {
      record.active = false;
      try {
        await record.fn();
      } catch (e) {
        this.disposerFailures++;
        this.host.log("error", '卸载 effect "' + record.label + '"（fiber #' + this.uid + " " + this.name + "）失败", e);
      }
    }
  }

  /** 挂一个 effect（ctx.effect 的实现）；返回的 disposer 会把它从 fiber 上摘掉并立即执行 */
  pushEffect(label: string, fns: Disposer[]): Disposer {
    const records = fns.map((fn) => ({ label, fn, active: true }));
    this.effectList.push(...records);
    return () => {
      for (const record of records.reverse()) {
        if (!record.active) continue;
        record.active = false;
        const at = this.effectList.indexOf(record);
        if (at >= 0) this.effectList.splice(at, 1);
        try {
          void record.fn();
        } catch (e) {
          this.disposerFailures++;
          this.host.log("error", '手动注销 effect "' + label + '" 失败', e);
        }
      }
    };
  }

  effects(): { label: string; active: boolean }[] {
    return this.effectList.map((e) => ({ label: e.label, active: e.active }));
  }

  /**
   * 等本 fiber 的排队状态切换跑完（诊断、测试、以及"卸载完再重挂"的调用方用）。
   * epoch 触发的加载/卸载是异步排队的，await fiber.ready 只保证**首次**落地，
   * 想确认"卸载真的撤干净了"要等这个。
   */
  whenIdle(): Promise<void> {
    return this.queue;
  }

  /** 还挂着的 disposer 数（0 = 没有泄漏；P3.0 的验收指标之一） */
  pendingEffects(): number {
    return this.effectList.length;
  }

  childCount(): number {
    return this.children.size;
  }

  async dispose(): Promise<void> {
    if (this._state === FiberState.DISPOSED) return;
    // 立刻标成 DISPOSED：防止 dispose 排队期间 refresh() 又把它拉起来
    this.setState(FiberState.UNLOADING);
    return this.schedule(async () => {
      for (const child of [...this.children]) await child.dispose();
      this.children.clear();
      await this.runEffects();
      this.setState(FiberState.DISPOSED);
      this.parent?.children.delete(this);
      this.host.forget(this);
      this.settle();
    });
  }

  async update(config: unknown): Promise<void> {
    if (this._state === FiberState.DISPOSED) return;
    if (this.plugin.schema) {
      const res = this.plugin.schema["~standard"].validate(config ?? {});
      if ("issues" in res && res.issues) throw new ValidationError(this.name, res.issues);
      config = (res as { value?: unknown }).value;
    }
    const prev = this.config;
    this.config = config;
    try {
      await this.schedule(() => this.reload());
    } catch (e) {
      this.config = prev;
      throw e;
    }
  }

  /** 显式重启（FAILED 的插件唯一的恢复路径） */
  async restart(): Promise<void> {
    if (this._state === FiberState.DISPOSED) return;
    this.epoch = INACTIVE;
    const epoch = this.computeEpoch();
    this.epoch = epoch;
    if (epoch === INACTIVE) {
      this._state = FiberState.PENDING;
      if (!this.settled) this.settle();
      return;
    }
    await this.schedule(() => this.reload());
  }

  then<TResult1 = void, TResult2 = never>(
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.ready.then(onfulfilled, onrejected);
  }
}

/** 同步摊平（能给就给；遇到 thenable / async iterable 返回 null，交给异步版本） */
export function collectSync(input: Disposable): Disposer[] | null {
  if (input === null || input === undefined) return [];
  if (typeof input === "function") return [input as Disposer];
  if (typeof (input as { then?: unknown }).then === "function") return null;
  if (typeof (input as AsyncIterable<Disposable>)[Symbol.asyncIterator] === "function") return null;
  const iter = input as Iterable<Disposable>;
  if (typeof iter[Symbol.iterator] === "function") {
    const out: Disposer[] = [];
    for (const item of iter) {
      const sub = collectSync(item);
      if (!sub) return null;
      out.push(...sub);
    }
    return out;
  }
  throw new Error("插件返回了不支持的形态（只接受 函数 / 函数数组 / Promise / async iterable）");
}

/** 规范化插件形态：函数 / {apply}；class 形态明确报错（不做半吊子支持） */
export function normalizePlugin(plugin: Plugin, label?: string): NormalizedPlugin {
  if (typeof plugin === "function") {
    const text = Function.prototype.toString.call(plugin).trimStart();
    if (text.startsWith("class ")) {
      throw new Error(
        "暂不支持 class 形态的插件（" + (label ?? plugin.name ?? "匿名") +
          "）：请改用 { name, inject, apply } 对象形态，行为一样但更容易诊断。",
      );
    }
    const injected = (plugin as unknown as { inject?: string[] }).inject ?? [];
    const provided = (plugin as unknown as { provide?: string | string[] }).provide;
    return {
      name: label ?? plugin.name ?? "anonymous",
      inject: [...injected],
      provide: provided ? (Array.isArray(provided) ? [...provided] : [provided]) : [],
      schema: (plugin as unknown as { Config?: StandardSchemaV1 }).Config,
      apply: plugin as unknown as (ctx: Context, config: unknown) => Disposable,
      kind: "function",
    };
  }
  if (plugin && typeof plugin === "object" && typeof (plugin as PluginObject).apply === "function") {
    const obj = plugin as PluginObject;
    return {
      name: label ?? obj.name ?? "anonymous",
      inject: obj.inject ? [...obj.inject] : [],
      provide: obj.provide ? (Array.isArray(obj.provide) ? [...obj.provide] : [obj.provide]) : [],
      schema: obj.config,
      apply: (ctx, config) => obj.apply(ctx, config),
      kind: "object",
    };
  }
  throw new Error("不是合法的插件：只接受函数或 { apply } 对象");
}
