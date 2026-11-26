package com.meshcrowd.app

import android.content.Context
import android.webkit.CookieManager
import org.json.JSONObject

object NotificationPoller {
    // True while the WebView is on screen.
    @Volatile var appVisible = false

    // The conversation the page shows ("" = none). null = a server whose page does not report it, where
    // everything stays silent while the app is on screen.
    @Volatile var openScope: String? = null

    // For pages that do not report the open conversation: messages that arrived while the page was on screen
    // were seen there; without moving the cursor past them the next background poll announced them as new.
    fun markSeen(context: Context) {
        val settings = SettingsStore(context)
        val origin = settings.origin ?: return
        val cookie = CookieManager.getInstance().getCookie(origin)
        if (cookie.isNullOrEmpty()) return
        val res = try { Net.get(NotificationMapper.pollUrl(origin, settings.lastNotificationId), settings.pin, cookie) } catch (_: Exception) { return }
        if (res.code != 200) return
        val latest = try { JSONObject(res.body).optLong("latestId", 0) } catch (_: Exception) { return }
        if (latest > settings.lastNotificationId) settings.lastNotificationId = latest
    }

    // One poll of GET /api/notifications/poll?since=<lastId>. Returns how many notifications were shown.
    // The very first poll only records the newest id so an old backlog never floods the shade.
    // Synchronized: the page, the timers and the services all poll, and two at once would announce twice.
    @Synchronized
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
        val labels = NotificationMapper.Labels(context.getString(R.string.notify_encrypted), context.getString(R.string.notify_attachment), context.getString(R.string.notify_pinned), context.getString(R.string.notify_thread), context.getString(R.string.notify_sticker))
        NotificationHelper.cancelRead(context, NotificationMapper.readPositions(json.optJSONArray("read")))
        var shown = 0
        val onScreen = if (appVisible) openScope else ""
        if (since > 0 && items != null && onScreen != null) {
            NotificationHelper.createChannels(context)
            for (i in 0 until items.length()) {
                val item = items.getJSONObject(i)
                if (NotificationMapper.isOnScreen(item, onScreen)) continue
                val mapped = NotificationMapper.map(item, labels) ?: continue
                NotificationHelper.showMessage(context, mapped)
                shown++
            }
        }
        if (latest > since) settings.lastNotificationId = latest
        return shown
    }
}
