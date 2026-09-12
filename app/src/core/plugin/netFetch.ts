/**
 * 插件网络门面（P3.10）：**宿主代发**受控的 HTTP 请求。
 *
 * 三条设计纪律：
 *   1. **域名范围由授权决定**：manifest 里用 `network.origins` 声明要访问哪些域名，
 *      用户授权时看到的就是这份清单；每次调用再按**目标 origin** 复核一次
 *      （所以"撤销授权立刻生效"是结构性的，不是补丁）。
 *   2. **不带用户的任何身份**：`credentials: "omit"`、不许自定义 Cookie、
 *      重定向自己处理并对每一跳重新查域名 —— 插件拿不到用户的 cookie / 登录态。
 *   3. **有界**：超时、单次响应字节上限、重定向次数上限、方法白名单（GET/POST/HEAD）、
 *      非文本响应不回传正文。插件是别人写的代码，这一层要能兜住它。
 *
 * 这一层与 quickjs 白名单、权限闸门是同一条线上的：**它管"能拿到什么"，不是"能不能联网"**。
 */

export type NetRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type NetResponse = {
  ok: boolean;
  status: number;
  /** 最终响应地址（跟过重定向之后） */
  url: string;
  contentType: string;
  /** 正文（仅文本类；非文本类为空串，note 里说明） */
  text: string;
  truncated: boolean;
  note?: string;
  /** 跟过几次重定向 */
  redirects: number;
};

export const NET_LIMITS = {
  timeoutMs: 15_000,
  maxBytes: 512 * 1024,
  maxRedirects: 3,
  maxHeaderCount: 20,
};

const ALLOWED_METHODS = ["GET", "POST", "HEAD"];
/** 这些头交给浏览器/宿主管，插件不许碰（尤其 cookie —— 那是用户的身份） */
const FORBIDDEN_HEADERS = new Set([
  "cookie",
  "cookie2",
  "host",
  "origin",
  "referer",
  "content-length",
  "connection",
  "accept-encoding",
  "user-agent",
  "proxy-authorization",
]);
const TEXTUAL = /^(text\/|application\/(json|xml|xhtml|javascript|ld\+json|manifest)|application\/[\w.+-]*\+json)/;

/**
 * 把 manifest 里写的域名规范化成 origin。
 * 允许写 `api.deepseek.com`（补 https://）或完整的 `https://api.deepseek.com`；
 * **不接受**路径、查询、通配符 —— 授权清单上必须是一条条具体的域名。
 */
export function normalizeOrigin(raw: unknown): { ok: true; origin: string } | { ok: false; message: string } {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: false, message: "域名不能为空" };
  if (s.includes("*")) return { ok: false, message: '"' + s + '" 不支持通配符：请写具体域名（可以写多条）' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "https://" + s;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, message: '"' + s + '" 不是合法的域名或 URL' };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: '"' + s + '" 只支持 http / https' };
  }
  if (!url.hostname) return { ok: false, message: '"' + s + '" 里没有主机名' };
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    return { ok: false, message: '"' + s + '" 只写域名（不要带路径 / 查询 / #）' };
  }
  return { ok: true, origin: url.origin.toLowerCase() };
}

/** 从一个绝对 URL 取 origin；不是 http(s) 就返回 null */
export function originOf(url: string): string | null {
  try {
    const u = new URL(String(url ?? ""));
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** 目标 origin 是否在授权清单里（**精确匹配**：授权了什么就只能访问什么） */
export function isAllowedOrigin(origin: string, allowed: string[]): boolean {
  return (allowed ?? []).some((a) => String(a).toLowerCase() === origin);
}

/** 请求头清洗：只要有一项非法就整体拒绝（不静默丢弃，否则插件会以为发出去的是它写的那份） */
export function sanitizeHeaders(input: unknown): { ok: true; headers: Record<string, string> } | { ok: false; message: string } {
  if (input === undefined || input === null) return { ok: true, headers: {} };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, message: "headers 必须是对象" };
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > NET_LIMITS.maxHeaderCount) {
    return { ok: false, message: "请求头太多了（上限 " + NET_LIMITS.maxHeaderCount + " 个）" };
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of entries) {
    const key = String(k).trim().toLowerCase();
    if (!key) continue;
    if (FORBIDDEN_HEADERS.has(key)) {
      return { ok: false, message: "不许设置请求头 " + key + "（Cookie / 身份类请求头由宿主掌控，插件不能碰）" };
    }
    if (typeof v !== "string" && typeof v !== "number") return { ok: false, message: "请求头 " + key + " 的值必须是字符串" };
    headers[key] = String(v);
  }
  return { ok: true, headers };
}

