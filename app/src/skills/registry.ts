/**
 * 技能注册表（P2.5）。形状对标 DSH 的 \`skills\` 服务（内部设计笔记 §1.4）：
 *   registerProvider / register（内存技能）/ list（概要）/ get（正文）/ snapshot（目录 + digest）。
 *
 * 与 DSH 一致的四条关键语义：
 *   1. **目录与正文分离**：list 只回概要，get 每次都向提供方要当前正文（正文从不缓存）；
 *   2. **同名裁决**：rank 小者赢 → 提供方注册序 → 提供方内部顺序；输的那个记进 shadowed 并告警；
 *   3. **失效只有一条路径**：提供方调 invalidate()（或运行时注册/注销）。没有 TTL、没有 watcher
 *      —— aireader 不做文件监听，用户装/删技能时显式刷新（§5.5 的取舍）；
 *   4. **digest 只由 [name, description] 决定**（对齐 dsh-tool-skill/lib/index.js:279-282）。
 *      描述里放会变的东西 = 每轮追加一条替换目录 = 前缀持续作废（§6.3）。
 *
 * 收集是异步的（用户技能要从盘上读），但**目录必须是同步可取的**：
 * 请求组装在 send() 里同步跑，所以刷新在启动时完成，之后 catalog() 只读缓存。
 */

import { fnv1a64 } from "../core/hash";
import {
  CATALOG_DESCRIPTION_MAX,
  type CatalogEntry,
  type CatalogSnapshot,
  type Disposer,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
  type SkillSummary,
} from "./types";

/** 描述进目录前归一化：空白折叠成单空格 → trim → 超长截断（对齐 DSH :337-340） */
export function normalizeDescription(desc: string, max = CATALOG_DESCRIPTION_MAX): string {
  const flat = desc.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, Math.max(0, max - 3)) + "...";
}

/**
 * 目录 digest（变更检测用，**不是密码学用途**）。输入与 DSH 逐字相同：
 * 每个条目取 JSON.stringify([name, description])，用 \n 连接；哈希实现见 core/hash.ts。
 */
export function catalogDigest(entries: CatalogEntry[]): string {
  return fnv1a64(entries.map((e) => JSON.stringify([e.name, e.description])).join("\n"));
}

/** 目录条目排序：**名字代码序**，永不用「最近使用」（§5.3） */
const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

type Collected = {
  candidates: SkillCandidate[];
  shadowed: { name: string; provider: string; by: string }[];
  warnings: string[];
  providers: string[];
  entries: CatalogEntry[];
  digest: string;
};

const EMPTY: Collected = {
  candidates: [],
  shadowed: [],
  warnings: [],
  providers: [],
  entries: [],
  digest: catalogDigest([]),
};

export class SkillRegistry {
  private providers: { provider: SkillProvider; order: number }[] = [];
  private runtime: SkillDefinition[] = [];
  /** 收集缓存：只在 revision 变化后重算（DSH 用 {cwd, scopeIds, revision} 做键，我们没有 cwd 轴） */
  private cache: Collected | null = null;
  /**
   * 上一次成功的收集结果。invalidate() 到下一次 refresh() 完成之间，catalog() 回这一份
   * （陈旧但可用）——否则 AI 刚写完技能那一瞬间的请求会拿到空目录。DSH 的 get() 也有同样的
   * "陈旧但可用"取舍（它只是把失效的代价留给下一次收集）。
   */
  private lastGood: Collected = EMPTY;
  private revision = 0;
  private nextOrder = 0;
  /** 变更订阅（界面提示「技能目录变了」用；返回 disposer） */
  private listeners = new Set<() => void>();

  /** 注册提供方，返回注销函数（对齐 DSH registerProvider 返回 disposer） */
  registerProvider(provider: SkillProvider): Disposer {
    const entry = { provider, order: this.nextOrder++ };
    this.providers.push(entry);
    this.invalidate();
    return () => {
      const at = this.providers.indexOf(entry);
      if (at < 0) return;
      this.providers.splice(at, 1);
      this.invalidate();
    };
  }

  /** 注册内存技能（插件自带、不落盘）。补默认 invocation 与 provider="runtime"，同层同名先到先得 */
  register(skill: Omit<SkillDefinition, "source" | "provider" | "invocation"> & {
    invocation?: Partial<SkillDefinition["invocation"]>;
    provider?: string;
  }): Disposer {
    const full: SkillDefinition = {
      ...skill,
      description: skill.description,
      invocation: {
        modelInvocable: skill.invocation?.modelInvocable ?? true,
        userInvocable: skill.invocation?.userInvocable ?? true,
      },
      source: "runtime",
      provider: skill.provider ?? "runtime",
    };
    if (this.runtime.some((s) => s.name === full.name)) {
      throw new Error('运行时技能 "' + full.name + '" 已经注册过（同名先到先得）');
    }
    this.runtime.push(full);
    this.invalidate();
    return () => {
      const at = this.runtime.findIndex((s) => s.name === full.name);
      if (at < 0) return;
      this.runtime.splice(at, 1);
      this.invalidate();
    };
  }

  /** 失效：唯一的变化入口（提供方自己调，或运行时注册/注销触发） */
  invalidate(): void {
    this.revision++;
    this.cache = null;
    this.emitChange();
  }

