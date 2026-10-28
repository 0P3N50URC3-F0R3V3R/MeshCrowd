package com.meshcrowd.app

import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.ByteArrayInputStream

// window.MeshCrowdAndroid: used by the server-served mobile UI (You tab, downloads). Only the
// configured origin is ever loaded into the WebView, so these methods are not reachable by other sites.
class AndroidBridge(private val activity: MainActivity) {
    private val settings = SettingsStore(activity)

    @JavascriptInterface
    fun getSettings(): String = JSONObject()
        .put("pollMinutes", settings.pollMinutes)
        .put("fastMode", settings.fastMode)
        .put("serverUrl", settings.origin ?: "")
        .put("version", BuildConfig.VERSION_NAME)
        .put("pushEnabled", settings.pushEnabled)
        .put("pushRegistered", settings.pushEndpoint != null)
        .toString()

    @JavascriptInterface
    fun setPollMinutes(minutes: Int) {
        settings.pollMinutes = minutes
        PollControl.apply(activity)
    }

    @JavascriptInterface
    fun setFastMode(on: Boolean) {
        settings.fastMode = on
        PollControl.apply(activity)
    }

    @JavascriptInterface
    fun saveFile(base64: String, name: String, mime: String): Boolean = try {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        Downloads.save(activity, name, Downloads.mimeFor(name, mime), ByteArrayInputStream(bytes))
        true
    } catch (_: Exception) {
        false
    }

    // Joined/left a voice or video call: communication audio mode plus a microphone foreground service.
    @JavascriptInterface
    fun setInCall(on: Boolean) {
        activity.runOnUiThread { activity.setInCall(on) }
    }

    @JavascriptInterface
    fun setSpeaker(on: Boolean) {
        activity.runOnUiThread { CallAudio.setSpeaker(activity, on) }
    }

    // UnifiedPush: installed distributors as [{id, label}], then enable with one of them ("" = the saved or only one).
    @JavascriptInterface
    fun pushDistributors(): String {
        val arr = org.json.JSONArray()
        for (d in PushControl.distributors(activity)) arr.put(JSONObject().put("id", d.id).put("label", d.label))
        return arr.toString()
    }

    @JavascriptInterface
    fun pushEnable(distributor: String): Boolean = PushControl.enable(activity, distributor)

    @JavascriptInterface
    fun pushDisable() {
        PushControl.disable(activity)
    }

    @JavascriptInterface
    fun changeServer() {
        activity.runOnUiThread { activity.startActivity(Intent(activity, SetupActivity::class.java).putExtra(SetupActivity.EXTRA_CHANGE, true)) }
    }

    @JavascriptInterface
    fun reload() {
        activity.runOnUiThread { activity.loadApp(null) }
    }

    // Opens the system screen where the user can exempt the app from battery optimisation.
    @JavascriptInterface
    fun openBatterySettings() {
        activity.runOnUiThread {
            val pm = activity.getSystemService(PowerManager::class.java)
            val intent = if (!pm.isIgnoringBatteryOptimizations(activity.packageName)) {
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).setData(Uri.parse("package:${activity.packageName}"))
            } else {
                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            }
            try { activity.startActivity(intent) } catch (_: Exception) { /* no such settings screen on this device */ }
        }
    }

}
