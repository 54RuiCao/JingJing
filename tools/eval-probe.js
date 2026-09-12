// 评测探针：跑一个任务，返回工具轨迹 / 答案 / 用量。由 run-eval.mjs 调用（cdp.mjs 不支持传参，所以用 argv 里的 JSON）。
(async () => {
  const task = JSON.parse(argvTask());
  function argvTask() {
    // cdp.mjs 把表达式当代码 eval，这里从 location 之外拿不到 argv，所以用 localStorage 传递
    return localStorage.getItem("eval.task") || "{}";
  }
  const inv = window.__TAURI_INTERNALS__.invoke;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const ta = document.querySelector(".air-chat-input textarea");
    if (!ta) return { err: "AI 面板不可见：先打开一本书并切到 AI 标签" };
    // 不需要正文的任务（写插件）把全书上下文关掉：不然每一步请求都要带上整本书
    //（踩过：32 次请求 = 1259 万 token）。cdp.mjs 跑完会复原 ai.* 设置。
    if (task.noFullBook) {
      await inv("db_execute", {
        sql: "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params: ["ai.fullBook", "false"],
      });
      window.dispatchEvent(new CustomEvent("aireader:reload-settings"));
      await sleep(600);
    }
    const before = document.querySelectorAll(".air-tool").length;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, task.question);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(150);
    const btn = [...document.querySelectorAll(".air-chat-input button")].find((b) => b.textContent.trim() === "发送");
    btn?.click();
    for (let i = 0; i < 400; i++) {
      await sleep(250);
      const busy = [...document.querySelectorAll(".air-chat-input button")].some((b) => b.textContent.trim() === "停止");
      if (!busy) break;
    }
    await sleep(500);
    const all = [...document.querySelectorAll(".air-tool")].map((t) => ({
      name: (t.getAttribute("title") || "").split(" · ")[0],
      text: t.textContent,
    }));
    // 写插件的任务：断言落在**运行时状态**上，不看回答像不像（见 P3.5 的"凭记忆复述"坑）
    let plugin = null;
    if (task.pluginId) {
      const rt = window.__aireaderRuntime;
      const found = rt?.plugins().find((p) => p.id === task.pluginId) ?? null;
      plugin = found
        ? {
            id: found.id,
            state: found.state,
            version: found.version,
            dynamic: found.dynamic === true,
            contributions: found.contributions ?? [],
            declared: found.capabilities ?? [],
          }
        : null;
    }
    const out = {
      trail: all.slice(before),
      answer: [...document.querySelectorAll(".air-chat-msg.air-chat-assistant")].pop()?.textContent ?? "",
      usage: document.querySelector(".air-chat-usage")?.textContent ?? null,
      err: document.querySelector(".air-chat-error")?.textContent ?? null,
      requests: all.length - before + 1,
      plugin,
    };
    // 收尾：把评测写出来的插件删掉（不留在用户的插件列表里），授权也撤销
    if (task.pluginId && task.cleanup !== false) {
      try {
        await window.__aireaderRuntime.pluginDev.undefine(task.pluginId);
        await window.__aireaderRuntime.permissions.revoke(task.pluginId);
      } catch {
        /* 没定义过就算了 */
      }
    }
    return out;
  } catch (e) {
    return { err: String(e) };
  }
})()
