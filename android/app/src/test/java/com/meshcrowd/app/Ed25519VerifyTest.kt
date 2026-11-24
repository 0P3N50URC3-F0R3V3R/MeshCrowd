package com.meshcrowd.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class Ed25519VerifyTest {
    // First two are RFC 8032 section 7.1 vectors 1 and 2, the rest were signed by Node's crypto.
    private val vectors = listOf(
        Triple("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "", "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
        Triple("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72", "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"),
        Triple("e5cbef2d7e9f013a155caf47f17281cf9fc61f1f31fe85409a3491ce8d9c4d4c", "", "fa809453c30d55b8f6eec3d7bd6f7cd05873b5f299e47937e58446a6d8181492a8a00265aa6b0907fc5e6e28b180c104d3681fe985d054a184dc9f7843412e0b"),
        Triple("2569b49eac619318464abbf9d2ade68c250a28a0764855314e456af824d82cca", "92aa81227b", "9d282879aeb4b914cc2dcd6b93879b3d6defa9e2966dbd6b3b40eb38c07d3fb48cc1fad654e0bf74eb63bc364cd5456a29e445d78c5ae3b3ed7a856a7366a30a"),
        Triple("a99a71db2392e87734ca896e1608c0b33a61ff3230b606fa1c718cc93c5b8632", "fc468dc95e04afea3ac9cfbbf98ae9c2385c0b08e66fc9cc10744c5c6badf9f68b273762ac16fa631615f830fd4dfbdc6ef93ff30feca40e38029b0dd12cbea9", "5e9497cded9fa47d49a52e3af4990d7bf181c93f99b26f3300fd1836af018c31f07c15f92b8748208d39ddca5902dae1ebe1517d67793cc03bb704e4942c2106"),
        Triple("280148d728c59d47e9a90d4fb3dc0848f3af846359a5cc0cfd82833e637a9665", "ecf5ff36aecaf7318ccbbbcc7039ad09bd9f26f8408df70da80486836af91649fdce8ad212fcf6df30a76ccd45fce9fc6eaf9394995356286291f8edb405dcfea6b611007f20920885bd7a2acf695047885f2daff04631885809b65aa4d6989575de7df01269ca26d7523002079c38e2c69a97db0937092e18026c92327a5ae8c64e3d2d9cb1835a59b913ddd404f68a599b5fe6419405793dda224118d5e11d67a4808babbb0a014ab89a56e8ab167e2aafa0115daaa2e1f9075362b4cc4ae13655231ddba36a173d58ab3deb793a456e00fb1ff679f9307e94ddc7c70942a6490ac9988fbcf5b63c93bafbaf6147c194b6b70673f1990c90c463f8259b9f9565621de7f28e60f2bd3fa1f10a597dbc2e8ab086f1fe99732eba63e6190fea4c02e3e37137776e992cbb78f3", "67ea00bc9147b25b943b109c939ec217eda32678a1e27ec7699b8898f537c40f7ea049ea743aa6ede0cb964764428c0a8cea2bcee575a762283143f118dfc405"),
    )

    private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    @Test fun validSignaturesVerify() {
        for ((pk, msg, sig) in vectors) assertTrue(pk, Ed25519Verify.verify(hex(pk), hex(msg), hex(sig)))
    }

    @Test fun aFlippedBitFails() {
        for ((pk, msg, sig) in vectors) {
            val bad = hex(sig).also { it[10] = (it[10].toInt() xor 1).toByte() }
            assertFalse(Ed25519Verify.verify(hex(pk), hex(msg), bad))
            assertFalse(Ed25519Verify.verify(hex(pk), hex(msg) + byteArrayOf(1), hex(sig)))
        }
    }

    @Test fun malformedInputIsFalseNotAnException() {
        val (pk, msg, sig) = vectors[0]
        assertFalse(Ed25519Verify.verify(hex(pk).copyOf(31), hex(msg), hex(sig)))
        assertFalse(Ed25519Verify.verify(hex(pk), hex(msg), hex(sig).copyOf(63)))
        assertFalse(Ed25519Verify.verify(ByteArray(32) { 0xff.toByte() }, hex(msg), hex(sig)))
        val big = hex(sig).also { for (i in 32 until 64) it[i] = 0xff.toByte() }
        assertFalse(Ed25519Verify.verify(hex(pk), hex(msg), big))
        assertFalse(Ed25519Verify.verify(ByteArray(0), ByteArray(0), ByteArray(0)))
    }
}
