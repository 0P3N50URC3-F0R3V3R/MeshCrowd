package com.meshcrowd.app

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

data class KnownServer(
    val url: String,
    val name: String,
    val icon: String,
    val lastUsed: Long,
    val signIn: String?,
    val pin: String?,
)

// The servers this phone has connected to, most recent first. Mirrors electron/knownServers.js.
object KnownServers {
    const val MAX = 50
    private const val MAX_NAME = 60
    private const val MAX_ICON = 24000
    private const val PNG_PREFIX = "data:image/png;base64,"
    private val modes = setOf(null, "keep", "session")

    fun normalizeOrigin(raw: String?): String? {
        val text = raw?.trim() ?: return null
        if (text.isEmpty() || text.any { it.isWhitespace() }) return null
        val uri = try { URI(text) } catch (_: Exception) { return null }
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        if (uri.userInfo != null) return null
        val host = uri.host?.lowercase() ?: return null
        val port = if (uri.port == -1) "" else ":${uri.port}"
        return "$scheme://$host$port"
    }

    fun find(list: List<KnownServer>, url: String?): KnownServer? {
        val origin = normalizeOrigin(url) ?: return null
        return list.firstOrNull { it.url == origin }
    }

    fun upsert(list: List<KnownServer>, url: String, name: String?, icon: String?, pin: String?, now: Long): List<KnownServer> {
        val origin = normalizeOrigin(url) ?: return list
        val prev = list.firstOrNull { it.url == origin }
        val cleanName = (name ?: "").split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ").take(MAX_NAME)
            .ifEmpty { URI(origin).authority }
        val cleanIcon = if (icon != null && icon.startsWith(PNG_PREFIX) && icon.length <= MAX_ICON) icon else ""
        val entry = KnownServer(origin, cleanName, cleanIcon, now, prev?.signIn, pin ?: prev?.pin)
        return (listOf(entry) + list.filter { it.url != origin }).take(MAX)
    }

    fun remove(list: List<KnownServer>, url: String?): List<KnownServer> {
        val origin = normalizeOrigin(url) ?: return list
        return list.filter { it.url != origin }
    }

    fun setSignIn(list: List<KnownServer>, url: String?, mode: String?): List<KnownServer> {
        if (mode !in modes) return list
        val origin = normalizeOrigin(url) ?: return list
        return list.map { if (it.url == origin) it.copy(signIn = mode) else it }
    }

    // A page can only ask for https servers, or an http one the user already connected to on purpose.
    fun switchTarget(raw: String?, list: List<KnownServer>): String? {
        val origin = normalizeOrigin(raw) ?: return null
        return if (origin.startsWith("https:") || list.any { it.url == origin }) origin else null
    }

    fun toJson(list: List<KnownServer>): String {
        val arr = JSONArray()
        for (s in list) {
            arr.put(JSONObject().put("url", s.url).put("name", s.name).put("icon", s.icon).put("lastUsed", s.lastUsed)
                .put("signIn", s.signIn ?: JSONObject.NULL).put("pin", s.pin ?: JSONObject.NULL))
        }
        return arr.toString()
    }

    fun fromJson(text: String?): List<KnownServer> {
        if (text.isNullOrEmpty()) return emptyList()
        return try {
            val arr = JSONArray(text)
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                val url = normalizeOrigin(o.optString("url")) ?: return@mapNotNull null
                val mode = if (o.isNull("signIn")) null else o.optString("signIn").takeIf { it in modes }
                KnownServer(url, o.optString("name").ifEmpty { URI(url).authority }, o.optString("icon"), o.optLong("lastUsed"), mode, if (o.isNull("pin")) null else o.optString("pin"))
            }.take(MAX)
        } catch (_: Exception) {
            emptyList()
        }
    }
}
