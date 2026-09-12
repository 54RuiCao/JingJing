/** vdom 区域的界面文案。key 用 `vdom.` 前缀。 */
const zh = {
  "vdom.depthLimit": "嵌套太深了（上限 {max} 层）：把界面拆成几块，或减少包装 div",
  "vdom.nodeNotObject": "每个节点必须是对象 { type, props?, children? }，收到 {got}",
  "vdom.gotArray": "数组",
  "vdom.tooManyNodes": "节点太多（上限 {max} 个）：列表要截断后再渲染",
  "vdom.typeMustBeString": "type 必须是字符串（标签名）",
  "vdom.unknownTag": "\"{tag}\" 不在允许的标签里。可用标签：{tags}（用不了自定义组件与 svg）",
  "vdom.propsMustBeObject": "props 必须是对象",
  "vdom.eventToken": "事件属性的值必须是 ui.handler(fn) 返回的字符串令牌（JSON 里放不下函数）",
  "vdom.unknownProp": "不认识的属性。可用：{props}，事件：{events}",
  "vdom.styleMustBeObject": "style 必须是对象（camelCase，例 { fontSize: 12 }）",
  "vdom.unknownStyleProp": "不允许的样式属性（可用：{props}）",
  "vdom.styleValue": "样式值只能是字符串或数字",
  "vdom.propValue": "属性值只能是字符串 / 数字 / 布尔，收到 {kind}",
  "vdom.childrenMustBeArray": "children 必须是数组",
  "vdom.textTooLong": "单个文本节点太长（上限 {max} 字符）",
} as const;

const en: Record<keyof typeof zh, string> = {
  "vdom.depthLimit": "Too deeply nested (limit {max} levels): split the UI into a few pieces, or remove wrapper div",
  "vdom.nodeNotObject": "Every node must be an object { type, props?, children? }, got {got}",
  "vdom.gotArray": "array",
  "vdom.tooManyNodes": "Too many nodes (limit {max}): truncate the list before rendering",
  "vdom.typeMustBeString": "type must be a string (the tag name)",
  "vdom.unknownTag": "\"{tag}\" is not an allowed tag. Available tags: {tags} (custom components and svg are not available)",
  "vdom.propsMustBeObject": "props must be an object",
  "vdom.eventToken": "Event prop values must be the string token returned by ui.handler(fn) (JSON cannot carry functions)",
  "vdom.unknownProp": "Unknown prop. Available: {props}; events: {events}",
  "vdom.styleMustBeObject": "style must be an object (camelCase, e.g. { fontSize: 12 })",
  "vdom.unknownStyleProp": "Disallowed style prop (available: {props})",
  "vdom.styleValue": "Style values must be a string or a number",
  "vdom.propValue": "Prop values must be a string / number / boolean, got {kind}",
  "vdom.childrenMustBeArray": "children must be an array",
  "vdom.textTooLong": "A single text node is too long (limit {max} chars)",
};

export const vdomPart = { zh, en };
