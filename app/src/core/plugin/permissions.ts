/**
 * 权限模型（P3.3）。照 内部设计笔记 §5.5：
 *
 *   三档状态：**unknown → granted(once | always) → denied**，默认 **deny**；
 *   无应答者时按「拒绝关闭」（fail closed）处理。
 *   授权对象是 (pluginId, version?, capability, scope)，scope 形如
 *   { paths: ["<bookDir>/**"], origins: ["api.deepseek.com"] }。
 *
 * 两条与 DSH 不同、但 aireader 必须有的：
 *   1. **授权要持久化**（DSH 只做一次性授权，没有 allow-always、没有规则存储与撤销）；
 *   2. 存放位置**绝不在插件目录里** —— 插件能写自己的目录 = 权限系统自废（§5.5），
 *      所以和插件选项一样进应用设置表。
 *
 * 这一层是"该不该做"，不是"能不能做"：真正的边界在 Tauri capability；
 * 再往上一层是 quickjs 的宿主函数白名单（runtime-quickjs.ts）。
 */

import type { CapabilityId } from "./manifest";

/** 宿主**已经接上门面**的能力：没接上的能力既不会被授予，也不会被调用（会明确报错） */
export const HOST_IMPLEMENTED_CAPABILITIES: CapabilityId[] = [
  "reader.read",
  "reader.annotate",
  "reader.navigate",
  "storage.plugin",
  "log.write",
  // P3.4：UI 桥接上了 —— 动态包能往已声明的插槽里挂声明式界面（JSON VDOM），
  // 所以 ui.slot 从"只有词表"变成"有门面"，也就从此参与授权闸门。
  "ui.slot",
  // P3.6：主题 token 覆盖（ctx.theme.overrideTokens）
  "ui.theme",
  // P3.10：网络（ctx.net.fetch）。**范围是域名**：授权时给的是 manifest.network.origins
  // 那份清单，每次调用再按目标 origin 复核 —— 所以"授权了 api.deepseek.com"就真的只能访问它。
  "net.fetch",
  // P3.11：用宿主已配置的 AI Key。**范围同样是域名**（授权时记下当时的 provider origin），
  // 而且 Key 只用来在宿主侧拼一个 Authorization 请求头 —— 它不进沙箱，插件拿不到。
  "ai.credentials",
];

export type GrantMode = "once" | "always";
export type PermissionState = "unknown" | "granted" | "denied";

/** 授权范围：只对需要范围的能力有意义（fs/net），其余留空 */
export type PermissionScope = {
  paths?: string[];
  origins?: string[];
};

/** 一条"要申请什么"（不含 pluginId/version）：manifest → 申请清单的桥 */
export type CapabilityRequest = {
  capability: CapabilityId;
  /** 只对需要范围的能力有意义（net.fetch 的 origins） */
  scope?: PermissionScope;
  reason?: string;
};

/**
 * 从 manifest 推出申请清单（P3.10）。
 *
 * 为什么要有这一步：`capabilities` 只是一串能力名，而 `net.fetch` 必须**连同域名**一起申请，
 * 用户点"授权"时看到的才是"允许访问 api.deepseek.com"而不是"允许联网"。
 */
export function capabilityRequests(
  manifest: {
    capabilities?: CapabilityId[];
    network?: { origins?: string[] };
  },
  /**
   * 宿主当前的 AI 服务地址（P3.11）：`ai.credentials` 的范围就是它 ——
   * 授权时把当时的 provider 域名写进记录，将来用户换了服务，旧授权不会跟着漂过去。
   */
  aiOrigin?: string | null,
): CapabilityRequest[] {
  return (manifest.capabilities ?? []).map((capability) => {
    if (capability === "net.fetch") {
      return {
        capability,
        scope: { origins: manifest.network?.origins ?? [] },
        reason: "访问 " + ((manifest.network?.origins ?? []).join(" / ") || "（未声明域名）"),
      };
    }
    if (capability === "ai.credentials") {
      return {
        capability,
        ...(aiOrigin ? { scope: { origins: [aiOrigin] } } : {}),
        reason: aiOrigin
          ? "用你配置的 " + aiOrigin + " 上的 AI Key（只对 GET 生效，Key 不会交给插件）"
          : "用你配置的 AI Key（当前还没配置服务地址）",
      };
    }
    return { capability };
  });
}

export type PermissionRequest = {
  pluginId: string;
  /** 授权绑版本：once 只覆盖当前版本；always 覆盖该插件后续版本 */
  version: string;
  capability: CapabilityId;
  scope?: PermissionScope;
  /** 给用户看的一句话：为什么需要它 */
  reason?: string;
};

