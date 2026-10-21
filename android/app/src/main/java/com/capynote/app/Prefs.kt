package com.capynote.app

import android.content.Context
import java.net.URI

/** 唯一的設定：伺服器網址。存在 SharedPreferences，沒設定就先進 SetupActivity。 */
object Prefs {
    private const val FILE = "capynote"
    private const val KEY_URL = "serverUrl"
    private const val KEY_CLEAR = "clearCacheOnResume"

    fun serverUrl(c: Context): String? =
        c.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY_URL, null)

    fun setServerUrl(c: Context, url: String?) {
        c.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString(KEY_URL, url).apply()
    }

    /** SetupActivity 清資料時 WebView 不在手上：留個旗標，MainActivity 回前景時清快取。 */
    fun requestClearCache(c: Context) {
        c.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putBoolean(KEY_CLEAR, true).apply()
    }

    fun takeClearCache(c: Context): Boolean {
        val p = c.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        val v = p.getBoolean(KEY_CLEAR, false)
        if (v) p.edit().remove(KEY_CLEAR).apply()
        return v
    }

    /** 使用者打的字 → 乾淨的 origin（無尾斜線、無路徑）；不是 http(s) 或沒有主機就回 null。 */
    fun normalize(raw: String): String? {
        var s = raw.trim()
        if (s.isEmpty()) return null
        if (!s.contains("://")) s = "https://$s"
        val u = runCatching { URI(s) }.getOrNull() ?: return null
        val scheme = u.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        val host = u.host ?: return null
        if (host.isEmpty()) return null
        val port = if (u.port > 0) ":${u.port}" else ""
        return "$scheme://$host$port"
    }

    /** 兩個網址是不是同一個 origin（scheme + host + port）。 */
    fun sameOrigin(a: String?, b: String?): Boolean {
        if (a == null || b == null) return false
        val x = runCatching { URI(a) }.getOrNull() ?: return false
        val y = runCatching { URI(b) }.getOrNull() ?: return false
        fun port(u: URI) = if (u.port > 0) u.port else if (u.scheme.equals("https", true)) 443 else 80
        return x.scheme.equals(y.scheme, true) && x.host.equals(y.host, true) && port(x) == port(y)
    }
}
