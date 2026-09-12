/**
 * 容器 + 插件注册表（P3.0）。对标 cordis 的 registry：**一个插件 = 一个 callback + N 个 fiber**
 * （registry.ts:136-145, 258-267）。
 *
 *   容器 = Reflect（服务存储）+ 事件总线 + 全部活着的 fiber + 一个 root fiber。
 *   root fiber 上的服务就是"应用能力的底座"（db / reader / theme / ai / skills / tools），
 *   内置插件是挂在它下面的子 fiber —— 于是"卸载一个内置插件"和"卸载第三方插件"是同一条路径。
 *
 * 事件面（P3.0 起步）：fiber/state（状态转移）、service/change（服务增删）。
 * 诊断：diagnostics() 给出每个 fiber 的状态、还挂着的 effect 数、被吞掉的 disposer 异常数
 * —— "控制台无泄漏 disposer"这句话要能用数字说出来，不能靠感觉。
 */

import { ContextImpl, type ContextHost } from "./context";
import { Fiber, normalizePlugin, type FiberHost, type NormalizedPlugin } from "./fiber";
import { Reflect } from "./reflect";
import {
  FIBER_STATE_EVENT,
  SERVICE_CHANGE_EVENT,
  type Context,
  type Disposer,
  type FiberState,
} from "./types";

export type ContainerOptions = {
  /** 名字（诊断用），默认 "aireader" */
  name?: string;
  /** 日志出口：容器**从不**把异常抛给调用方，全部走这里（默认 console） */
  log?: (level: "info" | "warn" | "error", message: string, error?: unknown) => void;
};

export type FiberDiagnostics = {
  uid: number;
  name: string;
  state: FiberState;
  inject: readonly string[];
  parent: number | null;
  effects: { label: string; active: boolean }[];
  pendingEffects: number;
  disposerFailures: number;
};

export type ContainerDiagnostics = {
  services: string[];
  fibers: FiberDiagnostics[];
  /** 所有 fiber 上还挂着的 disposer 总数（容器整体释放后应当为 0） */
  pendingEffects: number;
  /** 被吞掉的 disposer 异常总数（>0 说明有插件的清理在报错） */
  disposerFailures: number;
  logErrors: number;
};

type ContainerHost = FiberHost & ContextHost;

export class Container {
  readonly reflect: Reflect;
  readonly root: Fiber;
  readonly ctx: Context;
  private fibers = new Set<Fiber>();
  private listeners = new Map<string, Set<(...args: never[]) => void>>();
  private host: ContainerHost;
  private logFn: (level: "info" | "warn" | "error", message: string, error?: unknown) => void;
  private logErrors = 0;
  private disposed = false;

  constructor(options: ContainerOptions = {}) {
    const name = options.name ?? "aireader";
    this.logFn =
      options.log ??
      ((level, message, error) => {
        if (level === "error") console.error("[aireader/container] " + message, error ?? "");
        else if (level === "warn") console.warn("[aireader/container] " + message);
        else console.info("[aireader/container] " + message);
      });
    this.reflect = new Reflect({
      notify: (serviceName) => this.notify(serviceName),
      log: (level, message, error) => this.log(level, message, error),
    });
    this.host = {
      reflect: this.reflect,
      createContext: (fiber, parent, namespace) =>
        new ContextImpl(this.host, fiber, namespace, (parent as ContextImpl | null) ?? null),
      spawn: (namespace, parent, parentCtx, plugin, config) =>
        this.spawn(namespace, parent, parentCtx, plugin, config),
      notify: (serviceName) => this.notify(serviceName),
      // 卸载后**保留** fiber 记录：诊断要能看到"这个插件曾经在、现在 DISPOSED"，
      // 也才能验证"没有泄漏 disposer"（DSH 的 getEffects() 诊断树同理）。
      forget: () => {},
    
      emit: (event, ...args) => this.emit(event, ...args),
      on: (event, fn) => this.on(event, fn),
      log: (level, message, error) => this.log(level, message, error),
      recheck: () => this.recheck(),
    };
    this.root = new Fiber(this.host, normalizePlugin({ name, apply: () => {} }), {}, null, "");
    this.fibers.add(this.root);
    this.ctx = this.root.ctx;
    void this.root.begin();
  }