export type PermissionRecord = PermissionRequest & {
  state: "granted" | "denied";
  mode?: GrantMode;
  at: number;
};

export type PermissionDecision = {
  granted: boolean;
  /** 单勾 = once（只当前包），双勾 = always（后续版本也算） */
  mode?: GrantMode;
};

/**
 * 询问入口。**没有应答者 = 拒绝**：宁可让插件挂不起来，也不能悄悄放行。
 * 界面实现它（设置面板弹一条询问），没问题。
 */
export type PermissionAnswerer = (req: PermissionRequest, state: PermissionState) => Promise<PermissionDecision>;

export type PermissionStore = {
  ready(): Promise<void>;
  all(): PermissionRecord[];
  save(records: PermissionRecord[]): Promise<void>;
};

export type Disposer = () => void;

/** 范围覆盖：granted 必须完全包含 requested（没要范围就永远满足） */
export function scopeCovers(granted: PermissionScope | undefined, requested: PermissionScope | undefined): boolean {
  const coversList = (g: string[] | undefined, r: string[] | undefined): boolean => {
    if (!r || !r.length) return true;
    if (!g || !g.length) return false;
    return r.every((want) => g.some((have) => want === have || want.startsWith(have.replace(/\*+$/, ""))));
  };
  return coversList(granted?.paths, requested?.paths) && coversList(granted?.origins, requested?.origins);
}

export class PermissionBroker {
  private records: PermissionRecord[] = [];
  private listeners = new Set<() => void>();
  private store: PermissionStore;
  private answerer?: PermissionAnswerer;
  private log: (level: "info" | "warn" | "error", message: string, error?: unknown) => void;
  private now: () => number;
  /** 正在询问中的请求（同一个请求并发只问一次） */
  private pending = new Map<string, Promise<boolean>>();

  constructor(opts: {
    store: PermissionStore;
    answerer?: PermissionAnswerer;
    log?: (level: "info" | "warn" | "error", message: string, error?: unknown) => void;
    now?: () => number;
  }) {
    this.store = opts.store;
    this.answerer = opts.answerer;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
  }

  setAnswerer(answerer: PermissionAnswerer | undefined): void {
    this.answerer = answerer;
  }

  async ready(): Promise<void> {
    await this.store.ready();
    this.records = [...this.store.all()];
  }

  private key(req: { pluginId: string; capability: string }): string {
    return req.pluginId + "\u0000" + req.capability;
  }

  /** 找到与该请求匹配的记录（版本规则：always 跨版本；once/denied 只认同一个版本） */
  private match(req: PermissionRequest): PermissionRecord | undefined {
    const candidates = this.records.filter((r) => r.pluginId === req.pluginId && r.capability === req.capability);
    // always 优先（它能跨版本），其次才是同版本的记录
    const always = candidates.find((r) => r.state === "granted" && r.mode === "always" && scopeCovers(r.scope, req.scope));
    if (always) return always;
    return candidates.find((r) => r.version === req.version && scopeCovers(r.scope, req.scope));
  }

  stateOf(req: PermissionRequest): PermissionState {
    const record = this.match(req);
    if (!record) return "unknown";
    return record.state;
  }

  /** 现在能不能用这个能力（每次调用都问一遍 —— 撤销因此立刻生效） */
  allows(req: PermissionRequest): boolean {
    return this.stateOf(req) === "granted";
  }

  /** 缺哪些能力（加载器用它决定"先别挂，等用户授权"）。带范围的能力要用 missingRequests */
  missing(pluginId: string, version: string, capabilities: CapabilityId[]): CapabilityId[] {
    return capabilities.filter((capability) => this.stateOf({ pluginId, version, capability }) === "unknown");
  }

  /**
   * 缺哪些**申请**（P3.10：带范围）。`net.fetch` 的判据是"这个域名被授权了吗"，
   * 不是"这个能力被授权过吗" —— 否则给了一个域名就等于给了整个互联网。
   */
  missingRequests(pluginId: string, version: string, requests: CapabilityRequest[]): CapabilityRequest[] {
    return requests.filter(
      (r) => this.stateOf({ pluginId, version, capability: r.capability, scope: r.scope }) === "unknown",
    );
  }

  /** 一次授权一组**申请**（面板的"授权"按钮走这里；范围跟着一起落库） */
  async grantRequests(
    pluginId: string,
    version: string,
    requests: CapabilityRequest[],
    mode: GrantMode = "once",
  ): Promise<PermissionRecord[]> {
    const out: PermissionRecord[] = [];
    for (const r of requests) {
      out.push(await this.grant({ pluginId, version, capability: r.capability, scope: r.scope, reason: r.reason }, mode));
    }
    return out;
  }

