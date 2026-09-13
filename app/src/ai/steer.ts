/**
 * 给**正在进行的 agent 轮次**插话的收件箱（P5，照 DSH 的 steer 通道）。
 *
 * 为什么需要它：插件界面渲染失败时，宿主只是 `console.error` 一句 —— 而**写这个插件的 AI
 * 根本不知道**，它会以为"运行成功"，用户看到的是空白格子。DSH 的做法是把失败**推回给模型**：
 * 往会话里注入一条带**修复指令**的 user 消息（还会按 插件+槽位+错因 去重，避免刷屏）。
 *
 * 我们的接法：失败时 `pushSteer(key, text)`（key 用来去重），agentLoop 在**每一步开始前**
 * `drainSteer()` 取走并作为 user 消息追加 —— 于是 AI 在同一个轮次里就能自己修
 * （inspect 现场 → 改代码 → plugin_define 新版本 → plugin_run）。
 */
const inbox = new Map<string, string>();

/** 记一条要插给模型的话（同 key 只留最后一条） */
export function pushSteer(key: string, text: string): void {
  inbox.set(key, text);
}

/** 取走全部待插话（取走即清空：模型看过就不用再看） */
export function drainSteer(): string[] {
  if (!inbox.size) return [];
  const all = [...inbox.values()];
  inbox.clear();
  return all;
}

/** 还有几条待插话（界面拿来显示"有 N 条失败待处理"） */
export function steerPending(): number {
  return inbox.size;
}

/**
 * 插件界面渲染失败 → 推给写它的 AI。
 *
 * 措辞放在这里而不是调用点，是因为界面文件受 i18n 守卫管（界面文案必须进文案表），
 * 而这条消息**是给模型看的**、不是界面文案 —— 放这儿既躲开误报，也只有一个地方要改。
 * 内容照 DSH 的 steerRenderFailure：说明现状（哪一格、什么错、已被摘掉）+ **直接给修复步骤**。
 */
export function reportSlotFailure(slot: string, owner: string, label: string | undefined, error: unknown): void {
  const message = String(error instanceof Error ? error.message : error).slice(0, 300);
  pushSteer(
    "slot:" + owner + ":" + slot + ":" + message,
    "插件界面渲染失败（这是宿主推给你的，不是用户说的）：插件「" + (label ?? owner) + "」（" + owner +
      "）注册在槽位 " + slot + " 的界面渲染时抛错：" + message +
      "\n这一格已被宿主摘掉（abdicated），用户现在看到的是空白。" +
      "请自己修：先用 plugin_inspect 看这个插件的现场（代码、槽位、props、日志），" +
      "改完后用 plugin_define 定义同一个 pluginId 的新版本，再 plugin_run 挂上去。",
  );
}
