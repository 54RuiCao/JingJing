/**
 * 插槽内核（P3.2）：**不认识 React**，只管"谁在哪个格子里、谁盖住谁、谁声明了什么"。
 *
 * 为什么内核要独立：DSH 的 ui-slots 也是纯数据层（React 在 ui-renderer 里），
 * 于是插槽语义可以在 node 里直接断言（tools/slots-test.ts 就是这么做的），
 * 也避免"React 树一变就说不清到底谁占了格子"。
 *
 * 规则（与 DSH 逐条对齐，§3.1）：
 *   - 未声明的槽位注册 → 抛错；
 *   - single：同格子同 priority 再注册 → 抛错（覆盖必须显式换 priority）；
 *   - keyed：同 key 同 priority → 抛错；list：同 id 同 priority → 抛错；
 *   - 每个格子取**排序最前的存活 entry**（priority 小 → order 小 → 注册早）；
 *   - 子槽位只能由落在父槽位上的那个 entry 声明，且**递归级联释放**；
 *   - 崩溃（abdicate）只是把 entry 从格子里摘掉，注册账本与 disposer 都不动。
 */

import { t } from "../../i18n";
import {
  SlotError,
  type SlotCatalogEntry,
  type SlotCell,
  type SlotDeclaration,
  type SlotEntry,
  type SlotKind,
  type SlotsReader,
  type SlotRegistration,
} from "./types";

type SlotRecord = {
  name: string;
  declaration: SlotDeclaration;
  declaredByUid: number | null;
  declaredByLabel: string | null;
};

const cellKeyOf = (kind: SlotKind, entry: { id: string; key: string }): string =>
  kind === "list" ? entry.id : kind === "keyed" ? entry.key : "";

export type SlotOwner = { label: string; uid: number };

export class SlotCore implements SlotsReader {
  private slots = new Map<string, SlotRecord>();
  private entries = new Map<number, SlotEntry>();
  private bySlot = new Map<string, Set<number>>();
  private listeners = new Set<() => void>();
  private waiters: { name: string; run: () => void }[] = [];
  /** 父 entry 的 uid → 它声明的子槽位（相对 key 用于 renderSlot 授权，全名用于级联与诊断） */
  private children = new Map<number, { key: string; full: string }[]>();
  /** 渲染期崩掉的 entry（诊断） */
  private lastErrors = new Map<number, string>();
  private uidSeq = 0;
  private seqSeq = 0;
  private versionCount = 0;
  /** 声明纪元：只在声明/崩塌时 +1（DSH 用 declarationEpoch 判断 inject 要不要重跑） */
  private declEpoch = 0;

  // ---------- 声明 ----------

  declare(name: string, declaration: SlotDeclaration, owner: SlotOwner | null = null): () => void {
    if (this.slots.has(name)) {
      const by = this.slots.get(name)?.declaredByLabel ?? t("plug.slot.hostFallback");
      throw new SlotError("ALREADY_DECLARED", t("plug.slot.alreadyDeclared", { slot: name, owner: by }));
    }
    this.slots.set(name, {
      name,
      declaration,
      declaredByUid: owner?.uid ?? null,
      declaredByLabel: owner?.label ?? null,
    });
    this.declEpoch++;
    this.changed();
    this.runWaiters();

    return () => {
      if (!this.slots.has(name)) return;
      this.slots.delete(name);
      // 级联：这个槽位上的所有 entry 一起摘掉（它们本来就只活在父 entry 里）
      for (const uid of [...(this.bySlot.get(name) ?? [])]) this.release(uid);
      this.bySlot.delete(name);
      this.declEpoch++;
      this.changed();
    };
  }

  // ---------- 注册 ----------

