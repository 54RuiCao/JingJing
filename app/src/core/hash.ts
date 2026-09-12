/**
 * 变更检测与包完整性用的哈希（非密码学）。
 *
 * 为什么不用 sha256：
 *   - 技能目录 digest 要在**同步**路径上比对（浏览器的 crypto.subtle 是异步的）；
 *   - 插件包哈希只用于"内容变没变"和授权绑定，输入的规模很小（几百 KB 级的包）。
 * 输入格式与 DSH 的目录 digest 逐字一致（JSON.stringify([name, description]) 用 \n 连接），
 * 将来真要换 sha256，输入不用动、只换这一处实现。
 */

export function fnv1a64(input: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * 插件包内容哈希：文件按路径排序后逐对喂进去（路径 + 内容）。
 * 路径也要参与 —— 否则"改了文件名"这种变化看不出来。
 */
export function packageHash(files: { path: string; content: string }[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return fnv1a64(sorted.map((f) => f.path + "\u0000" + f.content).join("\u0001"));
}
