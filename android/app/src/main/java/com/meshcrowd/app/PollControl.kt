package com.meshcrowd.app

import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

class PollWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        NotificationPoller.poll(applicationContext)
        return Result.success()
    }
}

// Chooses between the two background modes from the stored settings:
//  - normal: WorkManager periodic work (battery friendly, at most every 15 minutes)
//  - fast:   a foreground service that polls every N minutes (down to 1) with a persistent notification
object PollControl {
    private const val WORK_NAME = "meshcrowd-poll"

    fun apply(context: Context) {
        val app = context.applicationContext
        val settings = SettingsStore(app)
        val work = WorkManager.getInstance(app)
        if (!settings.configured) {
            work.cancelUniqueWork(WORK_NAME)
            app.stopService(Intent(app, PollService::class.java))
            return
        }
        if (settings.fastMode) {
            work.cancelUniqueWork(WORK_NAME)
            val intent = Intent(app, PollService::class.java)
            if (Build.VERSION.SDK_INT >= 26) app.startForegroundService(intent) else app.startService(intent)
        } else {
            app.stopService(Intent(app, PollService::class.java))
            val request = PeriodicWorkRequestBuilder<PollWorker>(PollScheduler.workIntervalMinutes(settings.pollMinutes), TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            work.enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, request)
        }
    }
}
