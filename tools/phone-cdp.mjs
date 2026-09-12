// 把真机的 WebView 调试端口转到本机，让 tools/cdp.mjs 能像桌面一样查 DOM。
//
// 用法：
//   node tools/phone-cdp.mjs            # 找到 app 进程 → adb forward → 打印页面列表
//   node tools/phone-cdp.mjs --stop     # 撤掉转发
//
// 前提：手机插着 USB、开了调试；装的是 **debug 包**（release 包里 WebView 不可调试）。
// 原理：Android WebView 的调试 socket 名是 webview_devtools_remote_<pid>，
// 用 adb forward 转到本机 9222 端口，之后 node tools/cdp.mjs --file xxx.js 照常跑。
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// adb 从环境变量推：手上有 ANDROID_HOME 就用它下面的 platform-tools，
// 否则退回 PATH 里的 adb（**不写死本机路径** —— 那会跟着仓库一起泄露，
// tools/check-publish.mjs 就是这么把我拦下来的）
const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const ADB =
  process.env.ADB ||
  (sdkRoot ? join(sdkRoot, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb") : "adb");
const PKG = process.env.PKG ?? "app.aireader.desktop";

const adb = (...args) => execFileSync(ADB, args, { encoding: "utf8" }).trim();

if (process.argv.includes("--stop")) {
  try {
    adb("forward", "--remove", "tcp:9222");
  } catch {
    /* 没有就不用撤 */
  }
  console.log("已撤销 tcp:9222 转发");
  process.exit(0);
}

const devices = adb("devices").split("\n").filter((l) => l.endsWith("device"));
if (!devices.length) {
  console.error("没有连接的设备（adb devices 是空的）。手机插好了吗？USB 调试开了吗？");
  process.exit(1);
}
const pid = adb("shell", "pidof", PKG);
if (!pid) {
  console.error("app 没在运行（pidof " + PKG + " 为空）。先在手机上打开鲸鲸。");
  process.exit(2);
}
const socket = "webview_devtools_remote_" + pid.split(/\s+/)[0];
adb("forward", "tcp:9222", "localabstract:" + socket);
console.log("已转发 tcp:9222 → " + socket);
console.log("现在可以用：node tools/cdp.mjs --file tools/probe-phone.js");

try {
  const res = await fetch("http://127.0.0.1:9222/json", { signal: AbortSignal.timeout(3000) });
  const pages = await res.json();
  console.log(JSON.stringify(pages.map((p) => ({ type: p.type, title: p.title, url: p.url })), null, 2));
} catch (e) {
  console.error("连不上 127.0.0.1:9222：" + String(e));
}
