package com.capynote.app

import android.app.DownloadManager
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.widget.Toast
import java.net.URLDecoder
import kotlin.concurrent.thread

/**
 * 兩條下載路徑：
 *  - http(s)（備份 zip、檔案管理的下載、檔案筆記的下載）→ 系統 DownloadManager 串流，帶上登入 cookie，
 *    幾百 MB 也不會經過記憶體；通知列會看到進度。
 *  - blob:/data:（CSV、PNG、SVG、docx、出版的電子書 HTML）→ inject.js 轉 base64 進來，寫進 MediaStore 的「下載」。
 */
class Downloads(private val ctx: Context, private val userAgent: () -> String) {
    private val expected = HashMap<String, String>()

    fun expect(url: String, name: String) {
        if (name.isBlank()) return
        synchronized(expected) { expected[url] = name }
    }

    fun onDownloadStart(url: String, contentDisposition: String?, mime: String?) {
        if (url.startsWith("blob:") || url.startsWith("data:")) {
            // inject.js 應該已經攔下來了；若沒有（例如注入失敗），至少說清楚
            toast(ctx.getString(R.string.download_failed, "blob"))
            return
        }
        val name = safeName(
            synchronized(expected) { expected.remove(url) }
                ?: nameFromDisposition(contentDisposition)
                ?: URLUtil.guessFileName(url, contentDisposition, mime)
        )
        try {
            val req = DownloadManager.Request(Uri.parse(url))
            CookieManager.getInstance().getCookie(url)?.let { req.addRequestHeader("Cookie", it) }
            req.addRequestHeader("User-Agent", userAgent())
            if (!mime.isNullOrBlank()) req.setMimeType(mime)
            req.setTitle(name)
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            (ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
            toast(ctx.getString(R.string.download_started, name))
        } catch (e: Exception) {
            toast(ctx.getString(R.string.download_failed, e.message ?: e.javaClass.simpleName))
        }
    }

    fun saveBase64(rawName: String, mime: String, base64: String) {
        val name = safeName(rawName)
        thread(name = "capynote-save") {
            try {
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name)
                    put(MediaStore.Downloads.MIME_TYPE, mime.ifBlank { "application/octet-stream" })
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = ctx.contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw IllegalStateException("MediaStore insert failed")
                resolver.openOutputStream(uri)?.use { it.write(bytes) }
                    ?: throw IllegalStateException("openOutputStream failed")
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                toast(ctx.getString(R.string.download_saved, name))
            } catch (e: Exception) {
                toast(ctx.getString(R.string.download_failed, e.message ?: e.javaClass.simpleName))
            }
        }
    }

    private fun toast(msg: String) {
        android.os.Handler(ctx.mainLooper).post { Toast.makeText(ctx, msg, Toast.LENGTH_LONG).show() }
    }

    companion object {
        /** Content-Disposition：優先 filename*=UTF-8''…（伺服器對中文檔名用的），其次 filename="…"。 */
        fun nameFromDisposition(cd: String?): String? {
            if (cd.isNullOrBlank()) return null
            Regex("filename\\*\\s*=\\s*(?:UTF-8|utf-8)''([^;]+)").find(cd)?.let {
                return runCatching { URLDecoder.decode(it.groupValues[1].trim(), "UTF-8") }.getOrNull()
            }
            Regex("filename\\s*=\\s*\"([^\"]+)\"").find(cd)?.let { return it.groupValues[1] }
            Regex("filename\\s*=\\s*([^;]+)").find(cd)?.let { return it.groupValues[1].trim() }
            return null
        }

        fun safeName(n: String): String {
            val s = n.trim().replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]+"), "_").trim('.', ' ')
            return if (s.isEmpty()) "download" else s.take(200)
        }
    }
}
