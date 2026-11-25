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
import android.webkit.WebResourceResponse
import android.provider.OpenableColumns
import androidx.core.content.IntentCompat
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
    private var pendingAppUrl: String? = null
    private var loadedOrigin: String? = null
    private var launchedByShare = false

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
    private val askBluetooth = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }
    private var bluetoothAsked = false
    private var inCall = false

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = SettingsStore(this)
        // A login is kept until the user logs off (or leaves for another server): older "this session only" answers become "keep".
        KnownServers.find(settings.knownServers, settings.origin)?.takeIf { it.signIn != "keep" }?.let { settings.knownServers = KnownServers.setSignIn(settings.knownServers, it.url, "keep") }
        val invite = InviteLink.parse(intent?.dataString)
        captureShare(intent)
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

    private fun isShare(intent: Intent?) = intent?.action == Intent.ACTION_SEND || intent?.action == Intent.ACTION_SEND_MULTIPLE

    // Reads what another app shared and parks it for the page (see ShareStore); the page picks the destination.
    private fun captureShare(intent: Intent?) {
        if (!isShare(intent) || intent == null) return
        val streams = ArrayList<String>()
        if (intent.action == Intent.ACTION_SEND) {
            IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { streams.add(it.toString()) }
        } else {
            IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.forEach { streams.add(it.toString()) }
        }
        val clip = intent.clipData
        if (streams.isEmpty() && clip != null) for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { streams.add(it.toString()) }
        if (streams.isEmpty()) intent.data?.let { streams.add(it.toString()) }
        val item = ShareParser.parse(intent.action, intent.type, intent.getCharSequenceExtra(Intent.EXTRA_TEXT), intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT), streams) ?: return
        ShareStore.set(item, ::shareMeta, intent.getStringExtra(Intent.EXTRA_SHORTCUT_ID))
        launchedByShare = true
    }

    private fun shareMeta(uri: String): Triple<String, String, Long> {
        var name = Uri.parse(uri).lastPathSegment ?: "file"
        var size = -1L
        try {
            contentResolver.query(Uri.parse(uri), arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    c.getString(0)?.let { name = it }
                    if (!c.isNull(1)) size = c.getLong(1)
                }
            }
        } catch (_: Exception) { /* a provider that does not answer: serve the file without a size */ }
        val mime = try { contentResolver.getType(Uri.parse(uri)) } catch (_: Exception) { null }
        return Triple(name.take(200), mime.orEmpty(), size)
    }

    // The page is done with the share (sent or cancelled): go back to the app that shared.
    fun finishShare() {
        ShareStore.clear()
        if (launchedByShare) { launchedByShare = false; moveTaskToBack(true) }
    }

    private fun serveSharedFile(url: String): WebResourceResponse? {
        val origin = settings.origin ?: return null
        val prefix = "$origin/__mcshare/"
        if (!url.startsWith(prefix)) return null
        val notFound = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", mapOf("Cache-Control" to "no-store"), java.io.ByteArrayInputStream(ByteArray(0)))
        val file = ShareStore.fileFor(url.removePrefix(prefix).substringBefore('?')) ?: return notFound
        val stream = try { contentResolver.openInputStream(Uri.parse(file.uri)) } catch (_: Exception) { null } ?: return notFound
        val headers = HashMap<String, String>()
        headers["Cache-Control"] = "no-store"
        if (file.size >= 0) headers["Content-Length"] = file.size.toString()
        headers["Content-Disposition"] = "inline; filename*=UTF-8''" + Uri.encode(file.name)
        return WebResourceResponse(file.mime, null, 200, "OK", headers, stream)
    }

    fun confirmSwitchTo(origin: String, done: () -> Unit) {
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle(R.string.switch_title)
            .setMessage(getString(R.string.switch_body, Uri.parse(origin).authority ?: origin, Uri.parse(settings.origin ?: "").authority ?: ""))
            .setPositiveButton(R.string.switch_confirm) { _, _ ->
                startActivity(Intent(this, SetupActivity::class.java).putExtra(SetupActivity.EXTRA_ADDRESS, origin).putExtra(SetupActivity.EXTRA_AUTOCONNECT, true))
            }
            .setNegativeButton(android.R.string.cancel, null)
            .setOnDismissListener { done() }
            .show()
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
        loadedOrigin = origin
        offlineShown = false
        // The server picks the mobile UI from the user agent; /m/ is requested directly to skip a redirect.
        // A local loading screen shows instantly while the (possibly slow) network request is in flight.
        pendingAppUrl = origin + "/m/" + (deepLink ?: "")
        val q = "name=" + Uri.encode(settings.serverName ?: "") + "&host=" + Uri.encode(Uri.parse(origin).authority ?: origin)
        webView.loadUrl("$SPLASH_URL?$q")
        webView.requestFocus()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (isShare(intent)) {
            captureShare(intent)
            if (::webView.isInitialized) webView.evaluateJavascript("window.dispatchEvent(new Event('mc-share'))", null)
            return
        }
        // Setup finished for a different server while this activity was kept: show that server, not the old page.
        if (::webView.isInitialized && settings.configured && settings.origin != loadedOrigin) {
            loadApp(intent.getStringExtra(NotificationHelper.EXTRA_DEEP_LINK))
            return
        }
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
        NotificationHelper.cancelMessages(this)
        stopService(Intent(this, ConnectionService::class.java))
    }

    override fun onStop() {
        NotificationPoller.appVisible = false
        val appContext = applicationContext
        kotlin.concurrent.thread { try { NotificationPoller.markSeen(appContext) } catch (_: Exception) { /* next poll catches up */ } }
        CookieManager.getInstance().flush() // so the background poller sees the current session cookie
        if (settings.configured && !isChangingConfigurations) {
            try { ContextCompat.startForegroundService(this, Intent(this, ConnectionService::class.java)) } catch (_: Exception) { /* not allowed right now; the poller still runs */ }
        }
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

    // Headset audio routing needs BLUETOOTH_CONNECT on Android 12+; calls work without it, so it is asked once and never required.
    private fun bluetoothIfWanted(req: PermissionRequest): List<String> {
        if (Build.VERSION.SDK_INT < 31 || bluetoothAsked || PermissionRequest.RESOURCE_AUDIO_CAPTURE !in req.resources) return emptyList()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED) return emptyList()
        bluetoothAsked = true
        return listOf(Manifest.permission.BLUETOOTH_CONNECT)
    }

    private fun handleMediaRequest(req: PermissionRequest) {
        val origin = settings.origin
        if (origin == null || !req.origin.toString().trimEnd('/').equals(origin.trimEnd('/'), ignoreCase = true)) { req.deny(); return }
        val missing = req.resources.mapNotNull { neededPermission(it) }.distinct()
            .filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) {
            val ok = grantableResources(req)
            if (ok.isEmpty()) req.deny() else req.grant(ok)
            bluetoothIfWanted(req).firstOrNull()?.let { askBluetooth.launch(it) }
            return
        }
        mediaRequest?.deny()
        mediaRequest = req
        askMedia.launch((missing + bluetoothIfWanted(req)).toTypedArray())
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
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            if (request.method == "GET") serveSharedFile(request.url.toString()) else null

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
            if (url.startsWith(SPLASH_URL)) {
                val next = pendingAppUrl ?: return
                pendingAppUrl = null
                view.loadUrl(next)
                return
            }
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

    private companion object {
        const val SPLASH_URL = "file:///android_asset/splash.html"
    }
}
