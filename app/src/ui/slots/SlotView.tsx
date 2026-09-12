/**
 * 插槽的 React 绑定（P3.2）。
 *
 * 三条与 DSH 对齐的语义（§3.3）：
 *   1. **渲染子槽位必须用 props.renderSlot(key)**：拿别人的 key 去渲染会抛 SlotOwnershipError
 *      —— "谁能渲染哪一块"是机制，不是约定；
 *   2. **崩一个不连累别个**：entry 边界捕获 → 把该 entry 从格子里摘掉（abdicate），
 *      注册账本与 disposer 照常有效（§3.2）；
 *   3. chain 槽位本期没做：⟨renderSlotChain⟩ 存在但会抛一句明确的"未实现"，
 *      比"undefined is not a function"强得多。
 *
 * props 是**四份 share 的合并**：宿主传的 hostProps、entry 自己 props() 现算的业务 props、
 * 以及渲染子槽位用的两个函数。
 */

import { Component, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { t } from "../../i18n";
import { SlotError, type SlotEntry, type SlotsService } from "./types";

/** 渲染期边界：崩了就把这个 entry 摘掉，其他格子照常渲染 */
class SlotBoundary extends Component<{ onError: (error: unknown) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export type SlotViewProps = {
  slots: SlotsService;
  /** 槽位全名（例如 reader.view.tail） */
  name: string;
  /** 宿主侧上下文（例如当前书、当前主题），会并进每个 entry 的 props */
  hostProps?: Record<string, unknown>;
  className?: string;
  /** 槽位没声明 / 没有 entry 时渲染什么 */
  fallback?: ReactNode;
  /** 某个 entry 渲染崩了（已经摘掉它） */
  onError?: (slot: string, entry: SlotEntry, error: unknown) => void;
};

export function SlotView({ slots, name, hostProps, className, fallback = null, onError }: SlotViewProps) {
  // 订阅插槽变化：注册、卸载、崩溃摘格都会让 version +1
  useSyncExternalStore(
    (cb) => slots.onChange(cb),
    () => slots.version(),
    () => slots.version(),
  );

  const info = slots.of(name);
  if (!info) return <>{fallback}</>;

  // chain：不做格子裁决，渲染时靠 select(hostProps) **第一个匹配者**上（DSH 同）
  if (info.declaration.kind === "chain") {
    const elected = electChain(slots, info.cells.flatMap((c) => c.entries), hostProps, (entry, error) => onError?.(name, entry, error));
    const node = elected ?? fallback;
    if (node === null || node === undefined) return null;
    return className ? <div className={className}>{node}</div> : <>{node}</>;
  }

  const rendered: ReactNode[] = [];
  for (const cell of info.cells) {
    const entry = cell.winner;
    if (!entry) continue;
    rendered.push(
      <SlotBoundary
        key={cell.cellKey || "single"}
        onError={(error) => {
          slots.abdicate(entry.uid, error);
          onError?.(name, entry, error);
        }}
      >
        {renderEntry(slots, entry, name, hostProps)}
      </SlotBoundary>,
    );
  }
  if (!rendered.length) return <>{fallback}</>;
  return className ? <div className={className}>{rendered}</div> : <>{rendered}</>;
}

/**
 * chain 选举：按 priority → order → seq 依次问每个条目"这次你来吗"。
 * 三条与 DSH 对齐的语义（ui-renderer/lib/client.js:829-845）：
 *   1. select 返回 null/undefined = 弃权，继续问下一个；
 *   2. select **抛错也算弃权**（只记错误，不摘格）；
 *   3. 选中的那个拿到 props.matched（select 的返回值），且**崩溃不摘格** ——
 *      下次渲染时下一个候选自然会顶上（所以边界只上报，不 abdicate）。
 */
function electChain(
  slots: SlotsService,
  entries: SlotEntry[],
  hostProps: Record<string, unknown> | undefined,
  report: (entry: SlotEntry, error: unknown) => void,
): ReactNode | null {
  for (const entry of entries) {
    if (entry.abdicated || typeof entry.select !== "function") continue;
    let matched: unknown;
    try {
      matched = entry.select(hostProps ?? {});
    } catch (error) {
      report(entry, error);
      continue;
    }
    if (matched === null || matched === undefined) continue;
    return (
      <SlotBoundary
        key={entry.uid}
        onError={(error) => {
          report(entry, error);
        }}
      >
        {renderEntry(slots, entry, entry.slot, hostProps, matched)}
      </SlotBoundary>
    );
  }
  return null;
}

function renderEntry(
  slots: SlotsService,
  entry: SlotEntry,
  slotName: string,
  hostProps?: Record<string, unknown>,
  matched?: unknown,
): ReactNode {
  const Comp = entry.component as ComponentType<Record<string, unknown>>;
  const own = entry.props ? entry.props(undefined as never) ?? {} : {};
  const childOf = (child: string): { full: string; kind: string } => {
    if (!slots.ownsChild(entry.uid, child)) {
      const declared = slots.childrenOf(entry.uid);
      throw new SlotError(
        "CHILD_NOT_OWNED",
        declared.length
          ? t("plug.slot.childNotOwnedDeclared", { slot: slotName, child, children: declared.join(" / ") })
          : t("plug.slot.childNotOwned", { slot: slotName, child }),
      );
    }
    const full = slotName + "." + child;
    return { full, kind: slots.declaration(full)?.kind ?? "single" };
  };

  const renderSlot = (child: string): ReactNode => {
    const { full, kind } = childOf(child);
    if (kind === "chain") {
      throw new SlotError("CHAIN_WRONG_API", t("plug.slot.chainNeedsRenderSlotChain", { slot: full, child }));
    }
    return <SlotView slots={slots} name={full} hostProps={hostProps} />;
  };

  // chain 子槽位走另一条 API（DSH 同：用错 API 要抛明确的错，不能静默渲染成空）
  const renderSlotChain = (child: string): ReactNode => {
    const { full, kind } = childOf(child);
    if (kind !== "chain") {
      throw new SlotError("CHAIN_WRONG_API", t("plug.slot.notChain", { slot: full, kind, child }));
    }
    return <SlotView slots={slots} name={full} hostProps={hostProps} />;
  };

  return (
    <Comp
      {...(hostProps ?? {})}
      {...own}
      {...(matched === undefined ? {} : { matched })}
      renderSlot={renderSlot}
      renderSlotChain={renderSlotChain}
    />
  );
}

export { SlotBoundary };
