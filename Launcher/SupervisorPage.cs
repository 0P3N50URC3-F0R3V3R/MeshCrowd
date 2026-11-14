using System.Text;

namespace MeshCrowd.Launcher;

public sealed class SupervisorPage : Page
{
    private readonly DSubTabs _tabs = new() { Dock = DockStyle.Top, Tabs = ["Overview", "Timeline", "Reports"] };
    private readonly Panel _host = new() { Dock = DockStyle.Fill };
    private readonly Panel _overview = new() { Dock = DockStyle.Fill, Visible = true };
    private readonly Panel _timeline = new() { Dock = DockStyle.Fill, Visible = false };
    private readonly Panel _reports = new() { Dock = DockStyle.Fill, Visible = false };
    private readonly DList _events = new() { Dock = DockStyle.Fill };
    private readonly DCombo _typeFilter = new() { Width = 200 };
    private readonly DList _reportList = new() { Dock = DockStyle.Fill };
    private readonly RichTextBox _reportView = Ui.LogBox();
    private readonly DLabel _policy = new() { Font = Theme.Ui, ForeColor = Theme.Text };
    private readonly List<StatCard> _cards = new();
    private StatCard _sRestarts = null!, _sCrashes = null!, _sWatch = null!, _sUp24 = null!, _sUp7 = null!, _sNext = null!;
    private readonly System.Windows.Forms.Timer _clock = new() { Interval = 2000 };

    private static readonly Dictionary<string, (string glyph, Color color, string label)> Kinds = new()
    {
        ["state"] = (G.Pulse, Color.FromArgb(0x94, 0x9B, 0xA4), "State"),
        ["start"] = (G.Play, Color.FromArgb(0x23, 0xA5, 0x5A), "Start"),
        ["stop"] = (G.Stop, Color.FromArgb(0x94, 0x9B, 0xA4), "Stop"),
        ["kill"] = (G.Power, Color.FromArgb(0xF0, 0xB2, 0x32), "Kill"),
        ["restart"] = (G.Restart, Color.FromArgb(0x00, 0xA8, 0xFC), "Restart"),
        ["crash"] = (G.Warning, Color.FromArgb(0xDA, 0x37, 0x3C), "Crash"),
        ["autorestart"] = (G.Restart, Color.FromArgb(0xF0, 0xB2, 0x32), "Auto-restart"),
        ["giveup"] = (G.Cancel, Color.FromArgb(0xDA, 0x37, 0x3C), "Gave up"),
        ["watchdog"] = (G.Heart, Color.FromArgb(0xF0, 0xB2, 0x32), "Watchdog"),
        ["schedule"] = (G.Clock, Color.FromArgb(0x58, 0x65, 0xF2), "Schedule"),
        ["config"] = (G.Settings, Color.FromArgb(0x00, 0xA8, 0xFC), "Config"),
        ["settings"] = (G.Settings, Color.FromArgb(0x00, 0xA8, 0xFC), "Settings"),
        ["launcher"] = (G.Info, Color.FromArgb(0x94, 0x9B, 0xA4), "Launcher"),
        ["error"] = (G.Warning, Color.FromArgb(0xDA, 0x37, 0x3C), "Error"),
    };

    public SupervisorPage()
    {
        Title = "Supervisor";
        Subtitle = "Restarts, crashes and reports: what the launcher has seen and what it did about it.";
        BuildOverview();
        BuildTimeline();
        BuildReports();
        _host.Controls.AddRange([_overview, _timeline, _reports]);
        var tabPad = new Panel { Dock = DockStyle.Top, Height = 44, Padding = new Padding(24, 8, 24, 0) };
        _tabs.Dock = DockStyle.Fill;
        tabPad.Controls.Add(_tabs);
        Controls.Add(_host);
        Controls.Add(tabPad);
        _tabs.SelectedChanged += (_, _) =>
        {
            _overview.Visible = _tabs.Selected == 0; _timeline.Visible = _tabs.Selected == 1; _reports.Visible = _tabs.Selected == 2;
            if (_tabs.Selected == 1) FillEvents();
            if (_tabs.Selected == 2) FillReports();
        };
        App.Events.Added += _ => OnUi(() => { if (_timeline.Visible) FillEvents(); RefreshOverview(); });
        App.Host.ReportsChanged += () => OnUi(() => { if (_reports.Visible) FillReports(); });
        _clock.Tick += (_, _) => RefreshOverview();
    }

