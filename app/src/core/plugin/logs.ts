/**
 * 插件日志（P3.5）：`log.write` 的落点。
 *
 * P3.3 里 `ctx.log` 只往控制台打一行 —— 用户看不见、模型也看不见，
 * 于是"插件为什么不工作"这个问题只能靠猜。这里把它变成**有上限的环形缓冲**：
 *   - 面板能看（设置 → 插件日志）；
 *   - `plugin_diagnose` 能读（AI 闭环里"看日志"这一步）；
 *   - **有上限而且把丢了多少条如实报出来** —— 日志面板最常见的谎是"就这些"。
 *
 * 两条刻意的设计：
 *   1. **进程内**，不落盘：日志是运行现场，重启后"这卷日志"就不该还在（要长期审计是另一件事）。
 *   2. **每插件单独限流**：一个话痨插件不该把别人的日志挤掉（全局上限之外再按 pluginId 限一次）。
 */

import type { Disposer } from "../service/types";

export type PluginLogLevel = "info" | "warn" | "error";

export type PluginLogEntry = {
  /** 单调递增序号：排序稳定，也方便"我上次看到哪了" */
  seq: number;
  pluginId: string;
  level: PluginLogLevel;
  message: string;
  at: number;
};

export type PluginLogStoreOptions = {
  /** 全局上限（条） */
  max?: number;
  /** 单个插件的上限（条） */
  perPlugin?: number;
  /** 单条消息的长度上限（防止一个插件用一行 10MB 把缓冲撑爆） */
  maxMessageChars?: number;
  now?: () => number;
};

export class PluginLogStore {
  private entries: PluginLogEntry[] = [];
  private seq = 0;
  private dropped = 0;
  private listeners = new Set<() => void>();
  private versionValue = 0;
  private max: number;
  private perPlugin: number;
  private maxMessageChars: number;
  private now: () => number;

  constructor(opts: PluginLogStoreOptions = {}) {
    this.max = opts.max ?? 500;
    this.perPlugin = opts.perPlugin ?? 120;
    this.maxMessageChars = opts.maxMessageChars ?? 2000;
    this.now = opts.now ?? (() => Date.now());
  }

  write(pluginId: string, level: string, message: string): PluginLogEntry {
    const text = message.length > this.maxMessageChars ? message.slice(0, this.maxMessageChars) + "…（截断）" : message;
    const entry: PluginLogEntry = {
      seq: ++this.seq,
      pluginId,
      level: level === "error" ? "error" : level === "warn" ? "warn" : "info",
      message: text,
      at: this.now(),
    };
    this.entries.push(entry);
    this.trim(pluginId);
    this.changed();
    return entry;
  }

  /** 全局上限 + 单插件上限各裁一次；被丢掉的条数记在 dropped 里（面板要如实说） */
  private trim(pluginId: string): void {
    while (this.entries.length > this.max) {
      this.entries.shift();
      this.dropped++;
    }
    const mine = this.entries.filter((e) => e.pluginId === pluginId);
    if (mine.length > this.perPlugin) {
      const excess = mine.length - this.perPlugin;
      const victims = new Set(mine.slice(0, excess).map((e) => e.seq));
      this.entries = this.entries.filter((e) => !victims.has(e.seq));
      this.dropped += excess;
    }
  }

  /** 最近的在后（面板直接顺序渲染）；给了 pluginId 就只看它 */
  list(pluginId?: string, limit?: number): PluginLogEntry[] {
    const filtered = pluginId ? this.entries.filter((e) => e.pluginId === pluginId) : this.entries;
    const out = limit && limit > 0 ? filtered.slice(-limit) : filtered;
    return out.map((e) => ({ ...e }));
  }

  /** 清掉（指定插件或全部）；返回清掉几条 */
  clear(pluginId?: string): number {
    const before = this.entries.length;
    this.entries = pluginId ? this.entries.filter((e) => e.pluginId !== pluginId) : [];
    const removed = before - this.entries.length;
    if (removed) this.changed();
    return removed;
  }

  stats(): { kept: number; dropped: number; plugins: number } {
    return { kept: this.entries.length, dropped: this.dropped, plugins: new Set(this.entries.map((e) => e.pluginId)).size };
  }

  /** useSyncExternalStore 的快照 */
  version(): number {
    return this.versionValue;
  }

  onChange(fn: () => void): Disposer {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private changed(): void {
    this.versionValue++;
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        /* 订阅者抛错不影响日志本身 */
      }
    }
  }
}