  /** 宿主还没接门面的能力（声明了也不会被授予） */
  unimplemented(capabilities: CapabilityId[]): CapabilityId[] {
    return capabilities.filter((c) => !HOST_IMPLEMENTED_CAPABILITIES.includes(c));
  }

  /** 未决 → 问用户；拒绝 / 没人应答 → false */
  async ensure(req: PermissionRequest): Promise<boolean> {
    const state = this.stateOf(req);
    if (state === "granted") return true;
    if (state === "denied") return false;
    const key = this.key(req);
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const task = (async () => {
      if (!this.answerer) {
        this.log("warn", "插件 " + req.pluginId + " 请求能力 " + req.capability + "，但当前没有应答者：按拒绝处理");
        return false;
      }
      let decision: PermissionDecision;
      try {
        decision = await this.answerer(req, state);
      } catch (e) {
        this.log("error", "询问能力 " + req.capability + " 失败：按拒绝处理", e);
        return false;
      }
      if (!decision?.granted) {
        await this.deny(req);
        return false;
      }
      await this.grant(req, decision.mode ?? "once");
      return true;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  async grant(req: PermissionRequest, mode: GrantMode = "once"): Promise<PermissionRecord> {
    const record: PermissionRecord = { ...req, state: "granted", mode, at: this.now() };
    this.records = [...this.records.filter((r) => !(r.pluginId === req.pluginId && r.capability === req.capability && r.version === req.version)), record];
    await this.store.save(this.records);
    this.changed();
    return record;
  }

  async deny(req: PermissionRequest): Promise<void> {
    const record: PermissionRecord = { ...req, state: "denied", at: this.now() };
    this.records = [...this.records.filter((r) => !(r.pluginId === req.pluginId && r.capability === req.capability && r.version === req.version)), record];
    await this.store.save(this.records);
    this.changed();
  }

  /** 一次授权一组能力（设置面板的"授权"按钮走这里） */
  async grantAll(pluginId: string, version: string, capabilities: CapabilityId[], mode: GrantMode = "once"): Promise<PermissionRecord[]> {
    const out: PermissionRecord[] = [];
    for (const capability of capabilities) out.push(await this.grant({ pluginId, version, capability }, mode));
    return out;
  }

  /** 一次拒绝一组能力（拒绝记进存储：DSH 的"用户明确拒绝后不得自动重试"） */
  async denyAll(pluginId: string, version: string, capabilities: CapabilityId[]): Promise<void> {
    for (const capability of capabilities) await this.deny({ pluginId, version, capability });
  }

  /** 撤销：某个插件的一个能力，或它的全部能力（撤销后要立刻停 —— 调用方负责卸载） */
  async revoke(pluginId: string, capability?: CapabilityId): Promise<void> {
    const before = this.records.length;
    this.records = this.records.filter((r) => !(r.pluginId === pluginId && (!capability || r.capability === capability)));
    if (this.records.length === before) return;
    await this.store.save(this.records);
    this.changed();
  }

  /** 授权列表（设置面板显示 + 插件列表显示） */
  list(pluginId?: string): PermissionRecord[] {
    return this.records.filter((r) => !pluginId || r.pluginId === pluginId).map((r) => ({ ...r }));
  }

  onChange(fn: () => void): Disposer {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private changed(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (e) {
        this.log("error", "权限订阅者抛错", e);
      }
    }
  }
}

// ---------- 存储实现 ----------

export const PERMISSIONS_KEY = "plugins.permissions";

export type SettingsLike = {
  getSetting<T>(key: string, fallback: T): Promise<T>;
  setSetting(key: string, value: unknown): Promise<void>;
};

export function createMemoryPermissionStore(initial: PermissionRecord[] = []): PermissionStore & { records: PermissionRecord[] } {
  const table = [...initial];
  return {
    records: table,
    ready: async () => {},
    all: () => [...table],
    save: async (records) => {
      table.length = 0;
      table.push(...records);
    },
  };
}

export function createSettingsPermissionStore(settings: SettingsLike): PermissionStore {
  let table: PermissionRecord[] | null = null;
  return {
    async ready() {
      table = (await settings.getSetting<PermissionRecord[]>(PERMISSIONS_KEY, [])) ?? [];
    },
    all: () => [...(table ?? [])],
    async save(records) {
      table = [...records];
      await settings.setSetting(PERMISSIONS_KEY, table);
    },
  };
}
