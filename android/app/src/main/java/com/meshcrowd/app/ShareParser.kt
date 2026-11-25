package com.meshcrowd.app

// What another app shared with us (ACTION_SEND / ACTION_SEND_MULTIPLE), reduced to plain data so it can be tested
// without Android classes. Only content:// uris are kept: file:// and other schemes would let a sender point us at
// files we have no right to read.
data class ShareItem(val text: String, val subject: String, val uris: List<String>, val mime: String)

object ShareParser {
    const val MAX_FILES = 20
    const val MAX_TEXT = 15000
    const val MAX_SUBJECT = 200
    private const val SEND = "android.intent.action.SEND"
    private const val SEND_MULTIPLE = "android.intent.action.SEND_MULTIPLE"

    fun parse(action: String?, mime: String?, text: CharSequence?, subject: CharSequence?, streams: List<String>): ShareItem? {
        if (action != SEND && action != SEND_MULTIPLE) return null
        val uris = streams.map { it.trim() }.filter { it.startsWith("content://", ignoreCase = true) }.distinct().take(MAX_FILES)
        val cleanText = text?.toString()?.trim().orEmpty().take(MAX_TEXT)
        val cleanSubject = subject?.toString()?.replace(Regex("\\s+"), " ")?.trim().orEmpty().take(MAX_SUBJECT)
        if (cleanText.isEmpty() && uris.isEmpty()) return null
        return ShareItem(cleanText, cleanSubject, uris, mime?.trim().orEmpty())
    }
}
