using System.Text.Json.Nodes;

namespace MeshCrowd.Client;

// Port of the tray parts of electron/main.js: icon, blinking unread alert, tooltip and the "Recent" menu.
public sealed class TrayController : IDisposable
{
    public const int RecentDefault = 5;
    public const int RecentMax = 15;
    private const int BlinkSteps = 8;
    private const int BlinkHalfMs = 350;

    private readonly AppConfig _cfg;
    private readonly NotifyIcon _icon = new();
    private readonly System.Windows.Forms.Timer _blinkTimer = new() { Interval = 25 };
    private readonly Action _open;
    private readonly Action _logout;
    private readonly Action _quit;
    private readonly Action<JsonObject> _navigate;

    private readonly List<JsonObject> _recent = new();
    private TrayBadge _badge = new("online", 0);
    private readonly Dictionary<string, string> _labels = new()
    {
        ["open"] = "Open MeshCrowd", ["recent"] = "Recent", ["none"] = "No recent notifications", ["logout"] = "Log Out",
        ["quit"] = "Quit MeshCrowd", ["unread"] = "{count} unread",
    };

    private List<TrayIconHandle> _frames = new();
    private TrayIconHandle? _plain;
    private string _blinkKey = "";
    private long _blinkStart;
    private int _shown = -1;

