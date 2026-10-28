package com.meshcrowd.app

import java.security.MessageDigest

object PinnedTls {
    // SHA-256 of a DER certificate as AA:BB:... (the form shown to the user and stored as the pin).
    fun fingerprint(der: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(der).joinToString(":") { "%02X".format(it) }

    fun sameFingerprint(a: String, b: String): Boolean {
        fun norm(s: String) = s.filter { it.isLetterOrDigit() }.uppercase()
        return norm(a).isNotEmpty() && norm(a) == norm(b)
    }

    // A certificate the user pinned is identified by its fingerprint, not by its host name
    // (a self-signed certificate for "localhost" is reached as 10.0.2.2 or a LAN address).
    fun acceptHost(pin: String?, leafDer: ByteArray?, defaultVerified: Boolean): Boolean {
        if (defaultVerified) return true
        return pin != null && leafDer != null && sameFingerprint(fingerprint(leafDer), pin)
    }
}