/** 读正文，带字节上限（不做"先全部读进来再截断"——那等于没上限） */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = (res.body as ReadableStream<Uint8Array> | null)?.getReader?.();
  if (!reader) {
    const all = await res.text();
    return all.length > maxBytes ? { text: all.slice(0, maxBytes), truncated: true } : { text: all, truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      const keep = value.subarray(0, Math.max(0, value.byteLength - (size - maxBytes)));
      if (keep.byteLength) chunks.push(keep);
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        /* 取消失败无所谓 */
      }
      break;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(Math.min(size, maxBytes));
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.byteLength;
  }
  return { text: new TextDecoder().decode(buf), truncated };
}

/**
 * 真正发一次请求。**调用方必须先做过能力与范围的检查**（runtime-quickjs 里做），
 * 这里再用 allowedOrigins 复核一遍 + 管住重定向的每一跳（纵深防御，不是重复劳动）。
 */
export async function pluginFetch(opts: {
  url: string;
  init?: NetRequestInit;
  allowedOrigins?: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}): Promise<NetResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const allowed = opts.allowedOrigins ?? [];
  const timeoutMs = opts.timeoutMs ?? NET_LIMITS.timeoutMs;
  const maxBytes = opts.maxBytes ?? NET_LIMITS.maxBytes;
  const maxRedirects = opts.maxRedirects ?? NET_LIMITS.maxRedirects;

  const method = String(opts.init?.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.includes(method)) {
    throw new Error("net.fetch 只允许 " + ALLOWED_METHODS.join(" / ") + "，收到的是 " + method);
  }
  if (opts.init?.body !== undefined && typeof opts.init.body !== "string") {
    throw new Error("net.fetch 的 body 只能是字符串（要发 JSON 就自己 JSON.stringify）");
  }
  if (opts.init?.body !== undefined && method === "GET") {
    throw new Error("GET 不能带 body");
  }
  const headers = sanitizeHeaders(opts.init?.headers);
  if (!headers.ok) throw new Error(headers.message);

  const started = originOf(opts.url);
  if (!started) throw new Error("net.fetch 只接受 http / https 的绝对 URL，收到：" + String(opts.url).slice(0, 120));
  if (!isAllowedOrigin(started, allowed)) {
    throw new Error(
      "没有授权访问 " + started + "（这个插件被允许的域名：" + (allowed.join(" / ") || "（空）") + "）",
    );
  }

  let current = String(opts.url);
  let redirects = 0;
  for (;;) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(current, {
        method,
        headers: headers.headers,
        body: method === "GET" || method === "HEAD" ? undefined : opts.init?.body,
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new Error(
        ctrl.signal.aborted
          ? "请求超时（" + timeoutMs + "ms）：" + current
          : "请求失败：" + String(e instanceof Error ? e.message : e),
      );
    } finally {
      clearTimeout(timer);
    }

    const status = res.status;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("收到 " + status + " 但响应里没有 Location");
      if (redirects >= maxRedirects) throw new Error("重定向次数超过 " + maxRedirects + " 次，放弃");
      let next: string;
      try {
        next = new URL(loc, current).toString();
      } catch {
        throw new Error("重定向地址不合法：" + loc);
      }
      const nextOrigin = originOf(next);
      if (!nextOrigin || !isAllowedOrigin(nextOrigin, allowed)) {
        throw new Error("重定向到了未授权的域名 " + (nextOrigin ?? loc) + "（插件只被允许：" + allowed.join(" / ") + "）");
      }
      current = next;
      redirects++;
      continue;
    }

    const contentType = String(res.headers.get("content-type") ?? "");
    const isText = !contentType || TEXTUAL.test(contentType.toLowerCase());
    if (!isText) {
      // 二进制不回传：插件拿不到、上下文也不会被塞满
      try {
        await res.body?.cancel?.();
      } catch {
        /* 忽略 */
      }
      return {
        ok: res.ok,
        status,
        url: current,
        contentType,
        text: "",
        truncated: false,
        note: "响应不是文本类型（" + (contentType || "未知") + "），宿主按纪律没有回传正文",
        redirects,
      };
    }

    const body = method === "HEAD" ? { text: "", truncated: false } : await readCapped(res, maxBytes);
    return {
      ok: res.ok,
      status,
      url: current,
      contentType,
      text: body.text,
      truncated: body.truncated,
      ...(body.truncated ? { note: "正文超过 " + Math.round(maxBytes / 1024) + "KB，已截断" } : {}),
      redirects,
    };
  }
}
