/**
 * Context 的实现（P3.0）。形状与 cordis 的 Context 同构（内部设计笔记 §5.2）：
 *   get / provide / effect / on / emit / inject / plugin / mixin / isolate
 *
 * 两条实现上的要点：
 *   1. **每个注册都挂到 fiber 上**（provide / effect / on / mixin 都是）。
 *      所以"卸载插件"= fiber.dispose()，没有第二条清理路径，也不会漏。
 *   2. **子上下文的原型指向父上下文**（Object.setPrototypeOf），于是 mixin 到父级的服务方法
 *      在子级可见、而子级自己的属性遮蔽父级 —— 与 cordis 的 extend 行为一致。
 */

import { collectDisposables, collectSync, normalizePlugin, type Fiber, type NormalizedPlugin } from "./fiber";
import { isContextBoundService, type Context, type Disposable, type Disposer, type Plugin } from "./types";

export type ContextHost = {
  reflect: import("./reflect").Reflect;
  createContext(fiber: Fiber, parent: ContextImpl | null, namespace: string): Context;
  spawn(namespace: string, parent: Fiber | null, parentCtx: ContextImpl | null, plugin: NormalizedPlugin, config: unknown): Fiber;
  notify(name: string): void;
  emit(event: string, ...args: unknown[]): void;
  on(event: string, fn: (...args: never[]) => void): Disposer;
  log(level: "info" | "warn" | "error", message: string, error?: unknown): void;
  recheck(): void;
};

export class ContextImpl implements Context {
  readonly fiber: Fiber;
  readonly namespace: string;
  private host: ContextHost;

  constructor(host: ContextHost, fiber: Fiber, namespace: string, parent: ContextImpl | null) {
    this.host = host;
    this.fiber = fiber;
    this.namespace = namespace;
    if (parent) Object.setPrototypeOf(this, parent);
  }

  get name(): string {
    return this.fiber.name;
  }

  get<T = unknown>(name: string): T | undefined {
    const value = this.host.reflect.get(this.namespace, name)?.value;
    // 按上下文绑定的服务（插槽）：按**调用者**的 ctx 现造一份 facade
    return isContextBoundService(value) ? (value(this) as T) : (value as T | undefined);
  }

  provide<T>(name: string, impl: T, check?: () => boolean): Disposer {
    const remove = this.host.reflect.provide(this.namespace, name, impl, this.fiber, check);
    // 注册本身就是一次 fiber effect：fiber 卸载 → 服务自动消失（DSH 的语义）
    return this.fiber.pushEffect("provide:" + name, [remove]);
  }

  effect(fn: (ctx: Context) => Disposable | Promise<Disposable>, label = "effect"): Disposer {
    const result = fn(this);
    const sync = result && typeof (result as Promise<Disposable>).then === "function" ? null : collectSync(result);
    if (sync) return this.fiber.pushEffect(label, sync);
    let handle: Disposer | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const fns = await collectDisposables(await result);
        if (cancelled) {
          for (const f of [...fns].reverse()) {
            try {
              await f();
            } catch {
              /* 已经取消：清理失败只记不抛 */
            }
          }
          return;
        }
        handle = this.fiber.pushEffect(label, fns);
      } catch (e) {
        this.host.log("error", 'effect "' + label + '" 执行失败', e);
      }
    })();
    return () => {
      cancelled = true;
      return handle?.();
    };
  }

  on(event: string, fn: (...args: never[]) => void): Disposer {
    const off = this.host.on(event, fn);
    return this.fiber.pushEffect("on:" + event, [off]);
  }

  emit(event: string, ...args: unknown[]): void {
    this.host.emit(event, ...args);
  }

  inject(deps: string[], cb: (ctx: Context) => Disposable): Disposer {
    // 与 DSH 同：等价 ctx.plugin({ inject, apply: cb })，依赖变化时卸载重跑
    const fiber = this.plugin(
      { name: "inject:" + deps.join("+"), inject: deps, apply: (c) => cb(c) },
      undefined,
    );
    return () => fiber.dispose();
  }

  plugin<P extends Plugin>(plugin: P, config?: unknown): Fiber {
    const normalized = normalizePlugin(plugin);
    return this.host.spawn(this.namespace, this.fiber, this, normalized, config);
  }

  mixin(source: object, keys: string[]): Disposer {
    const target = this as unknown as Record<string, unknown>;
    const src = source as unknown as Record<string, unknown>;
    const saved = keys.map((k) => [k, target[k]] as const);
    for (const k of keys) {
      const value = src[k];
      target[k] = typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(source) : value;
    }
    return this.fiber.pushEffect("mixin:" + keys.join(","), [
      () => {
        for (const [k, prev] of saved) {
          if (prev === undefined) delete target[k];
          else target[k] = prev;
        }
      },
    ]);
  }

  isolate(name: string, label?: string): Context {
    // 与 DSH 的差异：它按**服务名**分别打标签，我们按**整个子上下文**打（够用且更好理解）。
    // 服务键里已经带 namespace，所以将来要做逐服务隔离只需改 reflect 的 key。
    const tag = label ?? name;
    const namespace = this.namespace ? this.namespace + "/" + tag : tag;
    return this.host.createContext(this.fiber, this, namespace);
  }

  recheck(): void {
    this.host.recheck();
  }

  services(): string[] {
    return this.host.reflect.names(this.namespace);
  }
}
