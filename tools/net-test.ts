/**
 * P3.10 契约测试：**插件网络门面**（ctx.net.fetch）。
 *
 * 这是全项目风险最高的一块（插件是别人写的代码，出去的是用户的网络），所以纪律要一条条钉住：
 *   域名范围、方法白名单、身份类请求头、重定向每一跳、超时、响应体积、非文本不回传。
 * 用**假 fetch**驱动，不碰真网络。
 *
 * 跑法：node tools/run-tests.mjs net-test
 */

import {
  NET_LIMITS,
  isAllowedOrigin,
  normalizeOrigin,
  originOf,
  pluginFetch,
  sanitizeHeaders,
} from "../app/src/core/plugin/netFetch";
import { setLangPref } from "../app/src/i18n";

// 断言写的是中文默认文案：把界面语言钉死，别受开发机系统语言影响
setLangPref("zh");
import { capabilityRequests } from "../app/src/core/plugin/permissions";
import { parseManifest } from "../app/src/core/plugin/manifest";

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) pass++;
  else failures.push(name + (detail ? " —— " + detail : ""));
}

const resp = (body: string, init: { status?: number; type?: string; headers?: Record<string, string>; url?: string } = {}) => {
  const headers = new Map(Object.entries(init.headers ?? { "content-type": init.type ?? "application/json" }));
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    url: init.url ?? "https://api.example.com/x",
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    body: {
      getReader: () => {
        const bytes = new TextEncoder().encode(body);
        let done = false;
        return {
          read: async () => {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: bytes };
          },
          cancel: async () => {},
        };
      },
    },
    text: async () => body,
  } as unknown as Response;
};

// ---------- 1) 域名规范化 ----------

check("裸域名补 https", JSON.stringify(normalizeOrigin("api.deepseek.com")) === JSON.stringify({ ok: true, origin: "https://api.deepseek.com" }));
check("完整 origin 原样", (normalizeOrigin("http://127.0.0.1:8899") as any).origin === "http://127.0.0.1:8899");
check("大小写归一", (normalizeOrigin("HTTPS://API.Example.COM") as any).origin === "https://api.example.com");
check("带路径被拒", normalizeOrigin("https://a.com/v1").ok === false);
check("带查询被拒", normalizeOrigin("https://a.com?x=1").ok === false);
check("通配符被拒", normalizeOrigin("*.example.com").ok === false);
check("空值被拒", normalizeOrigin("   ").ok === false);
check("非 http 协议被拒", normalizeOrigin("ftp://a.com").ok === false);
check("空 originOf（相对路径）", originOf("/api/x") === null);
check("originOf 取 origin", originOf("https://a.com/x?y=1") === "https://a.com");
check("范围精确匹配", isAllowedOrigin("https://a.com", ["https://a.com"]) === true);
check("范围外不放行", isAllowedOrigin("https://evil.com", ["https://a.com"]) === false);
check("空清单不放行", isAllowedOrigin("https://a.com", []) === false);

// ---------- 2) 请求头纪律 ----------

check("普通头放行", sanitizeHeaders({ Authorization: "Bearer x", "X-Api-Key": "k" }).ok === true);
check("Cookie 被拒", sanitizeHeaders({ Cookie: "session=1" }).ok === false);
check("Origin/Referer 被拒", sanitizeHeaders({ referer: "https://x.com" }).ok === false && sanitizeHeaders({ Origin: "https://x.com" }).ok === false);
check("非对象被拒", sanitizeHeaders("nope").ok === false);
check("头太多被拒", sanitizeHeaders(Object.fromEntries(Array.from({ length: 25 }, (_, i) => ["h" + i, "v"]))).ok === false);

// ---------- 3) pluginFetch：范围、方法、重定向、体积 ----------

const allowed = ["https://api.deepseek.com"];

let thrown = "";
try {
  await pluginFetch({ url: "https://evil.com/x", allowedOrigins: allowed, fetchImpl: (async () => resp("{}")) as never });
} catch (e) {
  thrown = String(e instanceof Error ? e.message : e);
}
check("未授权域名：直接拒，且不发出请求", thrown.includes("没有授权访问") && thrown.includes("https://evil.com"), thrown);

thrown = "";
try {
  await pluginFetch({ url: "file:///c:/x", allowedOrigins: allowed, fetchImpl: (async () => resp("")) as never });
} catch (e) {
  thrown = String(e instanceof Error ? e.message : e);
}
check("非 http(s) 被拒", thrown.includes("只接受 http"), thrown);

