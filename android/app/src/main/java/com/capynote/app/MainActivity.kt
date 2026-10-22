package com.capynote.app

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Message
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * 整個 APP 就是一個全螢幕 WebView 載入使用者設定的 capynote 網址。
 * 帳號、筆記、檔案、分享——全部就是網站本身，沒有第二份資料；同一個 cookie 登入，所以跟瀏覽器完全同步。
 * 原生端只補 WebView 做不到的事：檔案選取、下載、列印（PDF）、外部連結、狀態列顏色、連線錯誤畫面。
 */
class MainActivity : AppCompatActivity() {
    private lateinit var root: ViewGroup
    private lateinit var web: WebView
    private lateinit var errorView: LinearLayout
    private lateinit var errorDetail: TextView

    lateinit var downloads: Downloads
    lateinit var printer: Printer
    lateinit var folderPick: FolderPick

    private var loadedOrigin: String? = null      // 目前 WebView 載的是哪台伺服器
    private var mainFrameFailed = false
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var setupShown = false

    private val chooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCallback = null
    }

    // 「匯入整個資料夾」：系統的選資料夾畫面；選好了在背景把整棵樹走完，再把清單交給網頁（FolderPick.kt）
    private val folderChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val tree = r.data?.data
        if (r.resultCode != RESULT_OK || tree == null) { folderPicked(null); return@registerForActivityResult }
        Thread {
            val json = runCatching { folderPick.toJson(folderPick.walk(tree)) }.getOrNull()
            runOnUiThread { folderPicked(json) }
        }.start()
    }

    private fun folderPicked(json: String?) {
        web.evaluateJavascript("window.__capyFolderPicked && window.__capyFolderPicked(${json ?: "null"})", null)
    }

    fun pickFolder() {
        try {
            folderChooser.launch(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_folder_picker, Toast.LENGTH_SHORT).show()
            folderPicked(null)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        root = findViewById(R.id.root)
        web = findViewById(R.id.web)
        errorView = findViewById(R.id.error_view)
        errorDetail = findViewById(R.id.error_detail)
        findViewById<Button>(R.id.btn_retry).setOnClickListener { retry() }
        findViewById<Button>(R.id.btn_change_server).setOnClickListener { openSettings() }

        downloads = Downloads(applicationContext) { web.settings.userAgentString }
        printer = Printer(this)
        folderPick = FolderPick(contentResolver)

        // 邊到邊（targetSdk 35 強制）：自己把狀態列／導覽列／鍵盤的 inset 變成 padding，
        // 底色跟網站主題同步（applyTheme），所以狀態列看起來就是網站頂列的延伸。
        WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }

        setupWebView()
        applyTheme(resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK ==
            android.content.res.Configuration.UI_MODE_NIGHT_YES)

        onBackPressedDispatcher.addCallback(this) {
            // 網站用 pushState 記每一頁，所以返回鍵就是網站的「上一頁」，回到首頁（沒有 hash）才離開 APP。
            // 不能看 WebView.canGoBack()：Chromium 把「沒有使用者手勢的 pushState」（APP 一開就自動
            // 開上次的筆記、程式切頁）標成可跳過的歷史項目，canGoBack() 因此回 false，在筆記頁按返回
            // 就直接把 APP 關了（模擬器上抓到的）。改問網頁本身，用 history.back() 走它自己的歷史。
            if (errorView.visibility == View.VISIBLE) { finish(); return@addCallback }
            web.evaluateJavascript(
                "(function(){ if (location.hash && location.hash !== '#' && history.length > 1) { history.back(); return 'back'; } return 'exit'; })()"
            ) { r -> if (r == null || r.contains("exit")) finish() }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val s = web.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.allowFileAccess = false
        s.allowContentAccess = false
        s.javaScriptCanOpenWindowsAutomatically = true
        s.setSupportMultipleWindows(true)
        s.mediaPlaybackRequiresUserGesture = false
        s.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        s.cacheMode = WebSettings.LOAD_DEFAULT
        s.userAgentString = s.userAgentString + " capynote-android/" + BuildConfig.VERSION_NAME
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            // 網站自己有深色主題；不要讓 WebView 再把顏色反轉一次
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(s, false)
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)

        web.addJavascriptInterface(Bridge(this), "capynoteAndroid")

        val inject = resources.openRawResource(R.raw.inject).bufferedReader().use { it.readText() }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, inject, setOf("*"))
        }

        web.setDownloadListener { url, _, contentDisposition, mimetype, _ ->
            downloads.onDownloadStart(url, contentDisposition, mimetype)
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                val scheme = u.scheme?.lowercase()
                if ((scheme == "http" || scheme == "https") && Prefs.sameOrigin(u.toString(), loadedOrigin)) return false
                openExternal(u)
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                mainFrameFailed = false
            }

            // 匯入資料夾時每個檔案是一個同源假網址，內容由 FolderPick 串流（見 FolderPick.kt）
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val u = request.url
                if (!Prefs.sameOrigin(u.toString(), loadedOrigin)) return null
                return folderPick.intercept(u.path)
            }

            override fun onPageFinished(view: WebView, url: String?) {
                // 舊 WebView 沒有 document-start 注入：載完再補（腳本自己有守門，不會跑兩次）
                view.evaluateJavascript(inject, null)
                if (!mainFrameFailed) errorView.visibility = View.GONE
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showError(error.description?.toString() ?: "")
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame && response.statusCode >= 500) showError("HTTP ${response.statusCode}")
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView, filePathCallback: ValueCallback<Array<Uri>>, params: FileChooserParams
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = filePathCallback
                return try {
                    chooser.launch(params.createIntent())
                    true
                } catch (e: ActivityNotFoundException) {
                    fileCallback = null
                    false
                }
            }

            // window.open / target=_blank：同站的在這個 WebView 開（返回鍵可以回來），站外的交給瀏覽器
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                val tmp = WebView(view.context)
                tmp.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                        val u = request.url
                        if (Prefs.sameOrigin(u.toString(), loadedOrigin)) web.loadUrl(u.toString()) else openExternal(u)
                        v.post { runCatching { v.destroy() } }
                        return true
                    }
                }
                (resultMsg.obj as WebView.WebViewTransport).webView = tmp
                resultMsg.sendToTarget()
                return true
            }
        }
    }

    private fun openExternal(u: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, u))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show()
        }
    }

    private fun showError(detail: String) {
        mainFrameFailed = true
        errorDetail.text = if (detail.isBlank()) getString(R.string.error_hint) else "${getString(R.string.error_hint)}\n$detail"
        errorView.visibility = View.VISIBLE
    }

    private fun retry() {
        errorView.visibility = View.GONE
        val url = Prefs.serverUrl(this) ?: return openSettings()
        web.loadUrl(url)
    }

    fun openSettings() {
        setupShown = true
        startActivity(Intent(this, SetupActivity::class.java))
    }

    /** 跟網站的 data-theme 同步：root 底色（狀態列後面就是它）與狀態列圖示的深淺。 */
    fun applyTheme(dark: Boolean) {
        val bg = if (dark) Color.parseColor("#13161C") else Color.WHITE
        root.setBackgroundColor(bg)
        errorView.setBackgroundColor(bg)
        val ic = WindowInsetsControllerCompat(window, root)
        ic.isAppearanceLightStatusBars = !dark
        ic.isAppearanceLightNavigationBars = !dark
    }

    override fun onResume() {
        super.onResume()
        val url = Prefs.serverUrl(this)
        if (url == null) {
            if (setupShown) { finish(); return }   // 設定頁被按返回取消，沒有網址就沒有東西可開
            openSettings()
            return
        }
        setupShown = false
        if (Prefs.takeClearCache(this)) {
            web.clearCache(true)
            web.clearHistory()
            loadedOrigin = null
        }
        if (loadedOrigin == null || !Prefs.sameOrigin(url, loadedOrigin)) {
            loadedOrigin = url
            errorView.visibility = View.GONE
            web.loadUrl(url)
        }
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()   // 登入 cookie 立刻落盤，APP 被系統殺掉也不會掉登入
    }

    override fun onDestroy() {
        root.removeView(web)
        web.destroy()
        super.onDestroy()
    }
}
