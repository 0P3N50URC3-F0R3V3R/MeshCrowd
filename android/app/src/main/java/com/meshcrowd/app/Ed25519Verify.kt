package com.meshcrowd.app

import java.math.BigInteger
import java.security.MessageDigest

// Ed25519 signature verification (RFC 8032) with BigInteger, so it works on every supported Android version:
// the platform Signature("Ed25519") only exists from Android 13. Public inputs only, so timing does not matter.
object Ed25519Verify {
    private val P = BigInteger.valueOf(2).pow(255) - BigInteger.valueOf(19)
    private val L = BigInteger.valueOf(2).pow(252) + BigInteger("27742317777372353535851937790883648493")
    private val D = (BigInteger.valueOf(-121665) * BigInteger.valueOf(121666).modInverse(P)).mod(P)
    private val D2 = (D * BigInteger.valueOf(2)).mod(P)
    private val SQRT_M1 = BigInteger.valueOf(2).modPow((P - BigInteger.ONE) / BigInteger.valueOf(4), P)

    private class Pt(val x: BigInteger, val y: BigInteger, val z: BigInteger, val t: BigInteger)

    private val IDENTITY = Pt(BigInteger.ZERO, BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO)

    private fun mod(v: BigInteger) = v.mod(P)

    private fun affine(x: BigInteger, y: BigInteger) = Pt(x, y, BigInteger.ONE, mod(x * y))

    private fun add(a: Pt, b: Pt): Pt {
        val aa = mod((a.y - a.x) * (b.y - b.x))
        val bb = mod((a.y + a.x) * (b.y + b.x))
        val cc = mod(a.t * D2 * b.t)
        val dd = mod(a.z * BigInteger.valueOf(2) * b.z)
        val e = bb - aa
        val f = dd - cc
        val g = dd + cc
        val h = bb + aa
        return Pt(mod(e * f), mod(g * h), mod(f * g), mod(e * h))
    }

    private fun mul(point: Pt, scalar: BigInteger): Pt {
        var result = IDENTITY
        var addend = point
        var k = scalar
        while (k.signum() > 0) {
            if (k.testBit(0)) result = add(result, addend)
            addend = add(addend, addend)
            k = k.shiftRight(1)
        }
        return result
    }

    private fun sameX(a: Pt, b: Pt) = mod(a.x * b.z) == mod(b.x * a.z) && mod(a.y * b.z) == mod(b.y * a.z)

    private fun littleEndian(bytes: ByteArray): BigInteger = BigInteger(1, bytes.reversedArray())

    private fun decode(bytes: ByteArray): Pt? {
        if (bytes.size != 32) return null
        val sign = (bytes[31].toInt() shr 7) and 1
        val y = littleEndian(bytes.copyOf().also { it[31] = (it[31].toInt() and 0x7f).toByte() })
        if (y >= P) return null
        val y2 = mod(y * y)
        val u = mod(y2 - BigInteger.ONE)
        val v = mod(D * y2 + BigInteger.ONE)
        val v3 = mod(v * v * v)
        val v7 = mod(v3 * v3 * v)
        var x = mod(u * v3 * (u * v7).modPow((P - BigInteger.valueOf(5)) / BigInteger.valueOf(8), P))
        val vx2 = mod(v * x * x)
        if (vx2 != u) {
            if (vx2 != mod(-u)) return null
            x = mod(x * SQRT_M1)
        }
        if (x.signum() == 0 && sign == 1) return null
        if (x.testBit(0) != (sign == 1)) x = mod(-x)
        return affine(x, y)
    }

    private val BASE: Pt = run {
        val y = mod(BigInteger.valueOf(4) * BigInteger.valueOf(5).modInverse(P))
        val enc = y.toByteArray().let { be -> ByteArray(32).also { out -> for (i in be.indices) if (be.size - 1 - i < 32) out[be.size - 1 - i] = be[i] } }
        decode(enc)!!
    }

    fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean {
        return try {
            if (publicKey.size != 32 || signature.size != 64) return false
            val a = decode(publicKey) ?: return false
            val r = decode(signature.copyOfRange(0, 32)) ?: return false
            val s = littleEndian(signature.copyOfRange(32, 64))
            if (s >= L) return false
            val digest = MessageDigest.getInstance("SHA-512")
            digest.update(signature, 0, 32)
            digest.update(publicKey)
            digest.update(message)
            val k = littleEndian(digest.digest()).mod(L)
            sameX(mul(BASE, s), add(r, mul(a, k)))
        } catch (_: Exception) {
            false
        }
    }
}
