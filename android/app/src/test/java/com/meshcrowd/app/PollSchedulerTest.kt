package com.meshcrowd.app

import org.junit.Assert.assertEquals
import org.junit.Test

class PollSchedulerTest {
    @Test fun workManagerIntervalNeverBelowFifteenMinutes() {
        assertEquals(15L, PollScheduler.workIntervalMinutes(1))
        assertEquals(15L, PollScheduler.workIntervalMinutes(15))
        assertEquals(45L, PollScheduler.workIntervalMinutes(45))
        assertEquals(15L, PollScheduler.workIntervalMinutes(-3))
    }

    @Test fun foregroundServiceAllowsOneMinute() {
        assertEquals(60_000L, PollScheduler.serviceIntervalMillis(1))
        assertEquals(60_000L, PollScheduler.serviceIntervalMillis(0))
        assertEquals(300_000L, PollScheduler.serviceIntervalMillis(5))
    }

    @Test fun settingsAreClamped() {
        assertEquals(1, PollScheduler.clampMinutes(0))
        assertEquals(1440, PollScheduler.clampMinutes(99999))
        assertEquals(30, PollScheduler.clampMinutes(30))
    }
}

class DownloadsNameTest {
    @Test fun serverStoragePrefixAndUnsafeCharactersAreRemoved() {
        assertEquals("report.txt", Downloads.safeName("cbe937affccb1c4f-report.txt"))
        assertEquals("notes-final.txt", Downloads.safeName("0123456789abcdef0123456789abcdef-notes-final.txt"))
        assertEquals("a_b.txt", Downloads.safeName("a:b.txt"))
        assertEquals("evil.txt", Downloads.safeName("../../evil.txt"))
        assertEquals("download", Downloads.safeName("   "))
        assertEquals("my-file.txt", Downloads.safeName("my-file.txt"))
    }
}
