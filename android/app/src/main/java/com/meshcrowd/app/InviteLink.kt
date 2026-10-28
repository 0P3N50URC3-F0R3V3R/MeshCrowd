package com.meshcrowd.app

import java.net.URI

// `mcr://host[:port]/<invite code>` links (from the public /i/<code> page). They come from other apps, so
// everything is validated and nothing joins without the user pressing Connect / confirming in the page.
object InviteLink {
    data class Link(val host: String, val code: String)

    private val linkRe = Regex("""^mcr://([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+])(?::(\d{1,5}))?/+([^/?#]+)/?${'$'}""", RegexOption.IGNORE_CASE)
    private val codeRe = Regex("""^[A-Za-z0-9_.@-]{1,128}${'$'}""")

    fun parse(raw: String?): Link? {
        if (raw == null || raw.length > 300) return null
        val m = linkRe.matchEntire(raw.trim()) ?: return null
        val port = m.groupValues[2]
        if (port.isNotEmpty() && port.toInt() !in 1..65535) return null
        val code = m.groupValues[3].replace(Regex("%40", RegexOption.IGNORE_CASE), "@")
        if (!codeRe.matches(code)) return null
        val host = m.groupValues[1].lowercase()
        return Link(if (port.isEmpty()) host else "$host:$port", code)
    }

    // The page route the mobile UI turns into a "Join <server>?" confirmation.
    fun hash(link: Link) = "#invite=" + link.code.replace("@", "%40")

    // True when the link points at the server the app is already set up for.
    fun sameServer(link: Link, origin: String?): Boolean {
        if (origin == null) return false
        val uri = try { URI(origin) } catch (_: Exception) { return false }
        val host = uri.host?.lowercase() ?: return false
        val current = if (uri.port == -1) host else "$host:${uri.port}"
        return current == link.host
    }
}
