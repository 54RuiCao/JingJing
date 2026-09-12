/**
 * 内置插件：侧栏底部的阅读状态条（P3.2 的样例之一）。
 *
 * 它 **inject ["slots","readingStats"]** —— 于是它同时演示了两件事：
 *   1. 插件往槽位里挂 UI（sidebar.footer.action 是 list，加法席位）；
 *   2. 依赖另一个插件提供的服务：卸载 reading-stats 时它会自动 park，它挂的 UI 也跟着消失
 *      （注册的 disposer 挂在它自己的 fiber 上）。
 */

import { useT } from "../../i18n/react";
import { t } from "../../i18n";
import { HOST_API_VERSION } from "../../core/plugin/manifest";
import type { BuiltinPlugin } from "../../core/plugin/types";
import type { ReadingStatsService } from "../../core/app/services";
import type { SlotsService } from "../slots/types";

function StatusBadge({ stats }: { stats: ReadingStatsService }) {
  const t = useT();
  return (
    <div
      className="air-slot-badge"
      title={t("plug.statusBadge.providedBy", { id: "app.aireader.status-badge" })}
    >
      <span className="air-slot-badge-dot" />
      {stats.summary()}
    </div>
  );
}

export const statusBadgePlugin: BuiltinPlugin = {
  manifest: {
    id: "app.aireader.status-badge",
    // name / purpose 用 getter：语言可能在运行期切换，取词必须等到渲染时（写成 t(...) 会在模块加载时定死）
    get name() {
      return t("plug.builtin.statusBadge");
    },
    get purpose() {
      return t("plug.builtin.statusBadgePurpose");
    },
    version: "1.0.0",
    apiVersion: HOST_API_VERSION,
    capabilities: ["reader.read", "ui.slot"],
  },
  plugin: {
    name: "status-badge",
    inject: ["slots", "readingStats"],
    apply(ctx) {
      const slots = ctx.get<SlotsService>("slots");
      const stats = ctx.get<ReadingStatsService>("readingStats");
      if (!slots || !stats) return;
      slots.register({
        name: "sidebar.footer.action",
        id: "reading-status",
        order: 10,
        label: t("plug.statusBadge.label"),
        component: () => <StatusBadge stats={stats} />,
      });
    },
  },
};
