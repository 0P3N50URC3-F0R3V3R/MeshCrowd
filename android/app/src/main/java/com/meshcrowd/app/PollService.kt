package com.meshcrowd.app

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

// "Fast mode": keeps a persistent notification and polls the server every N minutes (N >= 1).
class PollService : Service() {
    @Volatile private var running = false
    private var thread: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        NotificationHelper.createChannels(this)
        val notification = NotificationHelper.serviceNotification(this)
        if (Build.VERSION.SDK_INT >= 34) startForeground(SERVICE_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(SERVICE_ID, notification)
        if (!running) {
            running = true
            thread = Thread {
                while (running) {
                    try { NotificationPoller.poll(applicationContext) } catch (_: Exception) { /* try again next round */ }
                    val wait = PollScheduler.serviceIntervalMillis(SettingsStore(applicationContext).pollMinutes)
                    try { Thread.sleep(wait) } catch (_: InterruptedException) { /* settings changed or stopping */ }
                }
            }.also { it.isDaemon = true; it.start() }
        } else {
            thread?.interrupt() // new interval takes effect now
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        thread?.interrupt()
        super.onDestroy()
    }

    private companion object { const val SERVICE_ID = 4711 }
}
