import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 期望固定端口，且不要在端口被占用时静默换端口
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // foliate-js 通过 file: 依赖链接到仓库根目录的 vendor/，需要放行父目录
    fs: { allow: [".."] },
    // Windows 上必须排掉 Rust 的构建目录：chokidar 会去 watch target/ 里的
    // *.exe（构建脚本），文件被链接器占着 → "EBUSY: resource busy or locked"，
    // 整个 dev server 直接退出（实测踩到，tauri dev 起不来）。
    // 还要排掉"写文件时产生的临时目录"：编辑器/工具会写 .xxx.tmpdir/xxx.tmp，
    // 刚写就被链接器或同进程占着 → 同样的 EBUSY 崩掉 dev server（实测踩到第二次）。
    watch: { ignored: ["**/src-tauri/**", "**/dist/**", "**/.*.tmpdir/**", "**/*.tmp"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome110",
    sourcemap: true,
  },
});
