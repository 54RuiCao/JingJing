package app.aireader.desktop

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  /**
   * P4：打开 **双指缩放**。
   *
   * Android WebView 默认 `builtInZoomControls = false`，多指手势会被它吞掉 ——
   * 这也是"双指缩放没反应"的原因。这里把内建缩放打开（再把那对 +/− 按钮藏掉）。
   *
   * 为什么这是对的做法：引擎侧 foliate 的 paginator 本来就判断
   * `visualViewport.scale > 1` 来处理"缩放态下不翻页"，也就是说它预期的机制
   * 就是**浏览器页面缩放**，而不是我们自己去实现一套（`vendor/foliate-js/paginator.js:833`）。
   */
  @SuppressLint("SetJavaScriptEnabled")
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.settings.builtInZoomControls = true
    webView.settings.displayZoomControls = false
    webView.settings.setSupportZoom(true)
    // 让页面按 viewport 宽度布局（配合 viewport-fit=cover，safe-area 才有意义）
    webView.settings.useWideViewPort = true
    webView.settings.loadWithOverviewMode = false
  }
}
