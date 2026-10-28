package com.meshcrowd.app

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.CookieManager
import android.webkit.MimeTypeMap
import android.webkit.URLUtil
import androidx.core.content.FileProvider
import java.io.File
import java.io.InputStream
import java.net.URLDecoder

// Saves downloaded files into the public Downloads folder (scoped storage: MediaStore on API 29+,
// the legacy public directory on API 26-28) and posts a "Downloaded" notification that opens the file.
object Downloads {
    fun safeName(raw: String): String {
        val cleaned = raw.substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001F]"), "_").trim().trim('.')
        // The server stores uploads as "<hex id>-<original name>"; show the original name.
        val unprefixed = cleaned.replace(Regex("^[0-9a-fA-F]{12,32}-(?=.)"), "")
        return unprefixed.ifEmpty { "download" }.take(120)
    }

    fun nameFor(url: String, contentDisposition: String?, mime: String?): String {
        val guessed = URLUtil.guessFileName(url, contentDisposition, mime)
        return safeName(runCatching { URLDecoder.decode(guessed, "UTF-8") }.getOrDefault(guessed))
    }

    fun mimeFor(name: String, hint: String?): String {
        if (!hint.isNullOrBlank() && hint != "application/octet-stream") return hint
        val ext = name.substringAfterLast('.', "").lowercase()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
    }

    fun save(context: Context, name: String, mime: String, input: InputStream): Uri {
        val safe = safeName(name)
        val resolver = context.contentResolver
        val uri: Uri
        if (Build.VERSION.SDK_INT >= 29) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, safe)
                put(MediaStore.Downloads.MIME_TYPE, mime)
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("MediaStore insert failed")
            resolver.openOutputStream(uri)?.use { out -> input.copyTo(out) } ?: error("cannot open output")
            resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        } else {
            val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS).also { it.mkdirs() }
            var target = File(dir, safe)
            var n = 1
            while (target.exists()) target = File(dir, "${safe.substringBeforeLast('.', safe)} ($n)${safe.substringAfterLast('.', "").let { if (it.isEmpty()) "" else ".$it" }}").also { n++ }
            target.outputStream().use { out -> input.copyTo(out) }
            uri = FileProvider.getUriForFile(context, "${context.packageName}.files", target)
        }
        NotificationHelper.showDownloaded(context, safe, uri, mime)
        return uri
    }

    // http(s) downloads go through our own (pin-aware) connection with the WebView's session cookie.
    fun downloadUrl(context: Context, url: String, userAgent: String?, contentDisposition: String?, mime: String?) {
        val settings = SettingsStore(context)
        Thread {
            try {
                val conn = Net.open(url, settings.pin, CookieManager.getInstance().getCookie(url), timeoutMs = 20000)
                if (!userAgent.isNullOrEmpty()) conn.setRequestProperty("User-Agent", userAgent)
                conn.setRequestProperty("Accept", "*/*")
                try {
                    if (conn.responseCode !in 200..299) return@Thread
                    val name = nameFor(url, contentDisposition ?: conn.getHeaderField("Content-Disposition"), mime ?: conn.contentType)
                    conn.inputStream.use { save(context, name, mimeFor(name, mime ?: conn.contentType?.substringBefore(';')), it) }
                } finally {
                    conn.disconnect()
                }
            } catch (_: Exception) {
                // The download simply does not happen; the page stays usable.
            }
        }.start()
    }
}
