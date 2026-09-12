/**
 * 宿主自带的 ui-layout 插件（P3.2）：**声明产品预设的槽位**。
 *
 * 为什么由插件来声明而不是直接在 App 里写死：DSH 里 root 与它的子槽位也是由 ui-layout
 * 这个插件声明的 —— 于是"谁能往哪挂"和"插件怎么被卸载"走同一条路径，
 * 槽位表本身也就成了可诊断、可替换的一部分。
 *
 * 表照 内部设计笔记 §5.4，逐项标注：kind / scope / replaceRisk / **是否已接线**。
 * 仍未接线的（root）如实标出来：声明了但没有渲染点，设置面板里会显示"未接线" ——
 * 比"声明了却永远没反应"诚实。
 */

import { t } from "../../i18n";
import { HOST_API_VERSION } from "../../core/plugin/manifest";
import type { BuiltinPlugin } from "../../core/plugin/types";
import type { SlotDeclaration, SlotsService } from "../slots/types";

type ShippedSlot = { name: string; declaration: SlotDeclaration };

export const SHIPPED_SLOTS: ShippedSlot[] = [
  {
    name: "sidebar.footer.action",
    declaration: {
      kind: "list",
      scope: "app",
      replaceRisk: "none",
      wired: true,
      get description() {
        return t("plug.layout.sidebarFooterAction");
      },
    },
  },
  {
    name: "settings.section",
    declaration: {
      kind: "list",
      scope: "app",
      replaceRisk: "none",
      wired: true,
      get description() {
        return t("plug.layout.settingsSection");
      },
    },
  },
  {
    name: "reader.view.tail",
    declaration: {
      kind: "list",
      scope: "book",
      replaceRisk: "none",
      wired: true,
      get description() {
        return t("plug.layout.readerViewTail");
      },
    },
  },
  {
    name: "reader.selection.action",
    declaration: {
      kind: "keyed",
      scope: "book",
      replaceRisk: "none",
      wired: true,
      get description() {
        return t("plug.layout.readerSelectionAction");
      },
    },
  },
  {
    name: "chat.message.action",
    declaration: {
      kind: "keyed",
      scope: "session",
      replaceRisk: "none",
      wired: true,
      get description() {
        return t("plug.layout.chatMessageAction");
      },
    },
  },
  {
    name: "library.view.top",
    declaration: {
      kind: "list",
      scope: "app",
      replaceRisk: "none",
      wired: true,
      get description() {
        return t("plug.layout.libraryViewTop");
      },
    },
  },
  {
    name: "root",
    declaration: {
      kind: "single",
      scope: "app",
      replaceRisk: "shadows-shipped-ui",
      wired: false,
      get description() {
        return t("plug.layout.root");
      },
    },
  },
  {
    name: "tool.call.card",
    declaration: {
      // P3.6 起是 **chain**：哪个插件渲染哪张卡，由它自己的 select(card) 决定
      //（看着工具名与结果自提名），第一个匹配者上，没人接手就用产品默认卡。
      // DSH 里对应 tool.view.cordis 的"运行卡片里的业务视图席位"。
      kind: "chain",
      scope: "session",
      replaceRisk: "shadows-shipped-ui",
      wired: true,
      get description() {
        return t("plug.layout.toolCallCard");
      },
      // 用法：slots.register({ name: 'tool.call.card', select: (p) => p.card?.name === 'search_book' ? {highlight:true} : null }, Card)
      // 组件拿到的 props 是 { card, matched }；matched 就是 select 的返回值
    },
  },
];

export const uiLayoutPlugin: BuiltinPlugin = {
  manifest: {
    id: "app.aireader.ui-layout",
    get name() {
      return t("plug.layout.pluginName");
    },
    get purpose() {
      return t("plug.layout.pluginPurpose");
    },
    version: "1.0.0",
    apiVersion: HOST_API_VERSION,
    capabilities: ["ui.slot"],
  },
  plugin: {
    name: "ui-layout",
    inject: ["slots"],
    apply(ctx) {
      const slots = ctx.get<SlotsService>("slots");
      if (!slots) return;
      for (const slot of SHIPPED_SLOTS) {
        slots.declare(slot.name, slot.declaration);
      }
    },
  },
};