  private emitChange(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        /* 订阅者抛错不影响注册表 */
      }
    }
  }

  onChange(fn: () => void): Disposer {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 重新收集（异步：用户技能要读盘）。返回收集结果，界面用它显示技能数 */
  async refresh(): Promise<CatalogSnapshot> {
    const seen = new Map<string, SkillCandidate>();
    const shadowed: Collected["shadowed"] = [];
    const warnings: string[] = [];
    const providers: string[] = [];

    const all: SkillCandidate[] = [];
    let order = 0;
    for (const { provider } of this.providers) {
      providers.push(provider.id + "(" + provider.rank + ")");
      let list: SkillSummary[] = [];
      try {
        list = (await provider.list()) ?? [];
      } catch (e) {
        warnings.push("提供方 " + provider.id + " 列举失败：" + String(e instanceof Error ? e.message : e));
        order++;
        continue;
      }
      try {
        const w = (provider as { warnings?: () => string[] }).warnings?.();
        if (w?.length) warnings.push(...w);
      } catch {
        /* 告警读取失败不影响收集 */
      }
      list.forEach((s, localOrder) => {
        all.push({
          ...s,
          rank: provider.rank,
          providerOrder: order,
          localOrder,
        });
      });
      order++;
    }
    for (const s of this.runtime) {
      all.push({ ...s, rank: 0, providerOrder: 0, localOrder: 0 });
    }

    // 同名裁决：rank → 提供方注册序 → 提供方内部顺序；输的记进 shadowed
    all.sort((a, b) =>
      a.rank - b.rank || a.providerOrder - b.providerOrder || a.localOrder - b.localOrder || byName(a, b),
    );
    for (const c of all) {
      const existing = seen.get(c.name);
      if (existing) {
        shadowed.push({ name: c.name, provider: c.provider, by: existing.provider });
        warnings.push(
          '技能 "' + c.name + '"（' + c.provider + "）被更高优先级的同名技能（" + existing.provider + "）盖住，已忽略",
        );
        continue;
      }
      seen.set(c.name, c);
    }

    const candidates = [...seen.values()].sort(byName);
    const entries: CatalogEntry[] = candidates
      .filter((c) => c.invocation.modelInvocable)
      .map((c) => ({ name: c.name, description: normalizeDescription(c.description) }));

    const collected: Collected = {
      candidates,
      shadowed,
      warnings,
      providers,
      entries,
      digest: catalogDigest(entries),
    };
    const changed = collected.digest !== this.lastGood.digest;
    this.cache = collected;
    this.lastGood = collected;
    // 目录真的变了才通知（AI 写完技能、用户丢了个 SKILL.md 进来都会走到这里）：
    // 订阅者（界面）拿到的是**已经更新过**的快照，不会读到上一份。
    if (changed) this.emitChange();
    return this.snapshot();
  }

  /** 同步取目录（缓存为空时回空目录 —— 首轮之前必须已经 refresh 过） */
  catalog(): CatalogSnapshot {
    return this.snapshot();
  }

  private snapshot(): CatalogSnapshot {
    const c = this.cache ?? this.lastGood;
    return {
      entries: c.entries,
      digest: c.digest,
      shadowed: c.shadowed,
      providers: c.providers,
      warnings: c.warnings,
    };
  }

  /** 全部候选（含被盖掉之前的完整列表；诊断/设置界面用） */
  candidates(): SkillCandidate[] {
    return this.cache?.candidates ?? [];
  }

  /** 模型可调用的技能（目录里有的就是这些） */
  modelInvocable(): SkillCandidate[] {
    return this.candidates().filter((c) => c.invocation.modelInvocable);
  }

  /** 用户 /name 可调用的技能 */
  userInvocable(): SkillCandidate[] {
    return this.candidates().filter((c) => c.invocation.userInvocable);
  }

  has(name: string): boolean {
    return this.candidates().some((c) => c.name === name);
  }

  /**
   * 取正文：**每次都重新问提供方**（正文从不缓存，DSH 同）。
   * 定义名与候选项不符 → 视为失效并返回 undefined（DSH :250-264 的校验）。
   */
  async get(name: string): Promise<SkillDefinition | undefined> {
    const candidate = this.candidates().find((c) => c.name === name);
    if (!candidate) return undefined;
    const provider = this.providers.find((p) => p.provider.id === candidate.provider)?.provider;
    const fromRuntime = this.runtime.find((s) => s.name === name);
    const def = fromRuntime ?? (provider ? await provider.get(name) : undefined);
    if (!def) return undefined;
    if (def.name !== name || typeof def.content !== "string") {
      this.invalidate();
      return undefined;
    }
    const summary = this.candidates().find((c) => c.name === name);
    return {
      ...def,
      description: def.description || summary?.description || "",
      invocation: def.invocation ?? summary?.invocation ?? { modelInvocable: true, userInvocable: true },
      source: def.source ?? summary?.source ?? "runtime",
      provider: def.provider ?? summary?.provider ?? "unknown",
    };
  }
}

/** 从 user-invocable 的候选里给 "/" 触发器找匹配（前缀匹配，按名字排序） */
export function matchSkillSlash(list: SkillCandidate[], prefix: string): SkillCandidate[] {
  const p = prefix.toLowerCase();
  return list.filter((s) => s.name.startsWith(p)).sort(byName);
}

/**
 * 用户消息里的 /名字 手势（正则与 DSH 逐字相同：dsh-tool-skill/lib/index.js:351）。
 * **只扫用户自己发的文本**（§2.6）：别的来源伪造不了手势。
 */
export const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;

export function parseSkillGestures(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SKILL_GESTURE)) {
    if (!out.includes(m[2])) out.push(m[2]);
  }
  return out;
}