    public TrayController(AppConfig cfg, Action open, Action logout, Action quit, Action<JsonObject> navigate)
    {
        _cfg = cfg;
        _open = open;
        _logout = logout;
        _quit = quit;
        _navigate = navigate;

        _icon.Text = "MeshCrowd";
        _icon.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) _open(); };
        _blinkTimer.Tick += (_, _) => BlinkTick();
        ApplyBadge();
        RebuildMenu();
        _icon.Visible = true;
    }

    public int RecentLimit
    {
        get
        {
            int? n = _cfg.GetInt("trayRecentCount");
            return n is >= 0 and <= RecentMax ? n.Value : RecentDefault;
        }
    }

    public int UnreadCount => _badge.Count;

    public void InvokeMenu(int index) => (_icon.ContextMenuStrip!.Items[index] as ToolStripMenuItem)?.PerformClick();

    public JsonObject DebugState() => new()
    {
        ["tooltip"] = _icon.Text, ["count"] = _badge.Count, ["status"] = _badge.Status, ["blinking"] = _blinkTimer.Enabled,
        ["menu"] = new JsonArray(_icon.ContextMenuStrip!.Items.Cast<ToolStripItem>().Select(i => (JsonNode?)JsonValue.Create(i.Text)).ToArray()),
        ["recent"] = new JsonArray(_recent.Select(n => (JsonNode?)n.DeepClone()).ToArray()),
    };

    private TrayTheme Theme()
    {
        var colors = new Dictionary<string, string?>();
        if (_cfg.Data["trayBadgeColors"] is JsonObject o)
            foreach (var (k, v) in o) colors[k] = v is JsonValue jv && jv.TryGetValue<string>(out var s) ? s : null;
        return new TrayTheme(_cfg.GetString("trayIconColor"), colors);
    }

    private static string MenuText(string s) => s.Replace("&", "&&");

    public void RebuildMenu()
    {
        var old = _icon.ContextMenuStrip;
        var menu = new ContextMenuStrip();
        menu.Items.Add(MenuText(_labels["open"]), null, (_, _) => _open());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem(MenuText(_labels["recent"])) { Enabled = false });
        if (_recent.Count == 0) menu.Items.Add(new ToolStripMenuItem(MenuText(_labels["none"])) { Enabled = false });
        foreach (var n in _recent.ToList())
        {
            string title = n["title"]?.GetValue<string>() ?? "";
            string body = n["body"]?.GetValue<string>() ?? "";
            string label = $"{title}: {body}";
            if (label.Length > 60) label = label[..60];
            menu.Items.Add(MenuText(label.Length == 0 ? title : label), null, (_, _) =>
            {
                _recent.Remove(n);
                RebuildMenu();
                _navigate(n);
            });
        }
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(MenuText(_labels["logout"]), null, (_, _) => _logout());
        menu.Items.Add(MenuText(_labels["quit"]), null, (_, _) => _quit());
        _icon.ContextMenuStrip = menu;
        old?.Dispose();
    }

    public void Push(JsonObject n)
    {
        _recent.Insert(0, n);
        TrimRecent();
        RebuildMenu();
    }

    public void TrimRecent()
    {
        int limit = RecentLimit;
        if (_recent.Count > limit) _recent.RemoveRange(limit, _recent.Count - limit);
    }

    public void Clear(JsonArray keys)
    {
        var cleared = keys.Select(k => k?.GetValue<string>()).ToHashSet();
        _recent.RemoveAll(n => cleared.Contains($"{ScalarText(n["scopeType"])}:{ScalarText(n["scopeId"])}"));
        RebuildMenu();
    }

    private static string ScalarText(JsonNode? n) => n is null ? "undefined" : n is JsonValue v && v.TryGetValue<string>(out var s) ? s : n.ToJsonString();

    // Focusing the window with nothing unread means whatever "Recent" holds was seen.
    public void OnWindowFocused()
    {
        if (_badge.Count > 0 || _recent.Count == 0) return;
        _recent.Clear();
        RebuildMenu();
    }

    public void SetLabels(JsonObject labels)
    {
        foreach (var k in _labels.Keys.ToList())
            if (labels[k] is JsonValue v && v.TryGetValue<string>(out var s) && s.Length < 80) _labels[k] = s;
        RebuildMenu();
        ApplyBadge();
    }

    public void SetBadge(string? status, int count)
    {
        _badge = new TrayBadge(string.IsNullOrEmpty(status) ? "online" : status, count);
        ApplyBadge();
    }

    private void StopBlink()
    {
        _blinkTimer.Stop();
        _blinkKey = "";
        DisposeFrames();
    }

    private void DisposeFrames()
    {
        foreach (var f in _frames) f.Dispose();
        _frames = new();
    }

    private void StartBlink()
    {
        var theme = Theme();
        string key = $"{_badge.Status}|{(_badge.Count > 9 ? 10 : _badge.Count)}|{theme.BaseColor}|{string.Join(",", theme.BadgeColors.Select(kv => kv.Key + kv.Value))}";
        if (_blinkTimer.Enabled && key == _blinkKey) return;
        StopBlink();
        _blinkKey = key;
        _frames = TrayIconRenderer.BuildBlinkFrames(_badge, theme, BlinkSteps).Select(TrayIconRenderer.ToIcon).ToList();
        _blinkStart = Environment.TickCount64;
        _shown = -1;
        _icon.Icon = _frames[0].Icon;
        _blinkTimer.Start();
    }

    private void BlinkTick()
    {
        if (_frames.Count == 0) { _blinkTimer.Stop(); return; }
        double phase = (Environment.TickCount64 - _blinkStart) % (2 * BlinkHalfMs) / (double)BlinkHalfMs;
        int idx = (int)Math.Round((phase <= 1 ? phase : 2 - phase) * BlinkSteps);
        if (idx == _shown) return;
        _shown = idx;
        _icon.Icon = _frames[idx].Icon;
    }

    public void ApplyBadge()
    {
        if (_badge.Count > 0) StartBlink();
        else
        {
            StopBlink();
            var next = TrayIconRenderer.ToIcon(TrayIconRenderer.BuildPlain(Theme()));
            _icon.Icon = next.Icon;
            _plain?.Dispose();
            _plain = next;
        }
        string tip = _badge.Count > 0
            ? $"MeshCrowd ({_labels["unread"].Replace("{count}", _badge.Count > 99 ? "99+" : _badge.Count.ToString())})"
            : "MeshCrowd";
        _icon.Text = tip.Length > 127 ? tip[..127] : tip;
    }

    public void Dispose()
    {
        _blinkTimer.Stop();
        _icon.Visible = false;
        _icon.Dispose();
        DisposeFrames();
        _plain?.Dispose();
    }
}
