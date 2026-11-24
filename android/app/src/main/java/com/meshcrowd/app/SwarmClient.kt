package com.meshcrowd.app

import org.json.JSONObject
import java.net.URI
import java.util.Base64

// Reads MeshSwarm trackers: every advert is checked (signature and limits) before it is shown, and the lists
// of several trackers are merged. Same rules as the server worker and electron/renderer/swarm.js.
object SwarmClient {
    private const val MAX_ADVERT = 32768
    private const val MAX_ICON_URI = 24000
    private const val MAX_PER_TRACKER = 500
    private const val MAX_FUTURE_SKEW = 5 * 60_000L
    private val registrations = setOf("open", "invite", "closed")
    private val badText = Regex("[\\p{Cc}\\u202A-\\u202E\\u2066-\\u2069\\u200E\\u200F]")
    private val verifiedCache = object : LinkedHashMap<String, Advert?>(256, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Advert?>?) = size > 2000
    }

    data class Advert(
        val url: String, val name: String, val description: String, val icon: String?,
        val registration: String, val updated: Long, val pub: String,
    )

    data class Entry(
        val url: String, val name: String, val description: String, val icon: String?,
        val registration: String, val updated: Long, val lastSeen: Long, val trackers: List<String>,
    )

    class Result(val servers: List<Entry>, val errors: List<Pair<String, String>>)

    // One https address per entry (no credentials, query or fragment), de-duplicated, at most 20; null if any line is bad.
    fun normalizeTrackers(lines: List<String>): List<String>? {
        val out = mutableListOf<String>()
        for (raw in lines.map { it.trim() }.filter { it.isNotEmpty() }) {
            val uri = try { URI(raw) } catch (_: Exception) { return null }
            if (uri.scheme != "https" || uri.host == null || uri.userInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
            val port = if (uri.port == -1) "" else ":${uri.port}"
            val base = "https://${uri.host.lowercase()}$port${uri.rawPath.orEmpty().trimEnd('/')}"
            if (base !in out) out.add(base)
        }
        return if (out.size > 20) null else out
    }

    fun verifyAdvert(str: String): Advert? = synchronized(verifiedCache) {
        if (verifiedCache.containsKey(str)) verifiedCache[str] else check(str).also { verifiedCache[str] = it }
    }

    private fun check(str: String): Advert? {
        if (str.length > MAX_ADVERT) return null
        val parts = str.split('.')
        if (parts.size != 2) return null
        val payload: ByteArray
        val signature: ByteArray
        val json: JSONObject
        try {
            val dec = Base64.getUrlDecoder()
            payload = dec.decode(parts[0])
            signature = dec.decode(parts[1])
            json = JSONObject(String(payload, Charsets.UTF_8))
        } catch (_: Exception) {
            return null
        }
        if (json.optInt("v", 0) != 1) return null
        val name = json.opt("name") as? String ?: return null
        val description = json.opt("description") as? String ?: return null
        if (name.length > 60 || description.length > 300 || badText.containsMatchIn(name) || badText.containsMatchIn(description)) return null
        val icon = if (json.isNull("icon")) null else (json.opt("icon") as? String ?: return null)
        if (icon != null && (icon.length > MAX_ICON_URI || !icon.startsWith("data:image/png;base64,"))) return null
        val registration = json.opt("registration") as? String ?: return null
        if (registration !in registrations) return null
        val updated = (json.opt("updated") as? Number)?.toLong() ?: return null
        val pub = json.opt("pub") as? String ?: return null
        val url = json.opt("url") as? String ?: return null
        if (url.length > 200) return null
        val uri = try { URI(url) } catch (_: Exception) { return null }
        if (uri.scheme != "https" || uri.userInfo != null || uri.host == null) return null
        val key = try { Base64.getUrlDecoder().decode(pub) } catch (_: Exception) { return null }
        if (!Ed25519Verify.verify(key, payload, signature)) return null
        return Advert(url, name, description, icon, registration, updated, pub)
    }

    fun loadList(trackers: List<String>, fetch: (String) -> String, now: () -> Long = System::currentTimeMillis): Result {
        val errors = mutableListOf<Pair<String, String>>()
        val seen = mutableListOf<Triple<Advert, Long, String>>()
        for (tracker in trackers) {
            try {
                val servers = JSONObject(fetch("$tracker/list")).optJSONArray("servers") ?: continue
                for (i in 0 until minOf(servers.length(), MAX_PER_TRACKER)) {
                    val item = servers.optJSONObject(i) ?: continue
                    val advert = verifyAdvert(item.optString("advert")) ?: continue
                    if (advert.updated > now() + MAX_FUTURE_SKEW) continue
                    seen.add(Triple(advert, item.optLong("lastSeen"), tracker))
                }
            } catch (e: Exception) {
                errors.add(tracker to (e.message ?: e.javaClass.simpleName))
            }
        }
        val entries = seen.groupBy { it.first.url }.map { (_, items) ->
            val best = items.groupBy { it.first.pub }.values.maxBy { group -> group.map { it.third }.toSet().size }
            val newest = best.maxBy { it.first.updated }.first
            Entry(newest.url, newest.name, newest.description, newest.icon, newest.registration, newest.updated,
                best.maxOf { it.second }, best.map { it.third }.distinct())
        }.sortedBy { it.name.lowercase() }
        return Result(entries, errors)
    }
}
