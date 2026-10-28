package com.meshcrowd.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PinnedTlsTest {
    @Test fun fingerprintIsColonSeparatedUppercaseSha256() {
        // SHA-256 of the empty input.
        assertEquals(
            "E3:B0:C4:42:98:FC:1C:14:9A:FB:F4:C8:99:6F:B9:24:27:AE:41:E4:64:9B:93:4C:A4:95:99:1B:78:52:B8:55",
            PinnedTls.fingerprint(ByteArray(0)),
        )
    }

    @Test fun matchingIgnoresCaseAndSeparators() {
        val fp = PinnedTls.fingerprint(byteArrayOf(1, 2, 3))
        assertTrue(PinnedTls.sameFingerprint(fp, fp.lowercase().replace(":", "")))
        assertFalse(PinnedTls.sameFingerprint(fp, PinnedTls.fingerprint(byteArrayOf(1, 2, 4))))
        assertFalse(PinnedTls.sameFingerprint(fp, ""))
    }
}

class AcceptHostTest {
    private val der = byteArrayOf(9, 8, 7)

    @Test fun pinnedLeafIsAcceptedEvenWhenTheHostNameDoesNotMatch() {
        assertTrue(PinnedTls.acceptHost(PinnedTls.fingerprint(der), der, defaultVerified = false))
    }

    @Test fun otherwiseTheNormalHostNameCheckDecides() {
        assertTrue(PinnedTls.acceptHost(null, der, defaultVerified = true))
        assertFalse(PinnedTls.acceptHost(null, der, defaultVerified = false))
        assertFalse(PinnedTls.acceptHost("00:11", der, defaultVerified = false))
    }
}
