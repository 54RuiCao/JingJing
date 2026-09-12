/**
 * 二进制 → base64（P4 移动端导入用）。
 *
 * 为什么要分块：`String.fromCharCode(...bytes)` 在几 MB 的数组上会**爆调用栈**
 * （一本书动辄 10 MB，实测 RangeError: Maximum call stack size exceeded）。
 * 32KB 一块既安全又快（比逐字节拼字符串快一个量级）。
 */
const CHUNK = 0x8000;

/** Uint8Array → base64 字符串（给 Tauri 命令传二进制用） */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
