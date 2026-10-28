package com.meshcrowd.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InviteLinkTest {
    @Test fun parsesHostPortAndCodes() {
        assertEquals(InviteLink.Link("chat.example.com:8443", "abc12345"), InviteLink.parse("mcr://chat.example.com:8443/abc12345"))
        assertEquals(InviteLink.Link("chat.example.com", "my-server"), InviteLink.parse("MCR://Chat.Example.com/my-server/"))
        assertEquals(InviteLink.Link("192.168.1.10:8443", "abc"), InviteLink.parse("mcr://192.168.1.10:8443/abc"))
        assertEquals(InviteLink.Link("h.example", "abc@other.example"), InviteLink.parse("mcr://h.example/abc%40other.example"))
    }

    @Test fun rejectsHostileOrMalformedLinks() {
        for (bad in listOf("", "https://x/abc", "mcr://", "mcr://host", "mcr://host/", "mcr://u:p@host/abc", "mcr://host/abc?x=1",
            "mcr://host/abc#x", "mcr://host:99999/abc", "mcr://host/a b", "mcr://host/%E0%A4%A", "mcr://ho st/abc", "mcr://host/a/b",
            "mcr://" + "a".repeat(300) + "/x")) {
            assertNull(bad, InviteLink.parse(bad))
        }
        assertNull(InviteLink.parse(null))
    }

    @Test fun hashEncodesTheAtSign() {
        assertEquals("#invite=abc%40d.example", InviteLink.hash(InviteLink.Link("h.example", "abc@d.example")))
        assertEquals("#invite=abc", InviteLink.hash(InviteLink.Link("h.example", "abc")))
    }

    @Test fun sameServerComparesHostAndPort() {
        val link = InviteLink.Link("h.example:8443", "abc")
        assertTrue(InviteLink.sameServer(link, "https://h.example:8443"))
        assertTrue(InviteLink.sameServer(InviteLink.Link("h.example", "abc"), "https://h.example"))
        assertFalse(InviteLink.sameServer(link, "https://h.example"))
        assertFalse(InviteLink.sameServer(link, "https://other.example:8443"))
        assertFalse(InviteLink.sameServer(link, null))
    }
}
