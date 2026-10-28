package com.meshcrowd.app

import android.content.Context
import android.content.pm.PackageManager
import android.webkit.CookieManager
import org.json.JSONObject
import org.unifiedpush.android.connector.UnifiedPush
import kotlin.concurrent.thread

// UnifiedPush as a third way to get notifications next to the periodic check and fast mode. The distributor
// app (for example ntfy) holds the connection; the server only sends it a "wake up" and the app then
// fetches the real notifications itself with its own session, so no message text goes through the distributor.
object PushControl {
    class Distributor(val id: String, val label: String)

    fun distributors(context: Context): List<Distributor> {
        val pm = context.packageManager
        return UnifiedPush.getDistributors(context).map { id ->
            val label = try { pm.getApplicationLabel(pm.getApplicationInfo(id, 0)).toString() } catch (_: PackageManager.NameNotFoundException) { id }
            Distributor(id, label)
        }
    }

    // Registers with the chosen distributor (or the saved/only one). False when there is none to use yet.
    fun enable(context: Context, distributor: String?): Boolean {
        val settings = SettingsStore(context)
        if (!distributor.isNullOrEmpty()) {
            UnifiedPush.saveDistributor(context, distributor)
        } else if (UnifiedPush.getSavedDistributor(context) == null) {
            val all = UnifiedPush.getDistributors(context)
            if (all.size != 1) return false
            UnifiedPush.saveDistributor(context, all[0])
        }
        settings.pushEnabled = true
        UnifiedPush.register(context)
        return true
    }

    fun disable(context: Context) {
        val settings = SettingsStore(context)
        val endpoint = settings.pushEndpoint
        settings.pushEnabled = false
        settings.pushEndpoint = null
        try { UnifiedPush.unregister(context) } catch (_: Exception) { /* nothing registered */ }
        if (endpoint != null) thread { sendToServer(context, "DELETE", endpoint) }
    }

    // Tells the MeshCrowd server where to wake this phone. Retried by the next registration if it fails.
    fun sendToServer(context: Context, method: String, endpoint: String): Boolean {
        val settings = SettingsStore(context)
        val origin = settings.origin ?: return false
        val cookie = CookieManager.getInstance().getCookie(origin)
        if (cookie.isNullOrEmpty()) return false
        val body = JSONObject().put("endpoint", endpoint).put("label", android.os.Build.MODEL ?: "Android").toString()
        return try {
            Net.send(method, "$origin/api/push/endpoint", settings.pin, cookie, body).code in 200..299
        } catch (_: Exception) {
            false
        }
    }
}
