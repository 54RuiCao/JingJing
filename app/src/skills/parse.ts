/**
 * SKILL.md 的 frontmatter 解析（P2.5）。容错语义照 DSH 的 parseFrontmatter/parseSkillFile：
 *   - **首行必须是 \`---\`**（容忍 BOM 与行尾 \r，兼容 CRLF），闭合行也是 \`---\`；
 *   - YAML 必须解析成对象，否则整个技能被丢弃（返回 error，不抛异常）；
 *   - 布尔字段只认 true/false/yes/no/on/off/1/0（大小写不敏感），**其他值直接报错丢弃**，
 *     绝不静默放行；**旧键名显式拒绝**（disableModelInvocation / modelInvocable / userInvocable）；
 *   - 未知多余字段静默忽略（无白名单）——自定义字段安全，但写错字段名不会有任何提示；
 *   - 正文 = 剩余部分 .trim()，**无大小上限**。
 *
 * 为什么自己写一个 YAML 子集：我们只用一个 parser、只吃这六个键，引入一个 YAML 依赖
 * （含锚点/标签/多文档等我们用不到的语义）不划算。子集能力：标量（含引号）、行内
 * \`[a, b]\` / \`{a: 1}\`、块标量 \`|\` 与 \`>\`、一层嵌套映射/列表（缩进）。
 */

import { SKILL_NAME_RE, type InvocationPolicy } from "./types";

export type ParsedSkill = {
  name: string;
  description: string;
  whenToUse?: string;
  invocation: InvocationPolicy;
  metadata?: Record<string, unknown>;
  /** 正文（已 trim） */
  content: string;
};

export type ParseOutcome =
  | { ok: true; skill: ParsedSkill }
  | { ok: false; error: string };

/** DSH 显式拒绝的旧键名（写了就报错，而不是当作未知字段忽略） */
const LEGACY_KEYS: Record<string, string> = {
  disableModelInvocation: "disable-model-invocation",
  modelInvocable: "user-invocable 的反面：请用 disable-model-invocation",
  userInvocable: "user-invocable",
};

// ---------- YAML 子集 ----------

type Scalar = string | number | boolean | null;
type YamlValue = Scalar | YamlValue[] | { [k: string]: YamlValue };

/** 去掉引号外的行尾注释：只有 \`#\` 前面是空白才算注释（中文正文里的 # 不受影响） */
function stripComment(s: string): string {
  let inS = false;
  let inD = false;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && inD) {
      out += c + (s[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === "#" && !inS && !inD && (i === 0 || /\s/.test(s[i - 1]))) break;
    out += c;
  }
  return out;
}

