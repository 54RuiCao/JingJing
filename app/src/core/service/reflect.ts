/**
 * 服务存储（P3.0）。对标 cordis 的 reflect 层（cordis/src/reflect.ts:277-336）：
 *   provide(name, value, check?) —— 注册本身就是一次 fiber effect，返回的 disposer 负责删掉它
 *   并**通知依赖者重新判定**（依赖方不是靠事件被"叫醒"，而是被叫去比 epoch）。
 *
 * 三条与 DSH 一致的语义：
 *   1. 同名服务在同一作用域内重复注册**抛错**（service "x" has been registered at ...）；
 *   2. check?: () => boolean 是"可用性谓词"：为 false 时依赖方**当作它不存在**（继续 park）；
 *   3. 只有 provider fiber 处于 ACTIVE 时服务才算存在 —— 在 cordis 里服务注册本就是 fiber
 *      的 effect，卸载即消失；我们用"entry 存在 ⇔ provider 还在"来保证同一条语义。
 */

import type { Disposer, Fiber } from "./types";

export type ServiceEntry<T = unknown> = {
  name: string;
  value: T;
  fiber: Fiber;
  check?: () => boolean;
};

export type ReflectHost = {
  /** provider 变化 → 通知依赖者重新判定 epoch */
  notify(name: string): void;
  log(level: "info" | "warn" | "error", message: string, error?: unknown): void;
};

export class Reflect {
  private store = new Map<string, ServiceEntry>();

  constructor(private host: ReflectHost) {}

  /** 作用域键：namespace 为空就是全局层（isolate 会把标签拼进来） */
  private key(namespace: string, name: string): string {
    return namespace ? namespace + "\u0000" + name : name;
  }

  provide<T>(namespace: string, name: string, value: T, fiber: Fiber, check?: () => boolean): Disposer {
    const key = this.key(namespace, name);
    const existing = this.store.get(key);
    if (existing) {
      throw new Error(
        '服务 "' + name + '" 已经被注册过了（provider fiber #' + existing.fiber.uid + " " + existing.fiber.name +
          "）。同名服务在同一作用域只能有一个：要么换个名字，要么先注销旧的。",
      );
    }
    const entry: ServiceEntry<T> = { name, value, fiber, check };
    this.store.set(key, entry as ServiceEntry);
    this.host.notify(name);
    return () => {
      if (this.store.get(key) !== (entry as ServiceEntry)) return;
      this.store.delete(key);
      this.host.notify(name);
    };
  }

  /**
   * 取服务。strict（默认）：只有 check() 为真、且 provider fiber 还活着才算可用。
   * 注意 provider 的 ACTIVE 判定由 fiber 负责（服务在 fiber 卸载时就被注销了），
   * 这里只兜一道"provider 已经不在了"的保险。
   */
  get(namespace: string, name: string): ServiceEntry | undefined {
    const entry = this.store.get(this.key(namespace, name));
    if (!entry) return undefined;
    if (entry.check && !entry.check()) return undefined;
    return entry;
  }

  /** 不看 check 的原始条目（诊断与 epoch 计算用） */
  raw(namespace: string, name: string): ServiceEntry | undefined {
    return this.store.get(this.key(namespace, name));
  }

  has(namespace: string, name: string): boolean {
    return this.get(namespace, name) !== undefined;
  }

  names(namespace: string): string[] {
    const prefix = namespace ? namespace + "\u0000" : "";
    const out: string[] = [];
    for (const [key, entry] of this.store) {
      if (!namespace || key.startsWith(prefix)) out.push(entry.name);
    }
    return out.sort();
  }

  size(): number {
    return this.store.size;
  }
}
