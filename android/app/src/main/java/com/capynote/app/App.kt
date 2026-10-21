package com.capynote.app

import android.app.Application
import android.webkit.CookieManager

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        // 登入是 HttpOnly cookie（rn_session）：WebView 的 CookieManager 會持久化到磁碟，
        // 所以關掉 APP 再開仍是登入狀態，跟瀏覽器一樣。
        CookieManager.getInstance().setAcceptCookie(true)
    }
}
