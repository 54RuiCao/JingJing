import { useEffect, useRef } from "react";

/**
 * foliate-js 的薄适配层。
 *
 * 架构纪律（见 内部设计笔记 §6）：
 *   - 这个文件只负责「挂载引擎、转发命令、抛出事件」，不承载任何业务状态；
 *   - 进度、批注、选区等状态放在引擎之外的 store 里；
 *   - 目标是把这一层控制在 500 行以内，避免重蹈 另一个同类阅读器 137KB 组件的覆辙。
 *
 * 两个必须遵守的引擎约束（P0 实测得出）：
 *   1. 打开一本书必须走 open() → setStyles() → renderer.next()，否则正文空白；
 *   2. 换书时要先 close() 再移除旧元素，否则旧渲染器异步渲染会抛
 *      "Cannot read properties of null (reading 'documentElement')"。
 */

export type RelocateDetail = {
  fraction: number;
  location: { current: number; next: number; total: number };
  tocItem?: { label?: string; href?: string };
  pageItem?: { label?: string };
  section?: { current: number; total: number };
};

export type TocItem = { label?: string; href?: string; subitems?: TocItem[] };

export type BookMetadata = {
  title?: string | Record<string, string>;
  author?: unknown;
  language?: unknown;
};

export type FoliateHandle = {
  open(source: File | Blob | string): Promise<void>;
  goTo(target: string | number): Promise<void>;
  goToFraction(fraction: number): Promise<void>;
  prev(): Promise<void>;
  next(): Promise<void>;
  setStyles(css: string): void;
  setFlow(flow: "paginated" | "scrolled"): void;
  getTOC(): TocItem[];
  getMetadata(): BookMetadata | undefined;
  getCover(): Promise<Blob | undefined>;
  getFractions(): number[];
  getLocation(): unknown;
  getElements(): { view: any; renderer: any };
  /** 当前选区（含 CFI 与相对窗口的矩形，用于定位浮动工具条） */
  getSelection(): SelectionInfo | null;
  /** 把批注交给引擎渲染（value 为 CFI） */
  addAnnotation(a: BookAnnotation): void;
  /** 跳到某个章节（全文检索结果用） */
  goToSection(index: number): Promise<void>;
  /** 移除引擎里的批注渲染 */
  deleteAnnotation(a: BookAnnotation): void;
  clearSelection(): void;
};

/** 交给引擎渲染的批注形状（与 foliate-js 的 overlayer 约定一致） */
export type BookAnnotation = { value: string; color?: string; note?: string };

export type SelectionInfo = {
  index: number;
  cfi: string;
  text: string;
  /** 相对应用窗口的坐标 */
  rect: { x: number; y: number; width: number; height: number };
};

type Props = {
  /** 当前排版 CSS，open 时会自动应用 */
  css: string;
  /** 当前翻页模式，open 时会自动应用 */
  flow: "paginated" | "scrolled";
  onRelocate?: (detail: RelocateDetail) => void;
  onReady?: (handle: FoliateHandle) => void;
  onError?: (error: unknown) => void;
  /** 打开书籍时读取上次阅读位置（P0-6） */
  getSavedLocation?: () => unknown;
  /** 恢复流程结束（此前的 relocate 不应回写存储） */
  onRestored?: () => void;
  /** 引擎渲染某一章节时，向它索要该章节需要绘制的批注 */
  getAnnotations?: (sectionIndex: number) => BookAnnotation[];
  /** 用户点击了书里的某条批注 */
  onAnnotationActivate?: (a: BookAnnotation) => void;
};

/*
 * 关于「相邻章节预加载」的实测结论（P1，2026-09）：
 *
 * 曾按假设实现过"提前 sections[i+1].load() 暖缓存"，结果实测**无效甚至有害**：
 *   - 章节 load() 冷启动仅 1.8ms、热调用 0ms，而整次跨章翻页约 18–22ms
 *     → 预加载最多只能省掉那 1.8ms，用户完全无感；
 *   - 早期版本在每次 relocate（含同章翻页）都触发，导致跨章翻页从 23ms 恶化到 37ms。
 * 因此已移除。真正的开销在 #createView()（新建 iframe）+ view.load()（文档加载与布局）+
 * 首次 columnize，属于引擎的"视图重建"成本。要真正消除它需要**视图池/多视图预渲染**
 * （另一个同类阅读器 正是这么改的），属于后续工作，不是"预加载"能解决的。
 *
 * 与之相比，把 paginator 的 turn-lock 从上游硬编码的 100ms 调小，收益大得多：
 * 翻页从约 119ms 降到约 22ms。
 */

/** 翻页锁：上游硬编码 100ms。实测真实渲染只要 2–3ms（跨章约 20ms），调到 20ms 兼顾防连击与手感。 */
const TURN_LOCK_MS = "20";

