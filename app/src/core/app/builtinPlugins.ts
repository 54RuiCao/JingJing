/**
 * 内置插件（P3.1）：manifest 与实现放在一起。
 *
 * 为什么要给内置插件也写 manifest：加载器只有一条路径 —— 内置与用户插件的差别只是
 * "实现从哪来"（内置编译器里就有，用户包要等 P3.3 的 quickjs 运行时）。
 * 于是"卸载内置插件"、"改内置插件的配置"、"内置插件启动失败不影响别的插件"这些话
 * 都自动成立，不需要第二套机制。
 *
 * id 用反 DNS 形式（≈ DSH 的 pluginId）：**一旦发布就不能改**，授权与回滚都绑它。
 */

import { t } from "../../i18n";
import { HOST_API_VERSION, type PluginManifest } from "../plugin/manifest";
import { HOST_IMPLEMENTED_CAPABILITIES } from "../plugin/permissions";
import type { BuiltinPlugin, PluginDevService, PluginLogsService, PluginsService } from "../plugin/types";
import type { SlotsService } from "../../ui/slots/types";
import { ToolRegistry } from "../../ai/tools/registry";
import { createReadingTools } from "../../ai/tools/reading";
import { createActionTools } from "../../ai/tools/actions";
import { createSkillTools } from "../../ai/tools/skills";
import { createPluginTools } from "../../ai/tools/plugin";
import type { ToolHost } from "../../ai/tools/host";
import type { ToolDefinition } from "../../ai/tools/types";
import type { SkillHost } from "../../skills/host";
import type { PathsService, ReadingStatsService } from "./services";
import { BUILTIN_UI_PLUGINS } from "../../ui/builtin/index";

/** 只读 + 写工具。守卫也跟着插件来去（P2.3 的"没打开书不许写"）。 */
export const readerToolsPlugin: BuiltinPlugin = {
  manifest: {
    id: "app.aireader.reader-tools",
    // name / purpose 用 getter：文案跟随界面语言，读的时候才取词
    get name() {
      return t("plug.builtin.readerTools");
    },
    get purpose() {
      return t("plug.builtin.readerToolsPurpose");
    },
    version: "1.0.0",
    apiVersion: HOST_API_VERSION,
    capabilities: ["reader.read", "reader.annotate", "reader.navigate"],
  },
  plugin: {
    name: "reader-tools",
    inject: ["tools", "reader"],
    apply(ctx) {
      const tools = ctx.get<ToolRegistry>("tools");
      const reader = ctx.get<ToolHost>("reader");
      if (!tools || !reader) return;
      // 注册一律走 ctx.effect：即使 apply 后面抛错，这些注册也会被逆序撤掉
      //（返回数组也能被收集，但那种写法在"抛错"时来不及生效 —— 每个注册都是 effect 才稳）
      ctx.effect(
        () =>
          tools.registerAll([
            ...createReadingTools(reader),
            ...createActionTools(reader),
          ] as ToolDefinition[]),
        "reader-tools:register",
      );
      ctx.effect(
        () =>
          tools.registerGuard(({ name }) => {
            if (!name.startsWith("add_") && name !== "goto_location") return null;
            if (reader.bookId()) return null;
            return "当前没有打开书库里的书，写操作被拒绝（先让用户从书架打开一本书）";
          }),
        "reader-tools:guard",
      );
    },
  },
};

/** 技能工具（load_skill / create_skill）。技能目录本身由 skills 服务提供。 */
export const skillToolsPlugin: BuiltinPlugin = {
  manifest: {
    id: "app.aireader.skill-tools",
    // name / purpose 用 getter：文案跟随界面语言，读的时候才取词
    get name() {
      return t("plug.builtin.skillTools");
    },
    get purpose() {
      return t("plug.builtin.skillToolsPurpose");
    },
    version: "1.0.0",
    apiVersion: HOST_API_VERSION,
  },
  plugin: {
    name: "skill-tools",
    inject: ["tools", "skills"],
    apply(ctx) {
      const tools = ctx.get<ToolRegistry>("tools");
      const skills = ctx.get<SkillHost>("skills");
      const paths = ctx.get<PathsService>("paths");
      if (!tools || !skills) return;
      ctx.effect(
        () =>
          tools.registerAll(
            createSkillTools({
              registry: skills.registry,
              write: (relPath, text, opts) => skills.write(relPath, text, opts.overwrite),
              refresh: async () => {
                await skills.refresh();
              },
              readResource: (name, rel) => skills.readResource(name, rel),
              skillsDir: () => paths?.skillsDir() ?? "",
            }),
          ),
        "skill-tools:register",
      );
    },
  },
};

