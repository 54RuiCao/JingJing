/**
 * 插件的用户级选项（启用/禁用 + 配置值）的存放处（P3.1）。
 *
 * **绝不放在插件目录里**（内部设计笔记 §5.5）：插件能写自己的目录 = 权限系统自废。
 * 所以它和将来的授权记录一样存在应用自己的 settings 表里（键 plugins.options），
 * 形状是 { "<pluginId>": { disabled?: boolean, config?: object } }。
 */

import type { PluginOptionStore, PluginOptions } from "./types";

export type SettingsLike = {
  getSetting<T>(key: string, fallback: T): Promise<T>;
  setSetting(key: string, value: unknown): Promise<void>;
};

export const PLUGIN_OPTIONS_KEY = "plugins.options";

/** 内存实现（测试，以及没有数据层时的兜底） */
export function createMemoryPluginStore(initial: Record<string, PluginOptions> = {}): PluginOptionStore {
  const table: Record<string, PluginOptions> = { ...initial };
  return {
    ready: async () => {},
    get: (id) => table[id],
    set: async (id, options) => {
      table[id] = options;
    },
    all: () => ({ ...table }),
    reload: async () => {},
  };
}

/** 数据层实现：整表存在 settings 的一行里（插件是几十个级别，不值得做行级并发） */
export function createSettingsPluginStore(settings: SettingsLike): PluginOptionStore {
  let table: Record<string, PluginOptions> = {};
  let loaded = false;

  const ensure = async (): Promise<void> => {
    if (loaded) return;
    table = (await settings.getSetting<Record<string, PluginOptions>>(PLUGIN_OPTIONS_KEY, {})) ?? {};
    loaded = true;
  };

  return {
    ready: ensure,
    // get 是同步的：加载器在扫描/挂载前先 await ready()，之后表就在内存里了
    get: (id) => table[id],
    async set(id, options) {
      await ensure();
      table = { ...table, [id]: options };
      await settings.setSetting(PLUGIN_OPTIONS_KEY, table);
    },
    all: () => ({ ...table }),
    async reload() {
      loaded = false;
      await ensure();
    },
  };
}
