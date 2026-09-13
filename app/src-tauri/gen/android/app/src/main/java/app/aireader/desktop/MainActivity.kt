package app.aireader.desktop

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    /**
     * P17：**把系统导航栏收起来**（沉浸式）。
     *
     * 为什么：手机底部那条导航栏（返回/主页/多任务）会盖住我们的底部栏 ——
     * 实测"搜索按钮贴最底下被挡住"。Android 上如果内容要延伸到屏幕底部，
     * 正确做法就是让它**浮在内容上、不用时自动隐藏**（swipe 一下唤出），
     * 而不是把界面往上缩一截留位置。
     *
     * BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE：用户从边缘上滑可以临时叫出导航栏。
     */
    WindowCompat.setDecorFitsSystemWindows(window, false)
    WindowInsetsControllerCompat(window, window.decorView).apply {
      hide(WindowInsetsCompat.Type.navigationBars())
      systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }
  }

  /** 回到前台时再收一次（有些机型切回来会把导航栏放出来） */
  override fun onResume() {
    super.onResume()
    WindowInsetsControllerCompat(window, window.decorView).apply {
      hide(WindowInsetsCompat.Type.navigationBars())
      systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }
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