thrown = "";
try {
  await pluginFetch({ url: "https://api.deepseek.com/x", init: { method: "DELETE" }, allowedOrigins: allowed, fetchImpl: (async () => resp("")) as never });
} catch (e) {
  thrown = String(e instanceof Error ? e.message : e);
}
check("方法白名单：DELETE 被拒", thrown.includes("只允许"), thrown);

const okRes = await pluginFetch({
  url: "https://api.deepseek.com/user/balance",
  init: { headers: { Authorization: "Bearer sk-test" } },
  allowedOrigins: allowed,
  fetchImpl: (async (url: string, init: RequestInit) => {
    // 宿主替它断掉了身份：credentials 必须是 omit，且 redirect 是 manual（重定向自己管）
    if (init.credentials !== "omit" || init.redirect !== "manual") throw new Error("凭证/重定向策略不对");
    return resp(JSON.stringify({ balance: 12.34 }), { url: String(url) });
  }) as never,
});
check("正常请求拿到文本", okRes.ok && okRes.status === 200 && JSON.parse(okRes.text).balance === 12.34);
check("带上 contentType 与最终 url", okRes.contentType.includes("json") && okRes.url.includes("api.deepseek.com"));

// 重定向：允许域名内的跳转要跟，且每一跳都要在范围内
let hops: string[] = [];
const redirected = await pluginFetch({
  url: "https://api.deepseek.com/a",
  allowedOrigins: allowed,
  fetchImpl: (async (url: string) => {
    hops.push(String(url));
    if (hops.length === 1) return resp("", { status: 302, headers: { location: "/b" } });
    return resp("final", { url: String(url) });
  }) as never,
});
check("同域名重定向跟随", redirected.text === "final" && redirected.redirects === 1, JSON.stringify([redirected.text, redirected.redirects]));

hops = [];
thrown = "";
try {
  await pluginFetch({
    url: "https://api.deepseek.com/a",
    allowedOrigins: allowed,
    fetchImpl: (async (url: string) => {
      hops.push(String(url));
      return resp("", { status: 302, headers: { location: "https://evil.com/steal" } });
    }) as never,
  });
} catch (e) {
  thrown = String(e instanceof Error ? e.message : e);
}
check("跨到未授权域名的重定向被拦下", thrown.includes("重定向到了未授权的域名"), thrown);

// 重定向次数上限
let loops = 0;
thrown = "";
try {
  await pluginFetch({
    url: "https://api.deepseek.com/a",
    allowedOrigins: allowed,
    fetchImpl: (async () => {
      loops++;
      return resp("", { status: 302, headers: { location: "/loop" } });
    }) as never,
  });
} catch (e) {
  thrown = String(e instanceof Error ? e.message : e);
}
check("重定向死循环被次数上限掐断", thrown.includes("重定向次数超过") && loops === NET_LIMITS.maxRedirects + 1, thrown + " loops=" + loops);

// 体积上限
const huge = "x".repeat(700 * 1024);
const capped = await pluginFetch({
  url: "https://api.deepseek.com/big",
  allowedOrigins: allowed,
  fetchImpl: (async () => resp(huge, { type: "text/plain" })) as never,
});
check("超大响应被截断到上限内", capped.truncated && capped.text.length <= NET_LIMITS.maxBytes && capped.text.length > NET_LIMITS.maxBytes - 4096, String(capped.text.length));
check("截断会给出 note", typeof capped.note === "string" && capped.note.includes("截断"));

// 非文本不回传正文
const binary = await pluginFetch({
  url: "https://api.deepseek.com/img.png",
  allowedOrigins: allowed,
  fetchImpl: (async () => resp("\u0000\u0001binary", { type: "image/png" })) as never,
});
check("非文本类型不回传正文", binary.text === "" && typeof binary.note === "string", JSON.stringify(binary));

// 超时
thrown = "";
try {
  await pluginFetch({
    url: "https://api.deepseek.com/slow",
    allowedOrigins: allowed,
    timeoutMs: 30,
    fetchImpl: ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      })) as never,
  });
} catch (e) {
  thrown = String(e instanceof Error ? e.message : e);
}
check("超时会中断并说明", thrown.includes("超时"), thrown);

