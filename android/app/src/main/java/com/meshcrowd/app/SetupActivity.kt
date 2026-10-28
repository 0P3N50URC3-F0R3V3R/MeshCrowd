package com.meshcrowd.app

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
import java.net.URI
import javax.net.ssl.SSLException

// First run (and "change server"): enter the server address, verify it, optionally trust a self-signed certificate.
class SetupActivity : AppCompatActivity() {
    private lateinit var settings: SettingsStore
    private lateinit var input: EditText
    private lateinit var status: TextView
    private lateinit var button: Button
    private lateinit var progress: ProgressBar

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = SettingsStore(this)
        val pad = (resources.displayMetrics.density * 24).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(Color.parseColor("#1E1F22"))
        }
        root.addView(TextView(this).apply { text = getString(R.string.setup_title); textSize = 24f; setTextColor(Color.WHITE) })
        root.addView(TextView(this).apply { text = getString(R.string.setup_hint); setTextColor(Color.parseColor("#B5BAC1")); setPadding(0, pad / 2, 0, pad / 2) })
        input = EditText(this).apply {
            hint = getString(R.string.setup_placeholder)
            setHintTextColor(Color.parseColor("#80848E"))
            setTextColor(Color.WHITE)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            setSingleLine()
            setText(intent.getStringExtra(EXTRA_ADDRESS) ?: settings.origin ?: "")
            setOnEditorActionListener { _, actionId, _ -> if (actionId == EditorInfo.IME_ACTION_GO) { connect(); true } else false }
        }
        root.addView(input)
        button = Button(this).apply {
            text = getString(R.string.setup_connect)
            setBackgroundColor(Color.parseColor("#0D9488"))
            setTextColor(Color.WHITE)
            setOnClickListener { connect() }
        }
        root.addView(button)
        progress = ProgressBar(this).apply { visibility = android.view.View.GONE }
        root.addView(progress)
        status = TextView(this).apply { setTextColor(Color.parseColor("#F23F43")); setPadding(0, pad / 2, 0, 0) }
        root.addView(status)
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(pad + bars.left, pad + bars.top, pad + bars.right, pad + maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        input.requestFocus()
    }

    private fun busy(on: Boolean) {
        progress.visibility = if (on) android.view.View.VISIBLE else android.view.View.GONE
        button.isEnabled = !on
    }

    private fun connect() {
        val candidates = ServerUrl.candidates(input.text.toString())
        if (candidates.isEmpty()) { status.text = getString(R.string.setup_invalid); return }
        status.text = ""
        busy(true)
        Thread { probe(candidates, null) }.start()
    }

    // Tries each origin (https first). A TLS failure on https offers to trust the certificate by fingerprint.
    private fun probe(candidates: List<String>, pin: String?) {
        var tlsProblem: String? = null
        for (origin in candidates) {
            try {
                val res = Net.get("$origin/api/config", pin)
                if (res.code == 200 && JSONObject(res.body).has("maxUploadMb")) {
                    runOnUiThread { accept(origin, pin) }
                    return
                }
            } catch (e: SSLException) {
                tlsProblem = origin
            } catch (_: Exception) {
                // try the next candidate
            }
        }
        val failedTls = tlsProblem
        if (failedTls != null && pin == null) {
            val uri = URI(failedTls)
            val fp = Net.peekLeafFingerprint(uri.host, if (uri.port == -1) 443 else uri.port)
            if (fp != null) { runOnUiThread { askTrust(candidates, fp) }; return }
        }
        runOnUiThread { busy(false); status.text = getString(R.string.setup_failed) }
    }

    private fun askTrust(candidates: List<String>, fingerprint: String) {
        busy(false)
        AlertDialog.Builder(this)
            .setTitle(R.string.setup_untrusted_title)
            .setMessage(getString(R.string.setup_untrusted_body, fingerprint))
            .setPositiveButton(R.string.setup_trust) { _, _ -> busy(true); Thread { probe(candidates, fingerprint) }.start() }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun accept(origin: String, pin: String?) {
        if (settings.origin != origin) settings.lastNotificationId = 0
        settings.origin = origin
        settings.pin = pin
        busy(false)
        if (ServerUrl.isCleartext(origin)) {
            AlertDialog.Builder(this)
                .setMessage(R.string.setup_cleartext)
                .setPositiveButton(android.R.string.ok) { _, _ -> finishSetup() }
                .setCancelable(false)
                .show()
        } else {
            finishSetup()
        }
    }

    private fun finishSetup() {
        PollControl.apply(this)
        val next = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
        // An invite link that started the setup: the page asks for confirmation before joining.
        intent.getStringExtra(EXTRA_INVITE_HASH)?.let { next.putExtra(NotificationHelper.EXTRA_DEEP_LINK, it) }
        startActivity(next)
        finish()
    }

    companion object {
        const val EXTRA_CHANGE = "change"
        const val EXTRA_ADDRESS = "address"
        const val EXTRA_INVITE_HASH = "inviteHash"
    }
}
