/**
 * 动态包的"虚拟插件目录"（P3.4）：把内存里的包定义**接进 P3.1 的加载器路径**。
 *
 * 为什么是叠加层而不是另写一条挂载路径：
 *   加载器已经有一条完整的纪律 —— 扫描 → 校验 manifest → 顺序挂载 → 失败隔离 →
 *   sync 对齐磁盘（版本/哈希变了就卸载重挂）→ 配置热更与回滚。
 *   动态包如果绕过它，就要把这一整套再实现一遍，而且"AI 写的插件"与"用户装的插件"
 *   会变成两种东西。做成叠加层之后：**同一个加载器、同一套校验、同一条回滚路径**，
 *   差别只有"包从哪来"。synс() 的版本比对也因此天然支持"追加新包再 run"与"对旧包再 run 回滚"。
 *
 * 三条边界：
 *   - 虚拟目录的 absDir 用 `aireader://dynamic/<pluginId>` 前缀：宿主据此区分
 *     "这是 AI 写的包"与"这是磁盘上的包"（id 冲突判定、诊断文案都要用）。
 *   - 同名时**动态包优先**（磁盘上的同名目录被遮住）—— 但 define 阶段会先拒掉 id 冲突，
 *     这里只是兜底，避免出现"两个条目争一个 id"。
 *   - 读文件只在"当前包"上做：加载器永远看到的是版本指针指向的那一版。
 */

import type { PluginDirEntry, PluginFs } from "./types";
import type { PluginDefinitionRegistry } from "./definitions";

export const DYNAMIC_DIR_PREFIX = "aireader://dynamic/";

export function dynamicDirOf(pluginId: string): string {
  return DYNAMIC_DIR_PREFIX + pluginId;
}

export function isDynamicDir(dir: string): boolean {
  return dir.startsWith(DYNAMIC_DIR_PREFIX);
}

export function createDynamicPluginFs(base: PluginFs, registry: PluginDefinitionRegistry): PluginFs {
  const byDir = (a: PluginDirEntry, b: PluginDirEntry) => (a.relDir < b.relDir ? -1 : a.relDir > b.relDir ? 1 : 0);
  return {
    async scan(): Promise<PluginDirEntry[]> {
      let disk: PluginDirEntry[] = [];
      try {
        disk = await base.scan();
      } catch {
        disk = [];
      }
      const ids = new Set(registry.ids());
      const out = disk.filter((d) => !ids.has(d.relDir));
      for (const id of registry.ids()) {
        const pkg = registry.currentOf(id);
        // 没有版本指针 = 定义过但从来没 run 过：**不进目录**（define 不改变运行态）
        if (!pkg) continue;
        out.push({ relDir: id, absDir: dynamicDirOf(id), files: pkg.files.map((f) => f.path).sort() });
      }
      return out.sort(byDir);
    },
    async read(relPath: string): Promise<string> {
      const at = relPath.indexOf("/");
      const id = at > 0 ? relPath.slice(0, at) : "";
      const file = at > 0 ? relPath.slice(at + 1) : "";
      if (id) {
        const pkg = registry.currentOf(id);
        if (pkg) {
          const found = pkg.files.find((f) => f.path === file);
          if (found) return found.content;
        }
      }
      return base.read(relPath);
    },
  };
}