/** 按分隔符切分，但尊重引号与括号深度（用于行内 [ ] 与 { }） */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inS = false;
  let inD = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && inD) {
      cur += c + (s[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (!inS && !inD && (c === "[" || c === "{")) depth++;
    else if (!inS && !inD && (c === "]" || c === "}")) depth--;
    if (c === sep && depth === 0 && !inS && !inD) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

const unquote = (s: string): string => {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    const inner = s.slice(1, -1);
    return inner.replace(/\\(["\\/nrt])/g, (_, c: string) =>
      c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c,
    );
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
};

/** 标量解析：引号 / 行内数组 / 行内映射 / 布尔 / 数字 / 字符串 */
function parseScalar(raw: string): YamlValue {
  const s = raw.trim();
  if (!s) return "";
  const quoted = (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"));
  if (!quoted) {
    if (s.startsWith("[") && s.endsWith("]")) {
      const inner = s.slice(1, -1).trim();
      return inner ? splitTop(inner, ",").map((p) => parseScalar(p)) : [];
    }
    if (s.startsWith("{") && s.endsWith("}")) {
      const inner = s.slice(1, -1).trim();
      const obj: { [k: string]: YamlValue } = {};
      if (inner) {
        for (const part of splitTop(inner, ",")) {
          const idx = part.indexOf(":");
          if (idx < 0) continue;
          const k = unquote(part.slice(0, idx).trim());
          obj[k] = parseScalar(part.slice(idx + 1));
        }
      }
      return obj;
    }
    const low = s.toLowerCase();
    if (low === "true" || low === "yes" || low === "on") return true;
    if (low === "false" || low === "no" || low === "off") return false;
    if (low === "null" || low === "~") return null;
    if (/^-?\d+$/.test(s)) return Number(s);
    if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  }
  return unquote(s);
}

const isBlank = (l: string) => !l.trim() || l.trim().startsWith("#");
const indentOf = (l: string) => l.length - l.trimStart().length;

/** 块标量：\`|\` 保换行、\`>\` 折成空格；\`-\`/\`+\` 后缀只影响尾换行，我们统一 trim 掉 */
function readBlockScalar(
  lines: { text: string; no: number }[],
  start: number,
  indent: number,
  folded: boolean,
): { value: string; next: number } {
  const buf: string[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.text.trim() && indentOf(l.text) <= indent) break;
    buf.push(l.text.slice(Math.min(l.text.length, indent + 2)));
  }
  const value = folded ? buf.join("\n").trim().replace(/\n+/g, " ").trim() : buf.join("\n").trim();
  return { value, next: i };
}

/** 解析一层映射；返回 [映射, 下一个未消费行号] */
function parseBlock(
  lines: { text: string; no: number }[],
  start: number,
  indent: number,
): [{ [k: string]: YamlValue }, number] {
  const map: { [k: string]: YamlValue } = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line.text)) {
      i++;
      continue;
    }
    const ind = indentOf(line.text);
    if (ind < indent) break;
    if (ind > indent) throw new Error("第 " + line.no + " 行缩进异常（同级键必须对齐）");
    const text = stripComment(line.text.slice(ind)).trimEnd();
    const idx = text.indexOf(":");
    if (idx <= 0) throw new Error("第 " + line.no + " 行不是「键: 值」形式");
    const key = unquote(text.slice(0, idx).trim());
    const rest = text.slice(idx + 1).trim();
    if (rest === "|" || rest === "|-" || rest === "|+" || rest === ">" || rest === ">-" || rest === ">+") {
      const { value, next } = readBlockScalar(lines, i + 1, ind, rest.startsWith(">"));
      map[key] = value;
      i = next;
      continue;
    }
    if (rest) {
      map[key] = parseScalar(rest);
      i++;
      continue;
    }
    // 空值：看下一非空行是否更深 → 嵌套映射或列表；否则是空字符串
    let j = i + 1;
    while (j < lines.length && isBlank(lines[j].text)) j++;
    if (j < lines.length && indentOf(lines[j].text) > ind) {
      const childIndent = indentOf(lines[j].text);
      if (lines[j].text.trimStart().startsWith("- ")) {
        const arr: YamlValue[] = [];
        let k = j;
        for (; k < lines.length; k++) {
          const t = lines[k].text.trim();
          if (!t) continue;
          if (indentOf(lines[k].text) < childIndent) break;
          if (!t.startsWith("- ")) break;
          arr.push(parseScalar(t.slice(2)));
        }
        map[key] = arr;
        i = k;
        continue;
      }
      const [child, next] = parseBlock(lines, j, childIndent);
      map[key] = child;
      i = next;
      continue;
    }
    map[key] = "";
    i++;
  }
  return [map, i];
}

export function parseYamlSubset(text: string): { [k: string]: YamlValue } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((t, n) => ({ text: t, no: n + 1 }));
  const [map] = parseBlock(lines, 0, 0);
  return map;
}

// ---------- frontmatter + 字段校验 ----------

/** 布尔字段：只认 DSH 认可的那几个写法，其他值报错（绝不静默放行） */
function parseBool(v: YamlValue, field: string, where: string): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number" && (v === 0 || v === 1)) return v === 1;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "yes", "on", "1"].includes(s)) return true;
    if (["false", "no", "off", "0"].includes(s)) return false;
  }
  throw new Error(where + "：frontmatter 字段 \"" + field + "\" 只能是 true/false/yes/no/on/off/1/0，收到 " + JSON.stringify(v));
}

function optionalString(v: YamlValue | undefined, field: string, where: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(where + "：frontmatter 字段 \"" + field + "\" 必须是字符串");
  const s = v.trim();
  return s ? s : undefined;
}

