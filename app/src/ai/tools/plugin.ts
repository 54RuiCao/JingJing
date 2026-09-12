/**
 * P3.4：AI 写插件闭环的四个工具（inspect / define / run / diagnose）。
 *
 * 对标 DSH 的 dsh-tool-cordis（内部设计笔记 §4.3 的六步）：
 *
 *   ① inspect   —— 自省面：服务 / 插槽目录 / 工具清单 / 能力词表 / 插件状态 / 已定义的包 / ctx API
 *   ② define    —— 铸一个**不可变包**（校验 + 语法预检 + pluginId/packageId），不运行、不审批
 *   ③ run       —— 授权门 + 挂到 P3.1 的加载器路径；纯宿主包（不声明能力）直接激活，
 *                  带能力声明的包（UI 半必然要 ui.slot）停在 awaiting-approval 等用户点头
 *   ④ diagnose  —— 版本指针 + 指定包源码 + 诊断（含渲染期失败）
 *
 * 两条纪律（DSH SKILL.md:376-395）：
 *   - **失败不自动回滚**：修 = 追加新包再 run；回滚 = 对旧的 packageId 再 run 一次；
 *   - 用户**明确拒绝**过的能力不自动重试（PermissionBroker 把 denied 也持久化）。
 *
 * 这四个工具本身是内置插件 app.aireader.plugin-tools 注册的 —— 与别的东西一样能被卸载，
 * 卸载后模型连这四个工具都看不见（schema 一起从请求前缀里消失）。
 */

import { CAPABILITIES } from "../../core/plugin/manifest";
import { OP_CAPABILITY } from "../../core/plugin/runtime-quickjs";
import { VDOM_EVENTS, VDOM_LIMITS, VDOM_PROPS, VDOM_STYLE_PROPS, VDOM_TAGS } from "../../ui/dynamic/vdom";
import type { CapabilityId } from "../../core/plugin/manifest";
import type { PluginDevService, PluginRunResult, PluginStatus } from "../../core/plugin/types";
import type { SlotCatalogEntry, SlotsService } from "../../ui/slots/types";
import type { ToolRegistry } from "./registry";
import type { ToolDefinition, ToolOutcome } from "./types";

export type PluginToolDeps = {
  dev: PluginDevService;
  slots: SlotsService;
  tools: ToolRegistry;
  plugins(): PluginStatus[];
  /** 宿主已经接上门面的能力（声明了这些才可能被授予） */
  implemented(): string[];
  /** disposerFailures / pendingEffects 这类容器诊断 */
  container(): { pendingEffects: number; disposerFailures: number; fibers: number };
  /** 插件日志（P3.5）：插件自己写下的东西，诊断时最直接 */
  logs: { list(pluginId?: string, limit?: number): { at: number; pluginId: string; level: string; message: string }[]; stats(): { kept: number; dropped: number; plugins: number } };
};

/** 宿主自己提供的服务（插件用 inject 声明依赖；动态包看不到这一层，只能用下面的 ctx 面） */
export const HOST_SERVICE_NAMES = [
  "tools",
  "reader",
  "skills",
  "db",
  "theme",
  "ai",
  "paths",
  "slots",
  "plugins",
  "permissions",
  "pluginDev",
  "pluginLogs",
];