export function FoliateView({
  css,
  flow,
  onRelocate,
  onReady,
  onError,
  getSavedLocation,
  onRestored,
  getAnnotations,
  onAnnotationActivate,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<any>(null);
  const cssRef = useRef(css);
  const flowRef = useRef(flow);
  cssRef.current = css;
  flowRef.current = flow;

  const relocateRef = useRef(onRelocate);
  relocateRef.current = onRelocate;
  const savedLocationRef = useRef(getSavedLocation);
  savedLocationRef.current = getSavedLocation;
  const restoredRef = useRef(onRestored);
  restoredRef.current = onRestored;
  const getAnnotationsRef = useRef(getAnnotations);
  getAnnotationsRef.current = getAnnotations;
  const onAnnotationActivateRef = useRef(onAnnotationActivate);
  onAnnotationActivateRef.current = onAnnotationActivate;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;

    const makeView = () => {
      const view = document.createElement("foliate-view") as any;
      view.addEventListener("relocate", (e: CustomEvent<RelocateDetail>) => {
        relocateRef.current?.(e.detail);
      });

      // 引擎渲染出某章节时，把属于该章节的批注交给它绘制
      view.addEventListener("create-overlay", (e: any) => {
        const index = e.detail?.index;
        if (typeof index !== "number") return;
        for (const a of getAnnotationsRef.current?.(index) ?? []) {
          try {
            view.addAnnotation(a);
          } catch {
            /* CFI 不匹配时引擎会抛错，忽略即可 */
          }
        }
      });

      // 真正决定"怎么画"
      view.addEventListener("draw-annotation", (e: any) => {
        const { draw, annotation } = e.detail ?? {};
        if (typeof draw !== "function") return;
        void import("foliate-js/overlayer.js")
          .then((m: any) => draw(m.Overlayer.highlight, { color: annotation?.color ?? "yellow" }))
          .catch(() => draw());
      });

      view.addEventListener("show-annotation", (e: any) => {
        const a = e.detail?.annotation ?? e.detail;
        if (a) onAnnotationActivateRef.current?.(a);
      });

      return view;
    };

    void import("foliate-js/view.js")
      .then(() => {
        if (disposed) return;
        const view = makeView();
        viewRef.current = view;
        host.appendChild(view);

        const handle: FoliateHandle = {
          async open(source) {
            // 先优雅关闭旧的渲染器，再移除，避免异步渲染访问已卸载的 document
            const old = host.querySelector("foliate-view") as any;
            if (old) {
              try {
                old.close?.();
              } catch {
                /* 忽略关闭异常 */
              }
              old.remove();
            }
            const fresh = makeView();
            viewRef.current = fresh;
            host.appendChild(fresh);
            await fresh.open(source);
            try {
              fresh.renderer?.setAttribute?.("flow", flowRef.current);
              fresh.renderer?.setAttribute?.("turn-lock", TURN_LOCK_MS);
              fresh.renderer?.setStyles?.(cssRef.current);
              // 先渲染首页，保证渲染器就绪
              await fresh.renderer?.next?.();
              // P0-6：再用 CFI 跳回上次位置（比 init() 可靠：init 是异步渲染，
              // 紧跟 getContents() 判断会误判为空并多翻一页，实测会导致位置后跳一章）
              const saved = savedLocationRef.current?.() as { cfi?: string } | null;
              if (saved?.cfi) {
                try {
                  await fresh.goTo(saved.cfi);
                } catch {
                  /* 恢复失败就停在首页 */
                }
              }
              fresh.renderer?.setAttribute?.("turn-lock", TURN_LOCK_MS);
              restoredRef.current?.();
            } catch (err) {
              onError?.(err);
            }
          },
          goTo: (t) => viewRef.current.goTo(t),
          goToFraction: (f) => viewRef.current.goToFraction(f),
          prev: () => viewRef.current.goLeft(),
          next: () => viewRef.current.goRight(),
          setStyles: (next: string) => viewRef.current?.renderer?.setStyles?.(next),
          setFlow: (f) => viewRef.current?.renderer?.setAttribute?.("flow", f),
          getTOC: () => viewRef.current?.book?.toc ?? [],
          getMetadata: () => viewRef.current?.book?.metadata,
          getCover: () => Promise.resolve(viewRef.current?.book?.getCover?.()),
          getFractions: () => viewRef.current?.getSectionFractions?.() ?? [],
          getLocation: () => viewRef.current?.lastLocation ?? null,
          getElements: () => ({ view: viewRef.current, renderer: viewRef.current?.renderer }),
          getSelection() {
            const v = viewRef.current;
            const contents: any[] = v?.renderer?.getContents?.() ?? [];
            for (const c of contents) {
              const sel = c?.doc?.getSelection?.();
              if (!sel || sel.isCollapsed || sel.rangeCount === 0) continue;
              const range = sel.getRangeAt(0);
              const text = sel.toString().trim();
              if (!text) continue;
              let cfi = "";
              try {
                cfi = v.getCFI(c.index, range);
              } catch {
                cfi = "";
              }
              const r = range.getBoundingClientRect();
              const frame = c.doc.defaultView?.frameElement?.getBoundingClientRect?.();
              return {
                index: c.index,
                cfi,
                text,
                rect: {
                  x: r.left + (frame?.left ?? 0),
                  y: r.top + (frame?.top ?? 0),
                  width: r.width,
                  height: r.height,
                },
              };
            }
            return null;
          },
          goToSection: (index: number) => viewRef.current?.renderer?.goTo?.({ index }) ?? Promise.resolve(),
          addAnnotation: (a) => {
            try {
              viewRef.current?.addAnnotation?.(a);
            } catch {
              /* 忽略无法定位的批注 */
            }
          },
          deleteAnnotation: (a) => {
            try {
              viewRef.current?.deleteAnnotation?.(a);
            } catch {
              /* 忽略 */
            }
          },
          clearSelection: () => {
            const v = viewRef.current;
            const contents: any[] = v?.renderer?.getContents?.() ?? [];
            for (const c of contents) c?.doc?.getSelection?.()?.removeAllRanges?.();
          },
        };
        onReady?.(handle);
      })
      .catch((err) => onError?.(err));

    return () => {
      disposed = true;
      const old = host.querySelector("foliate-view") as any;
      try {
        old?.close?.();
      } catch {
        /* 忽略 */
      }
      host.querySelectorAll("foliate-view").forEach((n) => n.remove());
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} style={{ width: "100%", height: "100%" }} />;
}
