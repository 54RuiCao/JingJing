/**
 * 内置插件的**显示名 / 说明**按插件 id 取词。
 *
 * 为什么不能直接读 manifest：manifest 在**加载时会被校验器拷成普通对象**
 * （`manifest.ts` 里 `return { ok: true, manifest: { …逐字段拷贝 } }`），
 * 那一刻 getter 就被求值了 —— 于是"启动时是中文，切到英文后插件列表还是中文"。
 * 显示层按 id 查表取词，跟快照无关，切语言立刻生效（实测踩到过）。
 */
import { t, type MessageKey } from "../../i18n";

const NAMES: Record<string, readonly [MessageKey, MessageKey]> = {
  "app.aireader.ui-layout": ["plug.layout.pluginName", "plug.layout.pluginPurpose"],
  "app.aireader.plugin-settings": ["plug.builtin.pluginManager", "plug.builtin.pluginManagerPurpose"],
  "app.aireader.plugin-logs": ["plug.builtin.pluginLogs", "plug.builtin.pluginLogsPurpose"],
  "app.aireader.status-badge": ["plug.builtin.statusBadge", "plug.builtin.statusBadgePurpose"],
  "app.aireader.reader-tail": ["reader.pluginName", "reader.pluginPurpose"],
  "app.aireader.reader-tools": ["plug.builtin.readerTools", "plug.builtin.readerToolsPurpose"],
  "app.aireader.skill-tools": ["plug.builtin.skillTools", "plug.builtin.skillToolsPurpose"],
  "app.aireader.plugin-tools": ["plug.builtin.pluginTools", "plug.builtin.pluginToolsPurpose"],
  "app.aireader.reading-stats": ["plug.builtin.readingStats", "plug.builtin.readingStatsPurpose"],
};

/** 内置插件 → 当前语言的显示名；不是内置插件就原样返回它的名字（第三方插件是数据） */
export function builtinName(id: string, fallback: string): string {
  const keys = NAMES[id];
  return keys ? t(keys[0]) : fallback;
}

/** 同上，取说明（可能是 undefined —— manifest 允许不写 purpose） */
export function builtinPurpose(id: string, fallback?: string): string | undefined {
  const keys = NAMES[id];
  return keys ? t(keys[1]) : fallback;
}
