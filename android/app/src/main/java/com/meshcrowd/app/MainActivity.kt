package com.meshcrowd.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import android.net.http.SslCertificate
import android.widget.FrameLayout

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var settings: SettingsStore
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var offlineShown = false

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data
        val uris: Array<Uri>? = if (result.resultCode == Activity.RESULT_OK && data != null) {
            val clip = data.clipData
            when {
                clip != null -> Array(clip.itemCount) { clip.getItemAt(it).uri }
                data.data != null -> arrayOf(data.data!!)
                else -> null
            }
        } else null
        fileCallback?.onReceiveValue(uris)
        fileCallback = null
    }

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }
    private val askStorage = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }
    private var mediaRequest: PermissionRequest? = null
    private val askMedia = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        val req = mediaRequest ?: return@registerForActivityResult
        mediaRequest = null
        val ok = grantableResources(req)
        if (ok.isEmpty()) req.deny() else req.grant(ok)
    }
    private var inCall = false

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = SettingsStore(this)
        val invite = InviteLink.parse(intent?.dataString)
        if (!settings.configured) {
            startActivity(setupIntent(invite))
            finish()
            return
        }
        NotificationHelper.createChannels(this)
        requestRuntimePermissions()

        webView = WebView(this).apply {
            isFocusable = true
            isFocusableInTouchMode = true
            setBackgroundColor(0xFF1E1F22.toInt())
        }
        // Android 15 draws apps edge-to-edge: pad the page by the system bars and the keyboard ourselves,
        // so the tab bar clears the gesture bar and the composer rises above the soft keyboard.
        val container = FrameLayout(this).apply { setBackgroundColor(0xFF1E1F22.toInt()) }
        container.addView(webView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(container)
        ViewCompat.setOnApplyWindowInsetsListener(container) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        configureWebView()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (offlineShown) { moveTaskToBack(true); return }
                // The page owns its own back stack (sheets, screens); it answers whether it used the press.
                webView.evaluateJavascript("(function(){return window.__mcBack ? window.__mcBack() : false;})()") { handled ->
                    if (handled != "true") moveTaskToBack(true)
                }
            }
        })

        PollControl.apply(this)
        val sameServer = invite != null && InviteLink.sameServer(invite, settings.origin)
        loadApp(intent?.getStringExtra(NotificationHelper.EXTRA_DEEP_LINK) ?: if (sameServer) InviteLink.hash(invite!!) else null)
        if (invite != null && !sameServer) confirmSwitchServer(invite)
    }

    private fun setupIntent(invite: InviteLink.Link?) = Intent(this, SetupActivity::class.java).apply {
        if (invite != null) {
            putExtra(SetupActivity.EXTRA_ADDRESS, invite.host)
            putExtra(SetupActivity.EXTRA_INVITE_HASH, InviteLink.hash(invite))
        }
    }

    // Never switches by itself: the user confirms here, presses Connect in setup (which handles https/http and
    // self-signed trust) and then confirms the join in the page.
    private fun confirmSwitchServer(invite: InviteLink.Link) {
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle(R.string.invite_switch_title)
            .setMessage(getString(R.string.invite_switch_body, invite.host))
            .setPositiveButton(R.string.invite_switch_continue) { _, _ -> startActivity(setupIntent(invite)) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        val s = webView.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.mediaPlaybackRequiresUserGesture = false
        s.allowFileAccess = false
        s.allowContentAccess = false
        s.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        s.setSupportMultipleWindows(false)
        s.userAgentString = s.userAgentString + " MeshCrowdAndroid/" + BuildConfig.VERSION_NAME
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)

        webView.addJavascriptInterface(AndroidBridge(this), "MeshCrowdAndroid")
        webView.webViewClient = ShellClient()
        webView.webChromeClient = ShellChrome()
        webView.setDownloadListener { url, userAgent, disposition, mime, _ ->
            if (url.startsWith("blob:")) saveBlob(url, Downloads.nameFor(url, disposition, mime), mime)
            else Downloads.downloadUrl(this, url, userAgent, disposition, mime)
        }
        // Tapping the page must always be able to raise the soft keyboard.
        webView.setOnTouchListener { v, _ -> if (!v.hasFocus()) v.requestFocus(); false }
    }

    fun loadApp(deepLink: String?) {
        val origin = settings.origin ?: return
        offlineShown = false
        // The server picks the mobile UI from the user agent; /m/ is requested directly to skip a redirect.
        webView.loadUrl(origin + "/m/" + (deepLink ?: ""))
        webView.requestFocus()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val invite = InviteLink.parse(intent.dataString)
        if (invite != null && ::webView.isInitialized) {
            if (InviteLink.sameServer(invite, settings.origin)) {
                webView.evaluateJavascript("location.hash = ${org.json.JSONObject.quote(InviteLink.hash(invite).removePrefix("#"))};", null)
            } else confirmSwitchServer(invite)
            return
        }
        val link = intent.getStringExtra(NotificationHelper.EXTRA_DEEP_LINK) ?: return
        if (!::webView.isInitialized) return
        val hash = link.removePrefix("#")
        // The running page listens to hashchange (web/m/lib/deepLink.mjs), so no reload is needed.
        webView.evaluateJavascript("location.hash = ${org.json.JSONObject.quote(hash)};", null)
    }

    override fun onStart() {
        super.onStart()
        NotificationPoller.appVisible = true
    }

    override fun onStop() {
        NotificationPoller.appVisible = false
        CookieManager.getInstance().flush() // so the background poller sees the current session cookie
        super.onStop()
    }

    fun setInCall(on: Boolean) {
        if (on == inCall) return
        inCall = on
        val svc = Intent(this, CallService::class.java)
        if (on) {
            CallAudio.enter(this)
            // The microphone foreground type needs the permission first; without it the page could not capture anyway.
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                try { ContextCompat.startForegroundService(this, svc) } catch (_: Exception) { /* not allowed right now; the call still works while visible */ }
            }
        } else {
            stopService(svc)
            CallAudio.leave(this)
        }
    }

    private fun neededPermission(resource: String): String? = when (resource) {
        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
        else -> null
    }

    private fun grantableResources(req: PermissionRequest): Array<String> = req.resources.filter { r ->
        val p = neededPermission(r)
        p != null && ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED
    }.toTypedArray()

    private fun handleMediaRequest(req: PermissionRequest) {
        val origin = settings.origin
        if (origin == null || !req.origin.toString().trimEnd('/').equals(origin.trimEnd('/'), ignoreCase = true)) { req.deny(); return }
        val missing = req.resources.mapNotNull { neededPermission(it) }.distinct()
            .filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) {
            val ok = grantableResources(req)
            if (ok.isEmpty()) req.deny() else req.grant(ok)
            return
        }
        mediaRequest?.deny()
        mediaRequest = req
        askMedia.launch(missing.toTypedArray())
    }

    override fun onDestroy() {
        if (inCall) setInCall(false)
        if (::webView.isInitialized) {
            (webView.parent as? android.view.ViewGroup)?.removeView(webView)
            webView.destroy()
        }
        super.onDestroy()
    }

    private fun requestRuntimePermissions() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        if (Build.VERSION.SDK_INT < 29 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED
        ) askStorage.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
    }

    // blob: downloads (decrypted encrypted-DM attachments) exist only inside the page: read them there and hand the bytes over.
    private fun saveBlob(url: String, name: String, mime: String?) {
        val js = """
            (function(){
              fetch(${org.json.JSONObject.quote(url)}).then(function(r){return r.blob();}).then(function(b){
                var fr = new FileReader();
                fr.onload = function(){ MeshCrowdAndroid.saveFile(String(fr.result).split(',')[1] || '', ${org.json.JSONObject.quote(name)}, b.type || ${org.json.JSONObject.quote(mime ?: "")}); };
                fr.readAsDataURL(b);
              });
            })();
        """.trimIndent()
        webView.post { webView.evaluateJavascript(js, null) }
    }

    private inner class ShellClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            val origin = settings.origin ?: return false
            val sameOrigin = url.toString().startsWith(origin)
            if (sameOrigin || url.scheme == "file" || url.scheme == "blob") return false
            if (url.scheme == "http" || url.scheme == "https" || url.scheme == "mailto" || url.scheme == "tel") {
                try { startActivity(Intent(Intent.ACTION_VIEW, url)) } catch (_: Exception) { /* no app to handle it */ }
            }
            return true
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            val der = SslCertificate.saveState(error.certificate)?.getByteArray("x509-certificate")
            val pin = settings.pin
            if (pin != null && der != null && PinnedTls.sameFingerprint(PinnedTls.fingerprint(der), pin)) handler.proceed() else handler.cancel()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame && !offlineShown) {
                offlineShown = true
                view.loadUrl("file:///android_asset/offline.html")
            }
        }

        override fun onPageFinished(view: WebView, url: String) {
            CookieManager.getInstance().flush()
        }
    }

    private inner class ShellChrome : WebChromeClient() {
        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            return try {
                pickFiles.launch(params.createIntent())
                true
            } catch (_: Exception) {
                fileCallback = null
                false
            }
        }

        // Microphone and camera for voice/video rooms, for the configured server origin only.
        override fun onPermissionRequest(request: PermissionRequest) { runOnUiThread { handleMediaRequest(request) } }

        override fun onPermissionRequestCanceled(request: PermissionRequest) { if (mediaRequest === request) mediaRequest = null }
    }
}
