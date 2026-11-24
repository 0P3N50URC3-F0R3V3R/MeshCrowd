package com.meshcrowd.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class KnownServersTest {
    private fun add(list: List<KnownServer>, url: String, now: Long, name: String = "n", icon: String? = null, pin: String? = null) =
        KnownServers.upsert(list, url, name, icon, pin, now)

    @Test fun normalizeKeepsHttpOriginsOnly() {
        assertEquals("https://h.example.com:8443", KnownServers.normalizeOrigin("HTTPS://H.Example.com:8443/x?y=1"))
        assertEquals("http://192.168.1.10:8080", KnownServers.normalizeOrigin("http://192.168.1.10:8080"))
        for (bad in listOf("javascript:alert(1)", "file:///c:/x", "intent:#Intent;end", "content://x/y", "ftp://x", "https://u:p@x.example.com", "", " ", "nonsense", null)) {
            assertNull(bad, KnownServers.normalizeOrigin(bad))
        }
    }

    @Test fun upsertMovesToFrontAndKeepsSignInAndPin() {
        var list = add(emptyList(), "https://a.example.com/x", 1, "A", pin = "AA")
        list = add(list, "https://b.example.com", 2, "B")
        list = KnownServers.setSignIn(list, "https://a.example.com", "keep")
        list = add(list, "https://a.example.com", 3, "A renamed")
        assertEquals(listOf("https://a.example.com", "https://b.example.com"), list.map { it.url })
        assertEquals("A renamed", list[0].name)
        assertEquals("keep", list[0].signIn)
        assertEquals("AA", list[0].pin)
        assertEquals(3L, list[0].lastUsed)
        assertNull(list[1].signIn)
    }

    @Test fun upsertRefusesBadAddressAndCleansFields() {
        assertEquals(emptyList<KnownServer>(), add(emptyList(), "javascript:1", 1))
        val long = KnownServers.upsert(emptyList(), "https://a.example.com", "  ${"n".repeat(100)}\nx", "data:image/jpeg;base64,AAAA", null, 1)[0]
        assertEquals(60, long.name.length)
        assertEquals("", long.icon)
        val png = "data:image/png;base64," + "A".repeat(100)
        assertEquals(png, add(emptyList(), "https://a.example.com", 1, "a", png)[0].icon)
        assertEquals("", add(emptyList(), "https://a.example.com", 1, "a", "data:image/png;base64," + "A".repeat(30000))[0].icon)
        assertEquals("a.example.com:8443", KnownServers.upsert(emptyList(), "https://a.example.com:8443", "", null, null, 1)[0].name)
    }

    @Test fun listIsCappedAndOldestDropped() {
        var list = emptyList<KnownServer>()
        for (i in 0 until KnownServers.MAX + 5) list = add(list, "https://h$i.example.com", i.toLong())
        assertEquals(KnownServers.MAX, list.size)
        assertEquals("https://h${KnownServers.MAX + 4}.example.com", list[0].url)
        assertEquals(false, list.any { it.url == "https://h0.example.com" })
    }

    @Test fun removeAndSetSignIn() {
        val list = add(emptyList(), "https://a.example.com", 1)
        assertNull(KnownServers.setSignIn(list, "https://a.example.com", "bogus")[0].signIn)
        assertEquals("session", KnownServers.setSignIn(list, "https://a.example.com", "session")[0].signIn)
        assertNull(KnownServers.setSignIn(list, "https://nope.example.com", "keep")[0].signIn)
        assertEquals(emptyList<KnownServer>(), KnownServers.remove(list, "https://a.example.com/"))
        assertEquals(1, KnownServers.remove(list, "https://other.example.com").size)
    }

    @Test fun switchTargetAcceptsHttpsAndKnownHttpOnly() {
        val known = add(emptyList(), "http://lan.example.com:8080", 1)
        assertEquals("https://new.example.com", KnownServers.switchTarget("https://New.Example.com/path", known))
        assertEquals("http://lan.example.com:8080", KnownServers.switchTarget("http://lan.example.com:8080/x", known))
        assertNull(KnownServers.switchTarget("http://other.example.com", known))
        for (bad in listOf("javascript:alert(1)", "intent:#Intent;end", "file:///c:/x", "content://x", "data:text/html,x", "https://u:p@x.example.com", "", null)) {
            assertNull(bad, KnownServers.switchTarget(bad, known))
        }
    }

    @Test fun jsonRoundTripAndCorruptJson() {
        val list = add(add(emptyList(), "https://a.example.com", 1, "A", pin = "P"), "https://b.example.com", 2, "B")
        val again = KnownServers.fromJson(KnownServers.toJson(KnownServers.setSignIn(list, "https://a.example.com", "keep")))
        assertEquals(list.map { it.url }, again.map { it.url })
        assertEquals("keep", again.first { it.url == "https://a.example.com" }.signIn)
        assertEquals("P", again.first { it.url == "https://a.example.com" }.pin)
        assertEquals(emptyList<KnownServer>(), KnownServers.fromJson("{ not json"))
        assertEquals(emptyList<KnownServer>(), KnownServers.fromJson(null))
        assertEquals(emptyList<KnownServer>(), KnownServers.fromJson("[{\"url\":\"javascript:1\"}]"))
    }
}
