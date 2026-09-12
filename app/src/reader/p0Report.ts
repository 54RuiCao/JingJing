import { invoke } from "@tauri-apps/api/core";
import type { FoliateHandle } from "./FoliateView";

/**
 * P0 自检报告：用可测量的方式回答「渲染成功了吗」「中文排版属性真的生效了吗」，
 * 不依赖人眼看截图。
 */

type Measure = {
  name: string;
  withFeature: number;
  withoutFeature: number;
  deltaPx: number;
  effective: boolean;
};

/** 在给定文档里测量某个 CSS 属性是否真的改变了排版 */
function measureFeature(
  doc: Document,
  feature: string,
  sample: string,
  css: (on: boolean) => string,
): Measure {
  const host = doc.createElement("div");
  host.style.cssText =
    "position:absolute;left:-9999px;top:0;white-space:nowrap;" +
    "font-size:20px;font-family:'Source Han Serif SC','Noto Serif CJK SC','SimSun',serif;";
  const probe = (on: boolean) => {
    const span = doc.createElement("span");
    span.setAttribute("style", css(on));
    span.textContent = sample;
    host.appendChild(span);
    const w = span.getBoundingClientRect().width;
    host.removeChild(span);
    return w;
  };
  doc.body.appendChild(host);
  const withoutFeature = probe(false);
  const withFeature = probe(true);
  doc.body.removeChild(host);
  const deltaPx = withFeature - withoutFeature;
  return {
    name: feature,
    withFeature: Math.round(withFeature * 100) / 100,
    withoutFeature: Math.round(withoutFeature * 100) / 100,
    deltaPx: Math.round(deltaPx * 100) / 100,
    effective: Math.abs(deltaPx) > 0.05,
  };
}

const CSS_PROBES: [string, string][] = [
  ["text-autospace", "normal"],
  ["text-spacing-trim", "space-first"],
  ["text-spacing-trim", "trim-start"],
  ["line-break", "strict"],
  ["hanging-punctuation", "allow-end"],
  ["text-justify", "inter-ideograph"],
  ["text-align-last", "justify"],
  ["writing-mode", "vertical-rl"],
  ["text-orientation", "upright"],
  ["ruby-align", "center"],
  ["font-variant-east-asian", "proportional-width"],
  ["text-emphasis", "dot"],
];

export type P0Report = Record<string, unknown>;

export function collectReport(handle: FoliateHandle, extra: Record<string, unknown>): P0Report {
  const report: P0Report = {
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
    chromeVersion: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? null,
    cssSupports: Object.fromEntries(CSS_PROBES.map(([p, v]) => [`${p}: ${v}`, CSS.supports(p, v)])),
    ...extra,
  };

  const { view, renderer } = handle.getElements();
  const book = view?.book;
  report.book = {
    title: book?.metadata?.title ?? null,
    language: book?.metadata?.language ?? null,
    tocEntries: Array.isArray(book?.toc) ? book.toc.length : null,
    sections: book?.sections?.length ?? null,
  };

  const contents: any[] = (() => {
    try {
      return renderer?.getContents?.() ?? [];
    } catch {
      return [];
    }
  })();
  report.renderer = {
    contentsCount: contents.length,
    flow: renderer?.getAttribute?.("flow") ?? null,
  };

  const doc: Document | undefined = contents[0]?.doc;
  if (doc) {
    const paras = Array.from(doc.querySelectorAll("p"));
    report.firstSection = {
      paragraphs: paras.length,
      textLength: (doc.body?.textContent ?? "").length,
      firstParagraph: (paras[0]?.textContent ?? "").slice(0, 60),
      htmlLang: doc.documentElement.getAttribute("lang"),
      bodyFontSize: doc.defaultView?.getComputedStyle(doc.body).fontSize ?? null,
      paragraphFontFamily: paras[0] ? doc.defaultView?.getComputedStyle(paras[0]).fontFamily ?? null : null,
      paragraphLineHeight: paras[0] ? doc.defaultView?.getComputedStyle(paras[0]).lineHeight ?? null : null,
      rubyCount: doc.querySelectorAll("ruby").length,
      imageCount: doc.querySelectorAll("img").length,
      scrollWidth: doc.documentElement.scrollWidth,
      clientWidth: doc.documentElement.clientWidth,
    };

    // 真正判断「属性是否生效」——比较开启前后的宽度差
    report.typographyEffect = [
      measureFeature(doc, "text-autospace（中英间距）", "中文ABC中文", (on) => `text-autospace: ${on ? "normal" : "no-autospace"};`),
      measureFeature(doc, "text-spacing-trim（标点挤压）", "「「引号」」，句号。", (on) => `text-spacing-trim: ${on ? "trim-start" : "space-all"};`),
      measureFeature(doc, "hanging-punctuation（标点悬挂）", "测试标点悬挂，句号。", (on) => `hanging-punctuation: ${on ? "allow-end last" : "none"};`),
    ];
  }

  return report;
}

export async function saveReport(report: P0Report, path: string): Promise<string> {
  return invoke<string>("save_report", { path, content: JSON.stringify(report, null, 2) });
}
