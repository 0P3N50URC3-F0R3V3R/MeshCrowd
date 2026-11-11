package com.meshcrowd.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

object NotificationHelper {
    const val CHANNEL_MESSAGES = "messages"
    const val CHANNEL_SERVICE = "service"
    // v2: the original "downloads" channel was IMPORTANCE_LOW and users never noticed it; channel importance cannot be raised once created.
    const val CHANNEL_DOWNLOADS = "downloads_v2"
    const val EXTRA_DEEP_LINK = "deepLink"
    private const val EXTRA_READ_SCOPE = "readScope"
    private const val EXTRA_MESSAGE_ID = "messageId"

    fun createChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_MESSAGES, context.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH))
        nm.createNotificationChannel(NotificationChannel(CHANNEL_SERVICE, context.getString(R.string.channel_service), NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(CHANNEL_DOWNLOADS, context.getString(R.string.channel_downloads), NotificationManager.IMPORTANCE_DEFAULT))
        nm.deleteNotificationChannel("downloads")
    }

    private fun canNotify(context: Context) = NotificationManagerCompat.from(context).areNotificationsEnabled()

    fun openAppIntent(context: Context, deepLink: String?, requestCode: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (deepLink != null) intent.putExtra(EXTRA_DEEP_LINK, deepLink)
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    // Android 14+ lets users swipe away foreground-service notifications; swiping re-enters the service, which re-posts it.
    private fun repostIntent(context: Context): PendingIntent {
        val intent = Intent(context, PollService::class.java)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return if (Build.VERSION.SDK_INT >= 26) PendingIntent.getForegroundService(context, 2, intent, flags)
        else PendingIntent.getService(context, 2, intent, flags)
    }

    fun showMessage(context: Context, m: NotificationMapper.Mapped) {
        if (!canNotify(context)) return
        val builder = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(m.title)
            .setContentText(m.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(m.body))
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setGroup(m.scopeKey)
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(context, m.deepLink, m.scopeKey.hashCode()))
            .addExtras(android.os.Bundle().apply { putString(EXTRA_READ_SCOPE, m.readScope); putLong(EXTRA_MESSAGE_ID, m.messageId) })
        @Suppress("MissingPermission")
        NotificationManagerCompat.from(context).notify(m.scopeKey, m.scopeKey.hashCode(), builder.build())
    }

    // The user read these on another device since the notification was posted.
    fun cancelRead(context: Context, lastRead: Map<String, Long>) {
        if (lastRead.isEmpty()) return
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.activeNotifications.filter { it.notification.channelId == CHANNEL_MESSAGES }.forEach {
            val extras = it.notification.extras
            if (NotificationMapper.isRetiredBy(extras.getString(EXTRA_READ_SCOPE).orEmpty(), extras.getLong(EXTRA_MESSAGE_ID, -1), lastRead)) nm.cancel(it.tag, it.id)
        }
    }

    // Opening the app is how the user sees what the background poller announced; leaving those
    // notifications up afterwards made the shade keep showing messages that were already read.
    fun cancelMessages(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.activeNotifications.filter { it.notification.channelId == CHANNEL_MESSAGES }.forEach { nm.cancel(it.tag, it.id) }
    }

    fun serviceNotification(context: Context): Notification =
        NotificationCompat.Builder(context, CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.service_title))
            .setContentText(context.getString(R.string.service_text))
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openAppIntent(context, null, 1))
            .setDeleteIntent(repostIntent(context))
            .build()

    fun showDownloadProgress(context: Context, id: Int, name: String, done: Long, total: Long) {
        if (!canNotify(context)) return
        val n = NotificationCompat.Builder(context, CHANNEL_DOWNLOADS)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(context.getString(R.string.download_progress))
            .setContentText(name)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setProgress(if (total > 0) 100 else 0, if (total > 0) (done * 100 / total).toInt() else 0, total <= 0)
            .build()
        @Suppress("MissingPermission")
        NotificationManagerCompat.from(context).notify(id, n)
    }

    fun cancelDownload(context: Context, id: Int) = NotificationManagerCompat.from(context).cancel(id)

    fun showDownloaded(context: Context, id: Int, name: String, uri: Uri, mime: String) {
        if (!canNotify(context)) return
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val pending = PendingIntent.getActivity(context, uri.hashCode(), view, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(context, CHANNEL_DOWNLOADS)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(context.getString(R.string.download_done))
            .setContentText(name)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        @Suppress("MissingPermission")
        NotificationManagerCompat.from(context).notify(id, n)
    }
}
