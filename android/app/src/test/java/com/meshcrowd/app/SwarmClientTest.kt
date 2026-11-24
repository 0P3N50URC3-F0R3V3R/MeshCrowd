package com.meshcrowd.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.util.Base64

class SwarmClientTest {
    private val vector = "eyJ2IjoxLCJ1cmwiOiJodHRwczovL3ZlY3Rvci5leGFtcGxlLmNvbTo4NDQzIiwibmFtZSI6IlZlY3RvciIsImRlc2NyaXB0aW9uIjoiaW50ZXJvcCB0ZXN0IiwiaWNvbiI6bnVsbCwicmVnaXN0cmF0aW9uIjoiaW52aXRlIiwidXBkYXRlZCI6MTcwMDAwMDAwMDAwMCwicHViIjoicTh1OGFRRW1NXzVORDZ1LXM1bVdWcEltWk11SFFEanh0eHItVFlMT09fOCJ9.QZrmQkps9mznKHd0XYlqrMbW1sSWE2QEKhGrm4YVSCdeLCcG8koKIVheDIEOInQ1I0l864yDRueyjCDSicnKBw"
    private val enc = Base64.getUrlEncoder().withoutPadding()

    private fun keys(): KeyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()

    private fun make(over: Map<String, Any?> = emptyMap(), pair: KeyPair = keys()): String {
        val pub = enc.encodeToString(pair.public.encoded.takeLast(32).toByteArray())
        val fields = linkedMapOf<String, Any?>("v" to 1, "url" to "https://a.example.com", "name" to "A", "description" to "", "icon" to null,
            "registration" to "open", "updated" to 1000, "pub" to pub)
        fields.putAll(over)
        val json = org.json.JSONObject()
        for ((k, v) in fields) json.put(k, v ?: org.json.JSONObject.NULL)
        val payload = json.toString().toByteArray()
        val sig = Signature.getInstance("Ed25519").apply { initSign(pair.private); update(payload) }.sign()
        return enc.encodeToString(payload) + "." + enc.encodeToString(sig)
    }

    private fun edit(str: String, from: String, to: String): String {
        val (p, s) = str.split('.')
        return enc.encodeToString(String(Base64.getUrlDecoder().decode(p)).replace(from, to).toByteArray()) + "." + s
    }

    private fun feed(vararg byTracker: Pair<String, Any>): (String) -> String = { url ->
        val entry = byTracker.first { url.startsWith(it.first) }.second
        if (entry is Exception) throw entry
        @Suppress("UNCHECKED_CAST")
        val items = entry as List<Pair<String, Long>>
        val arr = org.json.JSONArray()
        for ((advert, seen) in items) arr.put(org.json.JSONObject().put("advert", advert).put("lastSeen", seen))
        org.json.JSONObject().put("servers", arr).toString()
    }

    private val t1 = "https://t1.example.com"
    private val t2 = "https://t2.example.com"
    private val t3 = "https://t3.example.com"

    @Test fun advertBuiltByAMeshCrowdServerVerifies() {
        val a = SwarmClient.verifyAdvert(vector)
        assertNotNull(a)
        assertEquals("Vector", a!!.name)
        assertEquals("invite", a.registration)
    }

    @Test fun tamperingAndBadShapesAreRefused() {
        assertNull(SwarmClient.verifyAdvert(edit(vector, "Vector", "Vecxor")))
        val good = make()
        val pub = org.json.JSONObject(String(Base64.getUrlDecoder().decode(good.split('.')[0]))).getString("pub")
        assertNull(SwarmClient.verifyAdvert(edit(good, pub, enc.encodeToString(ByteArray(32) { 7 }))))
        assertNull(SwarmClient.verifyAdvert(make(mapOf("url" to "http://a.example.com"))))
        assertNull(SwarmClient.verifyAdvert(make(mapOf("url" to org.json.JSONArray(listOf("https://a.example.com"))))))
        assertNull(SwarmClient.verifyAdvert(make(mapOf("description" to "x".repeat(40000)))))
        assertNull(SwarmClient.verifyAdvert(make(mapOf("name" to "a‮b"))))
        assertNull(SwarmClient.verifyAdvert(make(mapOf("registration" to "maybe"))))
        assertNull(SwarmClient.verifyAdvert("nonsense"))
    }

    @Test fun trackerLinesAreValidated() {
        assertEquals(listOf("https://a.example.com:19898", "https://b.example.com/swarm"), SwarmClient.normalizeTrackers(listOf(" https://A.example.com:19898/ ", "", "https://b.example.com/swarm/", "https://a.example.com:19898")))
        for (bad in listOf("http://a.example.com", "https://u:p@a.example.com", "https://a.example.com?x=1", "ftp://a", "nonsense", "javascript:1")) assertNull(bad, SwarmClient.normalizeTrackers(listOf(bad)))
        assertNull(SwarmClient.normalizeTrackers((1..21).map { "https://t$it.example.com" }))
        assertEquals(emptyList<String>(), SwarmClient.normalizeTrackers(emptyList()))
    }

    @Test fun aFailingTrackerOnlyAddsToErrors() {
        val adv = make(mapOf("url" to "https://s.example.com", "name" to "S"))
        val r = SwarmClient.loadList(listOf(t1, t2), feed(t1 to RuntimeException("down"), t2 to listOf(adv to 5L)))
        assertEquals(1, r.servers.size)
        assertEquals("S", r.servers[0].name)
        assertEquals(listOf(t1), r.errors.map { it.first })
    }

    @Test fun trackerListIsCappedAndFutureDatedEntriesDropped() {
        val pair = keys()
        val many = (0 until 700).map { make(mapOf("url" to "https://s$it.example.com"), pair) to 1L }
        assertEquals(500, SwarmClient.loadList(listOf(t1), feed(t1 to many)).servers.size)
        val future = make(mapOf("url" to "https://f.example.com", "updated" to 1_000_000L + 10 * 60_000L), pair)
        assertEquals(0, SwarmClient.loadList(listOf(t1), feed(t1 to listOf(future to 1L)), { 1_000_000L }).servers.size)
    }

    @Test fun theKeyMostTrackersAgreeOnWinsAndLastSeenIsTheMaximum() {
        val legit = make(mapOf("name" to "Legit", "updated" to 1000))
        val evil = make(mapOf("name" to "Evil", "updated" to 9000))
        val r = SwarmClient.loadList(listOf(t1, t2, t3), feed(t1 to listOf(evil to 3L), t2 to listOf(legit to 7L), t3 to listOf(legit to 9L)))
        assertEquals(1, r.servers.size)
        assertEquals("Legit", r.servers[0].name)
        assertEquals(9L, r.servers[0].lastSeen)
    }
}
