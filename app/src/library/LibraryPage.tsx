import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { importBookFromFile, importBookFromPath } from "./importBook";
import { isMobile } from "../platform";
import { listBooks, deleteBook, loadProgress, type Book } from "../store/db";
import { filterBooks, groupsOfBook, type BookGroup, type BookGroupLink, type SortKey } from "./manage";
import { useT } from "../i18n/react";
import { GearIconReal, ImportIcon, SortIcon } from "../ui/mobileIcons";

type Props = {
  onOpen: (book: Book) => void;
  /** 导入完成后回调，用于让外层刷新 */
  onLibraryChanged?: () => void;
  /** 外部（如拖拽导入）触发的刷新计数 */
  version?: number;
  /** 当前书组筛选（null = 全部）；书组本身在侧栏的「书组」页里管理 */
  groupId?: string | null;
  groups?: BookGroup[];
  links?: BookGroupLink[];
  onClearGroup?: () => void;
  /** 卡片上的归类勾选：整份列表替换 */
  onSetBookGroups?: (bookId: string, groupIds: string[]) => void;
  /** 在卡片上直接新建一个书组并把它加进去 */
  onCreateGroupFor?: (name: string, bookId: string) => Promise<void> | void;
  /**
   * P7 手机端：同一个书库数据、两套版式（照参考设计 Home / Library 两个页签的差别）
   *   home    = 首页：继续阅读卡片 + 接下来（横向书架），没有排序控件
   *   library = 书库：封面网格 + 计数
   * 桌面不传 = 老样子。
   */
  view?: "home" | "library";
  /** 底栏的搜索圆钮点过之后，把焦点送进搜索框 */
  autoFocusSearch?: boolean;
  onSearchFocused?: () => void;
  /** 手机端头部右上角的设置圆钮（打开侧栏的「设置与插件」） */
  onOpenSettings?: () => void;
  /** 今日阅读秒数（首页底部那张"阅读目标"卡用） */
  todaySeconds?: number;
};

const FORMAT_LABEL: Record<string, string> = {
  epub: "EPUB",
  txt: "TXT",
  mobi: "MOBI",
  azw3: "AZW3",
  azw: "AZW",
  fb2: "FB2",
  cbz: "CBZ",
};

