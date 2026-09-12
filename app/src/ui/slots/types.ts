/**
 * UI 插槽的契约（P3.2）。形态照 内部设计笔记 §3，本期只做 **single / keyed / list** 三种
 * kind（chain 与 store 席位刻意留到确实有插件需要时 —— §5.7 第 3 条）。
 *
 * 三条一开始就要定死的语义：
 *   1. **数值低者渲染**（priority 小的赢）；同格子同 priority **直接抛错** ——
 *      "覆盖"必须是显式行为，不能因为注册顺序悄悄赢。
 *   2. **只有落在父槽位上的那个 entry 能声明子槽位**：entry 一走，它声明的整棵子树连带崩塌
 *      （§3.1 的 releaseEntry 级联）。这就是"只替换一小块 UI"的机制保证。
 *   3. **未声明的槽位不能注册**（注册就抛错），未声明的槽位渲染就是空。
 */

import type { Disposer } from "../../core/service/types";

/**
 * 四种 kind（P3.6 补齐 chain）：
 *   single —— 一个格子，同 priority 冲突直接抛错
 *   keyed  —— 每 key 一个格子
 *   list   —— 每 id 一个格子，按 priority → order 排序
 *   chain  —— **不做格子裁决**：条目用 select(props) 自提名，渲染时**第一个匹配者**上，其余顺延；
 *             同 priority 不冲突（本来就要并存），崩溃也**不摘格**（下一个候选顶上）
 */
export type SlotKind = "single" | "keyed" | "list" | "chain";
export type SlotScope = "app" | "book" | "session";
export type ReplaceRisk = "none" | "shadows-shipped-ui";

export type SlotDeclaration = {
  kind: SlotKind;
  scope: SlotScope;
  /** none = 加法席位；shadows-shipped-ui = 会盖住产品自带的那块 UI（设置面板要标红） */
  replaceRisk: ReplaceRisk;
  /** 宿主是不是真的有渲染点（声明了但还没接线的槽位要如实标出来） */
  wired: boolean;
  /** 人看的说明 */
  description?: string;
};

/** 注册选项。list 必须给 id、keyed 必须给 key（错给直接抛错，不做兜底猜测） */
export type SlotRegistration<P = Record<string, unknown>> = {
  name: string;
  /** list 用：同一个 id 是一个格子 */
  id?: string;
  /** keyed 用：同一个 key 是一个格子 */
  key?: string;
  /** 数值低者渲染；同格子同 priority 抛错 */
  priority?: number;
  /** 同格子内的排序（list 用） */
  order?: number;
  /** 给设置面板/诊断看的标签 */
  label?: string;
  /**
   * chain 必须给：自提名函数。返回 null/undefined = 弃权（这个条目不处理这次渲染）；
   * 返回任何别的值 = 我上，这个值会作为 props.matched 交给组件。
   * **抛错也算弃权**（不摘格，下一个候选顶上）—— 与 DSH 的 selector 语义一致。
   */
  select?: (props: Record<string, unknown>) => unknown;
  /** 声明子槽位（相对名）：子槽位的完整名字是 <父名>.<子名> */
  children?: Record<string, { kind: SlotKind; scope: SlotScope; replaceRisk?: ReplaceRisk; description?: string }>;
  /** 渲染时现算的 props（可以读实时状态） */
  props?: (own: P) => Record<string, unknown>;
  /** React 组件（内核不认识 React，所以这里是 unknown；由 SlotView 决定怎么用） */
  component: unknown;
};

export type SlotEntry = {
  uid: number;
  slot: string;
  id: string;
  key: string;
  priority: number;
  order: number;
  /** 注册序号（同 priority/order 时的最后一道确定性排序） */
  seq: number;
  label?: string;
  /** 拥有它的 fiber 名字（诊断与所有权） */
  owner: string;
  ownerUid: number;
  /** 渲染期崩过被摘掉（DSH 的 abdicate）：账本还在，格子里不再渲染它 */
  abdicated: boolean;
  component: unknown;
  props?: (own: never) => Record<string, unknown>;
  /** chain 用：自提名函数（见 SlotRegistration.select）；其余 kind 为 undefined */
  select?: (props: Record<string, unknown>) => unknown;
};

/** 一个格子（single 只有一个；keyed 每 key 一个；list 每 id 一个） */
export type SlotCell = {
  cellKey: string;
  /** 已按 priority → order → seq 排序；第一个是赢家 */
  entries: SlotEntry[];
  /** 赢家（被 abdicate 的话顺延到下一个活的） */
  winner: SlotEntry | null;
  /** 被赢家盖住的（诊断：谁盖了谁必须说得清） */
  shadows: SlotEntry[];
};

export type SlotCatalogEntry = SlotDeclaration & {
  name: string;
  /** 哪个 entry 声明的（null = 宿主自带） */
  declaredBy: string | null;
  cells: { key: string; winner: string | null; shadows: string[] }[];
  /** 注册到这个槽位上的 entry 数（含被盖住的） */
  registrationCount: number;
};

/** 插槽服务的**只读面**（React 渲染器与设置面板只用这一面） */
export type SlotsReader = {
  declared(name: string): boolean;
  declaration(name: string): SlotDeclaration | undefined;
  of(name: string): { declaration: SlotDeclaration; cells: SlotCell[] } | undefined;
  catalog(): SlotCatalogEntry[];
  /** 任何变化都会 +1（useSyncExternalStore 的快照） */
  version(): number;
  onChange(fn: () => void): Disposer;
  /** 渲染期崩了：把该 entry 从格子里摘掉（账本保留，disposer 照常有效） */
  abdicate(uid: number, error: unknown): void;
};

/** 插件看到的插槽服务（每个 fiber 一份 facade，register 的 disposer 自动挂到调用者的 fiber 上） */
export type SlotsService = SlotsReader & {
  register<P = Record<string, unknown>>(options: SlotRegistration<P>): Disposer;
  /** 等某个槽位被声明（声明变化时重跑），常用于"往别人声明的槽位里挂东西" */
  inject(name: string, cb: (slots: SlotsService) => Disposer | void): Disposer;
  /** 声明一个槽位（宿主自带的 ui-layout 用；插件一般不需要） */
  declare(name: string, declaration: SlotDeclaration): Disposer;
  /** 这个 entry 是否声明了某个子槽位（renderSlot 的授权检查） */
  ownsChild(uid: number, child: string): boolean;
  /** 该 entry 声明的子槽位全名 */
  childrenOf(uid: number): string[];
};

export type SlotErrorCode =
  | "NOT_DECLARED"
  | "ALREADY_DECLARED"
  | "INVALID_REGISTRATION"
  | "PRIORITY_CONFLICT"
  | "CHILD_NOT_OWNED"
  /** 渲染 API 用错了：chain 槽位要用 renderSlotChain，非 chain 的要用 renderSlot（DSH 同） */
  | "CHAIN_WRONG_API";

export class SlotError extends Error {
  readonly code: SlotErrorCode;
  constructor(code: SlotErrorCode, message: string) {
    super(message);
    this.name = "SlotError";
    this.code = code;
  }
}
