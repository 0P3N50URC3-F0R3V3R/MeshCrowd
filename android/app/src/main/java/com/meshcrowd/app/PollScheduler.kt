package com.meshcrowd.app

object PollScheduler {
    const val MIN_WORK_MINUTES = 15L

    fun clampMinutes(minutes: Int) = minutes.coerceIn(1, 1440)

    // WorkManager periodic work cannot run more often than every 15 minutes.
    fun workIntervalMinutes(minutes: Int) = maxOf(MIN_WORK_MINUTES, minutes.toLong())

    // The foreground service loop can go down to one minute.
    fun serviceIntervalMillis(minutes: Int) = maxOf(1, minutes) * 60_000L
}