/** 动态包能看到的 ctx 面（写给模型看的表：**能力 → 能做什么**） */
export const DYNAMIC_CTX_API: { api: string; capability: string | null; note: string }[] = [
  { api: "ctx.log(...args)", capability: "log.write", note: "写插件日志（控制台 + 诊断）" },
  {
    api: "ctx.reader.progress()",
    capability: "reader.read",
    note: "同步。{ fraction:0~1, chapter, location, sectionIndex, sectionTotal, sectionFraction:本章内进度, locations:{current,total} }",
  },
  { api: "ctx.reader.chapters()", capability: "reader.read", note: "同步。章节索引 [{n,title,cfi,chars,inContext}]；没装载全书上下文时是空数组" },
  { api: "ctx.reader.chapter(n, offset, maxChars)", capability: "reader.read", note: "同步。取第 n 章正文切片" },
  { api: "ctx.reader.selection()", capability: "reader.read", note: "同步。当前选区 {text,cfi,chapter} 或 null" },
  { api: "await ctx.reader.search(q, limit)", capability: "reader.read", note: "全文检索（FTS5）" },
  { api: "await ctx.reader.annotations()", capability: "reader.read", note: "本书的划线/笔记/书签" },
  {
    api: "await ctx.reader.activity()",
    capability: "reader.read",
    note:
      "宿主采集的**阅读活动**（每天读了多少秒/翻了多少页）：{ today, todaySeconds, todayTurns, days:[{day,seconds,turns}], totalSeconds, activeDays, streak, longestStreak, bestDay }。" +
      "做热力图/阅读目标/连续天数用它 —— 插件沙箱里没有定时器，读时长只能由宿主记",
  },
  { api: "await ctx.reader.addAnnotation({kind,cfi,text,note,color})", capability: "reader.annotate", note: "写批注（kind: highlight|note|bookmark）" },
  { api: "await ctx.reader.gotoChapter(n) / gotoCfi(cfi) / gotoFraction(f)", capability: "reader.navigate", note: "改阅读位置" },
  { api: "await ctx.storage.get/set/remove/keys", capability: "storage.plugin", note: "插件自己的存储（按 pluginId 隔离）" },
  {
    api: "★ 声明 ai.credentials（与 net.fetch 一起）后：对**你配置的 AI 服务**发 GET 时，宿主会自动带上 Authorization",
    capability: "ai.credentials",
    note:
      "做「查余额 / 查用量」这类插件用它：**不要在 config 里让用户再填一次 Key**，宿主会代填（Key 不进插件沙箱）。" +
      "三条边界：只对 GET / HEAD 生效（POST 会被拒 —— 宿主不愿意替插件花钱）；只对你配置的 AI 服务那个域名；" +
      "范围是授权那一刻记下的域名，用户换服务商后要重新授权。插件自己给了 authorization 则以它为准。",
  },
  {
    api: "await ctx.net.fetch(url, { method?, headers?, body? })",
    capability: "net.fetch",
    note:
      "**宿主代发**的 HTTP 请求，返回 { ok, status, url, contentType, text, truncated, note?, redirects }。" +
      "只能在 manifest 的 network.origins 里声明过、且被用户授权的域名上请求（每次调用按目标域名复核）；" +
      "只允许 GET/POST/HEAD、15 秒超时、512KB 上限、重定向最多 3 跳且每一跳都要在授权域名内；" +
      "不带 cookie（宿主代发，插件拿不到用户登录态），也不许自己设 Cookie/Origin/Referer 之类的头。" +
      "密钥类参数写在 config 里让用户自己填，**不要硬编码**。",
  },
  { api: "ctx.tools.register({name,description,parameters,capabilities}, execute)", capability: null, note: "注册工具进**同一个** ToolRegistry；capabilities 必填且必须是 manifest 的子集" },
  { api: "ctx.provide('plugin.名字', 纯数据)", capability: null, note: "提供服务（只能是数据：函数过不了 realm）" },
  { api: "ctx.effect(fn)", capability: null, note: "注册副作用；fn 必须**同步**，返回的 disposer 在卸载时调用" },
  { api: "ctx.slots.register({slot,id?,key?,order?,priority?,label?}, render)", capability: "ui.slot", note: "挂一块界面；render(props, ui) 必须**同步**返回声明式 VDOM" },
  { api: "ctx.slots.refresh()", capability: "ui.slot", note: "让这块界面重渲染（异步取到数据之后调它）" },
  {
    api: "ctx.theme.overrideTokens({ '--air-accent': '#c00' })",
    capability: "ui.theme",
    note: "覆盖主题 CSS 变量；值可以是字符串，也可以按主题给 { light, sepia, dark }。只能覆盖 --air-bg/panel/text/sub/border/hover/accent/cover-from/cover-to",
  },
];

const UI_SURFACE = {
  tags: [...VDOM_TAGS],
  props: [...VDOM_PROPS],
  events: [...VDOM_EVENTS],
  styleProps: [...VDOM_STYLE_PROPS],
  limits: VDOM_LIMITS,
  shape: "{ type: '标签名', props: { className?, style?, ...事件 }, children: [节点 | 字符串] }",
  handler: "事件的值必须写 ui.handler(fn) 返回的令牌：{ type: 'button', props: { onClick: ui.handler(function () { ... }) }, children: ['点我'] }",
};

const brief = (text: string, max = 70): string => (text.length > max ? text.slice(0, max) + "…" : text);

