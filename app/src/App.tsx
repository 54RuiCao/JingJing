import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FoliateView,
  type BookAnnotation,
  type FoliateHandle,
  type RelocateDetail,
  type SelectionInfo,
  type TocItem,
} from "./reader/FoliateView";
import { buildBookCSS, defaultTypography, type TypographyOptions } from "./reader/bookStyles";
import { collectReport, saveReport } from "./reader/p0Report";
import { txtToEpubFile, type TxtImportStats } from "./reader/txtToEpub";
import { LibraryPage } from "./library/LibraryPage";
import { ChatPanel, type BookContext, type ContextLoad } from "./ai/ChatPanel";
import { buildBookContext, locateHits, type BookContextData, type ManifestEntry } from "./ai/bookContext";
import { createToolHost, type ToolHostDeps } from "./ai/toolHost";
import { createSkillHost } from "./skills/host";
import {
  createAppRuntime,
  type AiCredentialService,
  type DbService,
  type ReadingActivityService,
  type ThemeService,
} from "./core/app/runtime";
import { originOf } from "./core/plugin/netFetch";
import type { AiCredentials } from "./core/app/services";
import { tauriPluginInvoke } from "./core/app/pluginFs";
import { SlotView } from "./ui/slots";
import type { SlotEntry } from "./ui/slots";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { importBookFromPath } from "./library/importBook";
import {
  addReadingActivity,
  countAnnotations,
  createGroup,
  deleteGroup as deleteBookGroup,
  getBook,
  initDb,
  listAllAnnotations,
  listBookGroups,
  listGroups,
  listReadingActivity,
  loadProgress,
  renameGroup,
  setBookGroups,
  saveProgress,
  touchBook,
  getSetting,
  setSetting,
  listAnnotations,
  addAnnotation,
  deleteAnnotation,
  sectionIndexOfCfi,
  searchBook,
  type Annotation,
  type AnnotationCounts,
  type AnnotationKind,
  type AnnotationWithBook,
  type Book as DbBook,
  type BookGroup,
  type BookGroupLink,
  type SearchHit,
} from "./store/db";
import {
  countByGroup,
  groupAnnotations,
  groupNameError,
  groupsOfBook,
  normalizeGroupName,
  relativeTime,
} from "./library/manage";
import { ensureIndexed } from "./reader/indexBook";
import { dayKey, summarizeActivity } from "./reader/readingActivity";
import { applyAppTheme, THEMES, THEME_LIST, type ThemeId } from "./reader/themes";
import { THEME_TOKENS } from "./ui/theme/overrides";
import { getLangPref, initI18n, setLangPref, type LangPref } from "./i18n";
import { isForeground, useMobile } from "./platform";
import { useT } from "./i18n/react";

/** P0-3：在这些属性上做 CSS.supports 探测，判断 WebView2（Chromium）原生支持到什么程度 */
const CSS_PROBES: [string, string][] = [
  ["text-autospace", "normal"],
  ["text-spacing-trim", "space-first"],
  ["text-spacing-trim", "trim-start"],
  ["line-break", "strict"],
  ["line-break", "anywhere"],
  ["hanging-punctuation", "allow-end"],
  ["hanging-punctuation", "last"],
  ["text-justify", "inter-ideograph"],
  ["text-align-last", "justify"],
  ["word-break", "break-all"],
  ["overflow-wrap", "anywhere"],
  ["font-variant-east-asian", "proportional-width"],
  ["text-emphasis", "dot"],
  ["writing-mode", "vertical-rl"],
  ["text-orientation", "upright"],
  ["ruby-align", "center"],
  ["text-decoration-skip-ink", "auto"],
  ["font-feature-settings", "'palt'"],
];

