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

    // URLUtil.guessFileName ignores the RFC 5987 "filename*=UTF-8''name" form the DM file route sends,
    // which saved every DM attachment as "<id>.bin".
    private fun extendedFilename(contentDisposition: String?): String? {
        val m = Regex("""filename\*\s*=\s*[^']*'[^']*'([^;]+)""", RegexOption.IGNORE_CASE).find(contentDisposition ?: return null) ?: return null
        return runCatching { URLDecoder.decode(m.groupValues[1].trim().trim('"').replace("+", "%2B"), "UTF-8") }.getOrNull()?.takeIf { it.isNotBlank() }
    }

    fun nameFor(url: String, contentDisposition: String?, mime: String?): String {
        extendedFilename(contentDisposition)?.let { return safeName(it) }
        val guessed = URLUtil.guessFileName(url, contentDisposition, mime)
        return safeName(runCatching { URLDecoder.decode(guessed, "UTF-8") }.getOrDefault(guessed))
    }

    fun mimeFor(name: String, hint: String?): String {
        if (!hint.isNullOrBlank() && hint != "application/octet-stream") return hint
        val ext = name.substringAfterLast('.', "").lowercase()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
    }

    fun save(context: Context, name: String, mime: String, input: InputStream, notifyId: Int = name.hashCode()): Uri {
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
        try { NotificationHelper.showDownloaded(context, notifyId, safe, uri, mime) } catch (_: Exception) { /* file is saved; the notification is a convenience */ }
        return uri
    }

    // http(s) downloads go through our own (pin-aware) connection with the WebView's session cookie.
    fun downloadUrl(context: Context, url: String, userAgent: String?, contentDisposition: String?, mime: String?) {
        val settings = SettingsStore(context)
        val main = android.os.Handler(android.os.Looper.getMainLooper())
        val notifyId = (System.nanoTime() and 0x7fffffff).toInt()
        fun toast(res: Int, arg: String) = main.post { android.widget.Toast.makeText(context, context.getString(res, arg), android.widget.Toast.LENGTH_LONG).show() }
        Thread {
            try {
                val conn = Net.open(url, settings.pin, CookieManager.getInstance().getCookie(url), timeoutMs = 20000)
                if (!userAgent.isNullOrEmpty()) conn.setRequestProperty("User-Agent", userAgent)
                conn.setRequestProperty("Accept", "*/*")
                try {
                    if (conn.responseCode !in 200..299) { NotificationHelper.cancelDownload(context, notifyId); toast(R.string.download_failed, "HTTP ${conn.responseCode}"); return@Thread }
                    val name = nameFor(url, contentDisposition ?: conn.getHeaderField("Content-Disposition"), mime ?: conn.contentType)
                    toast(R.string.download_started, name)
                    val total = conn.contentLengthLong
                    var done = 0L
                    var lastTick = 0L
                    NotificationHelper.showDownloadProgress(context, notifyId, name, 0, total)
                    val counted = object : java.io.FilterInputStream(conn.inputStream) {
                        override fun read(b: ByteArray, off: Int, len: Int): Int {
                            val n = super.read(b, off, len)
                            if (n > 0) {
                                done += n
                                val now = System.currentTimeMillis()
                                if (now - lastTick > 500) { lastTick = now; NotificationHelper.showDownloadProgress(context, notifyId, name, done, total) }
                            }
                            return n
                        }
                    }
                    counted.use { save(context, name, mimeFor(name, mime ?: conn.contentType?.substringBefore(';')), it, notifyId) }
                } finally {
                    conn.disconnect()
                }
            } catch (e: Exception) {
                NotificationHelper.cancelDownload(context, notifyId)
                toast(R.string.download_failed, e.message ?: e.javaClass.simpleName)
            }
        }.start()
    }
}
