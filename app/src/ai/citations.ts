/**
 * 引用锚点（P2.4）：把回答里的 [CH n] 变成可点击的跳转。
 *
 * 系统提示要求模型引用时写成 [CH n]（见 prompt.ts），n 与章节标记 <<CH n=..>> 一致、
 * 也等于「章节序号 + 1」，所以点击时直接 goToSection(n - 1) 即可（空章节也保留了标记，
 * 这个等式才成立）。这是「回答可验证」的最小闭环：模型说的每一句都能点回去看。
 */

export type CitationSegment = { text: string } | { n: number };

const RE = /\[\s*CH\s*(\d+)\s*\]/gi;

export function splitCitations(text: string): CitationSegment[] {
  const out: CitationSegment[] = [];
  let last = 0;
  RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ n: Number(m[1]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length ? out : [{ text }];
}

/** 回答里出现过哪些章节号（去重、升序），可用于「本回答引用了 3 处原文」 */
export function citedChapters(text: string): number[] {
  const set = new Set<number>();
  for (const seg of splitCitations(text)) if ("n" in seg) set.add(seg.n);
  return [...set].sort((a, b) => a - b);
}