  private log(level: "info" | "warn" | "error", message: string, error?: unknown): void {
    if (level === "error") this.logErrors++;
    try {
      this.logFn(level, message, error);
    } catch {
      /* 日志出口自己坏了也不能影响容器 */
    }
  }

  /** 服务变化 → 通知**依赖它的** fiber 重新判定 epoch（不是"叫醒它"，是"让它去比"） */
  notify(name: string): void {
    this.emit(SERVICE_CHANGE_EVENT, { name });
    for (const fiber of [...this.fibers]) {
      if (fiber.injectNames.includes(name)) fiber.refresh();
    }
  }

  /** check() 谓词翻转后由服务提供方调用：所有带 inject 的 fiber 重新判定 */
  recheck(): void {
    for (const fiber of [...this.fibers]) fiber.refresh();
  }

  private spawn(
    namespace: string,
    parent: Fiber | null,
    parentCtx: ContextImpl | null,
    plugin: NormalizedPlugin,
    config: unknown,
  ): Fiber {
    if (this.disposed) throw new Error("容器已经释放，不能再挂插件");
    // parentCtx 交给 Fiber 去建 Context：父子原型链在 container.createContext 里接上
    const fiber = new Fiber(this.host, plugin, config, parent, namespace, parentCtx);
    this.fibers.add(fiber);
    void fiber.begin();
    return fiber;
  }

  /** 挂一个插件（等价 ctx.plugin，但不需要先有 ctx） */
  plugin(pluginDef: Parameters<Context["plugin"]>[0], config?: unknown): Fiber {
    const normalized = normalizePlugin(pluginDef);
    return this.spawn("", this.root, this.ctx as ContextImpl, normalized, config);
  }

  emit(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as (...a: unknown[]) => void)(...args);
      } catch (e) {
        this.log("error", '事件 "' + event + '" 的监听器抛错', e);
      }
    }
  }

  on(event: string, fn: (...args: never[]) => void): Disposer {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => {
      set?.delete(fn);
    };
  }

  /** 状态变化订阅（诊断界面用）：简化成"任一 fiber 变了" */
  onFiberState(fn: (e: { uid: number; name: string; state: FiberState; error?: unknown }) => void): Disposer {
    return this.on(FIBER_STATE_EVENT, fn as (...args: never[]) => void);
  }

  /**
   * 等所有 fiber 的排队状态切换跑完。epoch 变化引发的加载/卸载是异步的，
   * "卸载一个插件、确认依赖它的插件真的 park 了"必须等这一下。
   */
  async settle(): Promise<void> {
    for (let round = 0; round < 3; round++) {
      const snapshot = [...this.fibers];
      await Promise.all(snapshot.map((f) => f.whenIdle().catch(() => {})));
      if (snapshot.length === this.fibers.size) break;
    }
  }

  diagnostics(): ContainerDiagnostics {
    const fibers = [...this.fibers].map((f) => ({
      uid: f.uid,
      name: f.name,
      state: f.state,
      inject: f.injectNames,
      parent: f.parent ? f.parent.uid : null,
      effects: f.effects(),
      pendingEffects: f.pendingEffects(),
      disposerFailures: f.disposerFailures,
    }));
    return {
      services: this.reflect.names(""),
      fibers,
      pendingEffects: fibers.reduce((sum, f) => sum + f.pendingEffects, 0),
      disposerFailures: fibers.reduce((sum, f) => sum + f.disposerFailures, 0),
      logErrors: this.logErrors,
    };
  }

  /** 释放整个容器：root fiber 级联卸载所有子 fiber，然后清空服务与监听器 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.root.dispose();
    this.listeners.clear();
    // 不清 this.fibers：释放之后 diagnostics() 仍然要能回答"还有没有残留 effect"
  }
}

export function createContainer(options?: ContainerOptions): Container {
  return new Container(options);
}
