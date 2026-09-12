/**
 * 极简 JSON Schema 校验（同步、结构化报错）。P2.3 时它住在 ai/tools/registry.ts 里，
 * P3.0 把容器也放到它上面（插件 config 也要校验），所以提到 core/ 下共用一份实现。
 *
 * 支持的是我们真正会写的子集：string(+enum) / number|integer(+min/max) / boolean /
 * array(+items/maxItems) / object(+properties/required/additionalProperties)。
 * **不做** oneOf/anyOf/pattern/format —— 需要这些时再写，而不是先支持再猜。
 */

export type JsonSchemaNode =
  | { type: "string"; description?: string; enum?: string[] }
  | { type: "number" | "integer"; description?: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description?: string }
  | { type: "array"; description?: string; items: JsonSchemaNode; maxItems?: number }
  | {
      type: "object";
      description?: string;
      properties: Record<string, JsonSchemaNode>;
      required?: string[];
      additionalProperties?: boolean;
    };

/** 校验失败时告诉调用方"哪里错了、怎么改"（工具层直接把它回传给模型） */
export function validateArgs(
  schema: JsonSchemaNode,
  args: unknown,
): { ok: true } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  validate(schema, args ?? {}, "", issues);
  return issues.length ? { ok: false, issues } : { ok: true };
}

function validate(node: JsonSchemaNode, value: unknown, path: string, issues: string[]): void {
  const typeName = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  switch (node.type) {
    case "string": {
      if (typeof value !== "string") {
        issues.push(path + " 需要字符串，收到 " + typeName(value));
        return;
      }
      if (node.enum && !node.enum.includes(value)) {
        issues.push(path + " 只能是 " + node.enum.join(" / ") + "，收到 " + JSON.stringify(value));
      }
      return;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        issues.push(path + " 需要" + (node.type === "integer" ? "整数" : "数字") + "，收到 " + typeName(value));
        return;
      }
      if (node.type === "integer" && !Number.isInteger(value)) {
        issues.push(path + " 需要整数，收到 " + value);
      }
      if (node.minimum !== undefined && value < node.minimum) issues.push(path + " 不能小于 " + node.minimum);
      if (node.maximum !== undefined && value > node.maximum) issues.push(path + " 不能大于 " + node.maximum);
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") issues.push(path + " 需要布尔值，收到 " + typeName(value));
      return;
    }
    case "array": {
      if (!Array.isArray(value)) {
        issues.push(path + " 需要数组，收到 " + typeName(value));
        return;
      }
      if (node.maxItems !== undefined && value.length > node.maxItems) {
        issues.push(path + " 最多 " + node.maxItems + " 项，收到 " + value.length);
      }
      value.forEach((v, i) => validate(node.items, v, path + "[" + i + "]", issues));
      return;
    }
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        issues.push(path + " 需要对象，收到 " + typeName(value));
        return;
      }
      const obj = value as Record<string, unknown>;
      for (const key of node.required ?? []) {
        if (obj[key] === undefined || obj[key] === null) issues.push(path + "." + key + " 是必填项");
      }
      for (const [key, sub] of Object.entries(node.properties)) {
        if (obj[key] === undefined) continue;
        validate(sub, obj[key], path + "." + key, issues);
      }
      if (node.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in node.properties)) issues.push(path + "." + key + " 不是可接受的参数");
        }
      }
      return;
    }
  }
}

/**
 * 把 JSON Schema 包成 StandardSchemaV1（插件 config 用同一个校验器）。
 * 校验是**同步**的（DSH 同：fiber.ts:50-62，异步校验直接 TypeError）。
 */
export function jsonSchemaStandard<T = unknown>(schema: JsonSchemaNode): {
  "~standard": {
    version: 1;
    vendor: string;
    validate: (value: unknown) => { value: T } | { issues: { message: string; path?: (string | number)[] }[] };
  };
} {
  return {
    "~standard": {
      version: 1,
      vendor: "aireader-json-schema",
      validate(value: unknown) {
        const res = validateArgs(schema, value);
        if (res.ok) return { value: (value ?? {}) as T };
        return {
          issues: res.issues.map((message) => {
            // "a.b[0] 需要整数" → path ["a","b",0]，与 DSH 的 (at a.b) 报错风格对齐
            const m = /^\.?([^ ]*)/.exec(message.replace(/^\\s+/, ""));
            const raw = m?.[1] ?? "";
            const path = raw
              .split(".")
              .filter(Boolean)
              .flatMap((seg) => {
                const parts: (string | number)[] = [];
                const re = /([^\\[\\]]+)|\\[(\\d+)\\]/g;
                let mm: RegExpExecArray | null;
                while ((mm = re.exec(seg))) parts.push(mm[2] !== undefined ? Number(mm[2]) : mm[1]);
                return parts;
              });
            return { message, path: path.length ? path : undefined };
          }),
        };
      },
    },
  };
}