function slotSummary(entries: SlotCatalogEntry[]) {
  return entries.map((e) => ({
    name: e.name,
    kind: e.kind,
    scope: e.scope,
    wired: e.wired,
    declaredBy: e.declaredBy,
    replaceRisk: e.replaceRisk,
    registrationCount: e.registrationCount,
    hint: e.wired ? undefined : "宿主还没有渲染点，挂上去也不会显示",
  }));
}

/** run 之后按状态给下一步（DSH 的 SKILL.md 里就是这种"教你怎么继续"的回执） */
function nextStep(result: PluginRunResult): string {
  switch (result.state) {
    case "ACTIVE":
      return result.contributions.length
        ? "已经在跑了，贡献：" + result.contributions.join(" / ")
        : "已经在跑了（这个包没有注册任何工具或界面：检查 apply 里是不是真的注册了东西）";
    case "PENDING_PERMISSION":
      return (
        "等用户授权：" + result.missing.join(" / ") +
        "（在右侧「插件」设置面板里点授权；授权后会自动挂起来，不需要再 run）" +
        (result.denied.length ? "；已被拒绝过的是：" + result.denied.join(" / ") + "（明确拒绝过的能力不会自动重试）" : "")
      );
    case "FAILED":
      return (
        "启动失败（**不会自动回滚**）：" + (result.detail ?? "") +
        "。改好代码后用 plugin_define 追加一个新版本再 run；要退回上一版就对旧的 packageId 再 run 一次。" +
        "先调 plugin_diagnose 看源码与堆栈。"
      );
    case "INVALID":
      return "配置不合法：" + (result.detail ?? "") + "（改 config 的默认值或 schema 后追加新版本再 run）";
    case "UNAVAILABLE":
      return "没有可执行的实现：" + (result.detail ?? "");
    case "DISABLED":
      return "用户在插件设置里关掉了它：请用户打开，或换一个 id 重新定义";
    default:
      return "当前状态：" + result.state + (result.detail ? "（" + result.detail + "）" : "");
  }
}

