/**
 * 服务容器的契约（P3.0）。形状对标 cordis（DSH 的服务容器层，见 内部设计笔记 §1、§5.2）。
 *
 * 四条不可省的纪律（§5.2 原文）：
 *   1. **每个注册返回 disposer**：provide / effect / on / inject / plugin 全部如此，
 *      卸载 = 逆序执行它们。全项目没有"手动清理清单"这条路径。
 *   2. **provider 变化时通知依赖者重新判定 epoch**（DSH 的 reflect.notify）。
 *   3. **卸载异常逐个吞掉并记日志**：一个坏 disposer 不能阻断其余（fiber.ts:675-696）。
 *   4. **依赖等待不是事件通知，是 epoch 比对**：把自己 inject 的每个服务的 provider-fiber uid
 *      串成字符串，串变了就卸载重载（fiber.ts:611-639）。这一条是整套容器的心脏。
 */

/** 卸载函数：同步或异步都可以（DSH：disposer 逆序执行且支持 async） */
export type Disposer = () => void | Promise<void>;

/** apply/effect 允许的返回形态（DSH 的 effect 形态很宽：函数 / 函数数组 / Promise / async iterable） */
export type Disposable =
  | Disposer
  | Iterable<Disposable>
  | AsyncIterable<Disposable>
  | Promise<Disposable>
  | void
  | null
  | undefined;

/** fiber 状态机（与 DSH 同名同义） */
export const FiberState = {
  PENDING: "PENDING",
  LOADING: "LOADING",
  ACTIVE: "ACTIVE",
  FAILED: "FAILED",
  UNLOADING: "UNLOADING",
  DISPOSED: "DISPOSED",
} as const;
export type FiberState = (typeof FiberState)[keyof typeof FiberState];

/** epoch 的特殊值：依赖缺失 → 等待（DSH 里是字符串 'INACTIVE'） */
export const INACTIVE = "INACTIVE";

export type ValidationIssue = { message: string; path?: readonly (string | number)[] };

/**
 * StandardSchemaV1 的最小面（DSH 的插件 config 就是这个接口，cordis/src/registry.ts:104）。
 * 只要求同步 validate：返回 {value} 或 {issues}。我们用 core/jsonSchema 的适配器实现它，
 * 不引第三方 schema 库（§1.4 的结论：接口就这一点，没必要为此拉一个依赖）。
 */
export type StandardSchemaV1<T = unknown> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    validate(value: unknown): { value: T } | { issues: readonly ValidationIssue[] };
  };
};

/** 插件形态一：函数；形态二：{ apply }；形态三：class（本容器不支持，见 registry.ts 的报错） */
export type PluginApply<C = unknown> = (ctx: Context, config: C) => Disposable;

export type PluginObject<C = unknown> = {
  /** 诊断用名字（DSH 里 name 只用于显示，真正的标识是回调本身） */
  name?: string;
  /** 硬依赖：缺失时 fiber 停在 PENDING，服务出现/更换时自动加载或重载 */
  inject?: string[];
  /**
   * 本插件提供的服务名。**只是元数据**（cordis/src/registry.ts:107 的注释就是这句：
   * "Service name(s) the plugin provides (read by Service and by loaders)"）。
   * 真正的注册动作永远是 ctx.provide(...)，provide 字段不产生任何行为——
   * 照它写权限判断会得到"看起来能约束、实际拦不住"的假安全。
   */
  provide?: string | string[];
  /** 配置 schema：同步校验，失败 → fiber FAILED（绝不半挂） */
  config?: StandardSchemaV1<C>;
  apply: PluginApply<C>;
};

export type Plugin<C = unknown> = PluginApply<C> | PluginObject<C>;

/**
 * 按上下文绑定的服务：有些服务（插槽）必须知道**是谁在调用** —— 插件注册的 disposer
 * 要挂到那个插件的 fiber 上，而不是挂到服务自己的 fiber 上。
 * 所以"服务"可以是一个工厂函数并标上 contextBound，ctx.get(name) 时按调用者的 ctx 现造。
 */
