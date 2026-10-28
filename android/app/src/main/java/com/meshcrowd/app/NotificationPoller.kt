package com.meshcrowd.app

import android.content.Context
import android.webkit.CookieManager
import org.json.JSONObject

object NotificationPoller {
    // True while the WebView is on screen: new messages are then visible in the page itself.
    @Volatile var appVisible = false

    // One poll of GET /api/notifications/poll?since=<lastId>. Returns how many notifications were shown.
    // The very first poll only records the newest id so an old backlog never floods the shade.
    fun poll(context: Context): Int {
        val settings = SettingsStore(context)
        val origin = settings.origin ?: return 0
        val cookie = CookieManager.getInstance().getCookie(origin)
        if (cookie.isNullOrEmpty()) return 0 // not signed in
        val since = settings.lastNotificationId
        val res = try {
            Net.get(NotificationMapper.pollUrl(origin, since), settings.pin, cookie)
        } catch (_: Exception) {
            return 0
        }
        if (res.code != 200) return 0
        val json = try { JSONObject(res.body) } catch (_: Exception) { return 0 }
        val latest = json.optLong("latestId", since)
        val items = json.optJSONArray("notifications")
        val labels = NotificationMapper.Labels(context.getString(R.string.notify_encrypted), context.getString(R.string.notify_attachment))
        var shown = 0
        if (since > 0 && items != null && !appVisible) {
            NotificationHelper.createChannels(context)
            for (i in 0 until items.length()) {
                val mapped = NotificationMapper.map(items.getJSONObject(i), labels) ?: continue
                NotificationHelper.showMessage(context, mapped)
                shown++
            }
        }
        if (latest > since) settings.lastNotificationId = latest
        return shown
    }
}
