/**
 * 动态包的 UI 桥（P3.4 第 0 步）。
 *
 * ## 问题
 * quickjs 里的插件与宿主 React **不是一个 realm**：函数、类、Symbol、原型都过不去。
 * 所以"插件返回 React 元素"这条路根本不通（DSH 的浏览器半是在**同一个 realm** 里
 * 用 React.createElement 求值的，我们没有那个条件）。
 *
 * ## 做法：声明式 JSON VDOM
 * 插件返回纯数据：`{ type, props, children }`；宿主写一个很薄的渲染器把它变成 React 元素；
 * 事件用**字符串令牌**（`ui.handler(fn)` 返回 "@0"）指回插件里的回调。
 *
 * 好处：纯数据、可序列化、**可校验**（标签白名单 + 深度/节点数上限 + 属性白名单），
 *      不需要任何跨 realm 桥，也不会把宿主的 React 树交给插件乱改。
 * 代价：用不了 npm 上的 React 组件（对"显示当前章节剩余页数"这类小组件足够）。
 *
 * ## 纪律
 *   - **不认识的标签/属性直接报错**，不静默丢弃 —— 报错信息里带白名单，模型能自己改对。
 *     这也让"渲染失败"成为一条可诊断的路径（槽位边界会摘掉这一格，diagnose 看得到）。
 *   - **渲染函数必须同步**：界面渲染不能等 promise（异步数据要在 handler/refresh 里先取好，
 *     存进插件自己的变量，渲染时只读）。
 *   - 不给 dangerouslySetInnerHTML / href / script：这层是 API 纪律，没必要开这些口子。
 */

import { Fragment, createElement, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { t } from "../../i18n";
// 桥的契约住在运行时那边（core 不认识 React，所以只能这样单向依赖：UI 层 import 类型）
import type { DynamicUiBridge } from "../../core/plugin/runtime-quickjs";

export type { DynamicUiBridge };

// ---------- 契约 ----------

export type VNode = { type: string; props?: Record<string, unknown>; children?: VChild[] };
export type VChild = VNode | string | number | null | false;

// ---------- 白名单 ----------

/** 可用的标签（够写"一块状态文本 + 一个按钮"这类小组件） */
export const VDOM_TAGS = [
  "div", "span", "p", "b", "strong", "i", "em", "small", "code", "pre", "br", "hr",
  "ul", "ol", "li", "button", "label", "input", "section", "header", "footer",
  "table", "thead", "tbody", "tr", "th", "td",
] as const;

/** 非事件属性白名单（值只能是字符串/数字/布尔） */
export const VDOM_PROPS = [
  "className", "style", "title", "id", "type", "value", "placeholder", "disabled",
  "checked", "readOnly", "rows", "cols", "min", "max", "step", "aria-label", "role",
] as const;

/** 事件属性（值必须是 ui.handler(...) 给出的字符串令牌） */
export const VDOM_EVENTS = [
  "onClick", "onDoubleClick", "onChange", "onInput", "onFocus", "onBlur",
  "onMouseEnter", "onMouseLeave", "onKeyDown",
] as const;

/** style 允许的 CSS 属性（camelCase，与 React 一致） */
export const VDOM_STYLE_PROPS = [
  "color", "backgroundColor", "fontSize", "fontWeight", "fontStyle", "fontFamily", "lineHeight",
  "letterSpacing", "textAlign", "textDecoration", "whiteSpace", "wordBreak",
  "margin", "marginTop", "marginRight", "marginBottom", "marginLeft",
  "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "display", "gap", "rowGap", "columnGap", "flexDirection", "flexWrap", "alignItems", "justifyContent",
  "width", "minWidth", "maxWidth", "height", "minHeight", "maxHeight",
  "border", "borderTop", "borderBottom", "borderColor", "borderWidth", "borderStyle", "borderRadius",
  "opacity", "overflow", "cursor", "verticalAlign", "position", "top", "right", "bottom", "left", "zIndex",
] as const;

/**
 * 白名单之外还有三道量纲限制（防止插件把界面卡死，**不是性能边界** —— React 画几千个 div 没问题）。
 *
 * nodes 从 200 提到 **600**：用户要的「像 GitHub 那样的阅读热力图」一年就是 53×7 = 371 个格子，
 * 200 个节点根本画不出一年的图（插件只能被迫缩水）。600 仍然挡得住"一次渲染几万个节点"这类事故。
 */
export const VDOM_LIMITS = { depth: 12, nodes: 600, textChars: 4000 };

export class VdomError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super((path ? path + "：" : "") + message);
    this.name = "VdomError";
    this.path = path;
  }
}

const TAGS = new Set<string>(VDOM_TAGS);
const PROPS = new Set<string>(VDOM_PROPS);
const STYLE_PROPS = new Set<string>(VDOM_STYLE_PROPS);
const EVENTS = new Map<string, string>(VDOM_EVENTS.map((e) => [e.toLowerCase(), e]));