  register<P>(options: SlotRegistration<P>, owner: SlotOwner): () => void {
    const record = this.slots.get(options.name);
    if (!record) {
      throw new SlotError("NOT_DECLARED", t("plug.slot.notDeclared", { slot: options.name }));
    }
    const kind = record.declaration.kind;
    if (kind === "list" && !options.id) {
      throw new SlotError("INVALID_REGISTRATION", t("plug.slot.listNeedsId", { slot: options.name }));
    }
    if (kind === "keyed" && !options.key) {
      throw new SlotError("INVALID_REGISTRATION", t("plug.slot.keyedNeedsKey", { slot: options.name }));
    }
    if (kind === "chain" && typeof options.select !== "function") {
      throw new SlotError("INVALID_REGISTRATION", t("plug.slot.chainNeedsSelect", { slot: options.name }));
    }
    if (typeof options.component !== "function" && typeof options.component !== "object") {
      throw new SlotError("INVALID_REGISTRATION", t("plug.slot.needsComponent"));
    }

    const entry: SlotEntry = {
      uid: ++this.uidSeq,
      slot: options.name,
      id: options.id ?? "",
      key: options.key ?? "",
      priority: options.priority ?? 0,
      order: options.order ?? 0,
      seq: ++this.seqSeq,
      label: options.label,
      owner: owner.label,
      ownerUid: owner.uid,
      abdicated: false,
      component: options.component,
      props: options.props as SlotEntry["props"],
      select: options.select,
    };
    const cellKey = cellKeyOf(kind, entry);

    // 同格子同 priority → 抛错（覆盖必须是显式行为）。
    // **chain 例外**：它的条目本来就要并存，谁上由渲染时的 select 决定（DSH 同）。
    for (const uid of kind === "chain" ? [] : (this.bySlot.get(options.name) ?? [])) {
      const other = this.entries.get(uid);
      if (!other || other.abdicated) continue;
      if (cellKeyOf(kind, other) !== cellKey) continue;
      if (other.priority === entry.priority) {
        throw new SlotError(
          "PRIORITY_CONFLICT",
          cellKey
            ? t("plug.slot.priorityConflictInCell", {
                slot: options.name,
                cell: cellKey,
                owner: other.owner,
                priority: entry.priority,
              })
            : t("plug.slot.priorityConflict", {
                slot: options.name,
                owner: other.owner,
                priority: entry.priority,
              }),
        );
      }
    }

    this.entries.set(entry.uid, entry);
    let set = this.bySlot.get(options.name);
    if (!set) {
      set = new Set();
      this.bySlot.set(options.name, set);
    }
    set.add(entry.uid);
    this.changed();

    // 子槽位声明：**只有这个 entry 能声明**，且随它一起释放
    const declaredChildren: { key: string; full: string }[] = [];
    for (const [childKey, spec] of Object.entries(options.children ?? {})) {
      const childName = options.name + "." + childKey;
      this.declare(
        childName,
        {
          kind: spec.kind,
          scope: spec.scope,
          replaceRisk: spec.replaceRisk ?? "none",
          wired: false,
          description: spec.description,
        },
        // 子槽位的"声明者"是**这个 entry**（不是 fiber）：entry 一卸载就靠这个 uid 做级联
        { label: owner.label, uid: entry.uid },
      );
      declaredChildren.push({ key: childKey, full: childName });
    }
    if (declaredChildren.length) this.children.set(entry.uid, declaredChildren);

    return () => this.release(entry.uid);
  }

  /** 摘掉一个 entry（disposer 调用或级联释放）；它声明的子槽位递归释放 */
  release(uid: number): void {
    const entry = this.entries.get(uid);
    if (!entry) return;
    this.entries.delete(uid);
    this.bySlot.get(entry.slot)?.delete(uid);
    this.lastErrors.delete(uid);
    this.changed();

    const children = this.children.get(uid) ?? [];
    this.children.delete(uid);
    for (const { full: childName } of children) {
      const record = this.slots.get(childName);
      if (record?.declaredByUid !== uid) continue;
      this.slots.delete(childName);
      for (const childUid of [...(this.bySlot.get(childName) ?? [])]) this.release(childUid);
      this.bySlot.delete(childName);
      this.declEpoch++;
    }
    if (children.length) {
      this.changed();
      this.runWaiters();
    }
  }

  /** renderSlot 的授权检查按**相对 key**（DSH 同：props.renderSlot('child')） */
  ownsChild(uid: number, child: string): boolean {
    return (this.children.get(uid) ?? []).some((c) => c.key === child);
  }

  /** 诊断/报错文案里给全名，免得看的人还要自己拼 */
  childrenOf(uid: number): string[] {
    return (this.children.get(uid) ?? []).map((c) => c.full);
  }

  // ---------- 读取 ----------

  declared(name: string): boolean {
    return this.slots.has(name);
  }

  declaration(name: string): SlotDeclaration | undefined {
    return this.slots.get(name)?.declaration;
  }

