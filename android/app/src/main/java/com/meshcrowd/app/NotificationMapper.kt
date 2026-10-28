package com.meshcrowd.app

import org.json.JSONObject

object NotificationMapper {
    data class Labels(val encrypted: String, val attachment: String)

    data class Mapped(
        val id: Long,
        val title: String,
        val body: String,
        val scopeKey: String,
        val deepLink: String,
        val mentioned: Boolean,
    )

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
        val author = message.optJSONObject("author")?.optString("displayName").orEmpty()
        if (id < 0 || scopeId < 0 || messageId < 0 || author.isEmpty()) return null
        if (scopeType != "dm" && scopeType != "channel") return null

        val body = when {
            message.optBoolean("isEncrypted") -> labels.encrypted
            message.optString("content").isNotEmpty() -> message.optString("content").take(MAX_BODY)
            (message.optJSONArray("attachments")?.length() ?: 0) > 0 -> labels.attachment
            else -> ""
        }
        val mentioned = item.optBoolean("mentioned")
        if (scopeType == "dm") {
            return Mapped(id, author, body, "dm:$scopeId", "#open=dm:$scopeId:$messageId", mentioned)
        }
        val serverId = item.optLong("serverId", -1)
        val channel = item.optString("channelName")
        val server = item.optString("serverName")
        val title = buildString {
            append(author)
            if (channel.isNotEmpty()) append(" #").append(channel)
            if (server.isNotEmpty()) append(" (").append(server).append(')')
        }
        val link = if (message.optString("scopeType") == "thread") {
            "#open=thread:$serverId:$scopeId:${message.optLong("scopeId")}:$messageId"
        } else {
            "#open=channel:$serverId:$scopeId:$messageId"
        }
        return Mapped(id, title, body, "channel:$serverId:$scopeId", link, mentioned)
    }
}
