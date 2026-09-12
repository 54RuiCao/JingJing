/**
 * 内置的 UI 插件（P3.2）：界面骨架 + 三个占位样例。
 *
 * 三者分工正好覆盖 P3.2 的验收（"三个内置插件分别占 sidebar / settings / 阅读页尾部，互不干扰"）：
 *   app.aireader.ui-layout       声明槽位（不含 UI）
 *   app.aireader.status-badge    sidebar.footer.action（并依赖 reading-stats 服务）
 *   app.aireader.reader-tail     reader.view.tail
 *   app.aireader.plugin-settings settings.section（P3.1 加载器的界面投影）
 */

import type { BuiltinPlugin } from "../../core/plugin/types";
import { uiLayoutPlugin } from "./uiLayout";
import { statusBadgePlugin } from "./statusBadge";
import { readerTailPlugin } from "./readerTail";
import { pluginSettingsPlugin } from "./pluginSettings";
import { pluginLogsPlugin } from "./pluginLogs";

export { SHIPPED_SLOTS, uiLayoutPlugin } from "./uiLayout";
export { statusBadgePlugin } from "./statusBadge";
export { readerTailPlugin } from "./readerTail";
export { pluginSettingsPlugin } from "./pluginSettings";
export { pluginLogsPlugin } from "./pluginLogs";

export const BUILTIN_UI_PLUGINS: BuiltinPlugin[] = [
  uiLayoutPlugin,
  statusBadgePlugin,
  readerTailPlugin,
  pluginSettingsPlugin,
  pluginLogsPlugin,
];
