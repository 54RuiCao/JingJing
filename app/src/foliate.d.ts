// foliate-js 是纯 JavaScript，没有类型声明；这里只声明我们用到的子模块。
declare module "foliate-js/view.js";
declare module "foliate-js/epubcfi.js" {
  export function fromCalibreHighlight(obj: unknown): string;
  export function parse(cfi: string): unknown;
  export function compare(a: string, b: string): number;
}
declare module "foliate-js/overlayer.js" {
  export const Overlayer: {
    highlight: unknown;
    underline: unknown;
    squiggly: unknown;
  };
}
declare module "foliate-js/progress.js" {
  export class TOCProgress {
    constructor(...args: unknown[]);
  }
  export class SectionProgress {
    constructor(...args: unknown[]);
  }
}