export type ContextBoundService<T> = ((ctx: Context) => T) & { readonly contextBound: true };

export function contextBoundService<T>(factory: (ctx: Context) => T): ContextBoundService<T> {
  return Object.assign(factory, { contextBound: true as const });
}

export function isContextBoundService(value: unknown): value is ContextBoundService<unknown> {
  return typeof value === "function" && (value as { contextBound?: unknown }).contextBound === true;
}

/** 事件名（内部事件面；插件也能用） */
export const FIBER_STATE_EVENT = "fiber/state";
export const SERVICE_CHANGE_EVENT = "service/change";

export type FiberStateEvent = {
  uid: number;
  name: string;
  state: FiberState;
  error?: unknown;
};

/**
 * Context：插件能看到的一切（§5.2 的接口形状，逐条对应）。
 * 服务读取走 get()，硬依赖走 inject，注册一律返回 disposer。
 */
export interface Context {
  /** 当前 fiber（根上下文是 root fiber；服务注册会挂在它上面） */
  readonly fiber: Fiber;
  /** 诊断名 */
  readonly name: string;
  /** 可选查询：不建立依赖；strict 语义下只返回 ACTIVE 且 check() 为真的实现 */
  get<T = unknown>(name: string): T | undefined;
  /** 注册服务；返回注销函数。同名在同一作用域内重复注册**抛错**（DSH 同） */
  provide<T>(name: string, impl: T, check?: () => boolean): Disposer;
  /** 注册一次副作用：fn 返回的 disposer 会挂到当前 fiber 上，卸载时逆序执行 */
  effect(fn: (ctx: Context) => Disposable | Promise<Disposable>, label?: string): Disposer;
  /** 事件：返回注销函数 */
  on(event: string, fn: (...args: never[]) => void): Disposer;
  emit(event: string, ...args: unknown[]): void;
  /** 延迟执行：依赖齐了才跑，依赖变化时卸载重跑（等价 ctx.plugin({inject, apply})） */
  inject(deps: string[], cb: (ctx: Context) => Disposable): Disposer;
  /** 挂一个插件：返回 fiber（可直接 await，见 fiber.ready 的语义） */
  plugin<P extends Plugin>(plugin: P, config?: unknown): Fiber;
  /** 把服务方法挂到 ctx 上并绑定 this（ctx.tools.get(...) 这种语法） */
  mixin(source: object, keys: string[]): Disposer;
  /** 服务作用域隔离：在返回的 ctx 之下 name 解析到新标签（父级不受影响） */
  isolate(name: string, label?: string): Context;
  /** check() 谓词翻转后调用：让所有带 inject 的 fiber 重新判定 epoch */
  recheck(): void;
  /** 诊断：当前可见的服务名 */
  services(): string[];
}

/** Fiber 的对外形状（与 Context 分开，避免循环依赖） */
export interface Fiber {
  readonly uid: number;
  readonly name: string;
  readonly injectNames: readonly string[];
  readonly provideNames: readonly string[];
  readonly state: FiberState;
  /** 首次加载结束（ACTIVE / PENDING / FAILED）；FAILED 时 reject */
  readonly ready: Promise<void>;
  readonly error: unknown;
  /** 诊断：本 fiber 上还挂着的 effect（label + 是否还在） */
  effects(): { label: string; active: boolean }[];
  /** 等排队的加载/卸载跑完（await ready 只保证首次落地） */
  whenIdle(): Promise<void>;
  /** 还挂着的 disposer 数（0 = 没有泄漏；卸载插件后应当归零） */
  pendingEffects(): number;
  dispose(): Promise<void>;
  update(config: unknown): Promise<void>;
  restart(): Promise<void>;
  then<TResult1 = void, TResult2 = never>(
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
}
