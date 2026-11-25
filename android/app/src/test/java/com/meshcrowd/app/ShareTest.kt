package com.meshcrowd.app

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShareTest {
    private val send = "android.intent.action.SEND"
    private val multiple = "android.intent.action.SEND_MULTIPLE"

    @After fun reset() = ShareStore.clear()

    @Test fun aLinkAloneIsAShare() {
        val s = ShareParser.parse(send, "text/plain", "  https://example.com/a?b=1 ", null, emptyList())!!
        assertEquals("https://example.com/a?b=1", s.text)
        assertEquals("", s.subject)
        assertTrue(s.uris.isEmpty())
    }

    @Test fun textWithASubjectKeepsBoth() {
        val s = ShareParser.parse(send, "text/plain", "Read this", "  An   article\ntitle ", emptyList())!!
        assertEquals("Read this", s.text)
        assertEquals("An article title", s.subject)
    }

    @Test fun anImageIsAContentUri() {
        val s = ShareParser.parse(send, "image/png", null, null, listOf("content://media/external/images/media/7"))!!
        assertEquals(listOf("content://media/external/images/media/7"), s.uris)
        assertEquals("image/png", s.mime)
    }

    @Test fun severalFilesAreDeduplicatedAndCapped() {
        val many = (1..30).map { "content://p/f$it" } + "content://p/f1"
        val s = ShareParser.parse(multiple, "*/*", null, null, many)!!
        assertEquals(ShareParser.MAX_FILES, s.uris.size)
        assertEquals("content://p/f1", s.uris[0])
        assertEquals(s.uris.size, s.uris.toSet().size)
    }

    @Test fun onlyContentUrisAreAccepted() {
        assertNull(ShareParser.parse(send, "image/png", null, null, listOf("file:///sdcard/secret.db")))
        assertNull(ShareParser.parse(send, "image/png", null, null, listOf("http://x.example.com/a.png", "javascript:alert(1)", "intent:#Intent;end")))
        val s = ShareParser.parse(send, "image/png", "caption", null, listOf("file:///sdcard/x", "CONTENT://p/ok"))!!
        assertEquals(listOf("CONTENT://p/ok"), s.uris)
    }

    @Test fun emptyOrForeignSharesAreRefused() {
        assertNull(ShareParser.parse(send, "text/plain", "   ", null, emptyList()))
        assertNull(ShareParser.parse(send, "text/plain", null, "subject only", emptyList()))
        assertNull(ShareParser.parse("android.intent.action.VIEW", "text/plain", "https://x.example.com", null, emptyList()))
        assertNull(ShareParser.parse(null, null, "x", null, emptyList()))
    }

    @Test fun veryLongTextIsTruncated() {
        val s = ShareParser.parse(send, "text/plain", "x".repeat(ShareParser.MAX_TEXT + 500), "s".repeat(500), emptyList())!!
        assertEquals(ShareParser.MAX_TEXT, s.text.length)
        assertEquals(ShareParser.MAX_SUBJECT, s.subject.length)
    }

    private val meta = { uri: String -> Triple(uri.substringAfterLast('/') + ".png", "image/png", 123L) }

    @Test fun storeHandsOutOpaqueUniqueIdsAndConsumesOnce() {
        ShareStore.set(ShareParser.parse(multiple, "image/png", "hi", null, listOf("content://p/a", "content://p/b"))!!, meta)
        assertTrue(ShareStore.hasPending())
        val json = JSONObject(ShareStore.take())
        assertEquals("hi", json.getString("text"))
        val files = json.getJSONArray("files")
        assertEquals(2, files.length())
        val ids = (0 until 2).map { files.getJSONObject(it).getString("id") }
        assertEquals(2, ids.toSet().size)
        for (id in ids) { assertEquals(18, id.length); assertFalse(id.contains("content")) }
        assertEquals("a.png", files.getJSONObject(0).getString("name"))
        assertEquals("", ShareStore.take())
        assertFalse(ShareStore.hasPending())
    }

    @Test fun filesAreOnlyServedForTheCurrentShare() {
        ShareStore.set(ShareParser.parse(send, "image/png", null, null, listOf("content://p/a"))!!, meta)
        val id = JSONObject(ShareStore.take()).getJSONArray("files").getJSONObject(0).getString("id")
        assertNotNull(ShareStore.fileFor(id))
        assertEquals("content://p/a", ShareStore.fileFor(id)!!.uri)
        assertNull(ShareStore.fileFor("content://p/a"))
        assertNull(ShareStore.fileFor("000000000000000000"))
        ShareStore.set(ShareParser.parse(send, "image/png", null, null, listOf("content://p/z"))!!, meta)
        assertNull("an older share's file is gone", ShareStore.fileFor(id))
        ShareStore.clear()
        assertNull(ShareStore.fileFor(id))
    }

    @Test fun shortcutsKeepValidIdsOnly() {
        val json = """[{"id":"dm:5","label":"  Anna  Kiss "},{"id":"ch:2:9","label":"#general"},{"id":"dm:5","label":"dup"},
            {"id":"javascript:1","label":"x"},{"id":"dm:x","label":"y"},{"id":"dm:6","label":"  "},
            {"id":"dm:7","label":"a"},{"id":"dm:8","label":"b"},{"id":"dm:9","label":"c"}]"""
        val r = ShareShortcuts.parse(json)
        assertEquals(listOf("dm:5" to "Anna Kiss", "ch:2:9" to "#general", "dm:7" to "a", "dm:8" to "b"), r)
        assertTrue(ShareShortcuts.parse("not json").isEmpty())
        assertEquals(40, ShareShortcuts.parse("[{\"id\":\"dm:1\",\"label\":\"${"z".repeat(90)}\"}]")[0].second.length)
    }

    @Test fun aPreselectedTargetTravelsWithTheShare() {
        ShareStore.set(ShareParser.parse(send, "text/plain", "x", null, emptyList())!!, meta, "dm:5")
        assertEquals("dm:5", JSONObject(ShareStore.take()).getString("target"))
    }
}