    private void BuildOverview()
    {
        var scroll = new ScrollPanel { Dock = DockStyle.Fill };
        scroll.Padding = new Padding(24, 12, 24, 20);
        var cards = new FlowLayoutPanel { AutoSize = true, WrapContents = true, Location = new Point(24, 16), BackColor = Theme.Bg2, MaximumSize = new Size(1200, 0) };
        _sRestarts = new StatCard("Restarts", "Supervisor relaunches since the launcher started (restart command, daily restart, memory limit).");
        _sCrashes = new StatCard("Crashes", "Unexpected exits since the launcher started.");
        _sWatch = new StatCard("Watchdog restarts", "Times the watchdog killed a server that stopped answering.");
        _sUp24 = new StatCard("Running, 24h", "Share of the last 24 hours the launcher saw the server running. Time the launcher itself was closed counts as down.");
        _sUp7 = new StatCard("Running, 7d", "Same for the last 7 days.");
        _sNext = new StatCard("Next planned restart", "From Settings > Scheduling.");
        foreach (var c in new[] { _sRestarts, _sCrashes, _sWatch, _sUp24, _sUp7, _sNext }) { c.Margin = new Padding(0, 0, 14, 14); cards.Controls.Add(c); }
        var polTitle = new DLabel { Text = "ACTIVE POLICY", Font = Theme.UiSmall, ForeColor = Theme.Muted, Location = new Point(24, 270), Size = new Size(300, 16), Wrap = false };
        var polCard = new DCard { Location = new Point(24, 292), Size = new Size(760, 190) };
        _policy.SetBounds(16, 14, 728, 160);
        polCard.Controls.Add(_policy);
        var edit = Ui.Button("Edit policy", BtnKind.Secondary, G.Settings, () => App.Main.GoTo("Settings"), "Open Launcher settings");
        var snap = Ui.Button("Create snapshot report", BtnKind.Secondary, G.Page, Snapshot, "Write a report now", "Saves the current state and the last 300 console lines to data\\launcher\\reports. Useful when something looks wrong but nothing crashed.");
        edit.Location = new Point(24, 498); snap.Location = new Point(edit.Right + 8, 498);
        scroll.Controls.AddRange([cards, polTitle, polCard, edit, snap]);
        scroll.AutoScrollMinSize = new Size(0, 560);
        _overview.Controls.Add(scroll);
    }

