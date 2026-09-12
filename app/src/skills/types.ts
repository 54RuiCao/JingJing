/**
 * 技能（skill）的契约（P2.5）。形态逐字对齐 DSH，见 内部设计笔记 §1.2。
 *
 * 一个技能 = kebab-case 名字 + 一句路由用描述 + 一段 Markdown 正文。
 * **没有** manifest、**没有**「声明所需工具」字段、**没有**可执行脚本、**没有**权限位：
 * 技能是纯提示词/数据层，正文进上下文 ≠ 获得能力（真正的门在工具注册表与守卫那边）。
 *
 * 三条从 DSH 抄来的硬约束（写在类型里，免得后来者又加字段）：
 *   1. 名字是**元数据里的 name**，不是目录名；
 *   2. 描述必须与会话、书、时间无关 —— digest 只由 [name, description] 决定，
 *      描述里放会变的东西会让每轮都追加一条替换目录，KV 前缀持续作废（§6.3）；
 *   3. list() 只回概要、get() 才回正文，目录与正文彻底分离（§1.4）。
 */

/** 提供方（技能从哪来）的稳定标识：内置 / 用户目录 / 运行时注册（AI 生成也走用户目录） */
export type SkillSource = "builtin" | "user" | "runtime";

/** 调用策略：两个方向默认都开着，只有显式写 false 才关（§1.2） */
export type InvocationPolicy = {
  /** false = 模型看不到（不进目录、skill 工具也拒绝加载），只能用户 /name 直呼 */
  modelInvocable: boolean;
  /** false = 用户 /name 调不到（只有模型能用） */
  userInvocable: boolean;
};

/** 目录项：**不含正文**。模型看到的就是这个（外加 500 字符描述上限的处理） */
export type SkillSummary = {
  name: string;
  description: string;
  /** 仅元数据，不渲染给模型；aireader 用于 / 候选排序 */
  whenToUse?: string;
  invocation: InvocationPolicy;
  source: SkillSource;
  /** 提供方 id，诊断用（同名被谁盖住了要说得清） */
  provider: string;
};

/** 资源基底：照 DSH 的四种形态裁成两种（我们没有 URL 与不透明资源） */
export type SkillResourceBase =
  | { kind: "directory"; path: string }
  | { kind: "opaque"; description: string };

/** 定义：**含正文**。每次 get() 都重新向提供方要，绝不缓存正文（§1.4） */
export type SkillDefinition = SkillSummary & {
  /** 正文（已 trim）。原样进 <skill_instructions>，不转义（本地可信内容） */
  content: string;
  resourceBase?: SkillResourceBase;
  /** 资源文件相对路径（references/… 之类），模型可用 load_skill 的 file 参数取 */
  resources?: string[];
  /** frontmatter 里的自由对象，原样附带 */
  metadata?: Record<string, unknown>;
};

/** 同名裁决时的候选项（内部用：带上 rank 与提供方内的顺序） */
export type SkillCandidate = SkillSummary & {
  /** 提供方层级：数字小的赢（内置 600、用户 400 —— 与 DSH 的 rank 常量同向） */
  rank: number;
  /** 提供方之间的注册顺序（同 rank 时先注册的赢） */
  providerOrder: number;
  /** 提供方内部返回顺序 */
  localOrder: number;
};

/** 技能提供方：注册进注册表后由它来回答"有哪些技能 / 某个技能是什么" */
export type SkillProvider = {
  id: string;
  /** DSH 的 rank 常量，对齐语义：项目 100 / agents 200 / custom 300 / user 400 / agents-home 500 / bundled 600 */
  rank: number;
  /** 只回概要；允许异步（用户目录要读盘） */
  list(): SkillSummary[] | Promise<SkillSummary[]>;
  /** 只回正文；名字不存在回 undefined */
  get(name: string): SkillDefinition | undefined | Promise<SkillDefinition | undefined>;
  /** 注册时返回的注销函数（disposer 纪律：每个注册都要能撤销） */
};

/** 注册提供方的返回值：调用即注销（P3 的 fiber effect 会把它挂到 fiber 上） */
export type Disposer = () => void;

/** 目录条目：模型可见的最小事实（digest 也只算这两个字段） */
export type CatalogEntry = { name: string; description: string };

/** 渲染给模型的目录快照 */
export type CatalogSnapshot = {
  entries: CatalogEntry[];
  /** 变更检测用（非密码学）：entries 的 [name, description] 序列的哈希 */
  digest: string;
  /** 被同名高优先级技能盖掉的候选（诊断 + 界面提示用） */
  shadowed: { name: string; provider: string; by: string }[];
  /** 提供方列表（诊断用） */
  providers: string[];
  /** 收集期的告警（SKILL.md 写坏了之类）——DSH 只写日志，我们还要能在界面上说出来 */
  warnings: string[];
};

/** 描述进目录前的归一化上限（对齐 DSH catalogDescriptionMaxLength 默认 500） */
export const CATALOG_DESCRIPTION_MAX = 500;

/** 技能名语法（与 DSH 同一条正则） */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** rank 常量（与 DSH 同值，便于将来整体拷 DSH 的技能目录） */
export const SKILL_RANK = {
  user: 400,
  builtin: 600,
} as const;
