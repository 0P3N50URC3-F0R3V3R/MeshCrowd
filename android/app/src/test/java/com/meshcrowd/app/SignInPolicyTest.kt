package com.meshcrowd.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SignInPolicyTest {
    private fun entry(mode: String?) = KnownServer("https://a.example.com", "A", "", 1, mode, null)

    @Test fun asksOnlyWhenNeverAskedAndACookieExists() {
        assertTrue(SignInPolicy.shouldAsk(entry(null), true))
        assertFalse(SignInPolicy.shouldAsk(entry(null), false))
        assertFalse(SignInPolicy.shouldAsk(entry("keep"), true))
        assertFalse(SignInPolicy.shouldAsk(entry("session"), true))
        assertFalse(SignInPolicy.shouldAsk(null, true))
    }

    @Test fun cookieValueIsExtractedFromTheHeader() {
        assertEquals("xyz", SignInPolicy.cookieValue("a=1; dismesh_session=xyz; b=2"))
        assertEquals("xyz", SignInPolicy.cookieValue("dismesh_session=xyz"))
        assertNull(SignInPolicy.cookieValue("a=1; b=2"))
        assertNull(SignInPolicy.cookieValue("dismesh_session="))
        assertNull(SignInPolicy.cookieValue(null))
        assertNull(SignInPolicy.cookieValue("xdismesh_session=nope"))
    }

    @Test fun sessionOnlyCookieHasNoExpiryAndRefusesInjection() {
        val c = SignInPolicy.sessionOnlyCookie("abc123")
        assertEquals("dismesh_session=abc123; Path=/; HttpOnly", c)
        assertFalse(c.contains("Max-Age", ignoreCase = true))
        assertFalse(c.contains("Expires", ignoreCase = true))
        assertEquals("", SignInPolicy.sessionOnlyCookie("abc; Max-Age=999999"))
        assertEquals("", SignInPolicy.sessionOnlyCookie("a b"))
        assertEquals("", SignInPolicy.sessionOnlyCookie(""))
    }
}
