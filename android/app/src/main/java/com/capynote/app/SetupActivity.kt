package com.capynote.app

import android.os.Bundle
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/** 第一次開啟、或從網站帳號選單的「APP 設定」進來：填伺服器網址、測試、清資料。 */
class SetupActivity : AppCompatActivity() {
    private lateinit var url: EditText
    private lateinit var status: TextView
    private var testing = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)
        val root = findViewById<android.view.View>(R.id.setup_root)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }

        url = findViewById(R.id.url)
        status = findViewById(R.id.status)
        url.setText(Prefs.serverUrl(this) ?: "")
        url.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) { save(); true } else false
        }
        findViewById<Button>(R.id.btn_test).setOnClickListener { test(null) }
        findViewById<Button>(R.id.btn_save).setOnClickListener { save() }
        findViewById<Button>(R.id.btn_reload).setOnClickListener {
            // 回到 MainActivity 時 onResume 會重載同一個網址；清掉 loadedOrigin 最簡單的辦法是走快取旗標的同一條路
            Prefs.requestClearCache(this)
            finish()
        }
        findViewById<Button>(R.id.btn_clear).setOnClickListener { confirmClear() }
        findViewById<TextView>(R.id.version).text = getString(R.string.version_fmt, BuildConfig.VERSION_NAME)
        if (Prefs.serverUrl(this) == null) url.requestFocus()
    }

    private fun normalized(): String? {
        val n = Prefs.normalize(url.text.toString())
        if (n == null) status.text = getString(R.string.url_invalid)
        return n
    }

    private fun save() {
        val n = normalized() ?: return
        // 先測，通了才存——存一個連不上的網址只會讓主畫面一直顯示錯誤
        test { ok ->
            if (ok) {
                Prefs.setServerUrl(this, n)
                finish()
            }
        }
    }

    /** GET <url>/api/health：伺服器在 HTTPS 轉址之前就回答它，所以區網 http 也測得到。 */
    private fun test(then: ((Boolean) -> Unit)?) {
        if (testing) return
        val n = normalized() ?: return
        testing = true
        status.text = getString(R.string.testing)
        thread(name = "capynote-health") {
            var ok = false
            var msg: String
            try {
                val c = URL("$n/api/health").openConnection() as HttpURLConnection
                c.connectTimeout = 8000
                c.readTimeout = 8000
                c.instanceFollowRedirects = true
                c.setRequestProperty("User-Agent", "capynote-android/" + BuildConfig.VERSION_NAME)
                val code = c.responseCode
                val body = runCatching { (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } }.getOrNull() ?: ""
                c.disconnect()
                ok = code == 200 && body.contains("\"ok\"")
                msg = if (ok) getString(R.string.test_ok) else getString(R.string.test_not_capynote, code)
            } catch (e: Exception) {
                msg = getString(R.string.test_fail, e.message ?: e.javaClass.simpleName)
            }
            if (ok && n.startsWith("http://")) msg += "\n" + getString(R.string.url_http_warn)
            runOnUiThread {
                testing = false
                status.text = msg
                then?.invoke(ok)
            }
        }
    }

    private fun confirmClear() {
        AlertDialog.Builder(this)
            .setTitle(R.string.clear_title)
            .setMessage(R.string.clear_msg)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                val cm = CookieManager.getInstance()
                cm.removeAllCookies(null)
                cm.flush()
                WebStorage.getInstance().deleteAllData()
                Prefs.requestClearCache(this)
                Toast.makeText(this, R.string.cleared, Toast.LENGTH_SHORT).show()
            }
            .show()
    }
}