/**
 * P3.4：AI 写插件的四个工具（inspect / define / run / diagnose）。
 *
 * 做成内置插件（而不是写死在 runtime 里）的理由与别的插件一样：**用户能在插件设置里关掉它**。
 * 关掉之后这四个工具的 schema 一起从请求前缀里消失 —— 不写插件的用户不必为它付 token。
 */
export const pluginToolsPlugin: BuiltinPlugin = {
  manifest: {
    id: "app.aireader.plugin-tools",
    // name / purpose 用 getter：文案跟随界面语言，读的时候才取词
    get name() {
      return t("plug.builtin.pluginTools");
    },
    get purpose() {
      return t("plug.builtin.pluginToolsPurpose");
    },
    version: "1.0.0",
    apiVersion: HOST_API_VERSION,
  },
  plugin: {
    name: "plugin-tools",
    inject: ["tools", "pluginDev", "slots", "plugins", "permissions", "pluginLogs"],
    apply(ctx) {
      const tools = ctx.get<ToolRegistry>("tools");
      const dev = ctx.get<PluginDevService>("pluginDev");
      const slots = ctx.get<SlotsService>("slots");
      const plugins = ctx.get<PluginsService>("plugins");
      const pluginLogs = ctx.get<PluginLogsService>("pluginLogs");
      if (!tools || !dev || !slots || !plugins || !pluginLogs) return;
      ctx.effect(
        () =>
          tools.registerAll(
            createPluginTools({
              dev,
              slots,
              tools,
              plugins: () => plugins.list(),
              implemented: () => HOST_IMPLEMENTED_CAPABILITIES,
              container: () => {
                const diag = plugins.diagnostics();
                return { pendingEffects: diag.pendingEffects, disposerFailures: diag.disposerFailures, fibers: diag.fibers.length };
              },
              logs: {
                list: (pluginId, limit) => pluginLogs.list(pluginId, limit),
                stats: () => pluginLogs.stats(),
              },
            }),
          ),
        "plugin-tools:register",
      );
    },
  },
};

/**
 * 阅读统计：给别的插件（以及 P3.4 的示例插件）提供一个 readingStats 服务。
 * 它带**配置**（style / showChapters），用来演示 P3.1 的配置校验与热更回滚。
 */
export const readingStatsPlugin: BuiltinPlugin = {
  manifest: {
    id: "app.aireader.reading-stats",
    // name / purpose 用 getter：文案跟随界面语言，读的时候才取词
    get name() {
      return t("plug.builtin.readingStats");
    },
    get purpose() {
      return t("plug.builtin.readingStatsPurpose");
    },
    version: "1.0.0",
    apiVersion: HOST_API_VERSION,
    capabilities: ["reader.read"],
    config: {
      type: "object",
      properties: {
        style: { type: "string", enum: ["short", "long"] },
        showChapters: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  plugin: {
    name: "reading-stats",
    inject: ["reader"],
    apply(ctx, raw) {
      const reader = ctx.get<ToolHost>("reader");
      if (!reader) return;
      const config = (raw ?? {}) as { style?: "short" | "long"; showChapters?: boolean };
      const style = config.style ?? "short";
      const showChapters = config.showChapters !== false;
      const service: ReadingStatsService = {
        chapters: () => reader.chapters().length,
        fraction: () => reader.progress().fraction,
        summary() {
          // 摘要会直接显示在状态条上（也进 AI 的工具结果），所以跟着界面语言走
          const progress = reader.progress();
          const percent = (progress.fraction * 100).toFixed(1);
          const n = reader.chapters().length;
          const chapter = progress.chapter || t("plug.stats.unknownChapter");
          if (style !== "long") {
            return showChapters ? t("plug.stats.summaryChapters", { percent, n }) : t("plug.stats.summary", { percent });
          }
          return showChapters
            ? t("plug.stats.summaryLongChapters", { percent, n, chapter })
            : t("plug.stats.summaryLong", { percent, chapter });
        },
      };
      return ctx.provide("readingStats", service);
    },
  },
};

/** 界面类内置插件（P3.2）：声明槽位 + 三个占位样例（侧栏 / 设置 / 阅读区尾部） */
export const BUILTIN_PLUGINS: BuiltinPlugin[] = [
  readerToolsPlugin,
  skillToolsPlugin,
  readingStatsPlugin,
  pluginToolsPlugin,
  ...BUILTIN_UI_PLUGINS,
];

/** id → 实现（P3.1 的实现来源；P3.3 会在这之前先问 quickjs 运行时） */
export function builtinImplementation(id: string) {
  return BUILTIN_PLUGINS.find((b) => b.manifest.id === id)?.plugin;
}

export type { PluginManifest };
