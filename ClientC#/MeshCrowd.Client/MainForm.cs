using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace MeshCrowd.Client;

public sealed class MainForm : Form
{
    private const string AppHost = "meshcrowd.app.local";
    private const int ConnectTimeoutMs = 20000;
    private static readonly string[] BadgeStates = ["online", "idle", "dnd", "offline"];

    private readonly AppConfig _cfg;
    private readonly string _dataDir;
    private readonly bool _dev;
    private readonly WebView2 _web = new();
    private readonly System.Windows.Forms.Timer _connectTimer = new() { Interval = ConnectTimeoutMs };
    private readonly System.Windows.Forms.Timer _boundsTimer = new() { Interval = 500 };
    private TrayController? _tray;
    private DownloadManager? _downloads;

    private McrLink? _pendingInvite;
    private bool _quitting;
    private bool _allowVisible;
    private bool _pendingMaximize;
    private bool _firstShowDone;
    private bool _fullscreen;
    private bool _elementFullscreen;
    private readonly CaptionButton _btnMin = new(CaptionKind.Minimize);
    private readonly CaptionButton _btnMax = new(CaptionKind.Maximize);
    private readonly CaptionButton _btnClose = new(CaptionKind.Close);
    private FormWindowState _prevState;
    private Rectangle _prevBounds;
    private string _lastNavUri = "";
    private TaskCompletionSource? _appPageLoaded;

    public MainForm(string dataDir, AppConfig cfg, bool dev, McrLink? invite)
    {
        _dataDir = dataDir;
        _cfg = cfg;
        _dev = dev;
        _pendingInvite = invite;

        Text = "MeshCrowd";
        BackColor = Color.FromArgb(0x1e, 0x1f, 0x22);
        StartPosition = FormStartPosition.Manual;
        try { Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath!); } catch { }

        _web.Dock = DockStyle.Fill;
        _web.DefaultBackgroundColor = Color.FromArgb(0x31, 0x33, 0x38);
        Controls.Add(_web);

        _btnMin.Click += (_, _) => WindowState = FormWindowState.Minimized;
        _btnMax.Click += (_, _) => WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
        _btnClose.Click += (_, _) => Close();
        foreach (var b in new[] { _btnMin, _btnMax, _btnClose })
        {
            Controls.Add(b);
            b.BringToFront();
        }

        _pendingMaximize = _cfg.GetBool("windowMaximized", false);
        Bounds = FitBoundsToScreen(ReadSavedBounds());

        _connectTimer.Tick += (_, _) =>
        {
            _connectTimer.Stop();
            if (_web.CoreWebView2 is null) return;
            _web.CoreWebView2.Stop();
            _ = ShowConnectPage(_lastServerTarget, true);
        };
        _boundsTimer.Tick += (_, _) => { _boundsTimer.Stop(); SaveWindowBounds(); };

        VisibleChanged += (_, _) => { UpdateWebVisibility(); SendWindowState(); };
        Resize += (_, _) => { UpdateChrome(); UpdateWebVisibility(); SendWindowState(); ScheduleSaveBounds(); };
        DpiChanged += (_, _) => { UpdateMinimumSize(); UpdateChrome(); };
        Move += (_, _) => ScheduleSaveBounds();
        Activated += (_, _) => { _tray?.OnWindowFocused(); SendWindowState(); };
        Deactivate += (_, _) => SendWindowState();
        SystemEvents_Hook();