const formRes = await pluginFetch({
  url: "https://api.deepseek.com/p",
  init: { method: "post", body: "a=1" },
  allowedOrigins: allowed,
  fetchImpl: (async (_u: string, init: RequestInit) => resp("ok", { url: String(_u) })) as never,
});
check("方法大小写不敏感（post → POST 且带 body）", formRes.ok);

// ---------- 4) manifest 的 network 字段 ----------

const base = { id: "ai.net-demo", name: "查余额", purpose: "看 DeepSeek 余额", version: "1.0.0", apiVersion: "aireader-plugin-1", main: "main.js" };
const withNet = parseManifest(
  JSON.stringify({ ...base, capabilities: ["net.fetch"], network: { origins: ["api.deepseek.com", "https://api.deepseek.com"] } }),
);
check("network 通过校验", withNet.ok === true, JSON.stringify(withNet.ok ? null : withNet.issues));
check("域名被规范化并去重", withNet.ok && JSON.stringify((withNet as any).manifest.network.origins) === JSON.stringify(["https://api.deepseek.com"]));

const missingOrigins = parseManifest(JSON.stringify({ ...base, capabilities: ["net.fetch"] }));
check("声明 net.fetch 却没给域名 → 拒", missingOrigins.ok === false && (missingOrigins as any).issues.some((i: any) => i.field === "network"));
const badOrigin = parseManifest(JSON.stringify({ ...base, capabilities: ["net.fetch"], network: { origins: ["https://a.com/v1"] } }));
check("域名带路径 → 拒", badOrigin.ok === false);
const netWithoutCap = parseManifest(JSON.stringify({ ...base, network: { origins: ["a.com"] } }));
check("给了 network 却没声明 net.fetch → 拒", netWithoutCap.ok === false);

// ---------- 5) 申请清单（授权那一刻用户看到的东西） ----------

const reqs = capabilityRequests({ capabilities: ["net.fetch", "log.write"], network: { origins: ["https://api.deepseek.com"] } });
check("net.fetch 的申请带域名范围", reqs[0].capability === "net.fetch" && JSON.stringify(reqs[0].scope) === JSON.stringify({ origins: ["https://api.deepseek.com"] }));
check("普通能力没有范围", reqs[1].capability === "log.write" && reqs[1].scope === undefined);
check("申请里带一句人话说明", typeof reqs[0].reason === "string" && reqs[0].reason.includes("api.deepseek.com"));

// ---------- 6) ai.credentials 的申请范围（P3.11） ----------

const credReqs = capabilityRequests(
  { capabilities: ["net.fetch", "ai.credentials"], network: { origins: ["api.deepseek.com"] } },
  "https://api.deepseek.com",
);
check(
  "ai.credentials 的申请范围是当时配置的 AI 服务域名",
  credReqs[1].capability === "ai.credentials" &&
    JSON.stringify(credReqs[1].scope) === JSON.stringify({ origins: ["https://api.deepseek.com"] }),
  JSON.stringify(credReqs[1]),
);
check(
  "申请说明写清了「只对 GET 生效、Key 不给插件」",
  String(credReqs[1].reason).includes("只对 GET") && String(credReqs[1].reason).includes("不会交给插件"),
  String(credReqs[1].reason),
);
const credNoOrigin = capabilityRequests({ capabilities: ["ai.credentials"] }, null);
check("拿不到服务地址时不编范围（但申请仍然列出）", credNoOrigin[0].scope === undefined && typeof credNoOrigin[0].reason === "string");

// manifest：ai.credentials 必须与 net.fetch 一起声明
const credAlone = parseManifest(JSON.stringify({ ...base, capabilities: ["ai.credentials"] }));
check("单独声明 ai.credentials → 拒（它只是 net.fetch 的加成）", credAlone.ok === false && (credAlone as any).issues.some((i: any) => i.field === "capabilities"));
const credOk = parseManifest(
  JSON.stringify({ ...base, capabilities: ["net.fetch", "ai.credentials"], network: { origins: ["api.deepseek.com"] } }),
);
check("net.fetch + ai.credentials 一起声明 → 通过", credOk.ok === true, JSON.stringify(credOk.ok ? null : credOk.issues));

console.log("P3.10 网络门面契约测试：" + pass + " 通过 / " + failures.length + " 失败");
if (failures.length) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("  ✓ 全部通过（域名规范化 / 请求头纪律 / 范围与重定向每一跳 / 体积与超时 / manifest 与申请清单）");
