package com.meshcrowd.app

import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

// Plain HTTPS/HTTP helpers shared by the setup check, the notification poller and downloads.
// A server certificate is accepted if the system trusts it OR its SHA-256 equals the pin the user approved.
object Net {
    class Response(val code: Int, val body: String)

    private fun systemTrustManager(): X509TrustManager {
        val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        factory.init(null as KeyStore?)
        return factory.trustManagers.filterIsInstance<X509TrustManager>().first()
    }

    fun socketFactory(pin: String?): SSLSocketFactory {
        val system = systemTrustManager()
        val manager = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = system.checkClientTrusted(chain, authType)
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                try {
                    system.checkServerTrusted(chain, authType)
                } catch (e: CertificateException) {
                    val leaf = chain.firstOrNull() ?: throw e
                    if (pin == null || !PinnedTls.sameFingerprint(PinnedTls.fingerprint(leaf.encoded), pin)) throw e
                }
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = system.acceptedIssuers
        }
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, arrayOf<TrustManager>(manager), null)
        return ctx.socketFactory
    }

    fun open(url: String, pin: String?, cookie: String? = null, timeoutMs: Int = 8000): HttpURLConnection {
        val conn = URL(url).openConnection() as HttpURLConnection
        if (conn is HttpsURLConnection) {
            conn.sslSocketFactory = socketFactory(pin)
            val default = HttpsURLConnection.getDefaultHostnameVerifier()
            conn.hostnameVerifier = HostnameVerifier { host, session ->
                PinnedTls.acceptHost(pin, session.peerCertificates.firstOrNull()?.encoded, default.verify(host, session))
            }
        }
        conn.connectTimeout = timeoutMs
        conn.readTimeout = timeoutMs
        conn.instanceFollowRedirects = false
        conn.setRequestProperty("Accept", "application/json")
        if (!cookie.isNullOrEmpty()) conn.setRequestProperty("Cookie", cookie)
        return conn
    }

    fun get(url: String, pin: String?, cookie: String? = null): Response {
        val conn = open(url, pin, cookie)
        try {
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            return Response(code, stream?.bufferedReader()?.use { it.readText() }.orEmpty())
        } finally {
            conn.disconnect()
        }
    }

    fun send(method: String, url: String, pin: String?, cookie: String?, json: String): Response {
        val conn = open(url, pin, cookie)
        try {
            conn.requestMethod = method
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use { it.write(json.toByteArray()) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            return Response(code, stream?.bufferedReader()?.use { it.readText() }.orEmpty())
        } finally {
            conn.disconnect()
        }
    }

    // Reads the server's leaf certificate WITHOUT validating it, only so the user can compare its
    // fingerprint and decide to trust it. Nothing is sent over this connection.
    fun peekLeafFingerprint(host: String, port: Int): String? {
        val trustAll = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, arrayOf<TrustManager>(trustAll), null)
        return try {
            ctx.socketFactory.createSocket(host, port).use { socket ->
                val ssl = socket as javax.net.ssl.SSLSocket
                ssl.soTimeout = 6000
                ssl.startHandshake()
                (ssl.session.peerCertificates.firstOrNull() as? X509Certificate)?.let { PinnedTls.fingerprint(it.encoded) }
            }
        } catch (_: Exception) {
            null
        }
    }
}
