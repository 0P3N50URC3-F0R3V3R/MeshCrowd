package com.meshcrowd.app

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.inputmethod.EditorInfo
import android.graphics.BitmapFactory
import android.util.Base64
import android.widget.Button
import android.widget.ImageView
import android.widget.ScrollView
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.Switch
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
    private lateinit var knownBox: LinearLayout
    private lateinit var swarmBox: LinearLayout
    private var swarmLoad = 0

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
        knownBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(knownBox)
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
        addPublicSection(root, pad)
        val scroll = ScrollView(this).apply { isFillViewport = true; addView(root) }
        setContentView(scroll)
        renderKnown()
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            root.setPadding(pad + bars.left, pad + bars.top, pad + bars.right, pad + maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        input.requestFocus()
        if (intent.getBooleanExtra(EXTRA_AUTOCONNECT, false)) connect()
    }

    private fun addPublicSection(root: LinearLayout, pad: Int) {
        val toggle = Switch(this).apply {
            text = getString(R.string.setup_public_show)
            setTextColor(Color.WHITE)
            isChecked = settings.swarmShow
            setPadding(0, pad / 2, 0, 0)
        }
        root.addView(TextView(this).apply { text = getString(R.string.setup_public_title); setTextColor(Color.parseColor("#B5BAC1")); setPadding(0, pad, 0, 0) })
        root.addView(toggle)
        root.addView(TextView(this).apply { text = getString(R.string.setup_public_privacy); setTextColor(Color.parseColor("#80848E")); textSize = 12f })
        swarmBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = android.view.View.GONE }
        root.addView(swarmBox)
        toggle.setOnCheckedChangeListener { _, on -> settings.swarmShow = on; refreshPublic() }
        refreshPublic()
    }

    private fun refreshPublic() {
        swarmLoad++
        swarmBox.removeAllViews()
        if (!settings.swarmShow) { swarmBox.visibility = android.view.View.GONE; return }
        swarmBox.visibility = android.view.View.VISIBLE
        val mine = swarmLoad
        val dp = resources.displayMetrics.density
        val trackers = settings.swarmTrackers
        val note = TextView(this).apply { text = getString(R.string.setup_public_loading); setTextColor(Color.parseColor("#80848E")); setPadding(0, (dp * 8).toInt(), 0, 0) }
        swarmBox.addView(note)
        val listBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val scroller = ScrollView(this).apply {
            addView(listBox)
            setOnTouchListener { v, _ -> v.parent.requestDisallowInterceptTouchEvent(true); false }
        }
        swarmBox.addView(scroller)
        swarmBox.addView(Button(this).apply {
            text = getString(R.string.setup_public_trackers)
            setOnClickListener { editTrackers() }
        })
        if (trackers.isEmpty()) { note.text = getString(R.string.setup_public_unreachable); return }
        Thread {
            val result = SwarmClient.loadList(trackers, { url ->
                val res = Net.get(url, null)
                if (res.code != 200) throw java.io.IOException("answered ${res.code}")
                res.body
            })
            runOnUiThread {
                if (mine != swarmLoad || isFinishing) return@runOnUiThread
                note.text = when {
                    result.servers.isNotEmpty() -> ""
                    result.errors.size == trackers.size -> getString(R.string.setup_public_unreachable)
                    else -> getString(R.string.setup_public_empty)
                }
                for (e in result.servers) listBox.addView(publicRow(e))
                if (result.servers.size > 3) scroller.layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, (dp * 300).toInt())
            }
        }.start()
    }

    private fun ago(ms: Long): String {
        val mins = maxOf(0L, (System.currentTimeMillis() - ms) / 60000)
        return when {
            mins < 1 -> getString(R.string.setup_ago_now)
            mins < 60 -> getString(R.string.setup_ago_min, mins)
            mins < 48 * 60 -> getString(R.string.setup_ago_hour, mins / 60)
            else -> getString(R.string.setup_ago_day, mins / 1440)
        }
    }

    private fun publicRow(e: SwarmClient.Entry): android.view.View {
        val dp = resources.displayMetrics.density
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, (dp * 8).toInt(), 0, (dp * 8).toInt())
            setOnClickListener { input.setText(e.url); connect() }
        }
        val icon = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_CROP; setBackgroundColor(Color.parseColor("#2B2D31")) }
        e.icon?.let {
            try {
                val bytes = Base64.decode(it.substringAfter("base64,"), Base64.DEFAULT)
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let { bmp -> icon.setImageBitmap(bmp) }
            } catch (_: Exception) { /* empty tile */ }
        }
        row.addView(icon, LinearLayout.LayoutParams((dp * 40).toInt(), (dp * 40).toInt()))
        val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding((dp * 12).toInt(), 0, 0, 0) }
        texts.addView(TextView(this).apply { text = e.name; setTextColor(Color.WHITE); textSize = 16f })
        if (e.description.isNotEmpty()) texts.addView(TextView(this).apply { text = e.description; setTextColor(Color.parseColor("#B5BAC1")); textSize = 13f })
        val reg = when (e.registration) { "open" -> R.string.setup_reg_open; "invite" -> R.string.setup_reg_invite; else -> R.string.setup_reg_closed }
        texts.addView(TextView(this).apply {
            text = "${java.net.URI(e.url).authority} · ${getString(reg)} · ${getString(R.string.setup_online)} ${ago(e.lastSeen)} · ${getString(R.string.setup_updated)} ${ago(e.updated)}"
            setTextColor(Color.parseColor("#949BA4")); textSize = 12f
        })
        row.addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        return row
    }

    private fun editTrackers() {
        val field = EditText(this).apply {
            setText(settings.swarmTrackers.joinToString("\n"))
            setTextColor(Color.WHITE)
            minLines = 3
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_VARIATION_URI
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.setup_public_trackers)
            .setMessage(R.string.setup_public_trackers_hint)
            .setView(field)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                val list = SwarmClient.normalizeTrackers(field.text.toString().lines())
                if (list == null) status.text = getString(R.string.setup_public_trackers_bad) else { settings.swarmTrackers = list; status.text = ""; refreshPublic() }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun renderKnown() {
        knownBox.removeAllViews()
        val list = settings.knownServers
        if (list.isEmpty()) return
        val dp = resources.displayMetrics.density
        knownBox.addView(TextView(this).apply { text = getString(R.string.setup_known); setTextColor(Color.parseColor("#B5BAC1")); setPadding(0, 0, 0, (dp * 6).toInt()) })
        for (s in list) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, (dp * 6).toInt(), 0, (dp * 6).toInt())
                setOnClickListener { input.setText(s.url); busy(true); status.text = ""; Thread { probe(listOf(s.url), s.pin) }.start() }
                setOnLongClickListener { askRemove(s); true }
            }
            val icon = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_CROP; setBackgroundColor(Color.parseColor("#2B2D31")) }
            if (s.icon.isNotEmpty()) {
                try {
                    val bytes = Base64.decode(s.icon.substringAfter("base64,"), Base64.DEFAULT)
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let { icon.setImageBitmap(it) }
                } catch (_: Exception) { /* keep the empty tile */ }
            }
            row.addView(icon, LinearLayout.LayoutParams((dp * 40).toInt(), (dp * 40).toInt()))
            val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding((dp * 12).toInt(), 0, 0, 0) }
            texts.addView(TextView(this).apply { text = s.name; setTextColor(Color.WHITE); textSize = 16f; setSingleLine(); ellipsize = android.text.TextUtils.TruncateAt.END })
            texts.addView(TextView(this).apply { text = java.net.URI(s.url).authority; setTextColor(Color.parseColor("#949BA4")); textSize = 12f; setSingleLine(); ellipsize = android.text.TextUtils.TruncateAt.END })
            row.addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            knownBox.addView(row)
        }
        knownBox.addView(android.view.View(this), LinearLayout.LayoutParams(1, (dp * 12).toInt()))
    }

    private fun askRemove(s: KnownServer) {
        AlertDialog.Builder(this)
            .setTitle(R.string.setup_known_remove_title)
            .setMessage(getString(R.string.setup_known_remove_body, s.name))
            .setPositiveButton(R.string.setup_known_remove) { _, _ -> settings.knownServers = KnownServers.remove(settings.knownServers, s.url); renderKnown() }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
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
        val pin = KnownServers.find(settings.knownServers, candidates.first())?.pin
        Thread { probe(candidates, pin) }.start()
    }

    // Tries each origin (https first). A TLS failure on https offers to trust the certificate by fingerprint.
    private fun probe(candidates: List<String>, pin: String?) {
        var tlsProblem: String? = null
        for (origin in candidates) {
            try {
                val res = Net.get("$origin/api/config", pin)
                if (res.code == 200 && JSONObject(res.body).has("maxUploadMb")) {
                    val instance = JSONObject(res.body).optJSONObject("instance")
                    val name = instance?.optString("name")
                    val icon = if (instance?.optBoolean("hasIcon") == true) fetchIcon(origin, pin) else null
                    runOnUiThread { accept(origin, pin, name, icon) }
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

    private fun fetchIcon(origin: String, pin: String?): String? = try {
        Net.getBytes("$origin/instance/icon", pin, 17000)?.let { "data:image/png;base64," + Base64.encodeToString(it, Base64.NO_WRAP) }
    } catch (_: Exception) {
        null
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

    private fun accept(origin: String, pin: String?, name: String?, icon: String?) {
        settings.knownServers = KnownServers.setSignIn(KnownServers.upsert(settings.knownServers, origin, name, icon, pin, System.currentTimeMillis()), origin, "keep")
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
        const val EXTRA_AUTOCONNECT = "autoconnect"
        const val EXTRA_INVITE_HASH = "inviteHash"
    }
}
