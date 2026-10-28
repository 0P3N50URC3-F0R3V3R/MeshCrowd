package com.meshcrowd.app

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build

// Routes call audio: communication mode while in a call, loudspeaker or the default (earpiece/headset) route.
@Suppress("DEPRECATION")
object CallAudio {
    private fun am(c: Context) = c.getSystemService(AudioManager::class.java)

    fun enter(c: Context) { am(c).mode = AudioManager.MODE_IN_COMMUNICATION }

    fun leave(c: Context) {
        val a = am(c)
        if (Build.VERSION.SDK_INT >= 31) a.clearCommunicationDevice() else a.isSpeakerphoneOn = false
        a.mode = AudioManager.MODE_NORMAL
    }

    // Off means "system default route": earpiece, or a wired/Bluetooth headset when one is connected.
    fun setSpeaker(c: Context, on: Boolean) {
        val a = am(c)
        if (Build.VERSION.SDK_INT >= 31) {
            if (on) a.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }?.let { a.setCommunicationDevice(it) }
            else a.clearCommunicationDevice()
        } else {
            a.isSpeakerphoneOn = on
        }
    }
}
