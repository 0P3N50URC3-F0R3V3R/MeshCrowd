package com.meshcrowd.app

import android.content.Context

class SettingsStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("meshcrowd", Context.MODE_PRIVATE)

    var origin: String?
        get() = prefs.getString("origin", null)
        set(value) = prefs.edit().putString("origin", value).apply()

    // SHA-256 of a self-signed server certificate the user explicitly trusted (null = system trust only).
    var pin: String?
        get() = prefs.getString("pin", null)
        set(value) = prefs.edit().putString("pin", value).apply()

    var pollMinutes: Int
        get() = PollScheduler.clampMinutes(prefs.getInt("pollMinutes", 15))
        set(value) = prefs.edit().putInt("pollMinutes", PollScheduler.clampMinutes(value)).apply()

    var fastMode: Boolean
        get() = prefs.getBoolean("fastMode", true)
        set(value) = prefs.edit().putBoolean("fastMode", value).apply()

    var pushEnabled: Boolean
        get() = prefs.getBoolean("pushEnabled", false)
        set(value) = prefs.edit().putBoolean("pushEnabled", value).apply()

    // The UnifiedPush address the distributor gave us (also sent to the server).
    var pushEndpoint: String?
        get() = prefs.getString("pushEndpoint", null)
        set(value) = prefs.edit().putString("pushEndpoint", value).apply()

    // Highest outbox id already turned into a notification; 0 = never polled.
    var lastNotificationId: Long
        get() = prefs.getLong("lastNotificationId", 0L)
        set(value) = prefs.edit().putLong("lastNotificationId", value).apply()

    // Display name of the server, reported by the page once it knows it; only used to word the loading screen.
    var serverName: String?
        get() = prefs.getString("serverName", null)
        set(value) = prefs.edit().putString("serverName", value).apply()

    var knownServers: List<KnownServer>
        get() = KnownServers.fromJson(prefs.getString("knownServers", null))
        set(value) = prefs.edit().putString("knownServers", KnownServers.toJson(value)).apply()

    var swarmShow: Boolean
        get() = prefs.getBoolean("swarmShow", false)
        set(value) = prefs.edit().putBoolean("swarmShow", value).apply()

    var swarmTrackers: List<String>
        get() = prefs.getString("swarmTrackers", null)?.let { text -> try { org.json.JSONArray(text).let { a -> (0 until a.length()).map { a.getString(it) } } } catch (_: Exception) { null } } ?: DEFAULT_TRACKERS
        set(value) = prefs.edit().putString("swarmTrackers", org.json.JSONArray(value).toString()).apply()

    val configured: Boolean get() = !origin.isNullOrEmpty()

    fun clearServer() {
        prefs.edit().remove("origin").remove("pin").remove("serverName").remove("lastNotificationId").apply()
    }

    companion object {
        val DEFAULT_TRACKERS = emptyList<String>()
    }
}