export function createPluginTools(deps: PluginToolDeps): ToolDefinition[] {
  const { dev } = deps;

  // ---------- ① inspect ----------

  const inspect: ToolDefinition<{ query?: string }> = {
    name: "plugin_inspect",
    description:
      "查看鲸鲸插件系统的现场：已声明的 UI 插槽、现有工具、服务、能力词表、插件状态、已定义的动态包、动态包能用的 ctx API，以及界面白名单。" +
      "**一次 overview（默认值）就能拿到全部**：返回内容很短，不要为了省篇幅分多次查（每一步都是一次完整的模型请求）。" +
      "写插件之前先调它——不要凭记忆猜 API 与槽位名。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          enum: ["overview", "slots", "tools", "services", "capabilities", "plugins", "packages", "api", "ui", "logs"],
          description: "查哪一块。overview = 全部各来一份摘要（默认）",
        },
      },
      required: [],
      additionalProperties: false,
    },
    executionMode: "parallel-safe",
    timeoutMs: 8000,
    // 返回的是一份结构化清单（有界）：裁剪会把 JSON 剪坏，模型就只能瞎猜
    keepFullResult: true,
    async execute(args): Promise<ToolOutcome> {
      const query = String(args?.query ?? "overview");
      const value: Record<string, unknown> = { query };
      const wantAll = query === "overview";
      try {
        if (wantAll || query === "slots") value.slots = slotSummary(deps.slots.catalog());
        if (wantAll || query === "tools") {
          const defs = deps.tools.visible();
          value.tools = defs.map((d) => ({ name: d.name, description: brief(d.description) }));
        }
        if (wantAll || query === "capabilities") {
          value.capabilities = CAPABILITIES.map((c) => ({
            id: c.id,
            risk: c.risk,
            implemented: deps.implemented().includes(c.id),
            hostImplemented: deps.implemented().includes(c.id) ? undefined : "宿主还没接门面：声明了也不会被授予",
            description: c.description,
          }));
        }
        if (wantAll || query === "plugins") {
          value.plugins = deps.plugins().map((p) => ({
            id: p.id,
            name: p.name,
            version: p.version,
            source: p.source,
            state: p.state,
            detail: p.detail,
            capabilities: p.capabilities,
            contributions: p.contributions ?? [],
          }));
        }
        if (wantAll || query === "packages") {
          value.packages = dev.listPackages().map((p) => ({
            packageId: p.packageId,
            pluginId: p.pluginId,
            version: p.version,
            capabilities: p.capabilities,
            files: p.files.map((f) => f.path),
            isCurrent: dev.currentPackageOf(p.pluginId)?.packageId === p.packageId,
          }));
        }
        if (wantAll || query === "services") {
          const diag = deps.container();
          value.services = {
            host: HOST_SERVICE_NAMES,
            note: "宿主服务只能通过插件 manifest/依赖声明使用；动态包能用的是下面 api 那一块（不是这些服务本身）",
            pendingEffects: diag.pendingEffects,
            disposerFailures: diag.disposerFailures,
            fibers: diag.fibers,
          };
        }
        if (wantAll || query === "api") {
          value.api = DYNAMIC_CTX_API;
          value.ops = OP_CAPABILITY;
          value.note = "capability 为 null 的 API 不需要授权；其余必须先写在 manifest 的 capabilities 里，再由用户授权。";
        }
        if (wantAll || query === "ui") value.ui = UI_SURFACE;
        if (wantAll || query === "logs") {
          // ctx.log 写的东西在这里能看见（P3.5）：插件不工作时先看它自己说了什么
          value.logs = deps.logs.list(undefined, 40).map((l) => ({ at: l.at, pluginId: l.pluginId, level: l.level, message: l.message }));
          value.logStats = deps.logs.stats();
        }
        value.hint =
          query === "logs"
            ? "这是所有插件最近写下的日志（ctx.log 与界面渲染失败）。插件没反应、界面不显示时先看这里。"
            : query === "api" || query === "ui"
            ? "写插件前把这两块看全：UI 半只能用白名单里的标签/属性，事件值必须是 ui.handler(fn) 的令牌。"
            : "需要更细的分块就再调一次 plugin_inspect（query=slots / api / ui / capabilities …）。";
        return { ok: true, value };
      } catch (e) {
        return { ok: false, error: { code: "INTERNAL", message: "inspect 失败：" + String(e instanceof Error ? e.message : e) } };
      }
    },
    present: (args) => ({ title: "查看插件现场", summary: String(args?.query ?? "overview"), tone: "ok" }),
  };

  // ---------- ② define ----------

  const define: ToolDefinition<{
    pluginId: string;
    name: string;
    purpose: string;
    version?: string;
    main: string;
    ui?: string;
    capabilities?: string[];
    /** 网络范围（P3.10）：声明 net.fetch 时必填 */
    network?: { origins?: string[] };
    config?: unknown;
  }> = {
    name: "plugin_define",
    description:
      "定义一个插件包（**只定义，不运行、不授权**）。包一旦定义就不可变：改内容必须换版本号（不给 version 会自动 +1）。" +
      "main 是宿主半（交出 apply(ctx, config)），ui 是可选的 UI 半（用 ctx.slots.register 挂声明式界面，需要 ui.slot 能力）。" +
      "定义成功后用 plugin_run 运行。",
    parameters: {
      type: "object",
      properties: {
        pluginId: { type: "string", description: "稳定标识，小写字母/数字/点/连字符，例：ai.chapter-left-pages。升级不变" },
        name: { type: "string", description: "插件名（≤40 字，会出现在插件列表里）" },
        purpose: { type: "string", description: "一句话说清这个插件做什么、给谁看（≤200 字）" },
        version: { type: "string", description: "语义化版本；不给就自动 +1（1.0.0 → 1.0.1）" },
        main: { type: "string", description: "宿主半代码：函数体或 IIFE，必须交出 apply(ctx, config)" },
        ui: { type: "string", description: "可选：UI 半代码，同样交出 apply(ctx, config)，里面用 ctx.slots.register 挂界面" },
        capabilities: {
          type: "array",
          items: { type: "string" },
          description:
            "声明需要的能力（reader.read / ui.slot / storage.plugin / net.fetch / ai.credentials / log.write …）。" +
            "**必须是你真的用到的**：少声明会调用失败，多声明会多要授权。" +
            "做「用用户已配置的 AI 服务」的插件时，net.fetch 与 ai.credentials 一起声明（后者让宿主代填 Authorization，不必再让用户填 Key）",
        },
        config: { type: "object", properties: {}, additionalProperties: true, description: "可选：JSON Schema（type 为 object），宿主会用它渲染配置表单并同步校验。**要用户填 API Key / 参数就写这里**，不要写死在代码里" },
        network: {
          type: "object",
          properties: {
            origins: {
              type: "array",
              items: { type: "string" },
              description: '要访问的域名，例 ["api.deepseek.com"]。声明了 net.fetch 就必填（最多 10 个）；不支持通配符',
            },
          },
          required: ["origins"],
          additionalProperties: false,
          description: "网络范围：授权时用户看到的就是这份域名清单",
        },
      },
      required: ["pluginId", "name", "purpose", "main"],
      additionalProperties: false,
    },
    executionMode: "exclusive",
    timeoutMs: 10000,
    async execute(args): Promise<ToolOutcome> {
      const result = dev.define({
        pluginId: String(args?.pluginId ?? ""),
        name: String(args?.name ?? ""),
        purpose: String(args?.purpose ?? ""),
        version: args?.version ? String(args.version) : undefined,
        main: String(args?.main ?? ""),
        ui: args?.ui ? String(args.ui) : undefined,
        capabilities: Array.isArray(args?.capabilities) ? (args.capabilities as string[]) : undefined,
        network: args?.network as { origins?: string[] } | undefined,
        config: args?.config,
      });
      if (!result.ok) {
        return {
          ok: false,
          error: {
            code: "INVALID_ARGUMENTS",
            message: result.issues.map((i) => i.field + ": " + i.message).join("；"),
            hint: "按上面的字段逐条改。语法预检问题（field=syntax）说明代码编译不过，先修语法再定义。",
          },
        };
      }
      const pkg = result.package;
      return {
        ok: true,
        value: {
          packageId: pkg.packageId,
          pluginId: pkg.pluginId,
          version: pkg.version,
          hash: pkg.hash,
          files: pkg.files.map((f) => f.path),
          capabilities: pkg.capabilities,
          created: result.created,
          previousVersionPackageId: result.previousPackageId,
          syntax: "已通过（只编译不执行）",
          next: result.created
            ? "用 plugin_run 运行它（pluginId=" + pkg.pluginId + "）。"
            : "这个包和之前一模一样，没有重新铸（幂等）。用 plugin_run 运行它。",
        },
      };
    },
  };

  // ---------- ③ run ----------

  const run: ToolDefinition<{ pluginId: string; packageId?: string }> = {
    name: "plugin_run",
    description:
      "运行一个已定义的插件包：把它挂进插件加载器（版本指针指向它 → 重新扫描 → 挂载）。" +
      "缺能力时会停在 awaiting-approval，等用户在插件设置面板里授权（授权后自动挂起来）。" +
      "**失败不会自动回滚**：改好代码后用 plugin_define 追加新版本再 run；要退回上一版就指定旧的 packageId 再 run。",
    parameters: {
      type: "object",
      properties: {
        pluginId: { type: "string", description: "要运行的插件 id（必须是 plugin_define 定义过的）" },
        packageId: { type: "string", description: "可选：指定运行哪一版（形如 pluginId@1.0.0#ab12cd34）。不给就用版本指针；**指定旧的就是回滚**" },
      },
      required: ["pluginId"],
      additionalProperties: false,
    },
    executionMode: "exclusive",
    timeoutMs: 20000,
    async execute(args): Promise<ToolOutcome> {
      const pluginId = String(args?.pluginId ?? "").trim();
      if (!pluginId) return { ok: false, error: { code: "INVALID_ARGUMENTS", message: "pluginId 必填" } };
      try {
        const startedAt = Date.now();
        const result = await dev.run(pluginId, args?.packageId ? String(args.packageId) : undefined);
        /**
         * run 之后**等一小会儿再回执**（P3.8 实测教训）。
         *
         * 界面是 React 异步渲染的：刚 run 完那一刻还没渲染，所以"渲染失败"也还没发生。
         * 实测：模型报"1.1.0 已上线"，界面其实因为 `overflowX` 不在白名单里被摘掉了 ——
         * 它没查、也就不知道，用户看到的是"什么都没有"。这里替它查一眼，把失败写进回执。
         */
        let renderFailures: { slot: string; message: string }[] = [];
        if (result.state === "ACTIVE") {
          await new Promise((r) => setTimeout(r, 400));
          try {
            const d = await dev.diagnose(pluginId);
            renderFailures = (d.renderFailures ?? [])
              .filter((f) => (f.at ?? 0) >= startedAt)
              .map((f) => ({ slot: f.slot, message: f.message }));
          } catch {
            /* 诊断失败不影响 run 的结论 */
          }
        }
        const warn = renderFailures.length
          ? "⚠ 刚挂上去就有界面渲染失败：" + renderFailures.map((f) => f.slot + "：" + f.message).join("；") +
            "。照着 plugin_inspect(query=ui) 的白名单改，然后 plugin_define 追加新版本再 plugin_run。"
          : "";
        return {
          ok: true,
          value: {
            ...result,
            awaitingApproval: result.state === "PENDING_PERMISSION",
            ...(renderFailures.length ? { renderFailures } : {}),
            next: nextStep(result) + (warn ? " " + warn : ""),
          },
        };
      } catch (e) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: String(e instanceof Error ? e.message : e),
            hint: "先用 plugin_inspect（query=packages）看看已经定义了哪些包。",
          },
        };
      }
    },
    present: (args, outcome) => ({
      title: "运行插件 " + String(args?.pluginId ?? ""),
      summary: outcome.ok ? String((outcome.value as { state?: string })?.state ?? "") : outcome.error.code,
      tone: outcome.ok ? "ok" : "error",
    }),
  };

  // ---------- ④ diagnose ----------

  const diagnose: ToolDefinition<{ pluginId: string; packageId?: string; includeSource?: boolean }> = {
    name: "plugin_diagnose",
    description:
      "诊断一个插件：版本指针、它有哪些包、当前状态与原因、缺哪些能力、贡献了什么、界面渲染失败记录，以及**指定包的源码**。" +
      "启动失败或界面不显示时先调它。注意：这里只报告，**不会自动回滚**。",
    parameters: {
      type: "object",
      properties: {
        pluginId: { type: "string", description: "插件 id" },
        packageId: { type: "string", description: "可选：要看哪一版的源码（默认当前指针那一版）" },
        includeSource: { type: "boolean", description: "是否带上源码（默认 true；只想看状态时可关掉省 token）" },
      },
      required: ["pluginId"],
      additionalProperties: false,
    },
    executionMode: "parallel-safe",
    timeoutMs: 8000,
    // 同上：诊断结果是结构化的，剪坏就没法照着修
    keepFullResult: true,
    async execute(args): Promise<ToolOutcome> {
      const pluginId = String(args?.pluginId ?? "").trim();
      if (!pluginId) return { ok: false, error: { code: "INVALID_ARGUMENTS", message: "pluginId 必填" } };
      const diagnosis = await dev.diagnose(pluginId, args?.packageId ? String(args.packageId) : undefined);
      const includeSource = args?.includeSource !== false;
      if (!includeSource) diagnosis.source = null;
      if (diagnosis.state === "NOT_DEFINED") {
        return {
          ok: true,
          value: {
            ...diagnosis,
            next:
              "这个 id 没有动态包。它可能是内置插件或磁盘上的插件（plugin_inspect 的 query=plugins 能看到）；" +
              "如果本来想写一个新插件，用 plugin_define 定义它。",
          },
        };
      }
      const hints: string[] = [];
      if (diagnosis.state === "FAILED") {
        hints.push("启动失败：照着 source 里的 main 改，然后 plugin_define 追加新版本 + plugin_run（不要试图改旧包）");
      }
      if (diagnosis.renderFailures.length) {
        hints.push("界面渲染失败过：多半是 VDOM 用了白名单外的标签/属性，或 render 不是同步的（plugin_inspect 的 query=ui 有白名单）");
      }
      if (diagnosis.missing.length) hints.push("缺授权：" + diagnosis.missing.join(" / ") + "（用户在插件设置面板授权后会自动挂起来）");
      if (diagnosis.denied.length) hints.push("被明确拒绝过的能力不会被自动重试：" + diagnosis.denied.join(" / "));
      if (diagnosis.unimplemented.length) hints.push("宿主还没接门面的能力：" + diagnosis.unimplemented.join(" / "));
      if (!hints.length && diagnosis.state === "ACTIVE") hints.push("它在正常跑：contributions 就是它挂上的东西");
      return { ok: true, value: { ...diagnosis, next: hints.join("；") } };
    },
  };

  return [inspect, define, run, diagnose] as ToolDefinition[];
}

export type { CapabilityId };
