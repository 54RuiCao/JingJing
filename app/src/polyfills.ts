/**
 * WebView2（Chromium 143）尚未实现 Map/WeakMap 的 upsert 提案方法
 * （`getOrInsert` / `getOrInsertComputed`），而 foliate-js 内置的 pdf.js（v155 构建）
 * 已经在用它们，导致打开 PDF 时报：
 *
 *   TypeError: this[#e].getOrInsertComputed is not a function
 *
 * 这是"库比运行时新"造成的兼容问题，不是我们的代码问题。等 WebView2 升到 Chromium 145+
 * 之后这段可以删掉（届时函数已存在，不会被覆盖）。
 */

type UpsertableProto = {
  getOrInsert?: (key: unknown, value: unknown) => unknown;
  getOrInsertComputed?: (key: unknown, compute: (key: unknown) => unknown) => unknown;
};

function installUpsert(proto: UpsertableProto): void {
  if (typeof proto.getOrInsert !== "function") {
    proto.getOrInsert = function getOrInsert(this: Map<unknown, unknown>, key, value) {
      if (!this.has(key)) this.set(key, value);
      return this.get(key);
    };
  }
  if (typeof proto.getOrInsertComputed !== "function") {
    proto.getOrInsertComputed = function getOrInsertComputed(
      this: Map<unknown, unknown>,
      key,
      compute: (key: unknown) => unknown,
    ) {
      if (!this.has(key)) this.set(key, compute(key));
      return this.get(key);
    };
  }
}

installUpsert(Map.prototype as unknown as UpsertableProto);
installUpsert(WeakMap.prototype as unknown as UpsertableProto);
