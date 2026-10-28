package com.meshcrowd.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

// Foreground service held while a voice/video call is joined, so the microphone keeps working
// with the screen off or the app in the background (Android 14 requires the microphone type).
class CallService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel(CHANNEL_CALL, getString(R.string.channel_call), NotificationManager.IMPORTANCE_LOW))
        val n: Notification = NotificationCompat.Builder(this, CHANNEL_CALL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.call_title))
            .setContentText(getString(R.string.call_text))
            .setCategory(Notification.CATEGORY_CALL)
            .setOngoing(true)
            .setContentIntent(NotificationHelper.openAppIntent(this, null, 4712))
            .build()
        if (Build.VERSION.SDK_INT >= 30) startForeground(SERVICE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        else startForeground(SERVICE_ID, n)
        return START_NOT_STICKY
    }

    private companion object {
        const val SERVICE_ID = 4712
        const val CHANNEL_CALL = "call"
    }
}
