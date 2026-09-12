/**
 * 技能宿主的装配（P2.5）：把内置提供方 + 用户目录提供方装进一个注册表，
 * 并把「写技能 / 读资源」这两个数据层动作接到 Tauri 命令上。
 *
 * 与 UI 分开的理由和工具层一样：ChatPanel 只拿到 registry + 三个动作，
 * 契约测试可以在 node 里用内存 fs 把整套技能逻辑跑一遍（tools/skills-test.ts）。
 */

import { invoke } from "@tauri-apps/api/core";
import { createBuiltinSkillProvider } from "./builtin";
import { createUserSkillProvider, type SkillFileEntry, type UserSkillProvider } from "./loader";
import { SkillRegistry } from "./registry";

export type SkillRefreshResult = {
  /** 解析成功的用户技能数 */
  userSkills: number;
  /** 当前目录里的技能总数（含内置） */
  total: number;
  digest: string;
};

export type SkillHost = {
  registry: SkillRegistry;
  /** 重新扫描用户目录 + 重算目录（启动、点「刷新」、AI 写完技能后调用） */
  refresh(): Promise<SkillRefreshResult>;
  /** 写技能文件（只允许 Markdown；Rust 侧还会再拒一次非 .md） */
  write(relPath: string, text: string, overwrite: boolean): Promise<string>;
  /** 读技能附带资源 */
  readResource(name: string, rel: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  /** 删除一个用户技能（整个技能目录或平铺文件），然后重扫 */
  remove(name: string): Promise<void>;
  /** 技能根目录（设置在哪个目录，界面上要告诉用户） */
  dir(): Promise<string>;
  /** 最近一次扫描的告警（写坏的 SKILL.md 之类） */
  warnings(): string[];
  /** 原始扫描条目（诊断用） */
  entries(): SkillFileEntry[];
};

/** Tauri 命令的薄封装（集中在这里，方便测试替换） */
export type SkillInvoke = {
  getSkillsDir(): Promise<string>;
  scanSkills(): Promise<SkillFileEntry[]>;
  readSkillText(relPath: string): Promise<string>;
  writeSkillText(relPath: string, text: string, overwrite: boolean): Promise<string>;
  deleteSkill(name: string): Promise<void>;
};

export const tauriSkillInvoke: SkillInvoke = {
  getSkillsDir: () => invoke<string>("get_skills_dir"),
  scanSkills: () => invoke<SkillFileEntry[]>("scan_skills"),
  readSkillText: (relPath) => invoke<string>("read_skill_text", { relPath }),
  writeSkillText: (relPath, text, overwrite) =>
    invoke<string>("write_skill_text", { relPath, text, overwrite }),
  deleteSkill: (name) => invoke<void>("delete_skill", { name }),
};

/** 技能根目录不可用时的兜底（浏览器里跑测试、或命令报错）：技能只剩内置的 */
export function createMemorySkillInvoke(initial: SkillFileEntry[] = [], files: Record<string, string> = {}): SkillInvoke {
  const store = new Map<string, string>(Object.entries(files));
  let entries = [...initial];
  return {
    getSkillsDir: async () => "(memory)",
    scanSkills: async () => entries,
    deleteSkill: async (name) => {
      for (const k of [...store.keys()]) {
        if (k === name + ".md" || k.startsWith(name + "/")) store.delete(k);
      }
      entries = entries.filter((e) => e.dirRel !== name && e.relPath !== name + ".md");
    },
    readSkillText: async (rel) => {
      const t = store.get(rel);
      if (t === undefined) throw new Error("没有这个文件：" + rel);
      return t;
    },
    writeSkillText: async (rel, text, overwrite) => {
      if (store.has(rel) && !overwrite) throw new Error("技能文件已存在（覆盖需要 overwrite=true）: " + rel);
      store.set(rel, text);
      return rel;
    },
  };
}

export function createSkillHost(io: SkillInvoke = tauriSkillInvoke): SkillHost {
  const registry = new SkillRegistry();
  registry.registerProvider(createBuiltinSkillProvider());
  const user: UserSkillProvider = createUserSkillProvider({
    list: () => io.scanSkills().catch(() => [] as SkillFileEntry[]),
    read: (rel) => io.readSkillText(rel),
  });
  registry.registerProvider(user);

  return {
    registry,
    async refresh() {
      const userSkills = await user.refresh();
      const snapshot = await registry.refresh();
      return { userSkills, total: snapshot.entries.length, digest: snapshot.digest };
    },
    write: (relPath, text, overwrite) => io.writeSkillText(relPath, text, overwrite),
    readResource: (name, rel) => user.readResource(name, rel),
    async remove(name) {
      await io.deleteSkill(name);
      await user.refresh();
      await registry.refresh();
    },
    dir: () => io.getSkillsDir().catch(() => ""),
    warnings: () => user.warnings(),
    entries: () => user.entries(),
  };
}
