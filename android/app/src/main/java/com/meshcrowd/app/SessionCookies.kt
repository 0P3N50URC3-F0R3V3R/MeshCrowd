package com.meshcrowd.app

import android.webkit.CookieManager

// The WebView side of "stay signed in": a "this session only" login is re-created as a session cookie and is
// removed when the user leaves that server or the app process starts fresh (WebView keeps session cookies on disk).
object SessionCookies {
    private var coldStartHandled = false
    private var converted: String? = null

    fun onColdStart() {
        if (coldStartHandled) return
        coldStartHandled = true
        CookieManager.getInstance().removeSessionCookies(null)
    }

    fun current(origin: String): String? = SignInPolicy.cookieValue(CookieManager.getInstance().getCookie(origin))

    fun makeSessionOnly(origin: String, value: String) {
        if (converted == value) return
        val cookie = SignInPolicy.sessionOnlyCookie(value)
        if (cookie.isEmpty()) return
        val cm = CookieManager.getInstance()
        cm.setCookie(origin, cookie)
        cm.flush()
        converted = value
    }

    fun dropIfSessionOnly(origin: String?, list: List<KnownServer>) {
        val server = KnownServers.find(list, origin) ?: return
        if (server.signIn != "session") return
        CookieManager.getInstance().apply { setCookie(server.url, "${SignInPolicy.COOKIE}=; Max-Age=0; Path=/"); flush() }
        converted = null
    }
}
