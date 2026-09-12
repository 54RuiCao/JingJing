/**
 * 用户技能提供方（P2.5）：读 %APPDATA%/aireader/skills 下的两种形态
 * （目录 bundle \`<dir>/SKILL.md\` 与平铺文件 \`<name>.md\`），照 DSH 的 discoverRoot 语义。
 *
 * 三条刻意的选择：
 *   1. **不做文件监听**（DSH 用 chokidar + awaitWriteFinish 是因为它的技能可能在编辑中变化；
 *      aireader 只在启动 / 用户点「刷新」/ AI 写完技能时重新扫描）—— 少一个常驻 watcher，
 *      也让"目录什么时候变"这件事在界面上是可见的；
 *   2. **list 只回概要、get 每次读盘**：与 DSH 一致（正文从不缓存），所以在外面用编辑器改了
 *      正文，下一次 load_skill 就是新版本；
 *   3. **写坏的 SKILL.md 不静默消失**：解析失败进 warnings 并在界面上说出来
 *      （DSH 那边模型目录里无法区分「没这个技能」与「技能写坏了」，见 §1.1）。
 *
 * 文件 IO 通过 deps 注入，所以这个模块可以脱离 Tauri 在 node 里跑契约测试。
 */

import { parseSkillFile } from "./parse";
import { SKILL_RANK, type SkillDefinition, type SkillProvider, type SkillSummary } from "./types";

export type SkillFileEntry = {
  /** SKILL.md 的路径（相对技能根目录），例如 "close-reading/SKILL.md" 或 "essay.md" */
  relPath: string;
  /** 技能所在目录（相对技能根），平铺文件是 "" */
  dirRel: string;
  /** 目录的绝对路径（渲染给模型的 Base directory；平铺文件是技能根目录的绝对路径） */
  absDir: string;
  /** 目录内的资源文件（相对 dirRel），例如 ["references/notes.md"] */
  resources: string[];
};

export type SkillFsDeps = {
  /** 扫描技能根目录（Rust 侧实现；只认一层，不递归找 SKILL.md） */
  list(): Promise<SkillFileEntry[]>;
  /** 读一个文件（相对技能根目录） */
  read(relPath: string): Promise<string>;
};

export type UserSkillProvider = SkillProvider & {
  /** 重新扫描 + 解析（异步）。返回解析成功的技能数 */
  refresh(): Promise<number>;
  /** 收集期的告警（写坏的 SKILL.md、超大文件、重名…） */
  warnings(): string[];
  /** 取技能自带的资源文件（load_skill 的 file 参数用） */
  readResource(name: string, rel: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  /** 最近一次扫描到的原始条目（诊断用） */
  entries(): SkillFileEntry[];
};

/** 单个技能文件的大小上限（防止把几百 KB 的东西读进上下文） */
const MAX_SKILL_BYTES = 256 * 1024;
/** 最多认多少个技能文件 */
const MAX_SKILLS = 200;

export function createUserSkillProvider(deps: SkillFsDeps): UserSkillProvider {
  let summaries: SkillSummary[] = [];
  let entriesBySkill = new Map<string, SkillFileEntry>();
  let rawEntries: SkillFileEntry[] = [];
  let warns: string[] = [];

  const refresh = async (): Promise<number> => {
    warns = [];
    summaries = [];
    entriesBySkill = new Map();
    try {
      rawEntries = (await deps.list()).slice(0, MAX_SKILLS);
    } catch (e) {
      rawEntries = [];
      warns.push("技能目录读取失败：" + String(e instanceof Error ? e.message : e));
      return 0;
    }
    for (const entry of rawEntries) {
      try {
        const text = await deps.read(entry.relPath);
        if (text.length > MAX_SKILL_BYTES) {
          warns.push(entry.relPath + "：文件过大（" + text.length + " 字符），已跳过");
          continue;
        }
        const parsed = parseSkillFile(text, entry.relPath);
        if (!parsed.ok) {
          warns.push(parsed.error);
          continue;
        }
        const skill = parsed.skill;
        if (entriesBySkill.has(skill.name)) {
          warns.push('技能 "' + skill.name + '" 在用户目录里出现了多次，只保留 ' + entriesBySkill.get(skill.name)!.relPath);
          continue;
        }
        entriesBySkill.set(skill.name, entry);
        summaries.push({
          name: skill.name,
          description: skill.description,
          whenToUse: skill.whenToUse,
          invocation: skill.invocation,
          source: "user",
          provider: "user-dir",
        });
      } catch (e) {
        warns.push(entry.relPath + "：读取失败（" + String(e instanceof Error ? e.message : e) + "）");
      }
    }
    return summaries.length;
  };

  const definitionOf = async (name: string): Promise<SkillDefinition | undefined> => {
    const entry = entriesBySkill.get(name);
    if (!entry) return undefined;
    const text = await deps.read(entry.relPath);
    const parsed = parseSkillFile(text, entry.relPath);
    if (!parsed.ok) {
      warns.push(parsed.error);
      return undefined;
    }
    const s = parsed.skill;
    if (s.name !== name) return undefined;
    return {
      name: s.name,
      description: s.description,
      whenToUse: s.whenToUse,
      invocation: s.invocation,
      metadata: s.metadata,
      source: "user",
      provider: "user-dir",
      content: s.content,
      resources: entry.resources,
      // 平铺文件的资源基底也是「它所在的目录」，与 DSH 一致（§1.1）
      resourceBase: { kind: "directory", path: entry.absDir },
    };
  };

  return {
    id: "user-dir",
    rank: SKILL_RANK.user,
    list: () => summaries,
    get: definitionOf,
    refresh,
    warnings: () => warns,
    entries: () => rawEntries,
    async readResource(name, rel) {
      const entry = entriesBySkill.get(name);
      if (!entry) return { ok: false, error: '技能 "' + name + '" 不存在' };
      const norm = rel.replace(/^\.\//, "").replace(/\\/g, "/");
      if (norm.includes("..") || norm.startsWith("/")) {
        return { ok: false, error: "资源路径不允许越出技能目录：" + rel };
      }
      if (!entry.resources.includes(norm)) {
        return {
          ok: false,
          error: "技能 " + name + " 没有资源 " + norm +
            (entry.resources.length ? "（可用：" + entry.resources.join("、") + "）" : "（该技能没有附带资源）"),
        };
      }
      try {
        const text = await deps.read(entry.dirRel ? entry.dirRel + "/" + norm : norm);
        return { ok: true, text };
      } catch (e) {
        return { ok: false, error: "读取失败：" + String(e instanceof Error ? e.message : e) };
      }
    },
  };
}

/** 一个空实现（技能目录不可用时兜底：只剩内置技能） */
export function createEmptySkillFs(): SkillFsDeps {
  return { list: async () => [], read: async () => "" };
}