    private void BuildTimeline()
    {
        var bar = new Panel { Dock = DockStyle.Top, Height = 54 };
        _typeFilter.Items = ["All events", "Crashes and give-ups", "Restarts", "Watchdog", "State changes", "Config changes"];
        _typeFilter.SelectedIndex = 0;
        _typeFilter.SelectedChanged += (_, _) => FillEvents();
        _typeFilter.Location = new Point(24, 11);
        var clear = Ui.Button("Clear history", BtnKind.Ghost, G.Delete, () =>
        {
            if (!Dlg.Confirm(this, "Clear history", "Delete the saved event history (events.jsonl)? Reports are kept.", "Clear", true)) return;
            try { File.Delete(Paths.EventsFile); } catch { }
            Dlg.Info(this, "Done", "The history file was removed. The list refreshes after the next launcher start.");
        }, "Delete the saved event history");
        clear.Location = new Point(_typeFilter.Right + 8, 11);
        bar.Controls.AddRange([_typeFilter, clear]);
        _events.HeightOf = _ => 34;
        _events.BackColor = Theme.Bg2;
        _events.DrawRow = (g, b, o, sel) =>
        {
            var e = (EventRec)o;
            var k = Kinds.GetValueOrDefault(e.Type, Kinds["launcher"]);
            TextRenderer.DrawText(g, k.glyph, Theme.IconsSmall, new Rectangle(b.X + 8, b.Y, 24, b.Height), k.color, TextFormatFlags.VerticalCenter | TextFormatFlags.HorizontalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            TextRenderer.DrawText(g, e.Time.ToString("MM-dd HH:mm:ss"), Theme.MonoSmall, new Rectangle(b.X + 40, b.Y, 120, b.Height), Theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            TextRenderer.DrawText(g, k.label, Theme.UiBold, new Rectangle(b.X + 168, b.Y, 110, b.Height), k.color, TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
            var txt = e.Detail != null ? $"{e.Message}   ({e.Detail})" : e.Message;
            TextRenderer.DrawText(g, txt, Theme.Ui, new Rectangle(b.X + 282, b.Y, b.Width - 296, b.Height), Theme.Text, TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
        };
        var pad = new Panel { Dock = DockStyle.Fill, Padding = new Padding(24, 0, 24, 24) };
        pad.Controls.Add(_events);
        _timeline.Controls.Add(pad);
        _timeline.Controls.Add(bar);
    }

    private void BuildReports()
    {
        var side = new Panel { Dock = DockStyle.Left, Width = 300, BackColor = Theme.Bg1, Padding = new Padding(12) };
        var top = new Panel { Dock = DockStyle.Top, Height = 44, BackColor = Theme.Bg1 };
        var folder = Ui.Button("Folder", BtnKind.Secondary, G.Folder, () => Sys.OpenFolder(Paths.ReportsDir), "Open the reports folder");
        var del = Ui.Button("Delete", BtnKind.Ghost, G.Delete, DeleteReport, "Delete the selected report");
        var all = Ui.Button("Delete all", BtnKind.Ghost, G.Clear, DeleteAll, "Delete every report");
        top.Controls.AddRange([folder, del, all]);
        del.Location = new Point(folder.Right + 6, 0); all.Location = new Point(del.Right + 4, 0);
        _reportList.HeightOf = _ => 46;
        _reportList.DrawRow = (g, b, o, sel) =>
        {
            var f = (FileInfo)o;
            bool crash = f.Name.StartsWith("crash");
            if (sel) { using var br = new SolidBrush(Theme.Accent); g.FillRectangle(br, b.X, b.Y + 4, 3, b.Height - 8); }
            TextRenderer.DrawText(g, f.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss"), Theme.Ui, new Rectangle(b.X + 12, b.Y + 5, b.Width - 20, 20), sel ? Theme.TextBright : Theme.Text, TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            TextRenderer.DrawText(g, crash ? "crash report" : "snapshot", Theme.UiSmall, new Rectangle(b.X + 12, b.Y + 25, b.Width - 20, 16), crash ? Theme.Red : Theme.Muted, TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
        };
        _reportList.SelectedIndexChanged += (_, _) =>
        {
            _reportView.Clear();
            if (_reportList.SelectedItem is FileInfo f) { try { _reportView.Text = File.ReadAllText(f.FullName); } catch { } }
        };
        side.Controls.Add(_reportList);
        side.Controls.Add(new Panel { Dock = DockStyle.Top, Height = 8, BackColor = Theme.Bg1 });
        side.Controls.Add(top);
        _reportView.Dock = DockStyle.Fill;
        var pad = new Panel { Dock = DockStyle.Fill, Padding = new Padding(24, 12, 24, 24) };
        pad.Controls.Add(_reportView);
        _reports.Controls.Add(pad);
        _reports.Controls.Add(side);
    }

    private void FillEvents()
    {
        string[]? types = _typeFilter.SelectedIndex switch
        {
            1 => ["crash", "giveup", "error"], 2 => ["restart", "autorestart"], 3 => ["watchdog"], 4 => ["state"], 5 => ["config", "settings"], _ => null
        };
        var list = App.Events.Snapshot().Where(e => types == null ? e.Type != "state" || false : types.Contains(e.Type)).Reverse().Take(1500).ToList();
        if (types == null) list = App.Events.Snapshot().Where(e => e.Type != "state").Reverse().Take(1500).ToList();
        _events.BeginUpdate();
        _events.Items.Clear();
        foreach (var e in list) _events.Items.Add(e);
        _events.EndUpdate();
    }

    private void FillReports()
    {
        _reportList.BeginUpdate();
        _reportList.Items.Clear();
        try { foreach (var f in new DirectoryInfo(Paths.ReportsDir).GetFiles("*.txt").OrderByDescending(f => f.LastWriteTime)) _reportList.Items.Add(f); } catch { }
        _reportList.EndUpdate();
        if (_reportList.Items.Count > 0) _reportList.SelectedIndex = 0; else _reportView.Text = "No reports yet. A report is written when the server crashes, or from Overview > Create snapshot report.";
    }

    private void Snapshot()
    {
        var up = App.Host.RunningSince.HasValue ? DateTime.Now - App.Host.RunningSince.Value : TimeSpan.Zero;
        var p = App.Host.WriteReport("Manual snapshot", 0, up, true);
        if (p == null) { Dlg.Info(this, "Failed", "The report could not be written."); return; }
        App.Events.Add("launcher", "Snapshot report written", Path.GetFileName(p));
        _tabs.Selected = 2;
        FillReports();
    }

    private void DeleteReport()
    {
        if (_reportList.SelectedItem is not FileInfo f || !Dlg.Confirm(this, "Delete report", $"Delete {f.Name}?", "Delete", true)) return;
        try { f.Delete(); } catch { }
        FillReports();
    }

    private void DeleteAll()
    {
        if (!Dlg.Confirm(this, "Delete all reports", "Delete every crash and snapshot report?", "Delete all", true)) return;
        try { foreach (var f in new DirectoryInfo(Paths.ReportsDir).GetFiles("*.txt")) f.Delete(); } catch { }
        FillReports();
    }

    private void RefreshOverview()
    {
        var h = App.Host;
        _sRestarts.Set(h.Restarts.ToString(), "supervisor relaunches");
        _sCrashes.Set(h.Crashes.ToString(), "unexpected exits", h.Crashes > 0 ? Theme.Red : null);
        _sWatch.Set(h.WatchdogRestarts.ToString(), "killed unresponsive server");
        _sUp24.Set($"{App.Events.RunningFraction(TimeSpan.FromHours(24)) * 100:0.#}%", "seen by this launcher");
        _sUp7.Set($"{App.Events.RunningFraction(TimeSpan.FromDays(7)) * 100:0.#}%", "seen by this launcher");
        var dr = App.Settings.Str("dailyRestart");
        if (dr.Length == 5)
        {
            var t = DateTime.Today.Add(TimeSpan.Parse(dr));
            if (t < DateTime.Now) t = t.AddDays(1);
            _sNext.Set(dr, t.Date == DateTime.Today ? "today" : "tomorrow");
        }
        else _sNext.Set("off", "no daily restart");
        var s = App.Settings;
        var sb = new StringBuilder();
        sb.AppendLine($"Crash recovery   {(s.Bool("autoRestart") ? $"on: give up after {s.Int("maxCrashes")} crashes in {s.Int("crashWindowMinutes")} min, first retry after {s.Int("backoffSeconds")} s" : "off: a crash leaves the server down")}");
        sb.AppendLine($"Watchdog         {(s.Bool("watchdog") ? $"on: probe every {s.Int("watchdogIntervalSeconds")} s, restart after {s.Int("watchdogFailures")} failures" : "off")}");
        sb.AppendLine($"Daily restart    {(s.Str("dailyRestart") == "" ? "off" : s.Str("dailyRestart") + $" with {s.Int("restartWarnSeconds")} s warning")}");
        sb.AppendLine($"Memory limit     {(s.Int("memoryLimitMb") > 0 ? $"restart above {s.Int("memoryLimitMb")} MB" : "off")}");
        sb.AppendLine($"Crash reports    {(s.Bool("reportOnCrash") ? "written to data\\launcher\\reports" : "off")}");
        sb.AppendLine($"Alerts           tray {(s.Bool("trayAlerts") ? "on" : "off")}, webhook {(s.Str("discordWebhook").StartsWith("https://") ? "configured" : "not set")}");
        sb.Append($"Stop timeout     {s.Int("stopTimeoutSeconds")} s before force kill");
        _policy.Font = Theme.Mono;
        _policy.Text = sb.ToString();
    }

    public override void OnShown() { RefreshOverview(); _clock.Start(); if (_timeline.Visible) FillEvents(); if (_reports.Visible) FillReports(); }
    public override void OnHidden() { _clock.Stop(); }
}
