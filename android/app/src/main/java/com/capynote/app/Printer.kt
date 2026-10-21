package com.capynote.app

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.print.PrintAttributes
import android.print.PrintManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import org.json.JSONObject

/**
 * PDF 匯出。網站在桌面瀏覽器是把排版好的文件放進 iframe 再 window.print()；Android 的 WebView
 * 不理 window.print()，所以 js/pdf.js 偵測到 window.capynoteAndroid 時改把「排版前的 HTML」交過來，
 * 這裡用一個不掛在畫面上的 WebView 重做同一套流程：載入 HTML（base URL 是伺服器，vendor 的
 * paged.polyfill.js 與字型才載得到）→ 等字型 → 設 PagedConfig → 載 paged.js → after 回呼 →
 * 系統列印對話框（使用者選「儲存為 PDF」）。跟桌面版同一份文件、同一個分頁引擎。
 */
class Printer(private val a: Activity) {
    private val TAG = "capynote"
    private var job: Job? = null   // 持有中的 WebView 要撐到列印對話框結束，否則被 GC 就印不出來

    fun print(html: String, extraCss: String, title: String) {
        val origin = Prefs.serverUrl(a) ?: return
        job?.dispose()
        Toast.makeText(a, R.string.print_preparing, Toast.LENGTH_SHORT).show()
        job = Job(a, origin, html, extraCss, title.ifBlank { "capynote" })
    }

    private class Job(
        private val a: Activity,
        origin: String,
        html: String,
        private val extraCss: String,
        private val title: String
    ) {
        private val TAG = "capynote"
        private val web = WebView(a)
        private var started = false
        private val handler = Handler(Looper.getMainLooper())
        private val fallback = Runnable { go() }

        inner class Hook {
            @JavascriptInterface
            fun ready() { Log.i(TAG, "print: paged.js done"); handler.post { go() } }
            @JavascriptInterface
            fun log(msg: String) { Log.i(TAG, "print js: $msg") }
        }

        init {
            web.settings.javaScriptEnabled = true
            web.settings.domStorageEnabled = true
            web.settings.allowFileAccess = false
            web.addJavascriptInterface(Hook(), "capynotePrint")
            web.webViewClient = object : WebViewClient() {
                private var booted = false
                override fun onPageFinished(view: WebView, url: String?) {
                    Log.i(TAG, "print page finished: $url booted=$booted")
                    if (booted) return
                    booted = true
                    view.evaluateJavascript(bootJs(extraCss), null)
                }
                override fun onReceivedError(view: WebView, request: android.webkit.WebResourceRequest, error: android.webkit.WebResourceError) {
                    Log.w(TAG, "print page error: ${request.url} ${error.description}")
                }
            }
            // 列印需要一個真實的版面寬度；沒掛上畫面的 WebView 給它 A4 等比的尺寸
            web.layout(0, 0, 794, 1123)
            Log.i(TAG, "print: loading ${html.length} chars, base $origin/")
            web.loadDataWithBaseURL("$origin/", html, "text/html", "utf-8", null)
            handler.postDelayed(fallback, 40_000)   // paged.js 卡住也要有出口
        }

        private fun go() {
            if (started) return
            started = true
            Log.i(TAG, "print: opening system print dialog")
            handler.removeCallbacks(fallback)
            try {
                val pm = a.getSystemService(Context.PRINT_SERVICE) as PrintManager
                val adapter = web.createPrintDocumentAdapter(title)
                val attrs = PrintAttributes.Builder()
                    .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                    .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                    .build()
                pm.print(title, adapter, attrs)
            } catch (e: Exception) {
                Toast.makeText(a, e.message ?: e.javaClass.simpleName, Toast.LENGTH_LONG).show()
            }
        }

        fun dispose() {
            handler.removeCallbacks(fallback)
            runCatching { web.destroy() }
        }

        /** 跟 js/pdf.js 的 boot() 同一套：等字型、PagedConfig.after 再補浮水印 CSS，最後通知原生端。 */
        private fun bootJs(css: String): String {
            val cssLit = JSONObject.quote(css)
            return """
                (function () {
                  var done = false;
                  function fin() { if (done) return; done = true; setTimeout(function () { capynotePrint.ready(); }, 500); }
                  window.onerror = function (m, src, line) { try { capynotePrint.log('error ' + m + ' @' + src + ':' + line); } catch (e) {} };
                  try { capynotePrint.log('boot readyState=' + document.readyState + ' fonts=' + !!(document.fonts && document.fonts.ready)); } catch (e) {}
                  window.PagedConfig = { auto: true, after: function () {
                    try { var c = $cssLit; if (c) { var s = document.createElement('style'); s.textContent = c; document.head.appendChild(s); } } catch (e) {}
                    fin();
                  } };
                  function start() {
                    var s = document.createElement('script');
                    s.src = 'vendor/paged.polyfill.js';
                    s.onerror = function () { try { capynotePrint.log('polyfill failed to load'); } catch (e) {} fin(); };
                    s.onload = function () { try { capynotePrint.log('polyfill loaded'); } catch (e) {} };
                    document.head.appendChild(s);
                  }
                  var started = false; function once() { if (!started) { started = true; start(); } }
                  if (document.fonts && document.fonts.ready) { document.fonts.ready.then(once, once); setTimeout(once, 3000); }
                  else once();
                })();
            """.trimIndent()
        }
    }
}
