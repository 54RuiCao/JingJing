import "./polyfills";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyDocLang } from "./i18n";
import "./styles.css";
// 手机端视觉规范（P6）：只作用于 [data-mobile="true"]，桌面样式一个像素不动
import "./ui/theme/mobile.css";

// 首帧之前把 <html lang> / 标题定下来（按系统语言；用户存过的偏好在 App 里再覆盖）
applyDocLang();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
