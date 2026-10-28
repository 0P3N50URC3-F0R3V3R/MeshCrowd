package com.meshcrowd.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class NotificationMapperTest {
    private val labels = NotificationMapper.Labels(encrypted = "New encrypted message", attachment = "Sent an attachment")

    private fun item(json: String) = JSONObject(json)

    @Test fun channelMessageUsesAuthorChannelAndServer() {
        val m = NotificationMapper.map(item("""{"id":7,"scopeType":"channel","scopeId":3,"serverId":2,"serverName":"Dev","channelName":"general","mentioned":true,
            "message":{"id":50,"scopeType":"channel","scopeId":3,"content":"hello @you","author":{"displayName":"Alex"},"attachments":[]}}"""), labels)!!
        assertEquals("Alex #general (Dev)", m.title)
        assertEquals("hello @you", m.body)
        assertEquals("channel:2:3", m.scopeKey)
        assertEquals("#open=channel:2:3:50", m.deepLink)
        assertEquals(7L, m.id)
        assertEquals(true, m.mentioned)
    }

    @Test fun dmUsesAuthorOnlyAndDmLink() {
        val m = NotificationMapper.map(item("""{"id":8,"scopeType":"dm","scopeId":11,"mentioned":true,
            "message":{"id":60,"content":"psst","author":{"displayName":"Sam"},"attachments":[]}}"""), labels)!!
        assertEquals("Sam", m.title)
        assertEquals("dm:11", m.scopeKey)
        assertEquals("#open=dm:11:60", m.deepLink)
    }

    @Test fun encryptedMessagesNeverShowContent() {
        val m = NotificationMapper.map(item("""{"id":9,"scopeType":"dm","scopeId":11,
            "message":{"id":61,"isEncrypted":true,"content":"v1:CIPHERTEXT","author":{"displayName":"Sam"},"attachments":[]}}"""), labels)!!
        assertEquals("New encrypted message", m.body)
        assertFalse(m.body.contains("CIPHER"))
    }

    @Test fun attachmentOnlyAndLongContent() {
        val a = NotificationMapper.map(item("""{"id":1,"scopeType":"dm","scopeId":1,"message":{"id":2,"content":"","author":{"displayName":"A"},"attachments":[{"id":1}]}}"""), labels)!!
        assertEquals("Sent an attachment", a.body)
        val long = "x".repeat(500)
        val l = NotificationMapper.map(item("""{"id":1,"scopeType":"dm","scopeId":1,"message":{"id":2,"content":"$long","author":{"displayName":"A"},"attachments":[]}}"""), labels)!!
        assertEquals(200, l.body.length)
    }

    @Test fun threadMessagesLinkIntoTheThread() {
        val m = NotificationMapper.map(item("""{"id":2,"scopeType":"channel","scopeId":3,"serverId":2,"serverName":"Dev","channelName":"general",
            "message":{"id":70,"scopeType":"thread","scopeId":9,"content":"in thread","author":{"displayName":"Alex"},"attachments":[]}}"""), labels)!!
        assertEquals("#open=thread:2:3:9:70", m.deepLink)
    }

    @Test fun malformedItemsAreSkipped() {
        assertNull(NotificationMapper.map(item("""{"id":1}"""), labels))
        assertNull(NotificationMapper.map(item("""{"id":1,"scopeType":"dm","scopeId":1,"message":{}}"""), labels))
    }
}

class PollUrlTest {
    @Test fun pollUrlTargetsTheOutboxCursorEndpoint() {
        assertEquals("http://10.0.2.2:8099/api/notifications/poll?since=42", NotificationMapper.pollUrl("http://10.0.2.2:8099", 42))
        assertEquals("https://a.example/api/notifications/poll?since=0", NotificationMapper.pollUrl("https://a.example", 0))
    }
}
