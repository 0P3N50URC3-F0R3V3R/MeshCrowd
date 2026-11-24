package com.meshcrowd.app

// Per-server "stay signed in" rules. Mirrors electron/signIn.js; the CookieManager side is in SessionCookies.
object SignInPolicy {
    const val COOKIE = "dismesh_session"

    fun shouldAsk(entry: KnownServer?, hasCookie: Boolean): Boolean = entry != null && entry.signIn == null && hasCookie

    fun cookieValue(header: String?): String? = header?.split(';')?.map { it.trim() }
        ?.firstOrNull { it.startsWith("$COOKIE=") }?.substringAfter('=')?.takeIf { it.isNotEmpty() }

    // A Set-Cookie string with no Max-Age/Expires, so it lives only as a session cookie. Anything that could
    // add attributes (';', whitespace) makes it refuse: an empty string means "do not set".
    fun sessionOnlyCookie(value: String): String =
        if (value.isEmpty() || value.any { it == ';' || it.isWhitespace() }) "" else "$COOKIE=$value; Path=/; HttpOnly"
}
