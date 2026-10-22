package com.capynote.app

import android.webkit.JavascriptInterface
import android.widget.Toast

/**
 * window.capynoteAndroid —— 網站看得到的原生介面。
 * 網站那邊只用到三個：openSettings()（帳號選單的「APP 設定」）、printHtml()（PDF 列印）、
 * 存在與否（有這個物件就是在 APP 裡）；其餘給 res/raw/inject.js 用。
 * 每個方法都可能從 JS 執行緒進來，碰 UI 的一律 runOnUiThread。
 */
class Bridge(private val a: MainActivity) {

    @JavascriptInterface
    fun version(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun openSettings() {
        a.runOnUiThread { a.openSettings() }
    }

    @JavascriptInterface
    fun setTheme(theme: String) {
        a.runOnUiThread { a.applyTheme(theme == "dark") }
    }

    @JavascriptInterface
    fun toast(msg: String) {
        a.runOnUiThread { Toast.makeText(a, msg, Toast.LENGTH_SHORT).show() }
    }

    /** http(s) 的 <a download>：DownloadListener 只拿得到網址，先把檔名登記起來。 */
    @JavascriptInterface
    fun expectDownload(url: String, name: String) {
        a.downloads.expect(url, name)
    }

    /** blob:/data: 的匯出：inject.js 轉成 base64 送過來，存進「下載」。 */
    @JavascriptInterface
    fun saveBlob(name: String, mime: String, base64: String) {
        a.downloads.saveBase64(name, mime, base64)
    }

    /** 「匯入整個資料夾」：inject.js 攔下 <input webkitdirectory> 的點擊改叫這裡，開系統的選資料夾畫面。 */
    @JavascriptInterface
    fun pickFolder() {
        a.runOnUiThread { a.pickFolder() }
    }

    /** 網頁把那次選取的檔案都讀完了，假網址可以作廢。 */
    @JavascriptInterface
    fun pickDone(token: String) {
        a.folderPick.release(token)
    }

    /** js/pdf.js 的「列印／另存 PDF」：把排版前的 HTML 交給原生端，走系統列印對話框。 */
    @JavascriptInterface
    fun printHtml(html: String, extraCss: String?, title: String?) {
        a.runOnUiThread { a.printer.print(html, extraCss ?: "", title ?: "") }
    }
}
