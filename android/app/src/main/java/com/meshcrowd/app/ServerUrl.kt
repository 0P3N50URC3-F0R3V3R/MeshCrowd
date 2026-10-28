package com.meshcrowd.app

import java.net.URI

object ServerUrl {
    private val hostRe = Regex("""^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?${'$'}|^\[[0-9A-Fa-f:.]+]${'$'}""")

    // A typed address -> the origins worth trying, https first. An explicit scheme is respected.
    fun candidates(input: String): List<String> {
        val raw = input.trim()
        if (raw.isEmpty() || raw.any { it.isWhitespace() }) return emptyList()
        val hasScheme = raw.contains("://")
        val withScheme = if (hasScheme) raw else "https://$raw"
        val uri = try { URI(withScheme) } catch (_: Exception) { return emptyList() }
        val scheme = uri.scheme?.lowercase() ?: return emptyList()
        if (scheme != "http" && scheme != "https") return emptyList()
        if (uri.userInfo != null) return emptyList()
        val host = uri.host ?: return emptyList()
        if (!hostRe.matches(host)) return emptyList()
        val port = if (uri.port == -1) "" else ":${uri.port}"
        return if (hasScheme) listOf("$scheme://$host$port") else listOf("https://$host$port", "http://$host$port")
    }

    fun isCleartext(origin: String) = origin.startsWith("http://", ignoreCase = true)
}
