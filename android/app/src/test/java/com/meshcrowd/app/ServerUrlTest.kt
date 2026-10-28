package com.meshcrowd.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerUrlTest {
    @Test fun bareHostTriesHttpsThenHttp() {
        assertEquals(listOf("https://chat.example.com", "http://chat.example.com"), ServerUrl.candidates("chat.example.com"))
    }

    @Test fun portIsKept() {
        assertEquals(listOf("https://192.168.1.44:8443", "http://192.168.1.44:8443"), ServerUrl.candidates(" 192.168.1.44:8443 "))
    }

    @Test fun explicitSchemeIsRespectedAndPathsAreDropped() {
        assertEquals(listOf("http://10.0.2.2:8099"), ServerUrl.candidates("http://10.0.2.2:8099/m/?x=1"))
        assertEquals(listOf("https://a.example"), ServerUrl.candidates("HTTPS://a.example/"))
    }

    @Test fun junkIsRejected() {
        assertTrue(ServerUrl.candidates("").isEmpty())
        assertTrue(ServerUrl.candidates("   ").isEmpty())
        assertTrue(ServerUrl.candidates("not a host").isEmpty())
        assertTrue(ServerUrl.candidates("ftp://x.example").isEmpty())
        assertTrue(ServerUrl.candidates("user:pw@host.example").isEmpty())
        assertTrue(ServerUrl.candidates("http://").isEmpty())
    }

    @Test fun cleartextDetection() {
        assertTrue(ServerUrl.isCleartext("http://x"))
        assertTrue(!ServerUrl.isCleartext("https://x"))
    }
}