  of(name: string): { declaration: SlotDeclaration; cells: SlotCell[] } | undefined {
    const record = this.slots.get(name);
    if (!record) return undefined;
    const kind = record.declaration.kind;
    const list = [...(this.bySlot.get(name) ?? [])]
      .map((uid) => this.entries.get(uid))
      .filter((e): e is SlotEntry => !!e)
      .sort((a, b) => a.priority - b.priority || a.order - b.order || a.seq - b.seq);

    const cells = new Map<string, SlotEntry[]>();
    for (const entry of list) {
      const key = cellKeyOf(kind, entry);
      const arr = cells.get(key) ?? [];
      arr.push(entry);
      cells.set(key, arr);
    }
    const out: SlotCell[] = [...cells.entries()].map(([cellKey, entries]) => {
      const winner = entries.find((e) => !e.abdicated) ?? null;
      return { cellKey, entries, winner, shadows: winner ? entries.filter((e) => e !== winner) : [] };
    });
    // list 的格子顺序 = 赢家的排序；single/keyed 就一个/按 key 稳定排序
    out.sort((a, b) => {
      const wa = a.winner ?? a.entries[0];
      const wb = b.winner ?? b.entries[0];
      if (!wa || !wb) return 0;
      return wa.priority - wb.priority || wa.order - wb.order || wa.seq - wb.seq;
    });
    return { declaration: record.declaration, cells: out };
  }

  catalog(): SlotCatalogEntry[] {
    return [...this.slots.values()]
      .map((record) => {
        const info = this.of(record.name);
        const regs = info?.cells.flatMap((c) => c.entries) ?? [];
        return {
          name: record.name,
          ...record.declaration,
          declaredBy: record.declaredByLabel,
          cells: (info?.cells ?? []).map((c) => ({
            key: c.cellKey,
            winner: c.winner?.label ?? c.winner?.owner ?? null,
            shadows: c.shadows.map((s) => s.label ?? s.owner),
          })),
          registrationCount: regs.length,
        };
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  version(): number {
    return this.versionCount;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  abdicate(uid: number, error: unknown): void {
    const entry = this.entries.get(uid);
    if (!entry) return;
    // **chain 不摘格**（DSH：选举候选在 select 时兜底，摘掉它反而丢了下一个候选）：
    // 只把错误记下来，条目的 abdicated 保持 false。这里是内核层的兜底 ——
    // 就算调用方按"崩了就摘"来调，chain 也不会被摘。
    if (this.slots.get(entry.slot)?.declaration.kind !== "chain") entry.abdicated = true;
    this.lastErrors.set(uid, String(error));
    this.changed();
  }

  /** 渲染期错误（诊断面板用） */
  renderErrors(): { slot: string; owner: string; message: string }[] {
    return [...this.lastErrors.entries()].map(([uid, message]) => {
      const entry = this.entries.get(uid);
      return { slot: entry?.slot ?? "?", owner: entry?.owner ?? "?", message };
    });
  }

  /** 复活被 abdicate 的 entry（换版本重挂插件时用；DSH 里也要重新注册才行） */
  revive(uid: number): void {
    const entry = this.entries.get(uid);
    if (!entry) return;
    entry.abdicated = false;
    this.lastErrors.delete(uid);
    this.changed();
  }

  private changed(): void {
    this.versionCount++;
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        /* 订阅者抛错不影响内核 */
      }
    }
  }

  // ---------- 等声明（slots.inject 的底） ----------

  private runWaiters(): void {
    if (!this.waiters.length) return;
    const pending = this.waiters.filter((w) => this.slots.has(w.name));
    this.waiters = this.waiters.filter((w) => !this.slots.has(w.name));
    for (const w of pending) {
      try {
        w.run();
      } catch {
        /* 等待者抛错不影响内核 */
      }
    }
  }

  /** 等某个槽位被声明 */
  whenDeclared(name: string, run: () => void): () => void {
    if (this.slots.has(name)) {
      run();
      return () => {};
    }
    const waiter = { name, run };
    this.waiters.push(waiter);
    return () => {
      const at = this.waiters.indexOf(waiter);
      if (at >= 0) this.waiters.splice(at, 1);
    };
  }

  /** 诊断用：当前有多少人在等声明 */
  waiterCount(): number {
    return this.waiters.length;
  }

  declarationEpoch(): number {
    return this.declEpoch;
  }

  /** 全部 entry 数（含被盖住与被 abdicate 的） */
  entryCount(): number {
    return this.entries.size;
  }

  slotCount(): number {
    return this.slots.size;
  }
}
