package com.meshcrowd.app

import org.json.JSONObject

object NotificationMapper {
    data class Labels(val encrypted: String, val attachment: String, val pinned: String = "%1\$s pinned a message", val thread: String = "%1\$s started a thread on your message", val sticker: String = "Sent a sticker")

    data class Mapped(
        val id: Long,
        val title: String,
        val body: String,
        val scopeKey: String,
        val deepLink: String,
        val mentioned: Boolean,
        // The read-state scope ("dm:11", "channel:3", "thread:9") and the message this notification shows,
        // so a later read position on another device can take it down again.
        val readScope: String = "",
        val messageId: Long = -1,
    )

    // Pin and thread-start events point at older messages, so reading never retires them.
    fun isRetiredBy(readScope: String, messageId: Long, lastRead: Map<String, Long>): Boolean {
        if (readScope.isEmpty() || messageId < 0) return false
        return (lastRead[readScope] ?: return false) >= messageId
    }

    fun readPositions(read: org.json.JSONArray?): Map<String, Long> {
        val out = HashMap<String, Long>()
        if (read == null) return out
        for (i in 0 until read.length()) {
            val r = read.optJSONObject(i) ?: continue
            val scopeType = r.optString("scopeType")
            val scopeId = r.optLong("scopeId", -1)
            if (scopeType.isEmpty() || scopeId < 0) continue
            out["$scopeType:$scopeId"] = r.optLong("lastReadMessageId", -1)
        }
        return out
    }

    private const val MAX_BODY = 200

    // The server's cursor endpoint for clients without an open WebSocket.
    fun pollUrl(origin: String, since: Long) = "$origin/api/notifications/poll?since=$since"

    // One outbox entry from GET /api/notifications -> what to show, or null if it is malformed.
    fun map(item: JSONObject, labels: Labels): Mapped? {
        val id = item.optLong("id", -1)
        val scopeType = item.optString("scopeType")
        val scopeId = item.optLong("scopeId", -1)
        val message = item.optJSONObject("message") ?: return null
        val messageId = message.optLong("id", -1)
        val kind = item.optString("kind")
        val actor = item.optJSONObject("actor")?.optString("displayName").orEmpty()
        val author = if (kind.isNotEmpty() && actor.isNotEmpty()) actor else message.optJSONObject("author")?.optString("displayName").orEmpty()
        if (id < 0 || scopeId < 0 || messageId < 0 || author.isEmpty()) return null
        if (scopeType != "dm" && scopeType != "channel") return null

        val body = when {
            kind == "thread" -> item.optString("threadTitle").ifEmpty { message.optString("content") }.take(MAX_BODY)
            message.optBoolean("isEncrypted") -> labels.encrypted
            message.optString("content").isNotEmpty() -> message.optString("content").take(MAX_BODY)
            (message.optJSONArray("attachments")?.length() ?: 0) > 0 -> labels.attachment
            message.optJSONObject("sticker") != null -> labels.sticker
            else -> ""
        }
        val mentioned = item.optBoolean("mentioned")
        val head = when (kind) { "pin" -> String.format(labels.pinned, author); "thread" -> String.format(labels.thread, author); else -> author }
        if (scopeType == "dm") {
            return Mapped(id, head, body, "dm:$scopeId", "#open=dm:$scopeId:$messageId", mentioned, if (kind.isEmpty()) "dm:$scopeId" else "", messageId)
        }
        val serverId = item.optLong("serverId", -1)
        val channel = item.optString("channelName")
        val server = item.optString("serverName")
        val title = buildString {
            append(head)
            if (channel.isNotEmpty()) append(" #").append(channel)
            if (server.isNotEmpty()) append(" (").append(server).append(')')
        }
        val inThread = message.optString("scopeType") == "thread"
        val link = if (inThread) {
            "#open=thread:$serverId:$scopeId:${message.optLong("scopeId")}:$messageId"
        } else {
            "#open=channel:$serverId:$scopeId:$messageId"
        }
        val readScope = when {
            kind.isNotEmpty() -> ""
            inThread -> "thread:${message.optLong("scopeId")}"
            else -> "channel:$scopeId"
        }
        return Mapped(id, title, body, "channel:$serverId:$scopeId", link, mentioned, readScope, messageId)
    }
}
