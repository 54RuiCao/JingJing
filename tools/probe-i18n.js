// 中英双语实测：切语言后界面文案、<html lang>、标题、持久化都要跟着走，切回来也能复原。
(async () => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { steps: [] };
  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;
  const tabs = () => [...document.querySelectorAll(".air-tabs button")].map((b) => b.textContent.trim());
  const cjkLines = (sel, n) =>
    ((document.querySelector(sel)?.innerText ?? "").split("\n").map((s) => s.trim()).filter((s) => CJK.test(s))).slice(0, n);
  const clickTab = async (re) => {
    const b = [...document.querySelectorAll(".air-tabs button")].find((x) => re.test(x.textContent));
    if (b) b.click();
    await sleep(450);
    return Boolean(b);
  };
  const pick = (value) => {
    const el = document.querySelector('[data-testid="ui-language"]');
    if (!el) return null;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value;
  };
  try {
    // 设置面板是折叠在侧栏里的，先切到「设置与插件」才拿得到语言下拉
    out.openedSettings = await clickTab(/设置与插件|Settings/);
    out.before = { lang: document.documentElement.lang, title: document.title, tabs: tabs(), select: Boolean(document.querySelector('[data-testid="ui-language"]')) };

    // ---------- 切英文 ----------
    out.picked = pick("en");
    await sleep(700);
    out.en = {
      lang: document.documentElement.lang,
      title: document.title,
      tabs: tabs(),
      tabHasCJK: tabs().some((t) => CJK.test(t)),
      settingsCJK: cjkLines(".air-side-body", 8),
      barCJK: cjkLines(".air-bar", 8),
      bodyHasCJK: cjkLines(".air-app", 12),
    };
    out.steps.push("switch-en");

    // 侧栏其它分页（目录 / 批注 / 检索 / 笔记 / 书组）也看一眼有没有漏网中文
    const perTab = {};
    for (const re of [/Contents|目录/, /Highlights|批注/, /Search|检索/, /Notes|笔记/, /Shelves|书组/]) {
      if (await clickTab(re)) perTab[String(re)] = cjkLines(".air-side-body", 4);
    }
    out.en.perTabCJK = perTab;
    await clickTab(/Settings|设置/);

    // 设置真的落库了吗（重启还在）
    out.persisted = await inv("db_select", { sql: "SELECT value FROM settings WHERE key='ui.language'", params: [] });
    // 窗口（任务栏）标题也应跟着走
    try {
      out.windowTitle = await inv("plugin:window|title", { label: "main" });
    } catch (e) {
      out.windowTitleErr = String(e).slice(0, 140);
    }

    // ---------- 切回跟随系统 ----------
    out.restored = pick("auto");
    await sleep(700);
    out.after = { lang: document.documentElement.lang, title: document.title, tabs: tabs() };
    out.steps.push("restored");
  } catch (e) {
    out.error = String(e);
  }
  return out;
})()
