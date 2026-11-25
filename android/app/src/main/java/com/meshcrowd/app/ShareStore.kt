package com.meshcrowd.app

import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom

data class SharedFile(val id: String, val uri: String, val name: String, val mime: String, val size: Long)

// The one share that is waiting for the page to pick a destination. Files are handed to the page by opaque id and are
// only ever served for the pending share, so a page cannot ask for an arbitrary uri.
object ShareStore {
    private val random = SecureRandom()
    private var text = ""
    private var subject = ""
    private var files: List<SharedFile> = emptyList()
    private var pending = false
    private var preselect: String? = null

    @Synchronized
    fun set(item: ShareItem, meta: (String) -> Triple<String, String, Long>, target: String? = null) {
        text = item.text
        subject = item.subject
        files = item.uris.map { uri ->
            val (name, mime, size) = meta(uri)
            SharedFile(newId(), uri, name, mime.ifEmpty { item.mime.ifEmpty { "application/octet-stream" } }, size)
        }
        pending = true
        preselect = target
    }

    @Synchronized
    fun hasPending(): Boolean = pending

    // Returns the pending share as JSON for the page, once; nothing is pending afterwards, but its files stay
    // readable until clear() so the page can still download them.
    @Synchronized
    fun take(): String {
        if (!pending) return ""
        pending = false
        val json = JSONObject().put("text", text).put("subject", subject)
        val arr = JSONArray()
        for (f in files) arr.put(JSONObject().put("id", f.id).put("name", f.name).put("mime", f.mime).put("size", f.size))
        json.put("files", arr)
        preselect?.let { json.put("target", it) }
        return json.toString()
    }

    @Synchronized
    fun fileFor(id: String): SharedFile? = files.firstOrNull { it.id == id }

    @Synchronized
    fun clear() {
        text = ""; subject = ""; files = emptyList(); pending = false; preselect = null
    }

    private fun newId(): String = ByteArray(9).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) }
}
