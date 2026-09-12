import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { importBookFromFile, importBookFromPath } from "./importBook";
import { isMobile } from "../platform";
import { listBooks, deleteBook, type Book } from "../store/db";
import { filterBooks, groupsOfBook, type BookGroup, type BookGroupLink, type SortKey } from "./manage";
import { useT } from "../i18n/react";

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
}: Props) {
  const t = useT();
  const [books, setBooks] = useState<Book[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  /** 正在展开「归类」气泡的那本书 */
  const [tagging, setTagging] = useState<string | null>(null);
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

      {busy && <div className="air-toast">{busy}</div>}
      {error && <div className="air-toast air-toast-error">{error}</div>}

      {books.length === 0 && !busy ? (
        <div className="air-empty">
          <div style={{ fontSize: 16 }}>{t("lib.empty")}</div>
          <div style={{ fontSize: 13, color: "#7b8494", marginTop: 8 }}>
            {t("lib.emptyHint")}
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
              <div className="air-card-title">{b.title || t("lib.untitled")}</div>
              <div className="air-card-sub">
                {b.author || t("lib.unknownAuthor")}
                {b.chapters ? t("lib.chapterCount", { n: b.chapters }) : ""}
              </div>
              {/* P3.9：归类。书组在侧栏「书组」页里管理，这里只做"这本书属于哪些组" */}
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
