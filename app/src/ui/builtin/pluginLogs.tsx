/**
 * 内置插件：设置面板里的「插件日志」分区（P3.5）。
 *
 * P3.3 的 `ctx.log` 只进控制台 —— 用户看不到、模型也看不到，"插件为什么不工作"只能猜。
 * 这条面板把日志变成**看得见的东西**：谁写的、什么时候、什么级别，以及"因为上限丢了多少条"
 * （日志面板最常见的谎是"就这些"）。
 *
 * 它只读 `pluginLogs` 服务，不认识 quickjs，也不认识加载器。
 */

import { useSyncExternalStore, useState } from "react";
import { useT } from "../../i18n/react";
import { t } from "../../i18n";
import type { MessageKey } from "../../i18n";
import { builtinName } from "./builtinNames";
import { HOST_API_VERSION } from "../../core/plugin/manifest";
import type { BuiltinPlugin, PluginLogsService, PluginsService } from "../../core/plugin/types";
import type { SlotsService } from "../slots/types";

/** 级别 → 界面文案的 key（语言可能在运行期切换，取词必须等到渲染时） */
const LEVEL_LABEL: Record<string, MessageKey> = {
  info: "plug.logs.level.info",
  warn: "plug.logs.level.warn",
  error: "plug.logs.level.error",
};

function timeOf(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

function PluginLogPanel({ logs, plugins }: { logs: PluginLogsService; plugins: PluginsService }) {
  // 订阅日志变化：写一条就 +1 版本，面板跟着刷新
  useSyncExternalStore(
    (cb) => logs.onChange(cb),
    () => logs.version(),
    () => logs.version(),
  );
  const t = useT();
  const [filter, setFilter] = useState("");
  const [onlyProblems, setOnlyProblems] = useState(false);

  // 内置插件按 id 取词（manifest 在校验时就被拷成普通对象了，读它拿不到切换后的语言）
  const nameOf = (id: string) => {
    const p = plugins.list().find((x) => x.id === id);
    return builtinName(id, p?.name ?? id);
  };
  const all = logs.list();
  const shown = all
    .filter((e) => (filter ? e.pluginId.includes(filter) || nameOf(e.pluginId).includes(filter) : true))
    .filter((e) => (onlyProblems ? e.level !== "info" : true))
    .slice(-200);
  const stats = logs.stats();

  return (
    <div className="air-plugin-panel air-log-panel">
      <div className="air-plugin-toolbar">
        <span className="air-plugin-count">
          {stats.dropped > 0
            ? t("plug.logs.countDropped", { kept: stats.kept, dropped: stats.dropped })
            : t("plug.logs.count", { kept: stats.kept })}
        </span>
        <span className="air-spacer" />
        <input
          className="air-log-filter"
          placeholder={t("plug.logs.filterPlaceholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label className="air-log-toggle">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
          {t("plug.logs.onlyProblems")}
        </label>
        <button className="air-plugin-btn" onClick={() => logs.clear()} disabled={!stats.kept}>
          {t("plug.logs.clear")}
        </button>
      </div>
      {shown.length === 0 ? (
        <div className="air-plugin-hint">
          {t("plug.logs.emptyBefore")}
          <code>ctx.log(...)</code>
          {t("plug.logs.emptyAfter")}
        </div>
      ) : (
        <div className="air-log-list">
          {shown.map((e) => (
            <div key={e.seq} className="air-log-row" data-level={e.level}>
              <span className="air-log-time">{timeOf(e.at)}</span>
              <span className={"air-log-level air-log-level-" + e.level}>{LEVEL_LABEL[e.level] ? t(LEVEL_LABEL[e.level]) : e.level}</span>
              <span className="air-log-id" title={e.pluginId}>
                {nameOf(e.pluginId)}
              </span>
              <span className="air-log-msg">{e.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const pluginLogsPlugin: BuiltinPlugin = {
  manifest: {
    id: "app.aireader.plugin-logs",
    // name / purpose 用 getter：语言可能在运行期切换，取词必须等到渲染时（写成 t(...) 会在模块加载时定死）
    get name() {
      return t("plug.builtin.pluginLogs");
    },
    get purpose() {
      return t("plug.builtin.pluginLogsPurpose");
    },
    version: "1.0.0",
    apiVersion: HOST_API_VERSION,
  },
  plugin: {
    name: "plugin-logs",
    inject: ["slots", "pluginLogs", "plugins"],
    apply(ctx) {
      const slots = ctx.get<SlotsService>("slots");
      const logs = ctx.get<PluginLogsService>("pluginLogs");
      const plugins = ctx.get<PluginsService>("plugins");
      if (!slots || !logs || !plugins) return;
      slots.register({
        name: "settings.section",
        id: "plugin-logs",
        // 排在内置插件管理（order 0）后面
        order: 10,
        label: t("plug.logs.section.label"),
        component: () => <PluginLogPanel logs={logs} plugins={plugins} />,
      });
    },
  },
};
