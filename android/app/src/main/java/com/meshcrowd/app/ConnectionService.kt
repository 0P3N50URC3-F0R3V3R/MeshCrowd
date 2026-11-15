package com.meshcrowd.app

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.app.NotificationManager
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

// Held while the app is in the background so the process keeps its priority and the CPU and Wi-Fi stay awake:
// the page's websocket then stays connected and the app is already current when the user returns.
class ConnectionService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    @Volatile private var online = true

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        NotificationHelper.createChannels(this)
        online = hasInternet(getSystemService(ConnectivityManager::class.java))
        val n = buildNotification(online)
        if (Build.VERSION.SDK_INT >= 34) startForeground(SERVICE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(SERVICE_ID, n)
        if (wakeLock == null) {
            wakeLock = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "meshcrowd:connection").apply { setReferenceCounted(false); acquire() }
        }
        if (wifiLock == null) {
            @Suppress("DEPRECATION")
            wifiLock = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
                .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "meshcrowd:connection").apply { setReferenceCounted(false); acquire() }
        }
        watchNetwork()
        return START_NOT_STICKY
    }

    private fun buildNotification(online: Boolean): Notification = NotificationCompat.Builder(this, NotificationHelper.CHANNEL_SERVICE)
        .setSmallIcon(R.drawable.ic_notification)
        .setContentTitle(getString(if (online) R.string.connection_title else R.string.connection_offline_title))
        .setContentText(getString(if (online) R.string.connection_text else R.string.connection_offline_text))
        .setOngoing(true)
        .setShowWhen(false)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .setContentIntent(NotificationHelper.openAppIntent(this, null, 4713))
        .build()

    // The notification must follow the real network: "connected" only while the default network can actually reach the internet.
    private fun hasInternet(cm: ConnectivityManager): Boolean {
        val caps = cm.getNetworkCapabilities(cm.activeNetwork ?: return false) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    private fun refresh(cm: ConnectivityManager) {
        val now = hasInternet(cm)
        if (now == online) return
        online = now
        getSystemService(NotificationManager::class.java).notify(SERVICE_ID, buildNotification(now))
    }

    private fun watchNetwork() {
        if (networkCallback != null) return
        val cm = getSystemService(ConnectivityManager::class.java)
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = refresh(cm)
            override fun onLost(network: Network) = refresh(cm)
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = refresh(cm)
        }
        try { cm.registerDefaultNetworkCallback(cb); networkCallback = cb } catch (_: Exception) { /* keep the static notification */ }
    }

    override fun onDestroy() {
        networkCallback?.let { try { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } catch (_: Exception) { /* already gone */ } }
        networkCallback = null
        wakeLock?.let { if (it.isHeld) it.release() }
        wifiLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        wifiLock = null
        super.onDestroy()
    }

    private companion object { const val SERVICE_ID = 4713 }
}