export type FrontmatterSplit =
  | { ok: true; data: { [k: string]: YamlValue }; body: string }
  | { ok: false; error: string };

/** 切出 frontmatter 与正文；首行不是 \`---\` 或无法解析成对象 → 失败 */
export function splitFrontmatter(text: string, where = "SKILL.md"): FrontmatterSplit {
  const clean = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = clean.split("\n");
  if ((lines[0] ?? "").trim() !== "---") {
    return { ok: false, error: where + "：文件必须以 --- 开头（frontmatter 起始行）" };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return { ok: false, error: where + "：frontmatter 没有闭合的 ---" };
  let data: { [k: string]: YamlValue };
  try {
    data = parseYamlSubset(lines.slice(1, end).join("\n"));
  } catch (e) {
    return { ok: false, error: where + "：frontmatter 不是合法 YAML（" + String(e instanceof Error ? e.message : e) + "）" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: where + "：frontmatter 必须是键值对象" };
  }
  return { ok: true, data, body: lines.slice(end + 1).join("\n").trim() };
}

/** 把 frontmatter 对象校验成技能元信息（字段穷尽：就这六个键） */
export function readSkillMeta(
  data: { [k: string]: YamlValue },
  body: string,
  where = "SKILL.md",
): ParseOutcome {
  try {
    for (const legacy of Object.keys(LEGACY_KEYS)) {
      if (legacy in data) {
        throw new Error(where + "：frontmatter 字段 \"" + legacy + "\" 已废弃，请用 \"" + LEGACY_KEYS[legacy] + "\"");
      }
    }
    const name = optionalString(data.name as YamlValue, "name", where);
    if (!name) throw new Error(where + "：缺少必填字段 name");
    if (!SKILL_NAME_RE.test(name)) {
      throw new Error(where + "：name \"" + name + "\" 不符合 kebab-case（只允许 a-z 0-9 与单连字符，例：close-reading）");
    }
    const description = optionalString(data.description as YamlValue, "description", where);
    if (!description) throw new Error(where + "：缺少必填字段 description（空串视为没有）");
    const whenToUse = optionalString(data.whenToUse as YamlValue, "whenToUse", where);
    const md = data.metadata as YamlValue | undefined;
    if (md !== undefined && md !== null && (typeof md !== "object" || Array.isArray(md))) {
      throw new Error(where + "：metadata 必须是对象");
    }
    const invocation: InvocationPolicy = {
      modelInvocable: "disable-model-invocation" in data
        ? !parseBool(data["disable-model-invocation"] as YamlValue, "disable-model-invocation", where)
        : true,
      userInvocable: "user-invocable" in data
        ? parseBool(data["user-invocable"] as YamlValue, "user-invocable", where)
        : true,
    };
    return {
      ok: true,
      skill: {
        name,
        description,
        whenToUse,
        invocation,
        metadata: md && typeof md === "object" && !Array.isArray(md) ? (md as Record<string, unknown>) : undefined,
        content: body,
      },
    };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
}

/** 完整解析一个 SKILL.md：切分 + 校验 */
export function parseSkillFile(text: string, where = "SKILL.md"): ParseOutcome {
  const split = splitFrontmatter(text, where);
  if (!split.ok) return split;
  return readSkillMeta(split.data, split.body, where);
}

/** 生成 frontmatter（AI 生成技能时用；顺序固定，便于人读与 diff） */
export function formatSkillFile(skill: {
  name: string;
  description: string;
  whenToUse?: string;
  modelInvocable?: boolean;
  userInvocable?: boolean;
  metadata?: Record<string, unknown>;
  body: string;
}): string {
  const q = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
  const lines = ["---", "name: " + skill.name, "description: " + q(skill.description)];
  if (skill.whenToUse) lines.push("whenToUse: " + q(skill.whenToUse));
  if (skill.metadata && Object.keys(skill.metadata).length) {
    lines.push("metadata: " + JSON.stringify(skill.metadata));
  }
  if (skill.modelInvocable === false) lines.push("disable-model-invocation: true");
  if (skill.userInvocable === false) lines.push("user-invocable: false");
  lines.push("---", "", skill.body.trim(), "");
  return lines.join("\n");
}