/** 事件名大小写归一：模型写 onclick / onclick 都能认（认出来再按白名单校验） */
function normalizeEvent(key: string): string | undefined {
  return EVENTS.get(key.toLowerCase());
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 校验一棵声明式 VDOM。**一次报第一个错**（带路径），因为渲染期不能攒错误：
 * 抛出去就由槽位边界摘掉这一格（P3.2 的 abdicate），diagnose 能读到原因。
 */
export function validateVdom(input: unknown, path = "root", depth = 1, counter = { n: 0 }): VNode {
  if (depth > VDOM_LIMITS.depth) {
    throw new VdomError(path, t("vdom.depthLimit", { max: VDOM_LIMITS.depth }));
  }
  if (!isPlainObject(input)) {
    throw new VdomError(
      path,
      t("vdom.nodeNotObject", {
        got: input === null ? "null" : Array.isArray(input) ? t("vdom.gotArray") : typeof input,
      }),
    );
  }
  if (++counter.n > VDOM_LIMITS.nodes) {
    throw new VdomError(path, t("vdom.tooManyNodes", { max: VDOM_LIMITS.nodes }));
  }
  const type = input.type;
  if (typeof type !== "string") throw new VdomError(path + ".type", t("vdom.typeMustBeString"));
  if (!TAGS.has(type)) {
    throw new VdomError(
      path + ".type",
      t("vdom.unknownTag", { tag: type, tags: VDOM_TAGS.join(" / ") }),
    );
  }

  const out: VNode = { type };

  if (input.props !== undefined) {
    if (!isPlainObject(input.props)) throw new VdomError(path + ".props", t("vdom.propsMustBeObject"));
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.props)) {
      const event = normalizeEvent(key);
      if (event) {
        if (typeof value !== "string" || !value) {
          throw new VdomError(
            path + ".props." + key,
            t("vdom.eventToken"),
          );
        }
        props[event] = value;
        continue;
      }
      if (key === "class") {
        props.className = value;
        continue;
      }
      if (!PROPS.has(key)) {
        throw new VdomError(
          path + ".props." + key,
          t("vdom.unknownProp", { props: VDOM_PROPS.join(" / "), events: VDOM_EVENTS.join(" / ") }),
        );
      }
      if (key === "style") {
        if (value === undefined || value === null) continue;
        if (!isPlainObject(value)) throw new VdomError(path + ".props.style", t("vdom.styleMustBeObject"));
        const style: Record<string, unknown> = {};
        for (const [cssKey, cssValue] of Object.entries(value)) {
          if (!STYLE_PROPS.has(cssKey)) {
            throw new VdomError(path + ".props.style." + cssKey, t("vdom.unknownStyleProp", { props: VDOM_STYLE_PROPS.join(" / ") }));
          }
          if (typeof cssValue !== "string" && typeof cssValue !== "number") {
            throw new VdomError(path + ".props.style." + cssKey, t("vdom.styleValue"));
          }
          style[cssKey] = cssValue;
        }
        props.style = style;
        continue;
      }
      const kind = typeof value;
      if (kind !== "string" && kind !== "number" && kind !== "boolean") {
        throw new VdomError(path + ".props." + key, t("vdom.propValue", { kind }));
      }
      props[key] = value;
    }
    out.props = props;
  }

  if (input.children !== undefined) {
    if (!Array.isArray(input.children)) throw new VdomError(path + ".children", t("vdom.childrenMustBeArray"));
    const kids: VChild[] = [];
    input.children.forEach((child, i) => {
      const at = path + ".children[" + i + "]";
      if (child === null || child === false || child === undefined) return;
      if (typeof child === "string" || typeof child === "number") {
        if (typeof child === "string" && child.length > VDOM_LIMITS.textChars) {
          throw new VdomError(at, t("vdom.textTooLong", { max: VDOM_LIMITS.textChars }));
        }
        kids.push(child);
        return;
      }
      kids.push(validateVdom(child, at, depth + 1, counter));
    });
    out.children = kids;
  }

  return out;
}

// ---------- 渲染 ----------

/** 把校验过的 VDOM 变成 React 元素。invoke 是"事件令牌 → 插件里的回调"的那一跳。 */
export function renderVdom(node: VNode, invoke: (token: string) => void): ReactNode {
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.props ?? {})) {
    // 校验过的 props 里，事件键已经是白名单里的规范写法（onClick …），值一定是字符串令牌
    if (EVENTS.has(key.toLowerCase()) && typeof value === "string") {
      const token = value;
      props[key] = () => invoke(token);
      continue;
    }
    props[key] = value;
  }
  const children = (node.children ?? []).map((child, i) =>
    typeof child === "object" && child !== null
      ? createElement(Fragment, { key: i }, renderVdom(child as VNode, invoke))
      : (child as ReactNode),
  );
  return createElement(node.type, props, ...children);
}

/**
 * 造一个宿主侧 React 组件：它不认识插件，只认识桥。
 * 渲染期抛错刻意**不吞** —— 交给 SlotView 的 entry 边界摘掉这一格（P3.2 的语义），
 * 同时通过 bridge.report 上报给 diagnose。
 */
export function createDynamicSlotComponent(bridge: DynamicUiBridge): ComponentType<Record<string, unknown>> {
  function DynamicSlot(props: Record<string, unknown>) {
    useSyncExternalStore(
      (cb) => bridge.subscribe(cb),
      () => bridge.version(),
      () => bridge.version(),
    );
    let raw: string;
    try {
      raw = bridge.render(props ?? {});
    } catch (e) {
      bridge.report(e);
      throw e;
    }
    let node: VNode;
    try {
      node = validateVdom(JSON.parse(raw === "" ? "null" : raw));
    } catch (e) {
      bridge.report(e);
      throw e;
    }
    try {
      return renderVdom(node, (token) => bridge.invoke(token));
    } catch (e) {
      bridge.report(e);
      throw e;
    }
  }
  DynamicSlot.displayName = "DynamicSlot(" + bridge.pluginId + ")";
  return DynamicSlot;
}