export function LibraryPage({
  onOpen,
  onLibraryChanged,
  version = 0,
  groupId = null,
  groups = [],
  links = [],
  onClearGroup,
  onSetBookGroups,
  onCreateGroupFor,
  view = "library",
  autoFocusSearch = false,
  onSearchFocused,
  onOpenSettings,
  todaySeconds: todaySecondsProp,
}: Props) {
  const t = useT();
  const [books, setBooks] = useState<Book[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  /** 正在展开「归类」气泡的那本书 */
  const [tagging, setTagging] = useState<string | null>(null);
  /** P7：正在展开「•••」菜单的那本书（参考里的 ••• 就在封面下方） */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** P14：排序菜单（原来是一排分段控件，占了一整行） */
  const [sortMenu, setSortMenu] = useState(false);
  const [newGroup, setNewGroup] = useState("");

  const refresh = useCallback(async () => {
    try {
      setBooks(await listBooks());
    } catch (e) {
      setError(t("lib.readFailed", { error: String(e) }));
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  // 筛选/排序口径在 library/manage.ts 里（纯函数，有契约测试）：搜索 + 书组 + 排序
  const shown = useMemo(
    () => filterBooks(books, { query, groupId, links, sort }),
    [books, query, groupId, links, sort],
  );
  const activeGroup = groupId ? groups.find((g) => g.id === groupId) ?? null : null;

  /**
   * P7 首页（参考 Home 页的 UI 逻辑）：
   *   继续阅读 = 最近打开的那一本（listBooks 就是按 COALESCE(opened_at, added_at) 排的），
   *   接下来 = 其余的书，横向书架。
   * 进度只有"这一本"需要，所以单独查一次，不拖累列表。
   */
  const continueBook = books[0] ?? null;
  const [continuePct, setContinuePct] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    if (!continueBook) {
      setContinuePct(null);
      return;
    }
    void loadProgress(continueBook.id)
      .then((p) => {
        if (alive) setContinuePct(p?.fraction ?? 0);
      })
      .catch(() => {
        if (alive) setContinuePct(null);
      });
    return () => {
      alive = false;
    };
    // continueBook 是每次 render 现取的对象，用 id 当依赖才不会被对象身份反复触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [continueBook?.id, version]);
  /**
   * P14：首页三栏需要"这本书读到哪了"。书不多（十几本），一次性把进度读进来最省事，
   * 也免得每个书架各查一遍。
   */
  const [progress, setProgress] = useState<Record<string, number>>({});
  useEffect(() => {
    let alive = true;
    void (async () => {
      const rows = await Promise.all(
        books.map(async (b) => {
          try {
            const p = await loadProgress(b.id);
            return [b.id, p?.fraction ?? 0] as const;
          } catch {
            return [b.id, 0] as const;
          }
        }),
      );
      if (alive) setProgress(Object.fromEntries(rows));
    })();
    return () => {
      alive = false;
    };
  }, [books, version]);

  /** 欲读清单：一次都没打开过的（没有进度记录） */
  const wantToRead = useMemo(
    () => books.filter((b) => !(b.opened_at ?? null)).slice(0, 12),
    [books],
  );
  /** 已读完：进度 ≥ 99% */
  const finished = useMemo(
    () => books.filter((b) => (progress[b.id] ?? 0) >= 0.99).slice(0, 12),
    [books, progress],
  );

  /** 阅读目标：今日阅读秒数（由 App 从阅读活动服务里取，取不到就当 0） */
  const todaySeconds = todaySecondsProp ?? 0;
  /** 每日目标：产品里还没有这个设置，先固定 30 分钟（将来进设置表） */
  const GOAL_MINUTES = 30;
  const goalSeconds = GOAL_MINUTES * 60;
  const goalRatio = goalSeconds ? Math.min(1, todaySeconds / goalSeconds) : 0;
  const goalTime = Math.floor(todaySeconds / 60) + ":" + String(Math.floor(todaySeconds % 60)).padStart(2, "0");

  const importOne = useCallback(
    async (srcPath: string) => {
      setError(null);
      try {
        setBusy(t("lib.importing", { name: srcPath.split(/[\\/]/).pop() ?? "" }));
        await importBookFromPath(srcPath);
      } catch (e) {
        setError(t("lib.importFailed", { error: String(e) }));
      } finally {
        setBusy(null);
        await refresh();
        onLibraryChanged?.();
      }
    },
    [refresh, onLibraryChanged, t],
  );

  /** 导入一个 File（移动端路径：字节走 IPC，不依赖 content:// 能被 Rust 读到） */
  const importFileOne = useCallback(
    async (file: File) => {
      setError(null);
      try {
        setBusy(t("lib.importing", { name: file.name }));
        await importBookFromFile(file);
      } catch (e) {
        setError(t("lib.importFailed", { error: String(e) }));
      } finally {
        setBusy(null);
        await refresh();
        onLibraryChanged?.();
      }
    },
    [refresh, onLibraryChanged, t],
  );

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** P7：底栏搜索圆钮把焦点送进来 */
  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!autoFocusSearch) return;
    searchRef.current?.focus();
    onSearchFocused?.();
  }, [autoFocusSearch, onSearchFocused]);

  const pickAndImport = useCallback(async () => {
    // P4：手机上不用 dialog 插件 —— Android 的文件选择器返回 content:// URI，
    // Rust 侧读不了（要走 ContentResolver）。WebView 里的 <input type="file">
    // 直接给 File 对象，读成字节交给 import_book_bytes，两条路落的盘完全一样。
    if (isMobile()) {
      fileInputRef.current?.click();
      return;
    }
    const picked = await openDialog({
      multiple: true,
      filters: [
        { name: t("lib.ebookFilter"), extensions: ["epub", "txt", "pdf", "mobi", "azw3", "azw", "fb2", "cbz"] },
      ],
    });
    if (!picked) return;
    const list = Array.isArray(picked) ? picked : [picked];
    for (const p of list) await importOne(String(p));
  }, [importOne, t]);

  const remove = useCallback(
    async (book: Book) => {
      if (!confirm(t("lib.removeConfirm", { title: book.title }))) return;
      setBusy(t("lib.deleting"));
      await deleteBook(book.id);
      setBusy(null);
      await refresh();
      onLibraryChanged?.();
    },
    [refresh, onLibraryChanged, t],
  );

  return (
    <div className="air-library">
      <div className="air-bar">
        <button onClick={() => void pickAndImport()}>{t("lib.importBooks")}</button>
        {/* 移动端的文件选择：常驻在 DOM 里、display 隐藏，点按钮时 .click()（见 pickAndImport） */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".epub,.txt,.mobi,.azw3,.azw,.fb2,.cbz,application/epub+zip"
          style={{ display: "none" }}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = ""; // 同一个文件能再选一次
            void (async () => {
              for (const f of files) await importFileOne(f);
            })();
          }}
        />
        <input
          className="air-search"
          placeholder={t("lib.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="air-spacer" />
        {activeGroup && (
          <button
            className="air-chip"
            title={t("lib.clearGroupFilter")}
            onClick={() => {
              setTagging(null);
              onClearGroup?.();
            }}
          >
            {t("lib.groupFilter", { name: activeGroup.name })}
          </button>
        )}
        <span style={{ color: "#7b8494" }}>
          {activeGroup
            ? t("lib.shownCount", { shown: shown.length, total: books.length })
            : t("lib.totalCount", { n: books.length })}
        </span>
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="recent">{t("lib.sortRecent")}</option>
          <option value="added">{t("lib.sortAdded")}</option>
          <option value="title">{t("lib.sortTitle")}</option>
        </select>
      </div>

      {/* P6 手机版头部：大标题 + 计数 + 分段控件 + 搜索/导入。
          桌面继续用上面那条 .air-bar（同一份 state，两套控件；CSS 按 data-mobile 二选一显示）。 */}
      <div className="air-lib-head">
        <div className="air-lib-headrow">
          <h1 className="air-lib-title">{view === "home" ? t("app.tabHome") : t("app.tabLibrary")}</h1>
          {/* P14（照参考）：搜索框从页头拿掉；导入与设置收进右上角这排圆钮；
              排序改成一个按钮打开的菜单（参考书库页右上角那两个圆钮）。 */}
          <div className="air-lib-tools">
            {view === "library" && (
              <button
                className="air-lib-gear"
                data-active={sortMenu}
                title={t("lib.sortHeading")}
                aria-label={t("lib.sortHeading")}
                onClick={() => setSortMenu((v) => !v)}
              >
                <SortIcon />
              </button>
            )}
            <button className="air-lib-gear" title={t("lib.importBooks")} aria-label={t("lib.importBooks")} onClick={() => void pickAndImport()}>
              <ImportIcon />
            </button>
            {onOpenSettings && (
              <button className="air-lib-gear" title={t("app.tabSettings")} aria-label={t("app.tabSettings")} onClick={onOpenSettings}>
                <GearIconReal />
              </button>
            )}
          </div>
        </div>
        {sortMenu && (
          <div className="air-sort-menu">
            <div className="air-sort-head">{t("lib.sortHeading")}</div>
            {(["recent", "added", "title"] as const).map((k) => (
              <button
                key={k}
                data-active={sort === k}
                onClick={() => {
                  setSort(k);
                  setSortMenu(false);
                }}
              >
                {t(k === "recent" ? "lib.sortRecent" : k === "added" ? "lib.sortAdded" : "lib.sortTitle")}
              </button>
            ))}
          </div>
        )}
        {activeGroup && (
          <button
            className="air-chip"
            title={t("lib.clearGroupFilter")}
            onClick={() => {
              setTagging(null);
              onClearGroup?.();
            }}
          >
            {t("lib.groupFilter", { name: activeGroup.name })}
          </button>
        )}
      </div>

      {busy && <div className="air-toast">{busy}</div>}
      {error && <div className="air-toast air-toast-error">{error}</div>}

      {books.length === 0 && !busy ? (
        <div className="air-empty">
          <div style={{ fontSize: 16 }}>{t("lib.empty")}</div>
          <div style={{ fontSize: 13, color: "#7b8494", marginTop: 8 }}>
            {t("lib.emptyHint")}
          </div>
        </div>
      ) : view === "home" ? (
        /* ---------- P7 首页（照参考 Home 页的 UI 逻辑）----------
           继续阅读：一张通栏深色卡片（左侧小封面 + 书名/作者/进度 + 右侧 •••）
           接下来：横向书架，封面大、下面一行书名
           底部居中一行"共 N 本"（参考里的 "2 books, 1 series"） */
        <div className="air-home">
          {continueBook && (
            <section className="air-home-section" data-tone="continue">
              <div className="air-home-sechead">{t("lib.continueReading")}</div>
              <div className="air-continue" onClick={() => onOpen(continueBook)} role="button">
                <div className="air-continue-cover">
                  {continueBook.cover_path ? (
                    <img src={continueBook.cover_path} alt="" />
                  ) : (
                    <span className="air-cover-fallback">{continueBook.title.slice(0, 6)}</span>
                  )}
                </div>
                <div className="air-continue-meta">
                  <div className="air-continue-title">{continueBook.title || t("lib.untitled")}</div>
                  <div className="air-continue-sub">{continueBook.author || t("lib.unknownAuthor")}</div>
                  <div className="air-continue-sub">
                    {t("lib.readingKind")} · {Math.round((continuePct ?? 0) * 100)}%
                  </div>
                </div>
                <span className="air-continue-more" aria-hidden>
                  •••
                </span>
              </div>
            </section>
          )}

          {wantToRead.length > 0 && (
            <section className="air-home-section" data-tone="want">
              <div className="air-home-sechead">
                {t("lib.wantToRead")}
                <span className="air-home-chev" aria-hidden>
                  ›
                </span>
              </div>
              <div className="air-home-sub">{t("lib.upNextHint")}</div>
              <div className="air-shelf">
                {wantToRead.map((b) => (
                  <div key={b.id} className="air-shelf-item" onClick={() => onOpen(b)} title={b.original_name}>
                    <div className="air-cover">
                      {b.cover_path ? (
                        <img src={b.cover_path} alt="" />
                      ) : (
                        <span className="air-cover-fallback">{b.title.slice(0, 8)}</span>
                      )}
                    </div>
                    <span className="air-shelf-badge">{(FORMAT_LABEL[b.format] ?? b.format).toUpperCase()}</span>
                    <div className="air-shelf-title">{b.title || t("lib.untitled")}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {finished.length > 0 && (
            <section className="air-home-section" data-tone="done">
              <div className="air-home-sechead">
                {t("lib.finished")}
                <span className="air-home-chev" aria-hidden>
                  ›
                </span>
              </div>
              <div className="air-shelf">
                {finished.map((b) => (
                  <div key={b.id} className="air-shelf-item" onClick={() => onOpen(b)} title={b.original_name}>
                    <div className="air-cover">
                      {b.cover_path ? (
                        <img src={b.cover_path} alt="" />
                      ) : (
                        <span className="air-cover-fallback">{b.title.slice(0, 8)}</span>
                      )}
                    </div>
                    <span className="air-shelf-badge">{(FORMAT_LABEL[b.format] ?? b.format).toUpperCase()}</span>
                    <div className="air-shelf-title">{b.title || t("lib.untitled")}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 阅读目标（照 iOS 那张 Reading Goals）：弧形进度 + 今日时长 + 目标 + 继续阅读 */}
          <section className="air-home-section air-goal">
            <div className="air-goal-title">{t("lib.goalTitle")}</div>
            <div className="air-goal-arc">
              <svg viewBox="0 0 200 108" aria-hidden>
                <path d="M12 100 A 88 88 0 0 1 188 100" fill="none" stroke="var(--m-grouped)" strokeWidth="9" strokeLinecap="round" />
                <path
                  d="M12 100 A 88 88 0 0 1 188 100"
                  fill="none"
                  stroke="var(--m-tint)"
                  strokeWidth="9"
                  strokeLinecap="round"
                  strokeDasharray={String(Math.max(0, Math.min(1, goalRatio)) * 276) + " 276"}
                />
              </svg>
              <div className="air-goal-inside">
                <div className="air-goal-label">{t("lib.goalToday")}</div>
                <div className="air-goal-time">{goalTime}</div>
                <div className="air-goal-sub">{t("lib.goalOf", { n: GOAL_MINUTES })}</div>
              </div>
            </div>
            {continueBook && (
              <button className="air-goal-btn" onClick={() => onOpen(continueBook)}>
                <span>{t("lib.continueReading")}</span>
                <span className="air-goal-btn-sub">{continueBook.title}</span>
              </button>
            )}
          </section>

          <div className="air-home-foot">
            {t("lib.totalCount", { n: books.length })}
            {groups.length ? t("lib.collectionCount", { n: groups.length }) : ""}
          </div>
        </div>
      ) : (
        <div className="air-grid">
          {shown.map((b) => (
            <div key={b.id} className="air-card" onClick={() => onOpen(b)} title={b.original_name}>
              <div className="air-cover">
                {b.cover_path ? (
                  <img src={b.cover_path} alt="" />
                ) : (
                  <span className="air-cover-fallback">{b.title.slice(0, 12)}</span>
                )}
                <span className="air-badge">{(FORMAT_LABEL[b.format] ?? b.format).toUpperCase()}</span>
              </div>
              {/*
                P7（照参考书库页的 UI 逻辑）：封面上**不再压操作按钮** ——
                参考里是"封面 → 下面一行：左边一个格式小胶囊、右边一个 •••"，
                归类/移除都收进 ••• 里。这样封面本身是干净的主视觉。
              */}
              {/* 桌面：还是老样子（封面右上角的 🏷 归类按钮，悬停显形）；手机上它被 CSS 隐藏，
                  改用下面那一行"格式胶囊 + •••"（参考书库页的做法） */}
              <button
                className="air-card-tag"
                title={t("lib.tagToGroup")}
                data-active={groupsOfBook(links, b.id).length > 0}
                onClick={(e) => {
                  e.stopPropagation();
                  setNewGroup("");
                  setTagging((cur) => (cur === b.id ? null : b.id));
                }}
              >
                🏷{groupsOfBook(links, b.id).length || ""}
              </button>
              <div className="air-card-meta">
                <span className="air-card-pill">{(FORMAT_LABEL[b.format] ?? b.format).toUpperCase()}</span>
                <button
                  className="air-card-more"
                  title={t("lib.moreActions")}
                  aria-label={t("lib.moreActions")}
                  data-active={menuFor === b.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setNewGroup("");
                    setTagging(null);
                    setMenuFor((cur) => (cur === b.id ? null : b.id));
                  }}
                >
                  •••
                </button>
              </div>
              {menuFor === b.id && (
                <div className="air-card-menu" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => {
                      setMenuFor(null);
                      setNewGroup("");
                      setTagging(b.id);
                    }}
                  >
                    {t("lib.tagToGroup")}
                    {groupsOfBook(links, b.id).length ? " · " + groupsOfBook(links, b.id).length : ""}
                  </button>
                  <button
                    className="air-card-menu-del"
                    onClick={() => {
                      setMenuFor(null);
                      void remove(b);
                    }}
                  >
                    {t("lib.remove")}
                  </button>
                </div>
              )}
              <div className="air-card-title">{b.title || t("lib.untitled")}</div>
              <div className="air-card-sub">
                {b.author || t("lib.unknownAuthor")}
                {b.chapters ? t("lib.chapterCount", { n: b.chapters }) : ""}
              </div>
              {tagging === b.id && (
                <div className="air-tag-pop" onClick={(e) => e.stopPropagation()}>
                  <div className="air-tag-head">{t("lib.putIntoGroup")}</div>
                  {groups.length === 0 && (
                    <div style={{ fontSize: 11, color: "#7b8494", marginBottom: 6 }}>
                      {t("lib.noGroupsYet")}
                    </div>
                  )}
                  {groups.map((g) => {
                    const on = groupsOfBook(links, b.id).includes(g.id);
                    return (
                      <label key={g.id} className="air-tag-row">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...groupsOfBook(links, b.id), g.id]
                              : groupsOfBook(links, b.id).filter((x) => x !== g.id);
                            onSetBookGroups?.(b.id, next);
                          }}
                        />
                        <span>{g.name}</span>
                      </label>
                    );
                  })}
                  <div className="air-tag-new">
                    <input
                      className="air-search"
                      style={{ minWidth: 0, flex: 1 }}
                      placeholder={t("lib.newGroupPlaceholder")}
                      value={newGroup}
                      onChange={(e) => setNewGroup(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        e.preventDefault();
                        void (async () => {
                          await onCreateGroupFor?.(newGroup, b.id);
                          setNewGroup("");
                        })();
                      }}
                    />
                    <button
                      onClick={() =>
                        void (async () => {
                          await onCreateGroupFor?.(newGroup, b.id);
                          setNewGroup("");
                        })()
                      }
                    >
                      {t("lib.createGroup")}
                    </button>
                  </div>
                </div>
              )}
              <button
                className="air-card-del"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(b);
                }}
              >
                {t("lib.remove")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
