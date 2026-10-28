package com.meshcrowd.app

import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import kotlin.concurrent.thread

// Receives the distributor's events: a new endpoint is handed to the server, a push is a wake-up that
// triggers one normal notification check.
class PushReceiverService : PushService() {
    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        SettingsStore(applicationContext).pushEndpoint = endpoint.url
        thread { PushControl.sendToServer(applicationContext, "PUT", endpoint.url) }
    }

    override fun onMessage(message: PushMessage, instance: String) {
        thread {
            try { NotificationPoller.poll(applicationContext) } catch (_: Exception) { /* the periodic check still runs */ }
        }
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        SettingsStore(applicationContext).pushEnabled = false
    }

    override fun onUnregistered(instance: String) {
        SettingsStore(applicationContext).pushEndpoint = null
    }
}
