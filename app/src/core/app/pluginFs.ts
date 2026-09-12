/**
 * 插件目录的 IO 缝（P3.1）：Rust 命令的薄封装 + 一个内存实现（契约测试用）。
 *
 * 与技能的 loader 一样，加载器只依赖这个缝，所以"扫目录 → 校验 → 挂载"整条链路
 * 可以在 node 里跑一遍，不需要浏览器与 Tauri。
 */

import { invoke } from "@tauri-apps/api/core";
import type { PluginDirEntry, PluginFs } from "../plugin/types";

export type PluginInvoke = {
  getPluginsDir(): Promise<string>;
  scanPlugins(): Promise<PluginDirEntry[]>;
  readPluginText(relPath: string): Promise<string>;
  writePluginText(relPath: string, text: string, overwrite: boolean): Promise<string>;
  deletePlugin(relDir: string): Promise<void>;
};

export const tauriPluginInvoke: PluginInvoke = {
  getPluginsDir: () => invoke<string>("get_plugins_dir"),
  scanPlugins: () => invoke<PluginDirEntry[]>("scan_plugins"),
  readPluginText: (relPath) => invoke<string>("read_plugin_text", { relPath }),
  writePluginText: (relPath, text, overwrite) =>
    invoke<string>("write_plugin_text", { relPath, text, overwrite }),
  deletePlugin: (relDir) => invoke<void>("delete_plugin", { relDir }),
};

/** 把 Rust 命令包成 PluginFs（扫描失败当空目录：插件目录不可用不该让应用起不来） */
export function createPluginFs(io: PluginInvoke = tauriPluginInvoke): PluginFs {
  return {
    scan: () => io.scanPlugins().catch(() => [] as PluginDirEntry[]),
    read: (rel) => io.readPluginText(rel),
  };
}

/** 内存实现：包就是一张 relPath → 内容 的表（扫描时按 manifest.json 推断包边界） */
export function createMemoryPluginFs(files: Record<string, string> = {}): PluginFs & { files: Record<string, string> } {
  // **不复制**：测试要能在建好 fs 之后"装包/删包"，共享同一张表最省事
  const table: Record<string, string> = files;
  const scan = async (): Promise<PluginDirEntry[]> => {
    const dirs = new Set<string>();
    for (const path of Object.keys(table)) {
      const at = path.indexOf("/");
      if (at <= 0) continue;
      const relDir = path.slice(0, at);
      if (path === relDir + "/manifest.json") dirs.add(relDir);
    }
    return [...dirs].sort().map((relDir) => ({
      relDir,
      absDir: "X:/plugins/" + relDir,
      files: Object.keys(table)
        .filter((p) => p.startsWith(relDir + "/"))
        .map((p) => p.slice(relDir.length + 1))
        .sort(),
    }));
  };
  return {
    files: table,
    scan,
    read: async (rel) => {
      const text = table[rel];
      if (text === undefined) throw new Error("没有这个文件：" + rel);
      return text;
    },
  };
}