/** 目录项 href 与 relocate 给出的 href 可能一个带 OEBPS/ 前缀、一个不带，统一后再比 */
const normalizeHref = (href?: string | null) =>
  (href ?? "").replace(/^\.\//, "").replace(/^OEBPS\//i, "").split("#")[0];
const sameHref = (a?: string | null, b?: string | null) => !!a && !!b && normalizeHref(a) === normalizeHref(b);

/** 侧栏分页（P3.9）：notes/groups 只在书库页出现，toc/anno/search 只在阅读页出现 */
type SideTab = "toc" | "anno" | "search" | "ai" | "typo" | "notes" | "groups";

type DiagResult = { prop: string; value: string; ok: boolean };

function runCssDiagnostics(): DiagResult[] {
  return CSS_PROBES.map(([prop, value]) => ({
    prop,
    value,
    ok: typeof CSS !== "undefined" && CSS.supports(prop, value),
  }));
}

/** 插件目录的 Tauri 命令封装：整个应用共用一份 */
const pluginInvoke = tauriPluginInvoke;

/** 阅读活动（P3.7）：结算间隔与"多久没动就算挂机" */
const ACTIVITY_TICK_SECONDS = 20;
const ACTIVITY_IDLE_MS = 3 * 60 * 1000;

/**
 * 书库页（route = library）专用的两个常量（P3.7 待办 B）。
 *
 * 书库里没有"正在读的书"，所以给 AI 面板一个空装载与空书名 —— 面板据此走
 * **通用对话**分支（bookId = null：ai_messages.book_id IS NULL、作用域 adhoc）。
 * 必须是模块级常量：写成内联字面量的话每次渲染都换引用，
 * 会把 ChatPanel 里以 context 为依赖的那些回调全部重建。
 */
const NO_CONTEXT: ContextLoad = { status: "idle", data: null, progress: null };
const LIBRARY_CONTEXT: BookContext = { title: "" };

export default function App() {
  const t = useT();
  const handleRef = useRef<FoliateHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [bookName, setBookName] = useState<string | null>(null);
  const [title, setTitle] = useState(t("app.noBookOpen"));
  const [toc, setToc] = useState<TocItem[]>([]);
  const [fraction, setFraction] = useState(0);
  const [location, setLocation] = useState("");
  const [flow, setFlow] = useState<"paginated" | "scrolled">("paginated");
  const [typo, setTypo] = useState<TypographyOptions>(defaultTypography);
  const [error, setError] = useState<string | null>(null);
  const [reportInfo, setReportInfo] = useState<string | null>(null);
  const [txtStats, setTxtStats] = useState<TxtImportStats | null>(null);
  const txtStatsRef = useRef<TxtImportStats | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [route, setRoute] = useState<"library" | "reader">("library");
  const [themeId, setThemeId] = useState<ThemeId>("light");
  const theme = THEMES[themeId];
  const settingsLoaded = useRef(false);
  const bookCss = useMemo(() => buildBookCSS(typo, theme), [typo, theme]);
  const [dbReady, setDbReady] = useState(false);
  const bookIdRef = useRef<string | null>(null);
  const savedLocRef = useRef<unknown>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const annotationsRef = useRef<Annotation[]>([]);
  annotationsRef.current = annotations;
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  /**
   * 书库管理（P3.9）：书组 / 书与组的关联 / 跨书笔记总览。
   * 数据放 App 而不是 LibraryPage：侧栏与书架要共享同一份（改一处两边同时刷新）。
   */
  const [groups, setGroups] = useState<BookGroup[]>([]);
  const [groupLinks, setGroupLinks] = useState<BookGroupLink[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [notes, setNotes] = useState<AnnotationWithBook[]>([]);
  const [noteCounts, setNoteCounts] = useState<AnnotationCounts>({ all: 0, highlight: 0, note: 0, bookmark: 0 });
  const [noteFilter, setNoteFilter] = useState<"all" | AnnotationKind>("all");
  const [noteQuery, setNoteQuery] = useState("");
  const [newGroupName, setNewGroupName] = useState("");

  /**
   * 检索命中；P3.7 起顺带记下"落在哪一章"（单文件 EPUB 一节多章，见 runSearch）。
   * ambiguous = 坐标对不上（老缓存），此时只报"这一节"，不假装知道是第几章。
   */
  const [searchHits, setSearchHits] = useState<
    (SearchHit & { chapter?: ManifestEntry; ambiguous?: boolean })[]
  >([]);
  const [indexStatus, setIndexStatus] = useState<string | null>(null);
  const [sideTab, setSideTab] = useState<SideTab>("toc");
  /**
   * P4 移动端：窄视口/真机走手机布局（侧栏变成底部抽屉）。
   * 桌面预览：localStorage["aireader.mobilePreview"] = "1" 或 URL 加 ?mobile=1。
   */
  const mobile = useMobile();
  const [sheetOpen, setSheetOpen] = useState(false);
  /**
   * P4：**Android 的返回键/返回手势**在 WebView 里就是 `history.back()`。
   * 我们用它做一个最小的界面栈（深度用 ref 记账，避免 push/pop 打架）：
   *   抽屉打开 = +1，阅读页 = +1；返回键先收抽屉，再退回书架，都没有才退出应用。
   * 桌面不受影响（mobile 为假时深度恒为 0）。
   */
  const uiDepthRef = useRef(0);
  const [currentBookId, setCurrentBookId] = useState<string | null>(null);
  const [currentAuthor, setCurrentAuthor] = useState("");
  const [currentHref, setCurrentHref] = useState<string | null>(null);
  /** 当前章节标题（目录项），AI 面板用来告诉模型「用户正在看哪里」 */
  const [currentChapter, setCurrentChapter] = useState("");
  /** P2.4 右侧分栏宽度（可拖拽；持久化在 ui.sideWidth） */
  const [sideWidth, setSideWidth] = useState(300);
  /** P2.2 全书上下文装载状态 */
  const [ctxLoad, setCtxLoad] = useState<ContextLoad>({ status: "idle", data: null, progress: null });
  const currentTocRef = useRef<HTMLButtonElement | null>(null);
  const diag = useMemo(runCssDiagnostics, []);
  const supported = diag.filter((d) => d.ok).length;

  const reportPath = (import.meta.env.VITE_P0_REPORT_PATH as string) || "p0-report.json";

  /** 分阶段写自检报告：无论成功失败都能知道应用走到了哪一步 */
  const stage = useCallback(
    async (name: string, extra: Record<string, unknown> = {}) => {
      try {
        await saveReport(
          { stage: name, timestamp: new Date().toISOString(), userAgent: navigator.userAgent, ...extra },
          reportPath,
        );
        setReportInfo(t("app.selfCheckStage", { name }));
      } catch (err) {
        setReportInfo(t("app.selfCheckWriteFailed", { name, error: String(err) }));
      }
    },
    [reportPath],
  );

  useEffect(() => {
    // 初始化 SQLite（建表 + 迁移）
    void initDb()
      .then(() => setDbReady(true))
      .catch((e) => setError(t("app.dbInitFailed", { error: String(e) })));
  }, []);

  // 原生文件拖拽导入（Tauri 的 drag-drop 事件拿得到真实路径；HTML5 drop 只能拿到 File 对象）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload as { type: string; paths?: string[] };
        // 不同平台/版本下，进入窗口时的事件类型可能是 enter 或 over，两个都处理
        if (payload.type === "over" || payload.type === "enter") {
          setDragOver(true);
          return;
        }
        if (payload.type === "leave") {
          setDragOver(false);
          return;
        }
        if (payload.type !== "drop") return;
        setDragOver(false);
        const paths = payload.paths ?? [];
        void (async () => {
          for (const p of paths) {
            setImportStatus(t("app.importing", { name: p.split(/[\\/]/).pop() ?? "" }));
            try {
              await importBookFromPath(p);
            } catch (e) {
              setError(t("app.importFailed", { error: String(e) }));
            }
          }
          setImportStatus(null);
          setLibraryVersion((v) => v + 1);
          setRoute("library");
        })();
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        /* 不支持拖拽事件时静默降级 */
      });
    return () => unlisten?.();
  }, []);

  // 主题应用到应用外壳（CSS 变量）
  useEffect(() => {
    applyAppTheme(theme);
  }, [theme]);

  // 读取已保存的阅读设置
  useEffect(() => {
    if (!dbReady) return;
    void (async () => {
      try {
        const [t, th, f, lang] = await Promise.all([
          getSetting("typography", defaultTypography),
          getSetting<ThemeId>("theme", "light"),
          getSetting<"paginated" | "scrolled">("flow", "paginated"),
          getSetting<LangPref>("ui.language", "auto"),
        ]);
        setTypo({ ...defaultTypography, ...(t as Partial<TypographyOptions>) });
        setThemeId(THEMES[th] ? th : "light");
        setFlow(f);
        // 界面语言：模块加载时已按系统语言定过，这里用用户存过的偏好覆盖
        initI18n(lang);
      } catch {
        /* 读不到就用默认值 */
      } finally {
        settingsLoaded.current = true;
      }
    })();
  }, [dbReady]);

  // P2.4：分栏宽度（读一次、改了就存）
  // 手机上换页（书架 ⇄ 阅读）时收起底部抽屉：不然它盖着刚打开的内容
  useEffect(() => {
    if (mobile) setSheetOpen(false);
  }, [mobile, route]);

  /** 关抽屉：走 history.back()，让 popstate 统一收口（这样"界面栈深度"不会记歪） */
  const closeSheet = useCallback(() => {
    if (mobile && sheetOpen) history.back();
    else setSheetOpen(false);
  }, [mobile, sheetOpen]);

  // 该压几层：抽屉 +1、阅读页 +1
  const uiDepth = mobile ? (sheetOpen ? 1 : 0) + (route === "reader" && bookName ? 1 : 0) : 0;
  useEffect(() => {
    if (!mobile) {
      uiDepthRef.current = 0;
      return;
    }
    while (uiDepthRef.current < uiDepth) {
      history.pushState({ aireaderUi: uiDepthRef.current + 1 }, "");
      uiDepthRef.current += 1;
    }
  }, [mobile, uiDepth]);

  useEffect(() => {
    if (!mobile) return;
    const onPop = () => {
      uiDepthRef.current = Math.max(0, uiDepthRef.current - 1);
      if (sheetOpen) {
        setSheetOpen(false);
        return;
      }
      if (routeRef.current === "reader" && bookOpenRef.current) {
        setRoute("library");
      }
      // 都没有可退的界面：交给浏览器（最终退出应用）
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [mobile, sheetOpen]);

  useEffect(() => {
    if (!dbReady) return;
    void getSetting<number>("ui.sideWidth", 300).then((w) => {
      if (typeof w === "number" && w >= 240 && w <= 760) setSideWidth(w);
    });
  }, [dbReady]);

  useEffect(() => {
    if (!dbReady) return;
    const id = window.setTimeout(() => void setSetting("ui.sideWidth", sideWidth).catch(() => {}), 400);
    return () => window.clearTimeout(id);
  }, [dbReady, sideWidth]);

  // 保存阅读设置（防抖；必须等首次读取完成，否则会用默认值覆盖用户设置）
  useEffect(() => {
    if (!dbReady || !settingsLoaded.current) return;
    const id = window.setTimeout(() => {
      void setSetting("typography", typo).catch(() => {});
      void setSetting("theme", themeId).catch(() => {});
      void setSetting("flow", flow).catch(() => {});
    }, 400);
    return () => window.clearTimeout(id);
  }, [dbReady, typo, themeId, flow]);

  useEffect(() => {
    // 冷启动埋点：React 首次挂载时刻（相对 webview 导航开始）
    (window as unknown as { __boot?: unknown }).__boot = {
      reactMountedMs: Math.round(performance.now()),
      domInteractiveMs: Math.round(performance.timing?.domInteractive ?? 0),
      domCompleteMs: Math.round(performance.timing?.domComplete ?? 0),
    };
    void stage("mounted");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onReady = useCallback((h: FoliateHandle) => {
    handleRef.current = h;
    setReady(true);
    void stage("foliate-ready");
  }, [stage]);

  // 打开书籍前先把进度读进内存，供适配层同步取用（引擎的 open 是同步流程）
  const readSavedLocation = useCallback(() => savedLocRef.current, []);

  const canSaveRef = useRef(false);
  /**
   * P3.4：relocate 时顺手把"这一章读到哪了"算出来（插件要用）。
   *
   * 章节起点/终点来自引擎自己的 `getSectionFractions()`（foliate 的 sectionFractions），
   * 所以这不是我们编的近似值。放在 relocate 里算、存进 liveRef，是为了让读它的人
   * （工具与插件 UI）拿到的是**同步就有**的值 —— 插件 UI 的渲染函数不能 await。
   */
  const sectionRef = useRef<{
    sectionIndex?: number;
    sectionTotal?: number;
    sectionFraction?: number;
    sectionStartFraction?: number;
    sectionEndFraction?: number;
    locations?: { current: number; total: number };
  }>({});
  const onRelocate = useCallback((d: RelocateDetail) => {
    const id = bookIdRef.current;
    if (id && canSaveRef.current && d?.fraction !== undefined) {
      void saveProgress(id, d, d.fraction).catch(() => {
        /* 进度写失败不打断阅读 */
      });
    }
    // 阅读活动（P3.7）：翻页=活跃；location.current 变了才算一次翻页
    const a = activityRef.current;
    const pageLoc = d.location?.current;
    if (typeof pageLoc === "number") {
      if (a.lastLocation >= 0 && pageLoc !== a.lastLocation) a.turns++;
      a.lastLocation = pageLoc;
    }
    a.lastActiveAt = Date.now();
    setFraction(d.fraction ?? 0);
    setCurrentHref(d.tocItem?.href ?? null);
    setCurrentChapter(String(d.tocItem?.label ?? ""));
    const loc = d.pageItem?.label ?? (d.location ? t("app.position", { page: d.location.current }) : "");
    setLocation(loc);
    const idx = d.section?.current;
    let sectionFraction: number | undefined;
    let start: number | undefined;
    let end: number | undefined;
    if (typeof idx === "number" && typeof d.fraction === "number") {
      const fractions = handleRef.current?.getFractions() ?? [];
      start = fractions[idx] ?? 0;
      end = fractions[idx + 1] ?? 1;
      const span = Math.max(1e-9, end - start);
      sectionFraction = Math.min(1, Math.max(0, (d.fraction - start) / span));
    }
    sectionRef.current = {
      sectionIndex: idx,
      sectionTotal: d.section?.total,
      sectionFraction,
      sectionStartFraction: start,
      sectionEndFraction: end,
      locations: d.location ? { current: d.location.current, total: d.location.total } : undefined,
    };
  }, []);

  /** 最近一次打开的书（重新装载全书上下文时要用回同一份 source） */
  const lastSourceRef = useRef<{ id: string; source: Blob | string; title: string } | null>(null);
  /** 装载任务的序号：换书后旧任务的回调不能再改写新书的状态 */
  const ctxSeqRef = useRef(0);

  /**
   * P2.2：抽取全书上下文（命中落盘缓存时几乎瞬时）。
   *
   * 抽取用离屏引擎实例，和阅读实例互不干扰；必须排在全文索引之后跑，
   * 否则两本大书会同时解析（实测 210 万字的书解析一次要数秒）。
   */
  const loadContextFor = useCallback(
    async (id: string, source: Blob | string, metaTitle: string, force = false) => {
      const seq = ++ctxSeqRef.current;
      setCtxLoad({ status: "loading", data: null, progress: null });
      try {
        const row = await getBook(id);
        const data = await buildBookContext(id, source, {
          sourceKey: (row?.derived_path || row?.path || "") + "|" + (row?.size ?? 0),
          title: metaTitle || row?.title || "",
          author: row?.author ?? "",
          onProgress: (done, total) => {
            if (seq !== ctxSeqRef.current) return;
            setCtxLoad((s) => (s.status === "loading" ? { ...s, progress: { done, total } } : s));
          },
          force,
        });
        if (seq !== ctxSeqRef.current) return;
        setCtxLoad({ status: "ready", data, progress: null });
      } catch (e) {
        if (seq !== ctxSeqRef.current) return;
        setCtxLoad({ status: "error", data: null, progress: null, error: String(e) });
      }
    },
    [],
  );

  /**
   * 工具层的实时快照：每次渲染刷新一次，工具回调读它（避免闭包里的过期值）。
   * 这是"执行层与呈现层分离"的落点——工具只认 ToolHost 那几个方法。
   */
  const liveRef = useRef({
    title: "",
    author: "",
    chapter: "",
    location: "",
    fraction: 0,
    section: {} as {
      sectionIndex?: number;
      sectionTotal?: number;
      sectionFraction?: number;
      sectionStartFraction?: number;
      sectionEndFraction?: number;
      locations?: { current: number; total: number };
    },
    selection: null as SelectionInfo | null,
    ctx: null as BookContextData | null,
    version: 0,
  });
  liveRef.current = {
    title: bookName ? title : "",
    author: currentAuthor,
    chapter: currentChapter,
    location,
    fraction,
    section: sectionRef.current,
    selection,
    ctx: ctxLoad.data,
    version: liveRef.current.version,
  };

  const toolHostDeps: ToolHostDeps = useMemo(
    () => ({
      bookId: () => bookIdRef.current,
      title: () => liveRef.current.title,
      author: () => liveRef.current.author,
      progress: () => {
        const l = liveRef.current;
        return { fraction: l.fraction, chapter: l.chapter, location: l.location, ...l.section };
      },
      context: () => liveRef.current.ctx,
      search: async (query, limit) => {
        const id = bookIdRef.current;
        if (!id) return [];
        // plain（该节全文）一起交给工具层：一节多章时要靠它把命中对齐到章（P3.7）
        return (await searchBook(id, query, limit)).map((h) => ({
          sectionIndex: h.sectionIndex,
          snippet: h.snippet,
          plain: h.plain,
        }));
      },
      selection: () => {
        const s = liveRef.current.selection;
        return s && s.cfi ? { text: s.text, cfi: s.cfi, chapter: liveRef.current.chapter } : null;
      },
      addAnnotation: async (input) => {
        const id = bookIdRef.current;
        if (!id) throw new Error(t("app.noOpenBook"));
        const row = await addAnnotation({
          bookId: id,
          kind: input.kind,
          cfi: input.cfi,
          text: input.text,
          note: input.note,
          color: input.color,
        });
        setAnnotations((list) => [...list, row]);
        if (row.kind !== "bookmark") {
          handleRef.current?.addAnnotation({ value: row.cfi, color: row.color, note: row.note });
        }
        return row;
      },
      listAnnotations: async () => {
        const id = bookIdRef.current;
        if (!id) return [];
        return listAnnotations(id);
      },
      goToChapter: async (n) => {
        await handleRef.current?.goToSection(n - 1);
      },
      /**
       * P3.7：按 href 跳（引擎的 resolveHref 认 "OEBPS/text00000.html#filepos..."）。
       * 单文件 EPUB 里一章不再是"一节的开头"，只有 href 能落到正确的锚点上。
       */
      goToHref: async (href) => {
        if (!href) return;
        await handleRef.current?.goTo(href);
      },
      goToCfi: async (cfi) => {
        await handleRef.current?.goTo(cfi);
      },
      goToFraction: async (f) => {
        await handleRef.current?.goToFraction(f);
      },
    }),
    [],
  );
  const toolHost = useMemo(() => createToolHost(toolHostDeps), [toolHostDeps]);

  /** P2.5 技能宿主：内置技能 + 用户目录技能（%APPDATA%/aireader/skills） */
  const skillHost = useMemo(() => createSkillHost(), []);
  /** 技能目录的绝对路径（同步读给工具结果用；真正的读盘在 skillHost.dir()） */
  const skillsDirRef = useRef("");
  useEffect(() => {
    void skillHost
      .dir()
      .then((d) => {
        skillsDirRef.current = d;
      })
      .catch(() => {});
  }, [skillHost]);

  /** 插件目录（P3.1）：同样的套路 —— 起手问一次，之后同步读 */
  const pluginsDirRef = useRef("");
  useEffect(() => {
    void pluginInvoke
      .getPluginsDir()
      .then((d) => {
        pluginsDirRef.current = d;
      })
      .catch(() => {});
  }, []);

  /**
   * P3.0 应用运行时：底座能力（tools/reader/skills/db/theme/ai/paths）注册成服务，
   * 内置功能（读工具、技能工具、阅读统计）挂成**插件** —— 于是它们每一个都能被卸载，
   * 而且卸载路径与将来的第三方插件是同一条。工具的实际注册发生在插件 apply 里，
   * 所以 registry 在 mount() 之后才有内容（一次微任务，用户来得及提问之前早就好了）。
   */
  const dbService: DbService = useMemo(
    () => ({
      listAnnotations: (id) => listAnnotations(id),
      addAnnotation: (a) => addAnnotation(a),
      searchBook: (id, query, limit) => searchBook(id, query, limit),
      getSetting: (key, fallback) => getSetting(key, fallback),
      setSetting: (key, value) => setSetting(key, value),
    }),
    [],
  );
  /**
   * 阅读活动采集（P3.7）。
   *
   * 口径：**阅读中 = 阅读页可见 && 窗口有焦点 && 最近 3 分钟有过翻页/按键/滚轮**。
   * 每 20 秒结算一次增量写库（SQLite UPSERT 累加），切到书架、失焦、挂机都不计时。
   * 采集放宿主是因为插件两头都够不着：沙箱没有定时器，也看不到路由与焦点。
   */
  const activityRef = useRef({ lastTickAt: 0, lastActiveAt: 0, lastLocation: -1, turns: 0 });
  const mobileRef = useRef(mobile);
  mobileRef.current = mobile;
  const routeRef = useRef(route);
  routeRef.current = route;
  const bookOpenRef = useRef(false);
  bookOpenRef.current = Boolean(bookName);

  const flushActivity = useCallback(async () => {
    const a = activityRef.current;
    const now = Date.now();
    const prev = a.lastTickAt;
    a.lastTickAt = now;
    // 首拍（或从后台回来）不记时长：那时候的 delta 是从上一次结算算起的挂机时间
    const seconds = prev ? Math.min(ACTIVITY_TICK_SECONDS * 2, (now - prev) / 1000) : 0;
    const turns = a.turns;
    a.turns = 0;
    /**
     * P4：判定"在读"的两条平台差异。
     *   - Android 会挂起后台 WebView，所以我们先看 **前台可见**（visibilityState）；
     *   - 桌面上"切到别的窗口"不该计时，所以桌面仍然要 hasFocus()；
     *     手机上不能用 hasFocus()：弹软键盘、下拉通知栏、系统弹窗都会让它变 false，
     *     那几秒其实人还在读书（实测口径见 docs/16 与 P3.7 的采集说明）。
     */
    const focused = mobileRef.current ? true : typeof document !== "undefined" && document.hasFocus();
    const reading =
      routeRef.current === "reader" &&
      bookOpenRef.current &&
      isForeground() &&
      focused &&
      now - a.lastActiveAt < ACTIVITY_IDLE_MS;
    if (!reading || (seconds <= 0 && turns <= 0)) return;
    try {
      await addReadingActivity(dayKey(now), seconds, turns);
    } catch {
      /* 统计写失败不该影响阅读 */
    }
  }, []);

  useEffect(() => {
    if (!dbReady) return;
    const id = window.setInterval(() => void flushActivity(), ACTIVITY_TICK_SECONDS * 1000);
    return () => window.clearInterval(id);
  }, [dbReady, flushActivity]);

  /**
   * 前后台切换（P4 移动端的主要差异点）。
   *   - 切到后台：**立刻结算一次**，因为 Android 可能马上把进程杀掉（最坏情况丢 20 秒增量）；
   *   - 回到前台：把 lastTickAt 归零，下次结算的 delta 从"回来这一刻"算起，
   *     不然会把后台那一段时间当成阅读时长（桌面上最小化窗口也是同一个道理）。
   */
  useEffect(() => {
    if (!dbReady) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        void flushActivity();
      } else {
        activityRef.current.lastTickAt = 0;
        activityRef.current.lastActiveAt = Date.now();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [dbReady, flushActivity]);

  const readingActivity: ReadingActivityService = useMemo(
    () => ({
      async snapshot() {
        return summarizeActivity(await listReadingActivity(400), dayKey(Date.now()));
      },
    }),
    [],
  );

  /**
   * 宿主自己的 AI 凭据（P3.11）：**只喂给 net 门面**，用来给插件的 GET 请求代填 Authorization。
   * 它不进沙箱（插件拿不到 Key 本身），也不出现在 plugin_inspect 的输出里。
   * 与 ChatPanel 一样监听 aireader:reload-settings —— 改完设置（或探针复原）要立刻生效。
   */
  const aiCredRef = useRef<AiCredentials | null>(null);
  useEffect(() => {
    if (!dbReady) return;
    const load = async () => {
      try {
        const [baseUrl, apiKey] = await Promise.all([
          getSetting<string>("ai.baseUrl", "https://api.deepseek.com"),
          getSetting<string>("ai.apiKey", ""),
        ]);
        const origin = originOf(String(baseUrl ?? ""));
        aiCredRef.current = origin
          ? { origin, hasKey: Boolean(apiKey), authorization: apiKey ? "Bearer " + apiKey : null }
          : null;
      } catch {
        aiCredRef.current = null;
      }
    };
    void load();
    window.addEventListener("aireader:reload-settings", load);
    return () => window.removeEventListener("aireader:reload-settings", load);
  }, [dbReady]);
  const aiCredentials: AiCredentialService = useMemo(() => ({ current: () => aiCredRef.current }), []);

  const themeRef = useRef<ThemeId>(themeId);
  themeRef.current = themeId;
  const themeService: ThemeService = useMemo(
    () => ({
      current: () => themeRef.current,
      set: (id) => setThemeId(id),
      list: () => THEME_LIST.map((t) => t.id),
    }),
    [],
  );

  const runtime = useMemo(
    () =>
      createAppRuntime({
        reader: toolHost,
        skills: skillHost,
        db: dbService,
        theme: themeService,
        readingActivity,
        aiCredentials,
        paths: {
          skillsDir: () => skillsDirRef.current,
          pluginsDir: () => pluginsDirRef.current,
        },
        pluginIo: pluginInvoke,
      }),
    [toolHost, skillHost, dbService, themeService, readingActivity, aiCredentials],
  );
  const toolRegistry = runtime.tools;

  /** 某个插件挂的 UI 渲染崩了：内核会把它从格子里摘掉，这里只负责说出来 */
  const onSlotError = useCallback((slot: string, entry: SlotEntry, error: unknown) => {
    console.error("[slot] " + slot + " 的「" + (entry.label ?? entry.owner) + "」渲染失败，已从格子里摘掉", error);
  }, []);

  /**
   * 插件运行时挂载。
   *
   * P4 实测踩到：**首次冷启动可能挂不上** —— `mount()` 里要先 `permissions.ready()`
   * （读设置表里的授权记录）再扫插件目录，如果这时候数据库还在建表/迁移，它就会抛；
   * 而 `void runtime.mount()` 把 rejection 吞了，界面看起来正常但一个插件都没有
   * （手机上第一次装完打开就是这样：设置面板里没有插件区、阅读区尾部也没有状态条）。
   *
   * 所以两件事：**等 dbReady 再挂**，并且**把失败说出来**（同时留一次重试）。
   */
  const [pluginMountFailed, setPluginMountFailed] = useState(false);
  useEffect(() => {
    if (!dbReady) return;
    let alive = true;
    const doMount = async () => {
      try {
        await runtime.mount();
        if (alive) setPluginMountFailed(false);
      } catch (e) {
        if (!alive) return;
        setPluginMountFailed(true);
        console.error("[plugins] 插件运行时挂载失败：", e);
      }
    };
    void doMount();
    return () => {
      alive = false;
      void runtime.dispose();
    };
  }, [runtime, dbReady]);

  // 挂载失败给一次自动重试（数据库刚建好那一下最容易撞上）
  useEffect(() => {
    if (!pluginMountFailed) return;
    const id = window.setTimeout(() => {
      void runtime.mount().then(
        () => setPluginMountFailed(false),
        (e) => console.error("[plugins] 重试仍然失败：", e),
      );
    }, 1500);
    return () => window.clearTimeout(id);
  }, [pluginMountFailed, runtime]);

  /**
   * P3.6：插件覆盖的主题 token。
   * 基础色板由 `applyAppTheme` 写进 documentElement 的 CSS 变量；这里在它**之后**
   * 叠加各层覆盖（后注册的压先注册的），主题切换或层变化时重算。
   */
  useEffect(() => {
    const apply = () => {
      const root = document.documentElement.style;
      const resolved = runtime.themeOverrides.resolve(themeId);
      for (const name of THEME_TOKENS) {
        const v = resolved[name];
        if (v === undefined) root.removeProperty(name);
        else root.setProperty(name, v);
      }
    };
    apply();
    const off = runtime.themeOverrides.onChange(apply);
    return () => {
      off();
    };
  }, [runtime, themeId]);

  const reloadBookContext = useCallback(() => {
    const last = lastSourceRef.current;
    if (!last) return;
    void loadContextFor(last.id, last.source, last.title, true);
  }, [loadContextFor]);

  const openFile = useCallback(async (file: File | Blob | string, name?: string) => {
    const h = handleRef.current;
    if (!h) return;
    setError(null);
    // 换书先清空上一本的装载状态，避免 AI 面板显示错书的章数与成本
    setCtxLoad({ status: "idle", data: null, progress: null });
    const fileName = name ?? (file instanceof File ? file.name : "");
    canSaveRef.current = false; // 打开与恢复期间的 relocate 不回写位置
    try {
      // TXT 需要先转成 EPUB（foliate-js 不支持裸 TXT）
      let source: File | Blob | string = file;
      if (/\.txt$/i.test(fileName)) {
        const text =
          typeof file === "string" ? await (await fetch(file)).text() : await (file as Blob).text();
        const t0 = performance.now();
        await stage("txt-converting", { chars: text.length });
        const res = await txtToEpubFile(text, fileName.replace(/\.txt$/i, ""));
        source = res.file;
        setTxtStats(res.stats);
        txtStatsRef.current = res.stats;
        console.info("TXT 转换完成", res.stats, "读取耗时", Math.round(performance.now() - t0), "ms");
      }
      // 引擎约束：适配层的 open() 内部已经按 open → setStyles → next 的顺序处理
      await h.open(source);
      const meta: any = h.getMetadata();
      const rawTitle = meta?.title;
      const metaTitle = typeof rawTitle === "string" ? rawTitle : rawTitle ? String(Object.values(rawTitle)[0] ?? "") : "";
      setTitle(metaTitle || t("app.untitledBook"));
      setToc(h.getTOC());
      setBookName(name ?? null);
      setSearchHits([]);

      // 首次打开时后台建立全文索引（不阻塞阅读）
      const id = bookIdRef.current;
      if (id) {
        void (async () => {
          try {
            setIndexStatus(t("app.indexBuildingStart"));
            const built = await ensureIndexed(id, source as Blob | string, (done, total) =>
              setIndexStatus(t("app.indexBuilding", { done, total })),
            );
            setIndexStatus(built ? t("app.indexReady") : null);
            window.setTimeout(() => setIndexStatus(null), 2500);
          } catch (e) {
            setIndexStatus(t("app.indexFailed", { error: String(e) }));
          }
          // 索引之后紧接着装载全书上下文（P2.2）：同一个离屏解析串行跑，不叠加内存峰值
          if (bookIdRef.current === id) {
            lastSourceRef.current = { id, source: source as Blob | string, title: metaTitle };
            await loadContextFor(id, source as Blob | string, metaTitle);
          }
        })();
      }

      // P0 自检：等首屏渲染完成后再采集（内容在 iframe 里，异步创建）
      window.setTimeout(() => {
        void (async () => {
          try {
            const rep = collectReport(h, {
              stage: "book-opened",
              source: name ?? null,
              flow,
              txtImport: txtStatsRef.current,
              typography: typo,
            });
            await saveReport(rep, reportPath);
            setReportInfo(t("app.selfCheckOpened", { path: reportPath }));
          } catch (err) {
            await stage("report-failed", { error: String(err) });
          }
        })();
      }, 1800);
    } catch (e) {
      setError(String(e));
      await stage("open-failed", { source: name ?? String(file).slice(0, 80), error: String(e) });
    }
  }, [flow, typo, stage, loadContextFor]);

  // 排版参数变化 → 重新注入样式
  useEffect(() => {
    if (!bookName) return;
    handleRef.current?.setStyles(buildBookCSS(typo, theme));
  }, [typo, theme, bookName]);

  useEffect(() => {
    handleRef.current?.setFlow(flow);
  }, [flow]);

  // 桌面交互：键盘翻页 / 缩放 / 退出
  useEffect(() => {
    if (route !== "reader") return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const h = handleRef.current;
      if (!h) return;
      switch (e.key) {
        case "ArrowLeft":
        case "PageUp":
          e.preventDefault();
          void h.prev();
          break;
        case "ArrowRight":
        case "PageDown":
        case " ":
          e.preventDefault();
          void h.next();
          break;
        case "Home":
          e.preventDefault();
          void h.goToFraction(0);
          break;
        case "End":
          e.preventDefault();
          void h.goToFraction(1);
          break;
        case "+":
        case "=":
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            setTypo((t) => ({ ...t, fontSize: Math.min(32, t.fontSize + 2) }));
          }
          break;
        case "-":
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            setTypo((t) => ({ ...t, fontSize: Math.max(12, t.fontSize - 2) }));
          }
          break;
        case "Escape":
          setRoute("library");
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route]);

  /**
   * 直接打开的文件（拖拽/文件选择/测试样书）不属于书库：必须清空书籍身份。
   *
   * 否则 bookIdRef 还指着上一本书，全文索引与全书上下文会被写到那本书名下
   * （P1 就存在这个隐患，实测确认：直接打开别的文件会覆盖上一本书的检索索引）。
   */
  const openAdHoc = useCallback(
    async (file: File | Blob | string, name?: string) => {
      bookIdRef.current = null;
      setCurrentBookId(null);
      setCurrentAuthor("");
      setCurrentChapter("");
      savedLocRef.current = null;
      setAnnotations([]);
      annotationsRef.current = [];
      lastSourceRef.current = null;
      setRoute("reader");
      await openFile(file, name);
    },
    [openFile],
  );

  const loadFixture = useCallback(async () => {
    // 开发/验收用：app/public/zh-sample.epub（由 tools/make-fixtures.mjs 生成）
    await openAdHoc("/zh-sample.epub", "zh-sample.epub");
  }, [openAdHoc]);

  // 验收用：构建时用 VITE_AUTOLOAD_FIXTURE=1 打开测试样书（正常构建不生效）
  const AUTOLOAD = import.meta.env.VITE_AUTOLOAD_FIXTURE === "1";
  const DEV_TOOLS = import.meta.env.VITE_DEV_TOOLS === "1";
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (!AUTOLOAD || !ready || autoLoaded.current) return;
    autoLoaded.current = true;
    void loadFixture();
  }, [AUTOLOAD, ready, loadFixture]);

  /**
   * 调试构建下把容器挂到 window 上：CDP 探针靠它观察 fiber 状态、卸载/重挂内置插件
   * （probe-p30.js 就是这么验"卸载一个插件 → 依赖它的插件自动 park"的）。
   * 发布构建里这段代码不会执行（VITE_DEV_TOOLS 未设置）。
   */
  useEffect(() => {
    if (!DEV_TOOLS) return;
    const w = window as unknown as { __aireaderRuntime?: unknown; __aireaderReact?: unknown };
    w.__aireaderRuntime = runtime;
    // 探针要往插槽里注册真实组件（error boundary 只在浏览器里生效，SSR 验不了），
    // 所以把 createElement 也递出去。仅调试构建。
    w.__aireaderReact = { createElement };
    return () => {
      delete w.__aireaderRuntime;
      delete w.__aireaderReact;
    };
  }, [DEV_TOOLS, runtime]);

  const pick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".epub,.mobi,.azw3,.azw,.fb2,.cbz,application/epub+zip";
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) void openAdHoc(f, f.name);
    };
    input.click();
  };

  const refreshAnnotations = useCallback(async (): Promise<Annotation[]> => {
    const id = bookIdRef.current;
    if (!id) return [];
    try {
      const rows = await listAnnotations(id);
      setAnnotations(rows);
      annotationsRef.current = rows;
      return rows;
    } catch {
      /* 读不到就当没有批注 */
      return [];
    }
  }, []);

  /**
   * 把批注补交给引擎绘制。
   *
   * 必须显式补一次：引擎的 create-overlay 在「打开书籍」阶段就触发了，
   * 而那时批注还没从数据库读出来（实测：侧栏有 2 条，书里一条都没画出来）。
   */
  const repaintAnnotations = useCallback((rows: Annotation[]) => {
    for (const a of rows) {
      if (a.kind === "highlight") {
        handleRef.current?.addAnnotation({ value: a.cfi, color: a.color, note: a.note });
      }
    }
  }, []);

  /** 从书架打开一本书：先取回进度，再切到阅读器并交给引擎打开 */
  // ---------- 书库管理（P3.9）：书组与笔记 ----------

  /** 重新拉一遍书组 / 关联 / 笔记总览（改完就刷，界面与书架共用同一份） */
  const refreshLibraryManage = useCallback(async () => {
    try {
      const [gs, ls, rows, counts] = await Promise.all([
        listGroups(),
        listBookGroups(),
        listAllAnnotations(500),
        countAnnotations(),
      ]);
      setGroups(gs);
      setGroupLinks(ls);
      setNotes(rows);
      setNoteCounts(counts);
    } catch (e) {
      setError(t("app.loadGroupsFailed", { error: String(e) }));
    }
  }, []);

  /**
   * 书库页才需要这些数据；另外**在读的时候新增/删除批注也要刷**（annotations 变了），
   * 否则回到主页会发现"刚写的笔记不在列表里"。
   */
  useEffect(() => {
    if (!dbReady) return;
    if (route !== "library" && annotations.length === 0) return;
    void refreshLibraryManage();
  }, [dbReady, route, libraryVersion, annotations, refreshLibraryManage]);

  const handleCreateGroup = useCallback(
    async (raw: string, forBookId?: string) => {
      const name = normalizeGroupName(raw);
      const bad = groupNameError(name, groups.map((g) => g.name));
      if (bad) {
        setError(bad);
        return;
      }
      try {
        const g = await createGroup(name);
        setGroups((list) => [...list, g]);
        if (forBookId) {
          const next = [...groupsOfBook(groupLinks, forBookId), g.id];
          await setBookGroups(forBookId, next);
          setGroupLinks((list) => [
            ...list.filter((l) => l.book_id !== forBookId),
            ...next.map((gid) => ({ book_id: forBookId, group_id: gid })),
          ]);
        }
      } catch (e) {
        setError(t("app.createGroupFailed", { error: String(e) }));
      }
    },
    [groups, groupLinks],
  );

  const handleRenameGroup = useCallback(
    async (g: BookGroup) => {
      const input = window.prompt(t("app.groupNamePrompt"), g.name);
      if (input === null) return;
      const bad = groupNameError(input, groups.map((x) => x.name), g.name);
      if (bad) {
        setError(bad);
        return;
      }
      const name = normalizeGroupName(input);
      try {
        await renameGroup(g.id, name);
        setGroups((list) => list.map((x) => (x.id === g.id ? { ...x, name } : x)));
      } catch (e) {
        setError(t("app.renameFailed", { error: String(e) }));
      }
    },
    [groups],
  );

  const handleDeleteGroup = useCallback(async (g: BookGroup) => {
    if (!window.confirm(t("app.confirmDeleteGroup", { name: g.name }))) return;
    try {
      await deleteBookGroup(g.id);
      setGroups((list) => list.filter((x) => x.id !== g.id));
      setGroupLinks((list) => list.filter((l) => l.group_id !== g.id));
      setSelectedGroupId((cur) => (cur === g.id ? null : cur));
    } catch (e) {
      setError(t("app.deleteGroupFailed", { error: String(e) }));
    }
  }, []);

  const handleSetBookGroups = useCallback(async (bookId: string, groupIds: string[]) => {
    try {
      await setBookGroups(bookId, groupIds);
      setGroupLinks((list) => [
        ...list.filter((l) => l.book_id !== bookId),
        ...groupIds.map((gid) => ({ book_id: bookId, group_id: gid })),
      ]);
    } catch (e) {
      setError(t("app.assignGroupFailed", { error: String(e) }));
    }
  }, []);

  const openBook = useCallback(
    async (book: DbBook) => {
      bookIdRef.current = book.id;
      setCurrentBookId(book.id);
      setCurrentAuthor(book.author ?? "");
      setCurrentChapter("");
      try {
        const prog = await loadProgress(book.id);
        savedLocRef.current = prog?.location ?? null;
      } catch {
        savedLocRef.current = null;
      }
      setRoute("reader");
      await touchBook(book.id);
      // 有派生 EPUB（TXT 转换结果）就用它，避免每次打开重转
      const srcPath = book.derived_path || book.path;
      const srcName = book.derived_path ? `${book.id}.epub` : book.original_name;
      await openFile(convertFileSrc(srcPath), srcName);
      const rows = await refreshAnnotations();
      repaintAnnotations(rows);
    },
    [openFile, refreshAnnotations, repaintAnnotations],
  );

  /**
   * 打开某本书并跳到指定位置（P3.9：主页「笔记」里点一条就回到原文）。
   * 顺序有讲究：openBook 内部会把上次阅读位置恢复出来，所以要**等它做完**再 goTo，
   * 否则会被恢复流程盖回去。
   */
  const openBookAt = useCallback(
    async (bookId: string, cfi?: string) => {
      try {
        const book = await getBook(bookId);
        if (!book) {
          setError(t("app.bookGone"));
          return;
        }
        await openBook(book);
        if (cfi) {
          try {
            await handleRef.current?.goTo(cfi);
          } catch {
            /* 位置失效（书换过版本）就停在书首，不打断 */
          }
        }
      } catch (e) {
        setError(t("app.openFailed", { error: String(e) }));
      }
    },
    [openBook],
  );

  // 桌面交互：滚轮翻页（仅分页模式；滚动模式下交还给引擎自己滚）
  const wheelAccum = useRef(0);
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      activityRef.current.lastActiveAt = Date.now();
      if (flow !== "paginated") return;
      wheelAccum.current += e.deltaY;
      if (Math.abs(wheelAccum.current) < 60) return;
      const down = wheelAccum.current > 0;
      wheelAccum.current = 0;
      if (down) void handleRef.current?.next();
      else void handleRef.current?.prev();
    },
    [flow],
  );

  // ---------- 批注（划线 / 书签 / 笔记） ----------

  /** 把某章节的划线交给引擎绘制 */
  const annotationsForSection = useCallback(
    (index: number): BookAnnotation[] =>
      annotationsRef.current
        .filter((a) => a.kind === "highlight" && sectionIndexOfCfi(a.cfi) === index)
        .map((a) => ({ value: a.cfi, color: a.color, note: a.note })),
    [],
  );

  // 选区轮询：引擎不给 selectionchange 事件，250ms 轮询足够跟手且开销可忽略
  useEffect(() => {
    if (route !== "reader" || !bookName) return;
    const timer = window.setInterval(() => {
      const sel = handleRef.current?.getSelection() ?? null;
      setSelection((prev) => {
        if (!sel && !prev) return prev;
        if (sel && prev && sel.cfi === prev.cfi && sel.text === prev.text) return prev;
        return sel;
      });
    }, 250);
    return () => window.clearInterval(timer);
  }, [route, bookName]);

  const clearSelection = useCallback(() => {
    handleRef.current?.clearSelection();
    setSelection(null);
  }, []);

  const addHighlight = useCallback(
    async (color: string) => {
      const sel = selection;
      const id = bookIdRef.current;
      if (!sel || !id || !sel.cfi) return;
      try {
        const row = await addAnnotation({ bookId: id, kind: "highlight", cfi: sel.cfi, text: sel.text, color });
        setAnnotations((list) => [...list, row]);
        handleRef.current?.addAnnotation({ value: row.cfi, color: row.color, note: row.note });
      } catch (e) {
        setError(t("app.highlightFailed", { error: String(e) }));
      }
      clearSelection();
    },
    [selection, clearSelection],
  );

  const addNote = useCallback(async () => {
    const sel = selection;
    const id = bookIdRef.current;
    if (!sel || !id || !sel.cfi) return;
    const note = window.prompt(t("app.notePrompt"), "");
    if (note === null) return;
    try {
      const row = await addAnnotation({
        bookId: id,
        kind: "note",
        cfi: sel.cfi,
        text: sel.text,
        note,
        color: "blue",
      });
      setAnnotations((list) => [...list, row]);
      handleRef.current?.addAnnotation({ value: row.cfi, color: row.color, note: row.note });
    } catch (e) {
      setError(t("app.addNoteFailed", { error: String(e) }));
    }
    clearSelection();
  }, [selection, clearSelection]);

  const addBookmark = useCallback(async () => {
    const id = bookIdRef.current;
    if (!id) return;
    const loc = handleRef.current?.getLocation() as { cfi?: string } | null;
    if (!loc?.cfi) return;
    try {
      const row = await addAnnotation({ bookId: id, kind: "bookmark", cfi: loc.cfi, text: title });
      setAnnotations((list) => [...list, row]);
    } catch (e) {
      setError(t("app.addBookmarkFailed", { error: String(e) }));
    }
  }, [title]);

  const removeAnnotation = useCallback(async (a: Annotation) => {
    try {
      await deleteAnnotation(a.id);
      setAnnotations((list) => list.filter((x) => x.id !== a.id));
      if (a.kind !== "bookmark") {
        handleRef.current?.deleteAnnotation({ value: a.cfi, color: a.color, note: a.note });
      }
    } catch (e) {
      setError(t("app.deleteAnnotationFailed", { error: String(e) }));
    }
  }, []);

  const jumpToAnnotation = useCallback((a: Annotation) => {
    void handleRef.current?.goTo(a.cfi);
  }, []);

  const runSearch = useCallback(async () => {
    const id = bookIdRef.current;
    const q = searchQuery.trim();
    if (!id || !q) {
      setSearchHits([]);
      return;
    }
    try {
      const rows = await searchBook(id, q);
      // P3.7：命中落在哪一章里是**检索时**算好的（换书/重装后不能拿旧清单去配旧命中）。
      // 全文索引按节建，单文件 EPUB 一节多章 —— 同一个词在这一节里可能出现多次，
      // 所以一个节级命中会摊成多条章级命中（与工具层用同一个 locateHits）。
      const manifest = ctxLoad.data?.manifest ?? [];
      setSearchHits(
        rows.flatMap((h) => {
          const same = manifest.filter((m) => m.section === h.sectionIndex);
          if (same.length <= 1) return [{ ...h, chapter: same[0] }];
          const hits = locateHits(manifest, h.sectionIndex, h.plain, q, 3);
          if (!hits.length) return [{ ...h, chapter: same[0], ambiguous: true }];
          return hits.map((x) => ({
            ...h,
            snippet: x.snippet,
            chapter: manifest.find((m) => m.n === x.n),
          }));
        }),
      );
    } catch (e) {
      setError(t("app.searchFailed", { error: String(e) }));
    }
  }, [searchQuery, ctxLoad]);

  // 目录面板：递归渲染 + 高亮当前章节 + 自动滚到可见处
  const renderToc = (items: TocItem[], depth = 0): React.ReactNode =>
    items.map((it, i) => {
      const active = sameHref(it.href, currentHref);
      return (
        <div key={`${depth}-${i}`}>
          <button
            className={`air-toc-item${active ? " active" : ""}`}
            style={{ paddingLeft: 6 + Math.min(depth, 3) * 12 }}
            ref={active ? currentTocRef : undefined}
            onClick={() => {
              // 手机上点目录就是要跳到那一章：顺手收起抽屉，否则它盖着正文
              if (mobile) closeSheet();
              if (it.href) void handleRef.current?.goTo(it.href);
            }}
            title={it.label ?? ""}
          >
            {String(it.label ?? "").slice(0, 80)}
          </button>
          {it.subitems?.length ? renderToc(it.subitems, depth + 1) : null}
        </div>
      );
    });

  useEffect(() => {
    currentTocRef.current?.scrollIntoView({ block: "nearest" });
  }, [currentHref, sideTab]);

  const Toggle = ({ k, label }: { k: keyof TypographyOptions; label: string }) => (
    <button
      data-active={String(Boolean(typo[k]))}
      onClick={() => setTypo((t) => ({ ...t, [k]: !t[k] }))}
      style={{ marginRight: 4, marginBottom: 4 }}
    >
      {label}
    </button>
  );

  /**
   * P3.7 待办 B：**书库页也能用 AI**。
   *
   * 两条列都始终挂载、只切 display —— 换路由不能让 FoliateView 卸载（引擎实例一没，
   * 回到阅读页就是白屏，因为没人会再调一次 open()），也不该让 AI 面板重挂。
   * 书库分支只留 AI 一页：目录/批注/检索讲的都是"当前这本书"，书库里没有书。
   */
  const isLibrary = route === "library";
  /**
   * 侧栏分页**按路由给**（P3.9）：
   *   - 书库页：笔记（跨书总览）· 书组 · AI · 设置与插件；
   *   - 阅读页：目录 · 批注 · 检索 · AI · 设置与插件。
   * 「设置与插件」两边都要有 —— 管理插件、改主题不该逼用户先打开一本书。
   * sideTab 只存"用户点过的那个"，当前路由没有它就落到该路由的第一页（切回来时还在原页）。
   */
  const tabs: (readonly [SideTab, string])[] = isLibrary
    ? [
        ["notes", t("app.tabNotes", { n: noteCounts.all })],
        ["groups", t("app.tabGroups", { n: groups.length })],
        ["ai", "AI"],
        ["typo", t("app.tabSettings")],
      ]
    : [
        ["toc", t("app.tabToc", { n: toc.length })],
        ["anno", t("app.tabAnno", { n: annotations.length })],
        ["search", t("app.tabSearch")],
        ["ai", "AI"],
        ["typo", t("app.tabSettings")],
      ];
  const tab: SideTab = tabs.some(([id]) => id === sideTab) ? sideTab : tabs[0][0];
  /** 笔记总览（跨书）：按书分组，组内按时间倒序 */
  const noteGroups = useMemo(
    () => groupAnnotations(notes, { kind: noteFilter, query: noteQuery }),
    [notes, noteFilter, noteQuery],
  );
  const groupCounts = useMemo(() => countByGroup(groupLinks), [groupLinks]);

  return (
    <div className="air-app" data-mobile={mobile ? "true" : "false"}>
      <div className="air-reader-shell" style={{ display: "flex" }}>
      {route === "reader" && (
      <div className="air-bar">
        <button onClick={() => setRoute("library")}>{t("app.backToLibrary")}</button>
        <button onClick={pick}>{t("app.openFile")}</button>
        {DEV_TOOLS && (
          <>
            <button onClick={() => void loadFixture()}>{t("app.openFixture")}</button>
            <button onClick={() => void openAdHoc("/huge.txt", "huge.txt")}>{t("app.openHugeTxt")}</button>
          </>
        )}
        {bookName && (
          <>
            <button onClick={() => void handleRef.current?.prev()}>{t("app.prevPage")}</button>
            <button onClick={() => void addBookmark()}>{t("app.addBookmark")}</button>
            <button onClick={() => void handleRef.current?.next()}>{t("app.nextPage")}</button>
            <span style={{ minWidth: 46, textAlign: "right" }}>{(fraction * 100).toFixed(1)}%</span>
            <span style={{ color: "#7b8494" }}>{location}</span>
          </>
        )}
        {txtStats && (
          <span className="air-stat-text" style={{ color: "#5b6472", fontSize: 12 }}>
            {t("app.txtImportStats", {
              chapters: txtStats.chapters,
              chars: (txtStats.chars / 10000).toFixed(1),
              convertMs: txtStats.convertMs,
              epubMB: (txtStats.epubBytes / 1048576).toFixed(2),
              heapMB: txtStats.heapMB ?? "?",
            })}
          </span>
        )}
        {/* 自检结果只在调试构建里显示：它是 P0 的排查痕迹，不该出现在给别人的版本里（实测截图里会带出来） */}
        {DEV_TOOLS && reportInfo && <span style={{ color: "#16794c", fontSize: 12 }}>{reportInfo}</span>}
        <span className="air-spacer" />
        <span style={{ color: "#7b8494", maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </span>
      </div>
      )}

      <div className="air-main">
        {/* 阅读列：一直挂着（只切 display），否则回到阅读页时引擎实例已丢 */}
        <div className="air-reader-col" style={{ display: route === "reader" ? "flex" : "none" }}>
        <div
          className={`air-reader${dragOver ? " dragover" : ""}`}
          onWheel={onWheel}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void openAdHoc(f, f.name);
          }}
        >
          <FoliateView
            css={bookCss}
            flow={flow}
            getSavedLocation={readSavedLocation}
            getAnnotations={annotationsForSection}
            onAnnotationActivate={(a) => {
              const row = annotationsRef.current.find((x) => x.cfi === a.value);
              if (row?.note) window.alert(row.note);
            }}
            onRestored={() => {
              canSaveRef.current = true;
            }}
            onReady={onReady}
            onRelocate={onRelocate}
            onError={(e) => setError(String(e))}
          />
          {!bookName && (
            <div
              style={{
                position: "absolute", inset: 16, display: "flex", alignItems: "center",
                justifyContent: "center", flexDirection: "column", gap: 10,
                border: "2px dashed #c9cfda", borderRadius: 12, color: "#6b7280",
                pointerEvents: "none",
              }}
            >
              {/* 手机上没法"拖进来"（触摸屏没有 drag & drop），换成"点按钮选文件"的说法 */}
              <div style={{ fontSize: 15 }}>{mobile ? t("app.dropHintMobile") : t("app.dropHint")}</div>
              <div style={{ fontSize: 12 }}>{ready ? t("app.engineReady") : t("app.engineLoading")}</div>
              {error && <div style={{ color: "#b3261e", fontSize: 12 }}>{error}</div>}
            </div>
          )}
        </div>
          {/* P3.2：阅读区尾部（插件席位）。没有插件占位时整条不存在，不占地方 */}
          <SlotView
            slots={runtime.slots}
            name="reader.view.tail"
            className="air-reader-tail"
            onError={onSlotError}
          />
        </div>

        {/* 书库列（P3.7 待办 B）：与阅读列并列，各自切 display */}
        <div className="air-lib-col" style={{ display: isLibrary ? "flex" : "none" }}>
          {/*
            P3.7：书库页主区的插件席位（library.view.top）。
            没有它的时候，"让 AI 在主页加一块东西"是做不到的 —— 模型查插槽目录只会看到
            root 未接线、其余都是侧栏/阅读区，于是它把界面塞进侧栏底栏（实测就是这样）。
          */}
          <SlotView slots={runtime.slots} name="library.view.top" className="air-library-top" onError={onSlotError} />
          {dbReady ? (
            <LibraryPage
              onOpen={(b) => void openBook(b)}
              version={libraryVersion}
              groupId={selectedGroupId}
              groups={groups}
              links={groupLinks}
              onClearGroup={() => setSelectedGroupId(null)}
              onSetBookGroups={(bookId, groupIds) => void handleSetBookGroups(bookId, groupIds)}
              onCreateGroupFor={(name, bookId) => handleCreateGroup(name, bookId)}
            />
          ) : (
            <div className="air-empty">
              <div style={{ fontSize: 14 }}>{t("app.libraryInitializing")}</div>
            </div>
          )}
        </div>

        {!mobile && (
        <div
          className="air-side-drag"
          title={t("app.dragSideWidth")}
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startW = sideWidth;
            const move = (ev: MouseEvent) =>
              setSideWidth(Math.min(760, Math.max(240, startW - (ev.clientX - startX))));
            const up = () => {
              window.removeEventListener("mousemove", move);
              window.removeEventListener("mouseup", up);
            };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
          }}
        />
        )}
        <aside
          className="air-side"
          data-open={mobile ? (sheetOpen ? "true" : "false") : undefined}
          // 手机上宽度交给 CSS（100%），桌面才用拖动出来的宽度
          style={mobile ? undefined : { width: sideWidth, flex: "0 0 auto" }}
        >
          <div className="air-tabs">
            {tabs.map(([id, label]) => (
              <button
                key={id}
                data-active={tab === id}
                onClick={() => {
                  setSideTab(id);
                  if (mobile) setSheetOpen(true);
                }}
              >
                {label}
              </button>
            ))}
            {mobile && (
              <button
                className="air-sheet-close"
                title={t("app.closePanel")}
                aria-label={t("app.closePanel")}
                onClick={closeSheet}
              >
                ✕
              </button>
            )}
          </div>

          {/* 侧栏内容区：固定高度、自己滚动（AI 那一页内部再分「消息区滚动 + 输入框常驻」） */}
          <div className="air-side-body">
          {tab === "ai" && (
            /* P3.7 待办 B：书库页（route=library）用 bookId=null 的**通用对话** ——
               后端早就支持（ai_messages.book_id IS NULL、作用域 adhoc 只放只读工具），
               这里只是把它接到书库分支上。没有 foliate 实例，reader.* 工具会回结构化的
               NOT_AVAILABLE，那是设计内行为。 */
            <ChatPanel
              bookId={isLibrary ? null : currentBookId}
              load={isLibrary ? NO_CONTEXT : ctxLoad}
              registry={toolRegistry}
              skills={skillHost}
              ai={runtime.ai}
              slots={runtime.slots}
              onReload={isLibrary ? undefined : reloadBookContext}
              onJumpToChapter={
                isLibrary
                  ? undefined
                  : (n) => {
                      // 优先用章节清单里的 href（含 #锚点）；没有清单（未装载）才回退到节号
                      const m = ctxLoad.data?.manifest.find((x) => x.n === n);
                      if (m?.href) void handleRef.current?.goTo(m.href);
                      else void handleRef.current?.goToSection(n - 1);
                    }
              }
              context={
                isLibrary
                  ? LIBRARY_CONTEXT
                  : {
                      title: bookName ? title : "",
                      author: currentAuthor,
                      chapter: currentChapter,
                      location,
                      toc: toc.map((t) => String(t.label ?? "")).filter(Boolean),
                    }
              }
            />
          )}

          {tab === "notes" && (
            <>
              <h3>{t("app.allNotes", { n: noteCounts.all })}</h3>
              <div style={{ display: "flex", gap: 4, marginBottom: 6, flexWrap: "wrap" }}>
                {(
                  [
                    ["all", t("app.noteFilterAll", { n: noteCounts.all })],
                    ["highlight", t("app.noteFilterHighlight", { n: noteCounts.highlight })],
                    ["note", t("app.noteFilterNote", { n: noteCounts.note })],
                    ["bookmark", t("app.noteFilterBookmark", { n: noteCounts.bookmark })],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} data-active={noteFilter === k} onClick={() => setNoteFilter(k)}>
                    {label}
                  </button>
                ))}
              </div>
              <input
                className="air-search"
                style={{ width: "100%", marginBottom: 8 }}
                placeholder={t("app.searchNotesPlaceholder")}
                value={noteQuery}
                onChange={(e) => setNoteQuery(e.target.value)}
              />
              {noteGroups.length === 0 && (
                <div style={{ color: "#9aa3b2", lineHeight: 1.7 }}>
                  {t("app.noNotes")}
                  <br />
                  {t("app.noNotesHint")}
                </div>
              )}
              {noteGroups.map((g) => (
                <div key={g.bookId} className="air-note-book">
                  <div className="air-note-bookhead">
                    <span className="air-note-booktitle" title={g.title}>
                      {g.title}
                    </span>
                    <span style={{ color: "#7b8494", fontSize: 11 }}>{t("app.noteItems", { n: g.items.length })}</span>
                  </div>
                  {g.items.map((a) => (
                    <div key={a.id} className="air-anno">
                      <button
                        className="air-anno-main"
                        onClick={() => void openBookAt(g.bookId, a.cfi)}
                        title={t("app.clickToSource", { cfi: a.cfi || "" })}
                      >
                        <span className={"air-anno-kind air-anno-" + a.kind}>
                          {a.kind === "highlight" ? t("app.highlight") : a.kind === "bookmark" ? t("app.bookmark") : t("app.note")}
                        </span>
                        <span className="air-anno-text">{a.note || a.text || t("app.noContent")}</span>
                        <span className="air-anno-time">{relativeTime(a.created_at)}</span>
                      </button>
                      <button className="air-anno-del" onClick={() => void removeAnnotation(a)} title={t("app.delete")}>
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}

          {tab === "groups" && (
            <>
              <h3>{t("app.groupsHeading", { n: groups.length })}</h3>
              <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                <input
                  className="air-search"
                  style={{ minWidth: 0, flex: 1 }}
                  placeholder={t("app.newGroupPlaceholder")}
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    void (async () => {
                      await handleCreateGroup(newGroupName);
                      setNewGroupName("");
                    })();
                  }}
                />
                <button
                  onClick={() =>
                    void (async () => {
                      await handleCreateGroup(newGroupName);
                      setNewGroupName("");
                    })()
                  }
                >
                  {t("app.create")}
                </button>
              </div>

              <button className="air-toc-item" data-active={!selectedGroupId} onClick={() => setSelectedGroupId(null)}>
                {t("app.allBooks")}
              </button>
              {groups.map((g) => (
                <div key={g.id} className="air-group-row">
                  <button
                    className="air-toc-item"
                    data-active={selectedGroupId === g.id}
                    onClick={() => setSelectedGroupId(g.id)}
                    title={t("app.onlyThisGroup")}
                  >
                    {g.name}
                    <span className="air-group-count">{groupCounts[g.id] ?? 0}</span>
                  </button>
                  <button className="air-group-act" onClick={() => void handleRenameGroup(g)} title={t("app.rename")}>
                    ✎
                  </button>
                  <button className="air-group-act air-group-del" onClick={() => void handleDeleteGroup(g)} title={t("app.delete")}>
                    ×
                  </button>
                </div>
              ))}
              <div style={{ fontSize: 11, color: "#7b8494", lineHeight: 1.7, marginTop: 8 }}>
                {groups.length === 0
                  ? t("app.noGroups")
                  : t("app.groupFilterHint")}
                <br />
                {t("app.groupOnShelfHint")}
              </div>
            </>
          )}

          {tab === "search" && (
            <>
          <h3>{t("app.searchHeading")}</h3>
          <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
            <input
              className="air-search"
              style={{ minWidth: 0, flex: 1 }}
              placeholder={t("app.searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runSearch();
              }}
            />
            <button onClick={() => void runSearch()}>{t("app.search")}</button>
          </div>
          {indexStatus && <div style={{ fontSize: 11, color: "#7b8494", marginBottom: 6 }}>{indexStatus}</div>}
          {searchHits.length > 0 && (
            <div style={{ fontSize: 11, color: "#7b8494", marginBottom: 4 }}>{t("app.searchHits", { n: searchHits.length })}</div>
          )}
          {searchHits.map((hit, i) => (
            <button
              key={`${hit.sectionIndex}-${i}`}
              className="air-toc-item"
              onClick={() =>
                hit.chapter?.href
                  ? void handleRef.current?.goTo(hit.chapter.href)
                  : void handleRef.current?.goToSection(hit.sectionIndex)
              }
            >
              <span style={{ color: "#7b8494", fontSize: 11 }}>
                {hit.chapter
                  ? t("app.chapterWithTitle", { n: hit.chapter.n, title: hit.chapter.title })
                  : t("app.sectionNumber", { n: hit.sectionIndex + 1 })}
                {hit.ambiguous ? t("app.ambiguousSection") : ""}
              </span>
              <div style={{ fontSize: 12, lineHeight: 1.5 }}>{hit.snippet}</div>
            </button>
          ))}
            </>
          )}

          {tab === "anno" && (
            <>
          <h3>{t("app.annotationsHeading", { n: annotations.length })}</h3>
          {annotations.length === 0 && <div style={{ color: "#9aa3b2" }}>{t("app.noAnnotationsHint")}</div>}
          {annotations.map((a) => (
            <div key={a.id} className="air-anno">
              <button className="air-anno-main" onClick={() => jumpToAnnotation(a)} title={a.cfi}>
                <span className={`air-anno-kind air-anno-${a.kind}`}>
                  {a.kind === "highlight" ? t("app.highlight") : a.kind === "bookmark" ? t("app.bookmark") : t("app.note")}
                </span>
                <span className="air-anno-text">{a.note || a.text || t("app.noContent")}</span>
              </button>
              <button className="air-anno-del" onClick={() => void removeAnnotation(a)} title={t("app.delete")}>
                ×
              </button>
            </div>
          ))}
            </>
          )}

          {tab === "typo" && (
            <>
          <h3>{t("app.languageHeading")}</h3>
          <div style={{ marginBottom: 10 }}>
            <select
              data-testid="ui-language"
              value={getLangPref()}
              onChange={(e) => {
                const v = e.target.value as LangPref;
                setLangPref(v); // 立刻生效（订阅了语言的组件一起重渲染）
                void setSetting("ui.language", v).catch(() => {});
              }}
            >
              <option value="auto">{t("app.langAuto")}</option>
              <option value="zh">{t("app.langZh")}</option>
              <option value="en">{t("app.langEn")}</option>
            </select>
          </div>

          <h3>{t("app.themeHeading")}</h3>
          <div style={{ marginBottom: 10 }}>
            {THEME_LIST.map((th) => (
              <button
                key={th.id}
                data-active={themeId === th.id}
                onClick={() => setThemeId(th.id)}
                style={{ marginRight: 4 }}
              >
                {t(th.nameKey)}
              </button>
            ))}
          </div>

          <h3>{t("app.typographyHeading")}</h3>
          <div style={{ marginBottom: 8 }}>
            <label>{t("app.fontSize", { n: typo.fontSize })}&nbsp;
              <input type="range" min={12} max={32} value={typo.fontSize}
                onChange={(e) => setTypo((t) => ({ ...t, fontSize: Number(e.target.value) }))} />
            </label>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label>{t("app.lineHeightLabel", { n: typo.lineHeight.toFixed(2) })}&nbsp;
              <input type="range" min={1.2} max={2.4} step={0.05} value={typo.lineHeight}
                onChange={(e) => setTypo((t) => ({ ...t, lineHeight: Number(e.target.value) }))} />
            </label>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label>{t("app.indentLabel", { n: typo.indent })}em&nbsp;
              <input type="range" min={0} max={3} step={0.5} value={typo.indent}
                onChange={(e) => setTypo((t) => ({ ...t, indent: Number(e.target.value) }))} />
            </label>
          </div>
          <div style={{ marginBottom: 8 }}>
            <button data-active={flow === "paginated"} onClick={() => setFlow("paginated")}>{t("app.paginated")}</button>{" "}
            <button data-active={flow === "scrolled"} onClick={() => setFlow("scrolled")}>{t("app.scrolled")}</button>
          </div>
          <div style={{ marginBottom: 8 }}>
            {t("app.fontFamily")}
            {(["serif", "sans", "publisher"] as const).map((f) => (
              <button
                key={f}
                data-active={typo.fontFamily === f}
                onClick={() => setTypo((t) => ({ ...t, fontFamily: f }))}
                style={{ marginLeft: 4 }}
              >
                {f === "serif" ? t("app.fontSerif") : f === "sans" ? t("app.fontSans") : t("app.fontPublisher")}
              </button>
            ))}
          </div>
          <div>
            <Toggle k="justify" label={t("app.toggleJustify")} />
            <Toggle k="autospace" label={t("app.toggleAutospace")} />
            <Toggle k="spacingTrim" label={t("app.toggleSpacingTrim")} />
            <Toggle k="strictLineBreak" label={t("app.toggleStrictLineBreak")} />
            <Toggle k="hangingPunctuation" label={t("app.toggleHangingPunctuation")} />
            <Toggle k="hyphenate" label={t("app.toggleHyphenate")} />
          </div>

            </>
          )}

          {tab === "toc" && (
            <div className="air-toc-tree">
              {toc.length === 0 ? (
                <div style={{ color: "#9aa3b2" }}>{t("app.tocEmpty")}</div>
              ) : (
                renderToc(toc)
              )}
            </div>
          )}

          {tab === "typo" && (
            <>
              <h3 style={{ marginTop: 16 }}>{t("app.diagHeading")}</h3>
              <div style={{ fontSize: 11, color: "#7b8494", marginBottom: 6 }}>
                {t("app.diagSupported", { supported, total: diag.length, ua: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? "" })}
              </div>
              <div className="air-diag">
                {diag.map((d) => (
                  <div key={d.prop + d.value}>
                    <span className={d.ok ? "yes" : "no"}>{d.ok ? "✓" : "✗"}</span> {d.prop}: {d.value}
                  </div>
                ))}
              </div>

              {/* P3.2：设置分区（插件席位）—— 插件管理面板就挂在这里 */}
              <SlotView slots={runtime.slots} name="settings.section" onError={onSlotError} />
            </>
          )}

          </div>

          {/* P3.2：侧栏底部（插件席位） */}
          <SlotView slots={runtime.slots} name="sidebar.footer.action" onError={onSlotError} />
        </aside>
      </div>
      </div>

      {error && (
        <div className="air-errorbar">
          <span>{error}</span>
          <button onClick={() => setError(null)}>{t("app.close")}</button>
        </div>
      )}

      {(dragOver || importStatus) && (
        <div className="air-drop-overlay">
          <div>{importStatus ?? t("app.dropToImport")}</div>
        </div>
      )}

      {selection && (
        <div
          className="air-selbar"
          style={{ left: selection.rect.x, top: Math.max(8, selection.rect.y - 46) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {["yellow", "green", "blue", "pink"].map((c) => (
            <button
              key={c}
              className="air-swatch"
              style={{ background: { yellow: "#ffe58a", green: "#b7e5a8", blue: "#a8d3f0", pink: "#f2b8d0" }[c] }}
              title={t("app.highlight")}
              onClick={() => void addHighlight(c)}
            />
          ))}
          <button onClick={() => void addNote()}>{t("app.note")}</button>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(selection.text);
              clearSelection();
            }}
          >
            {t("app.copy")}
          </button>
          {/* P3.2：选中浮条上的动作（keyed，key = 动作名） */}
          <SlotView
            slots={runtime.slots}
            name="reader.selection.action"
            hostProps={{ selection, clearSelection }}
            onError={onSlotError}
          />
        </div>
      )}
    </div>
  );
}