        _ = Handle;
        BeginInvoke(async () => await InitAsync());
    }

    private string _lastServerTarget = "";

    protected override void SetVisibleCore(bool value) => base.SetVisibleCore(value && _allowVisible);

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Native.StyleCaption(Handle);
        UpdateMinimumSize();
        UpdateChrome();
        Nc.FrameChanged(Handle);
    }

    private void UpdateMinimumSize()
    {
        float scale = DeviceDpi / 96f;
        MinimumSize = new Size((int)(800 * scale), (int)(560 * scale));
    }

    // The page's own top bar (38px, draggable) is the title bar: the native caption is cut off in
    // WM_NCCALCSIZE and these three buttons take its place, as Electron's titleBarOverlay does.
    private void UpdateChrome()
    {
        float s = DeviceDpi / 96f;
        bool maxed = WindowState == FormWindowState.Maximized;
        int pad = _fullscreen || maxed ? 0 : (int)Math.Round(3 * s);
        if (Padding.Top != pad) Padding = new Padding(0, pad, 0, 0);
        int w = (int)Math.Round(46 * s), h = (int)Math.Round(38 * s);
        int x = ClientSize.Width - 3 * w;
        var buttons = new[] { _btnMin, _btnMax, _btnClose };
        for (int i = 0; i < buttons.Length; i++)
        {
            buttons[i].SetBounds(x + i * w, pad, w, h);
            buttons[i].Visible = !_fullscreen;
        }
        _btnMax.Restored = maxed;
    }

    protected override void WndProc(ref Message m)
    {
        switch (m.Msg)
        {
            case Nc.WmNcCalcSize when m.WParam != IntPtr.Zero:
            {
                if (_fullscreen) { m.Result = IntPtr.Zero; return; }
                var p = Marshal.PtrToStructure<Nc.NcCalcSizeParams>(m.LParam);
                int top = p.Rgrc0.Top;
                base.WndProc(ref m);
                p = Marshal.PtrToStructure<Nc.NcCalcSizeParams>(m.LParam);
                p.Rgrc0.Top = top + (WindowState == FormWindowState.Maximized ? Nc.FrameTop((uint)DeviceDpi) : 0);
                Marshal.StructureToPtr(p, m.LParam, false);
                m.Result = IntPtr.Zero;
                return;
            }
            case Nc.WmNcHitTest:
            {
                base.WndProc(ref m);
                if ((int)m.Result == Nc.HtClient && !_fullscreen && WindowState == FormWindowState.Normal)
                {
                    long lp = m.LParam.ToInt64();
                    var pt = PointToClient(new Point((short)(lp & 0xFFFF), (short)((lp >> 16) & 0xFFFF)));
                    if (pt.Y < Padding.Top)
                    {
                        int corner = (int)Math.Round(8 * DeviceDpi / 96f);
                        m.Result = pt.X < corner ? Nc.HtTopLeft : pt.X >= ClientSize.Width - corner ? Nc.HtTopRight : Nc.HtTop;
                    }
                }
                return;
            }
        }
        base.WndProc(ref m);
    }

    private void SystemEvents_Hook()
    {
        Microsoft.Win32.SystemEvents.DisplaySettingsChanged += (_, _) => Refit();
    }

    // ---- startup ---------------------------------------------------------------------------------

    private async Task InitAsync()
    {
        _tray = new TrayController(_cfg, ShowAndFocus, () => PostEvent("dismesh:request-logout", null), Quit, n =>
        {
            ShowAndFocus();
            PostEvent("dismesh:navigate-to", n);
        });
        _downloads = new DownloadManager(_cfg, PostEvent, () => Handle);

        var options = new CoreWebView2EnvironmentOptions();
        if (_dev)
        {
            string args = Environment.GetEnvironmentVariable("MESHCROWD_BROWSER_ARGS") ?? "";
            if (Environment.GetEnvironmentVariable("MESHCROWD_CDP_PORT") is { Length: > 0 } port) args += $" --remote-debugging-port={port}";
            options.AdditionalBrowserArguments = args.Trim();
        }
        var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(_dataDir, "webview2"), options);
        await _web.EnsureCoreWebView2Async(env);
        SetupWebView(_web.CoreWebView2);

        Native.SetLoginItem(_cfg.GetBool("startWithWindows", false));
        EnsureProtocolRegistered();

        LoadTarget();
    }

    private void SetupWebView(CoreWebView2 core)
    {
        var s = core.Settings;
        s.AreDevToolsEnabled = _dev;
        s.IsStatusBarEnabled = false;
        s.IsPasswordAutosaveEnabled = false;
        s.IsGeneralAutofillEnabled = false;
        s.IsBuiltInErrorPageEnabled = false;
        s.IsZoomControlEnabled = true;
        s.IsNonClientRegionSupportEnabled = true;

        _ = core.AddScriptToExecuteOnDocumentCreatedAsync(ReadResourceText("bridge.js"));

        core.AddWebResourceRequestedFilter($"https://{AppHost}/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += OnWebResourceRequested;
        core.WebMessageReceived += OnWebMessage;
        core.NavigationStarting += OnNavigationStarting;
        core.FrameNavigationStarting += OnFrameNavigationStarting;
        core.NavigationCompleted += OnNavigationCompleted;
        core.ContentLoading += (_, _) =>
        {
            if (!IsAppUri(core.Source)) _connectTimer.Stop();
        };
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var u) && Native.IsExternalSafe(u)) Native.OpenExternal(u.AbsoluteUri);
        };
        core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Allow;
        core.DocumentTitleChanged += (_, _) => { if (!string.IsNullOrEmpty(core.DocumentTitle)) Text = core.DocumentTitle; };
        core.ServerCertificateErrorDetected += OnCertificateError;
        core.DownloadStarting += (_, e) => _downloads!.OnStarting(e, this);
        core.ContextMenuRequested += OnContextMenu;
        core.ProcessFailed += OnProcessFailed;
        core.ContainsFullScreenElementChanged += (_, _) =>
        {
            if (core.ContainsFullScreenElement) { if (!_fullscreen) { _elementFullscreen = true; SetFullscreen(true); } }
            else if (_elementFullscreen) { _elementFullscreen = false; SetFullscreen(false); }
        };
    }

    private static string ReadResourceText(string name)
    {
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name)!;
        using var r = new StreamReader(s, Encoding.UTF8);
        return r.ReadToEnd();
    }

    // ---- local pages (connect / connecting) ------------------------------------------------------

    private bool IsAppUri(string? uri) => Uri.TryCreate(uri, UriKind.Absolute, out var u) && u.Host.Equals(AppHost, StringComparison.OrdinalIgnoreCase);

    private void OnWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var uri = new Uri(e.Request.Uri);
        string name = uri.AbsolutePath.TrimStart('/');
        var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("renderer/" + name);
        var env = _web.CoreWebView2.Environment;
        if (stream is null)
        {
            e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", "");
            return;
        }
        string type = name.EndsWith(".html") ? "text/html; charset=utf-8" : name.EndsWith(".js") ? "text/javascript; charset=utf-8" : "application/octet-stream";
        e.Response = env.CreateWebResourceResponse(stream, 200, "OK", $"Content-Type: {type}\r\nCache-Control: no-store");
    }

    private async Task ShowConnectPage(string url, bool failed)
    {
        string host = "";
        try { host = new Uri(url).Authority; } catch { }
        string q = failed ? $"host={Uri.EscapeDataString(host)}&failed=1" : $"host={Uri.EscapeDataString(host)}";
        _appPageLoaded = new TaskCompletionSource();
        _web.CoreWebView2.Navigate($"https://{AppHost}/connecting.html?{q}");
        await Task.WhenAny(_appPageLoaded.Task, Task.Delay(3000));
    }

    private async void LoadServer(string url)
    {
        _connectTimer.Stop();
        _lastServerTarget = url;
        await ShowConnectPage(url, false);
        _web.CoreWebView2.Navigate(url);
        _connectTimer.Start();
    }

    private void LoadTarget()
    {
        if (_cfg.ServerUrl is { } url) LoadServer(url);
        else _web.CoreWebView2.Navigate($"https://{AppHost}/connect.html");
    }

    // ---- navigation policy -----------------------------------------------------------------------

    private string? ServerOrigin()
    {
        if (_cfg.ServerUrl is null || !Uri.TryCreate(_cfg.ServerUrl, UriKind.Absolute, out var u)) return null;
        return u.GetLeftPart(UriPartial.Authority);
    }

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        _lastNavUri = e.Uri;
        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var target)) { e.Cancel = true; return; }
        if (IsAppUri(e.Uri) || target.Scheme is "about" or "data" or "blob") return;
        string? origin = ServerOrigin();
        if (origin is not null && target.GetLeftPart(UriPartial.Authority).Equals(origin, StringComparison.OrdinalIgnoreCase)) return;
        e.Cancel = true;
        if (Native.IsExternalSafe(target)) Native.OpenExternal(target.AbsoluteUri);
    }

    private void OnFrameNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var target)) return;
        if (target.Scheme is "about" or "data" or "blob") return;
        string? origin = ServerOrigin();
        if (origin is not null && target.GetLeftPart(UriPartial.Authority).Equals(origin, StringComparison.OrdinalIgnoreCase)) return;
        e.Cancel = true;
        if (Native.IsExternalSafe(target)) Native.OpenExternal(target.AbsoluteUri);
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess && e.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled && !IsAppUri(_lastNavUri))
        {
            _connectTimer.Stop();
            _ = ShowConnectPage(_lastNavUri, true);
            return;
        }
        if (e.IsSuccess && IsAppUri(_web.CoreWebView2.Source))
        {
            _appPageLoaded?.TrySetResult();
            if (!_firstShowDone) ApplyInitialVisibility();
        }
        SendWindowState();
    }

    // ---- certificates (trust on first use) -------------------------------------------------------

    private static string Fingerprint(byte[] der) => string.Join(":", SHA256.HashData(der).Select(b => b.ToString("X2")));

    private void OnCertificateError(object? sender, CoreWebView2ServerCertificateErrorDetectedEventArgs e)
    {
        var deferral = e.GetDeferral();
        string host = new Uri(e.RequestUri).Authority;
        string fp = Fingerprint(System.Security.Cryptography.X509Certificates.X509Certificate2.CreateFromPem(e.ServerCertificate.ToPemEncoding()).RawData);
        string? known = _cfg.Trusted[host]?.GetValue<string>();
        BeginInvoke(() =>
        {
            bool trust = known == fp;
            if (!trust)
            {
                int choice = Ask(
                    known is not null ? "Server certificate changed!" : "Untrusted server certificate",
                    known is not null
                        ? $"The certificate for {host} has changed since you last connected. This could mean the server was reinstalled, or it could mean someone is intercepting your connection."
                        : $"{host} is using a self-signed certificate (normal for a MeshCrowd server on your own network).",
                    $"Fingerprint (SHA-256): {fp}\n\nOnly trust this if you recognize the server.",
                    known is not null ? ["Cancel (recommended)", "Trust new certificate anyway"] : ["Cancel", "Trust this server"],
                    known is not null);
                trust = choice == 1;
                if (trust)
                {
                    _cfg.Trusted[host] = fp;
                    _cfg.Save();
                }
            }
            e.Action = trust ? CoreWebView2ServerCertificateErrorAction.AlwaysAllow : CoreWebView2ServerCertificateErrorAction.Cancel;
            deferral.Complete();
        });
    }

    private int Ask(string title, string message, string detail, string[] buttons, bool warning)
    {
        var page = new TaskDialogPage
        {
            Caption = title,
            Heading = message,
            Text = detail,
            Icon = warning ? TaskDialogIcon.Warning : TaskDialogIcon.Information,
            AllowCancel = true,
        };
        var made = buttons.Select(b => new TaskDialogButton(b)).ToArray();
        foreach (var b in made) page.Buttons.Add(b);
        page.DefaultButton = made[0];
        var result = Visible && WindowState != FormWindowState.Minimized ? TaskDialog.ShowDialog(this, page) : TaskDialog.ShowDialog(page);
        return Array.IndexOf(made, result) is var i && i >= 0 ? i : 0;
    }

    // ---- context menu / crashes ------------------------------------------------------------------

    private static readonly HashSet<string> HiddenMenuItems = new(StringComparer.OrdinalIgnoreCase)
    {
        "back", "forward", "reload", "saveAs", "print", "share", "webCapture", "inspectElement", "inspect", "saveImageAs", "copyImage",
        "copyImageLocation", "openLinkInNewWindow", "openLinkInNewTab", "openLinkInIncognito", "saveLinkAs", "createQrCode", "emoji",
        "saveVideoAs", "saveAudioAs", "pictureInPicture", "loop", "controls", "showControls", "openImageInNewTab", "other", "viewSource",
    };

    private void OnContextMenu(object? sender, CoreWebView2ContextMenuRequestedEventArgs e)
    {
        var t = e.ContextMenuTarget;
        bool useful = t.IsEditable || t.HasSelection || t.HasLinkUri;
        if (!useful) { e.Handled = true; return; }
        for (int i = e.MenuItems.Count - 1; i >= 0; i--)
            if (HiddenMenuItems.Contains(e.MenuItems[i].Name)) e.MenuItems.RemoveAt(i);
        while (e.MenuItems.Count > 0 && e.MenuItems[0].Kind == CoreWebView2ContextMenuItemKind.Separator) e.MenuItems.RemoveAt(0);
        while (e.MenuItems.Count > 0 && e.MenuItems[^1].Kind == CoreWebView2ContextMenuItemKind.Separator) e.MenuItems.RemoveAt(e.MenuItems.Count - 1);
        if (e.MenuItems.Count == 0) e.Handled = true;
    }

    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        switch (e.ProcessFailedKind)
        {
            case CoreWebView2ProcessFailedKind.RenderProcessExited:
                if (e.ExitCode != 0) BeginInvoke(LoadTarget);
                break;
            case CoreWebView2ProcessFailedKind.RenderProcessUnresponsive:
                BeginInvoke(() =>
                {
                    if (Ask("MeshCrowd is not responding", "The window has stopped responding.", "", ["Wait", "Reload"], true) == 1) LoadTarget();
                });
                break;
            case CoreWebView2ProcessFailedKind.BrowserProcessExited:
                BeginInvoke(() =>
                {
                    MessageBox.Show("The WebView2 runtime stopped. MeshCrowd will close; start it again.", "MeshCrowd", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    Quit();
                });
                break;
        }
    }

    // ---- window state / bounds -------------------------------------------------------------------

    private Rectangle? ReadSavedBounds()
    {
        if (_cfg.Data["windowBounds"] is not JsonObject b) return null;
        int? Get(string k) => b[k] is JsonValue v && v.TryGetValue<double>(out var d) ? (int)d : null;
        if (Get("x") is not { } x || Get("y") is not { } y || Get("width") is not { } w || Get("height") is not { } h || w <= 0 || h <= 0) return null;
        return new Rectangle(x, y, w, h);
    }

    private static bool OnScreen(Rectangle b)
    {
        var wa = Screen.FromRectangle(b).WorkingArea;
        return b.X < wa.X + wa.Width - 100 && b.X + b.Width > wa.X + 100 && b.Y >= wa.Y - 10 && b.Y < wa.Y + wa.Height - 50;
    }

    private Rectangle FitBoundsToScreen(Rectangle? saved)
    {
        float scale = DeviceDpi / 96f;
        bool has = saved is { } s && OnScreen(s);
        var wa = (has ? Screen.FromRectangle(saved!.Value) : Screen.PrimaryScreen!).WorkingArea;
        int width = Math.Min(saved?.Width ?? (int)(1280 * scale), wa.Width);
        int height = Math.Min(saved?.Height ?? (int)(820 * scale), wa.Height);
        int x = has ? Math.Clamp(saved!.Value.X, wa.X, wa.X + wa.Width - width) : wa.X + (wa.Width - width) / 2;
        int y = has ? Math.Clamp(saved!.Value.Y, wa.Y, wa.Y + wa.Height - height) : wa.Y + (wa.Height - height) / 2;
        return new Rectangle(x, y, width, height);
    }

    private void Refit()
    {
        if (!IsHandleCreated || WindowState != FormWindowState.Normal || _fullscreen || !Visible) return;
        var fitted = FitBoundsToScreen(Bounds);
        if (fitted != Bounds) Bounds = fitted;
    }

    private void ScheduleSaveBounds()
    {
        _boundsTimer.Stop();
        _boundsTimer.Start();
    }

    private void SaveWindowBounds()
    {
        if (!IsHandleCreated || WindowState == FormWindowState.Minimized || _fullscreen || !_firstShowDone) return;
        bool max = WindowState == FormWindowState.Maximized;
        var b = max ? RestoreBounds : Bounds;
        _cfg.Set("windowBounds", new JsonObject { ["x"] = b.X, ["y"] = b.Y, ["width"] = b.Width, ["height"] = b.Height });
        _cfg.Set("windowMaximized", max);
        _cfg.Save();
    }

    private void ApplyPendingMaximize()
    {
        if (!_pendingMaximize) return;
        _pendingMaximize = false;
        WindowState = FormWindowState.Maximized;
    }

    private void ApplyInitialVisibility()
    {
        _firstShowDone = true;
        if (!_cfg.GetBool("startMinimized", false))
        {
            ShowAndFocus();
        }
        else if (!_cfg.GetBool("closeToTray", false))
        {
            _allowVisible = true;
            WindowState = FormWindowState.Minimized;
            Show();
        }
        if (_pendingInvite is { } link)
        {
            _pendingInvite = null;
            HandleInvite(link);
        }
    }

    public void ShowAndFocus()
    {
        _allowVisible = true;
        if (!Visible) Show();
        if (WindowState == FormWindowState.Minimized) Native.Restore(Handle);
        ApplyPendingMaximize();
        Activate();
        Native.Foreground(Handle);
    }

    // Hiding the form does not reliably flip document.hidden in the page, so tell the controller.
    private void UpdateWebVisibility()
    {
        // The WinForms control keeps its controller private and does not follow a hidden parent form.
        var c = typeof(WebView2).GetField("_coreWebView2Controller", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(_web) as CoreWebView2Controller;
        if (c is not null) c.IsVisible = Visible && WindowState != FormWindowState.Minimized;
    }

    private void SendWindowState()
    {
        if (_web.CoreWebView2 is null) return;
        PostEvent("dismesh:window-state", new JsonObject
        {
            ["hidden"] = !Visible || WindowState == FormWindowState.Minimized,
            ["focused"] = ActiveForm == this,
            ["notifyWhenHidden"] = _cfg.GetBool("notifyWhenHidden", true),
            ["notifyWhenUnfocused"] = _cfg.GetBool("notifyWhenUnfocused", false),
        });
    }

    private void SetFullscreen(bool on)
    {
        if (on == _fullscreen) return;
        if (on)
        {
            SaveWindowBounds();
            _prevState = WindowState;
            _prevBounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            _fullscreen = true;
            WindowState = FormWindowState.Normal;
            Bounds = Screen.FromControl(this).Bounds;
        }
        else
        {
            _fullscreen = false;
            Bounds = _prevBounds;
            WindowState = _prevState;
        }
        Nc.FrameChanged(Handle);
        UpdateChrome();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        _boundsTimer.Stop();
        SaveWindowBounds();
        if (!_quitting && e.CloseReason == CloseReason.UserClosing && _cfg.GetBool("closeToTray", false))
        {
            e.Cancel = true;
            Hide();
            return;
        }
        base.OnFormClosing(e);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        _tray?.Dispose();
        _tray = null;
        base.OnFormClosed(e);
    }

    public void Quit()
    {
        _quitting = true;
        _tray?.Dispose();
        _tray = null;
        Close();
        Application.Exit();
    }

    // ---- invite links / second instance ----------------------------------------------------------

    private void EnsureProtocolRegistered()
    {
        if (!_cfg.GetBool("handleInviteLinks", true)) return;
        // Claim mcr:// only when nobody has it; the Electron client and this one must not fight over it.
        if (!Native.HasProtocolHandler()) Native.SetProtocolRegistered(true);
    }

    public void OnSecondInstance(string[] argv)
    {
        var link = InviteUrl.Find(argv);
        if (link is not null) { HandleInvite(link); return; }
        ShowAndFocus();
    }

    private void HandleInvite(McrLink link)
    {
        if (_web.CoreWebView2 is null || !_firstShowDone) { _pendingInvite = link; return; }
        var target = InviteUrl.Target(link, _cfg.ServerUrl);
        if (!target.SameServer)
        {
            ShowAndFocus();
            int choice = Ask("Invite link", $"Open an invite to {link.Host}?",
                $"This client will switch to https://{link.Host} and ask before joining. Only continue if you trust whoever sent you the link.",
                ["Cancel", "Open this server"], false);
            if (choice != 1) return;
            _cfg.ServerUrl = target.Origin;
            _cfg.Save();
        }
        LoadServer(target.Url);
        ShowAndFocus();
    }

    // ---- IPC bridge ------------------------------------------------------------------------------

    private void PostEvent(string name, JsonNode? data)
    {
        if (_web.CoreWebView2 is null) return;
        var msg = new JsonObject { ["type"] = "event", ["name"] = name, ["data"] = data?.DeepClone() };
        _web.CoreWebView2.PostWebMessageAsJson(msg.ToJsonString());
    }

    private bool IsTrustedSource(string source)
    {
        if (IsAppUri(source)) return true;
        string? origin = ServerOrigin();
        return origin is not null && Uri.TryCreate(source, UriKind.Absolute, out var u)
            && u.GetLeftPart(UriPartial.Authority).Equals(origin, StringComparison.OrdinalIgnoreCase);
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!IsTrustedSource(e.Source)) return;
        JsonObject? msg;
        try { msg = JsonNode.Parse(e.WebMessageAsJson) as JsonObject; } catch { return; }
        if (msg is null) return;
        string channel = msg["channel"]?.GetValue<string>() ?? "";
        JsonNode? arg = msg["arg"];
        string type = msg["type"]?.GetValue<string>() ?? "";

        if (type == "invoke")
        {
            JsonNode? result;
            try { result = Invoke(channel, arg); } catch { result = null; }
            var reply = new JsonObject { ["type"] = "result", ["id"] = msg["id"]?.DeepClone(), ["value"] = result };
            _web.CoreWebView2.PostWebMessageAsJson(reply.ToJsonString());
        }
        else if (type == "send") Send(channel, arg);
    }

    private void Send(string channel, JsonNode? arg)
    {
        switch (channel)
        {
            case "dismesh:show-window":
                ShowAndFocus();
                break;
            case "dismesh:f11":
                if (_cfg.GetBool("f11Fullscreen", true)) SetFullscreen(!_fullscreen);
                break;
            case "dismesh:push-notification":
                if (arg is JsonObject n) _tray?.Push((JsonObject)n.DeepClone());
                break;
            case "dismesh:clear-notifications":
                if (arg is JsonArray keys) _tray?.Clear(keys);
                break;
            case "dismesh:set-tray-labels":
                if (arg is JsonObject labels) _tray?.SetLabels(labels);
                break;
            case "dismesh:set-tray-badge":
            {
                string? status = arg?["status"] is JsonValue sv && sv.TryGetValue<string>(out var s) ? s : null;
                int count = arg?["count"] is JsonValue cv && cv.TryGetValue<double>(out var c) ? (int)c : 0;
                _tray?.SetBadge(status, count);
                break;
            }
        }
    }

    private JsonNode? Invoke(string channel, JsonNode? arg)
    {
        switch (channel)
        {
            case "dismesh:get-config": return _cfg.Data.DeepClone();
            case "dismesh:debug-state" when _dev: return new JsonObject { ["tray"] = _tray?.DebugState(), ["visible"] = Visible, ["state"] = WindowState.ToString(), ["fullscreen"] = _fullscreen, ["bounds"] = $"{Bounds.X},{Bounds.Y},{Bounds.Width},{Bounds.Height}", ["title"] = Text, ["taskbarError"] = TaskbarProgress.LastError };
            case "dismesh:debug-menu" when _dev: _tray?.InvokeMenu(arg?.GetValue<int>() ?? 0); return null;
            case "dismesh:open-external":
            {
                string? raw = arg is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
                if (raw is null || !Uri.TryCreate(raw, UriKind.Absolute, out var u) || !Native.IsExternalSafe(u)) return false;
                Native.OpenExternal(u.AbsoluteUri);
                return true;
            }
            case "dismesh:set-server": return SetServer(arg is JsonValue sv && sv.TryGetValue<string>(out var url) ? url : "");
            case "dismesh:retry-connect": LoadTarget(); return new JsonObject { ["ok"] = true };
            case "dismesh:forget-server":
                _connectTimer.Stop();
                _cfg.ServerUrl = null;
                _cfg.Save();
                LoadTarget();
                return new JsonObject { ["ok"] = true };
            case "dismesh:get-network-interfaces": return NetworkInterfaces();
            case "dismesh:get-app-settings": return AppSettingsView();
            case "dismesh:set-app-settings": return SetAppSettings(arg as JsonObject);
            case "dismesh:select-download-dir": return _downloads!.SelectDownloadDir(this);
            case "dismesh:show-download": _downloads!.Show(IdOf(arg)); return null;
            case "dismesh:open-download": return _downloads!.Open(IdOf(arg));
            case "dismesh:cancel-download": _downloads!.Cancel(IdOf(arg)); return null;
            case "dismesh:open-download-dir": return _downloads!.OpenDir();
        }
        return null;
    }

    private static int IdOf(JsonNode? arg) => arg is JsonValue v && v.TryGetValue<double>(out var d) ? (int)d : -1;

    private JsonNode SetServer(string raw)
    {
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var url) || url.Scheme is not ("http" or "https"))
            return new JsonObject { ["ok"] = false, ["error"] = "Enter a valid URL, e.g. https://192.168.1.10:8443" };

        if (url.Scheme == "http")
        {
            int choice = Ask("Unencrypted connection", $"{url.Authority} is plain HTTP, not HTTPS.",
                "Your login and messages would be sent unencrypted, and this skips certificate verification entirely. Only do this for local testing on a server you control.",
                ["Cancel", "Connect anyway"], true);
            if (choice != 1) return new JsonObject { ["ok"] = false, ["error"] = "Connection cancelled." };
        }

        _cfg.ServerUrl = url.AbsoluteUri;
        _cfg.Save();
        LoadTarget();
        return new JsonObject { ["ok"] = true };
    }

    private static JsonArray NetworkInterfaces()
    {
        var list = new JsonArray();
        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
            foreach (var a in nic.GetIPProperties().UnicastAddresses)
            {
                if (a.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                string ip = a.Address.ToString();
                if (ip.StartsWith("169.254.") || ip.StartsWith("127.")) continue;
                list.Add(new JsonObject { ["name"] = nic.Name, ["address"] = ip });
            }
        }
        return list;
    }

    private JsonObject AppSettingsView() => new()
    {
        ["downloadMode"] = _cfg.GetString("downloadMode") == "folder" ? "folder" : "ask",
        ["downloadDir"] = _cfg.GetString("downloadDir") ?? "",
        ["defaultDownloadDir"] = Native.DownloadsFolder(),
        ["closeToTray"] = _cfg.GetBool("closeToTray", false),
        ["startMinimized"] = _cfg.GetBool("startMinimized", false),
        ["startWithWindows"] = _cfg.GetBool("startWithWindows", false),
        ["handleInviteLinks"] = _cfg.GetBool("handleInviteLinks", true),
        ["f11Fullscreen"] = _cfg.GetBool("f11Fullscreen", true),
        ["trayRecentCount"] = _tray?.RecentLimit ?? TrayController.RecentDefault,
        ["notifyWhenHidden"] = _cfg.GetBool("notifyWhenHidden", true),
        ["notifyWhenUnfocused"] = _cfg.GetBool("notifyWhenUnfocused", false),
        ["trayIconColor"] = _cfg.GetString("trayIconColor"),
        ["trayBadgeColors"] = (_cfg.Data["trayBadgeColors"] as JsonObject)?.DeepClone() ?? new JsonObject(),
    };

    private static bool IsHex(string? s) => s is { Length: 7 } && s[0] == '#' && int.TryParse(s.AsSpan(1), System.Globalization.NumberStyles.HexNumber, null, out _);

    private JsonNode SetAppSettings(JsonObject? settings)
    {
        if (settings is null) return new JsonObject { ["ok"] = false, ["error"] = "invalid settings" };

        string[] keys = ["closeToTray", "startMinimized", "startWithWindows", "trayIconColor", "trayBadgeColors", "handleInviteLinks", "f11Fullscreen", "downloadMode", "downloadDir", "trayRecentCount", "notifyWhenHidden", "notifyWhenUnfocused"];
        bool Truthy(string k) => settings[k] is JsonValue v && (v.TryGetValue<bool>(out var b) ? b : v.TryGetValue<double>(out var d) ? d != 0 : v.TryGetValue<string>(out var s) && s.Length > 0);

        foreach (var key in keys)
        {
            if (!settings.ContainsKey(key)) continue;
            switch (key)
            {
                case "closeToTray":
                case "startMinimized":
                case "f11Fullscreen":
                case "notifyWhenHidden":
                case "notifyWhenUnfocused":
                    _cfg.Set(key, Truthy(key));
                    break;
                case "startWithWindows":
                    _cfg.Set(key, Truthy(key));
                    Native.SetLoginItem(Truthy(key));
                    break;
                case "downloadMode":
                    if (settings[key] is JsonValue mv && mv.TryGetValue<string>(out var mode) && DownloadManager.Modes.Contains(mode)) _cfg.Set(key, mode);
                    break;
                case "downloadDir":
                {
                    string raw = settings[key] is JsonValue dv && dv.TryGetValue<string>(out var ds) ? ds : "";
                    string? dir = raw == "" ? "" : DownloadManager.NormalizeDir(raw);
                    if (dir is null) return new JsonObject { ["ok"] = false, ["error"] = "invalid-path" };
                    if (dir.Length > 0)
                    {
                        try { Directory.CreateDirectory(dir); } catch { return new JsonObject { ["ok"] = false, ["error"] = "unwritable-path" }; }
                    }
                    _cfg.Set(key, dir);
                    break;
                }
                case "trayRecentCount":
                    if (settings[key] is JsonValue rv && rv.TryGetValue<double>(out var rd) && rd == Math.Floor(rd) && rd is >= 0 and <= TrayController.RecentMax)
                    {
                        _cfg.Set(key, (int)rd);
                        _tray?.TrimRecent();
                        _tray?.RebuildMenu();
                    }
                    break;
                case "handleInviteLinks":
                    _cfg.Set(key, Truthy(key));
                    Native.SetProtocolRegistered(Truthy(key));
                    break;
                case "trayIconColor":
                    if (settings[key] is null) _cfg.Set(key, null);
                    else if (settings[key] is JsonValue cv && cv.TryGetValue<string>(out var color) && IsHex(color)) _cfg.Set(key, color);
                    break;
                case "trayBadgeColors":
                    if (settings[key] is JsonObject colors)
                    {
                        var cleaned = new JsonObject();
                        foreach (var state in BadgeStates)
                        {
                            if (colors.ContainsKey(state) && colors[state] is null) cleaned[state] = null;
                            else if (colors[state] is JsonValue sv && sv.TryGetValue<string>(out var hex) && IsHex(hex)) cleaned[state] = hex;
                            else if ((_cfg.Data["trayBadgeColors"] as JsonObject)?[state] is { } existing) cleaned[state] = existing.DeepClone();
                        }
                        _cfg.Set(key, cleaned);
                    }
                    break;
            }
        }
        _cfg.Save();
        _tray?.ApplyBadge();
        SendWindowState();
        var view = AppSettingsView();
        view["ok"] = true;
        return view;
    }
}
