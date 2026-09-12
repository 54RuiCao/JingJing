/**
 * 内置插件：阅读区尾部的一条（P3.2 的样例之一）。
 *
 * 与状态条的分工：那条是"这本书读到哪了"（全局、常驻），这条是"当前这一屏的上下文"，
 * 并且带一个动作（回到本章开头）—— 用来演示槽位 props 与实时状态读取。
 */

import { HOST_API_VERSION } from "../../core/plugin/manifest";
import type { BuiltinPlugin } from "../../core/plugin/types";
import type { ToolHost } from "../../ai/tools/host";
import type { SlotsService } from "../slots/types";
import { t } from "../../i18n";
import { useT } from "../../i18n/react";

function ReaderTail({ reader }: { reader: ToolHost }) {
  const t = useT();
  const progress = reader.progress();
  const context = reader.context();
  const pct = (progress.fraction * 100).toFixed(1);
  return (
    <div className="air-slot-tail" title={t("reader.tailProvidedBy", { id: "app.aireader.reader-tail" })}>
      <span className="air-slot-tail-chapter">{progress.chapter || t("reader.noChapter")}</span>
      <span className="air-slot-tail-loc">{progress.location}</span>
      <span className="air-slot-tail-pct">{pct}%</span>
      <span className="air-slot-tail-ctx">
        {context
          ? t("reader.contextLoaded", { loaded: context.loadedChapters, total: context.chapters })
          : t("reader.noContext")}
      </span>
      <button
        className="air-slot-tail-btn"
        onClick={() => {
          void reader.goToFraction(0);
        }}
        title={t("reader.goToStart")}
      >
        {t("reader.backToStart")}
      </button>
    </div>
  );
}

export const readerTailPlugin: BuiltinPlugin = {
  manifest: {
    id: "app.aireader.reader-tail",
    // name / purpose 用 getter：语言可能在运行期切换，取词必须等到渲染时（写成 t(...) 会在模块加载时定死）
    get name() {
      return t("reader.pluginName");
    },
    get purpose() {
      return t("reader.pluginPurpose");
    },
    version: "1.0.0",
    apiVersion: HOST_API_VERSION,
    capabilities: ["reader.read", "reader.navigate", "ui.slot"],
  },
  plugin: {
    name: "reader-tail",
    inject: ["slots", "reader"],
    apply(ctx) {
      const slots = ctx.get<SlotsService>("slots");
      const reader = ctx.get<ToolHost>("reader");
      if (!slots || !reader) return;
      slots.register({
        name: "reader.view.tail",
        id: "reader-status",
        order: 10,
        label: t("reader.slotLabel"),
        component: () => <ReaderTail reader={reader} />,
      });
    },
  },
};
