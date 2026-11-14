using System.Diagnostics;

namespace MeshCrowd.Launcher;

public sealed class StatCard : DCard
{
    private readonly DLabel _title = new() { Font = Theme.UiSmall, ForeColor = Theme.Muted, Wrap = false };
    private readonly DLabel _value = new() { Font = Theme.UiBig, ForeColor = Theme.TextBright, Wrap = false };
    private readonly DLabel _sub = new() { Font = Theme.UiSmall, ForeColor = Theme.Muted, Wrap = false };
    public Spark? Chart { get; }

    public StatCard(string title, string tip, bool spark = false, Color? line = null)
    {
        Size = new Size(230, 112);
        Padding = new Padding(14);
        _title.Text = title.ToUpperInvariant();
        _title.SetBounds(14, 12, 200, 16);
        _value.Text = "-";
        _value.SetBounds(14, 30, 200, 36);
        _sub.SetBounds(14, 68, 200, 16);
        Controls.AddRange([_title, _value, _sub]);
        if (spark)
        {
            Chart = new Spark { Line = line ?? Theme.Accent, BackColor = Theme.Bg1 };
            Chart.SetBounds(14, 84, 202, 22);
            Controls.Add(Chart);
        }
        Tip.Set(this, title, tip);
        foreach (Control c in Controls) Tip.Set(c, title, tip);
    }

    public void Set(string value, string sub = "", Color? color = null)
    {
        _value.Text = value;
        _value.ForeColor = color ?? Theme.TextBright;
        _sub.Text = sub;
    }
}

public sealed class DashboardPage : Page
{
    private readonly DCard _hero = new() { Height = 150 };
    private readonly Label _dot = new() { Size = new Size(18, 18), BackColor = Color.Transparent };
    private readonly DLabel _state = new() { Font = Theme.UiBig, ForeColor = Theme.TextBright, Wrap = false };
    private readonly DLabel _detail = new() { ForeColor = Theme.Muted, Wrap = false };
    private readonly DLabel _meta = new() { ForeColor = Theme.Text, Wrap = false };
    private readonly DButton _start, _stop, _restart, _restartIn, _cancel, _kill, _openWeb, _openClient, _openData;
    private readonly ScrollPanel _scroll = new() { Dock = DockStyle.Fill };
    private readonly FlowLayoutPanel _cards = new() { AutoSize = true, WrapContents = true, BackColor = Theme.Bg2, Margin = new Padding(0) };
    private readonly StatCard _users, _cpu, _mem, _req, _lag, _db, _turn, _warn, _restarts, _crashes, _up24, _up7;
    private readonly DCard _recentCard = new();
    private readonly RichTextBox _recent = Ui.LogBox();
    private readonly DLabel _recentTitle = new() { Text = "RECENT WARNINGS AND ERRORS", Font = Theme.UiSmall, ForeColor = Theme.Muted, Wrap = false };
    private readonly System.Windows.Forms.Timer _clock = new() { Interval = 1000 };
    private bool _starting;

    public DashboardPage()
    {
        Title = "Dashboard";
        Subtitle = "Live state of the server process, with one-click control.";
        _scroll.Padding = new Padding(24, 20, 24, 20);

        _dot.Paint += (_, e) => { Theme.Quality(e.Graphics); using var b = new SolidBrush(App.StateColor(App.Host.State)); e.Graphics.FillEllipse(b, 1, 1, 15, 15); };
        _start = Ui.Button("Start server", BtnKind.Success, G.Play, StartServer, "Start the server", "Runs runtime\\node.exe server\\supervisor.js in the background. Checks the ports first.");
        _stop = Ui.Button("Stop", BtnKind.Danger, G.Stop, StopServer, "Stop the server", "Clean shutdown through the server's own stop command (database is flushed). Force-kills only after the timeout in Settings.");
        _restart = Ui.Button("Restart", BtnKind.Primary, G.Restart, () => App.Host.RestartGraceful(0), "Restart now", "The supervisor relaunches the server process. Online users reconnect on their own.");
        _restartIn = Ui.Button("Restart with countdown", BtnKind.Secondary, G.Clock, RestartIn, "Restart after a countdown", "Online users see a notice with the remaining time (server restart <seconds>).");
        _cancel = Ui.Button("Cancel pending", BtnKind.Ghost, G.Cancel, () => App.Host.CancelPending(), "Cancel a scheduled stop/restart", "Sends 'server cancel'.");
        _kill = Ui.Button("Force kill", BtnKind.Ghost, G.Power, KillServer, "Terminate immediately", "Kills the whole process tree. Use only when the server hangs; the database may need recovery.");
        _openWeb = Ui.Button("Open web UI", BtnKind.Secondary, G.Globe, () => Sys.OpenUrl(App.LocalUrl()), "Open the web client in your browser", "Uses localhost and the configured port. Self-signed certificates show a browser warning.");
        _openClient = Ui.Button("Desktop client", BtnKind.Secondary, G.Home, OpenClient, "Start the desktop client", "Runs start-client.bat from the server folder.");
        _openData = Ui.Button("Data folder", BtnKind.Secondary, G.Folder, () => Sys.OpenFolder(Paths.DataDir), "Open the data folder");

        _hero.Controls.AddRange([_dot, _state, _detail, _meta, _start, _stop, _restart, _restartIn, _cancel, _kill, _openWeb, _openClient, _openData]);
        _hero.Resize += (_, _) => LayoutHero();

        _users = new StatCard("Users online", "Signed-in users and open connections (from the 'stats' command).", true, Theme.Green);
        _cpu = new StatCard("CPU", "CPU use of the server process.", true, Theme.Accent);
        _mem = new StatCard("Memory", "Resident memory (RSS) of the server process. A steady rise over days can indicate a leak; the launcher can restart at a limit (Settings > Scheduling).", true, Theme.Link);
        _req = new StatCard("Requests / min", "HTTP requests per minute and server errors (5xx).", true, Theme.Yellow);
        _lag = new StatCard("Event loop lag", "How long the single JavaScript thread is blocked. Above ~100 ms the server feels sluggish.", true, Theme.Red);
        _db = new StatCard("Database", "SQLite database size and write-ahead log size.");
        _turn = new StatCard("TURN relays", "Active relayed voice/video allocations.");
        _warn = new StatCard("Warn / error (1h)", "Warnings and errors logged in the last hour.");
        _restarts = new StatCard("Restarts", "Supervisor relaunches seen since the launcher started (planned and requested).");
        _crashes = new StatCard("Crashes", "Unexpected exits since the launcher started, and watchdog restarts.");
        _up24 = new StatCard("Running, 24h", "Share of the last 24 hours the launcher saw the server running.");
        _up7 = new StatCard("Running, 7d", "Share of the last 7 days the launcher saw the server running.");
        foreach (var c in new[] { _users, _cpu, _mem, _req, _lag, _db, _turn, _warn, _restarts, _crashes, _up24, _up7 }) { c.Margin = new Padding(0, 0, 14, 14); _cards.Controls.Add(c); }

        _recentCard.Height = 230;
        _recentTitle.SetBounds(16, 12, 400, 16);
        _recent.BackColor = Theme.Bg0;
        _recent.SetBounds(14, 36, 400, 180);
        _recentCard.Controls.AddRange([_recentTitle, _recent]);
        _recentCard.Resize += (_, _) => _recent.SetBounds(14, 36, _recentCard.Width - 28, _recentCard.Height - 50);

        _scroll.Controls.AddRange([_hero, _cards, _recentCard]);
        _scroll.Resize += (_, _) => LayoutAll();
        Controls.Add(_scroll);

        _clock.Tick += (_, _) => Refresh2();
        App.Host.StateChanged += () => OnUi(Refresh2);
        App.Host.StatsUpdated += s => OnUi(() => ApplyStats(s));
        App.Host.LineAdded += l => { if (l.Level is "WARN" or "ERROR") OnUi(() => AddRecent(l)); };
        foreach (var l in App.Host.Snapshot().Where(l => l.Level is "WARN" or "ERROR").TakeLast(30)) AddRecent(l);
        LayoutAll();
        Refresh2();
    }

    private void LayoutAll()
    {
        int w = Math.Max(500, _scroll.ClientSize.Width - 48);
        _hero.SetBounds(24, 20, w, 150);
        LayoutHero();
        _cards.MaximumSize = new Size(w + 14, 0);
        _cards.Location = new Point(24, _hero.Bottom + 20);
        int perRow = Math.Max(1, (w + 14) / (230 + 14));
        int rows = (int)Math.Ceiling(12 / (double)perRow);
        _cards.Size = new Size(w + 14, rows * (112 + 14));
        _recentCard.SetBounds(24, _cards.Bottom + 6, w, 230);
        _scroll.AutoScrollMinSize = new Size(0, _recentCard.Bottom + 24);
    }

    private void LayoutHero()
    {
        int w = _hero.Width;
        _dot.Location = new Point(22, 26);
        _state.SetBounds(50, 16, 420, 38);
        _detail.SetBounds(52, 58, Math.Max(100, w - 70), 20);
        _meta.SetBounds(52, 80, Math.Max(100, w - 70), 20);
        int x = 22, y = 108;
        foreach (var b in new[] { _start, _stop, _restart, _restartIn, _cancel, _kill })
        {
            if (!b.Visible) continue;
            b.Location = new Point(x, y);
            x += b.Width + 8;
        }
        int rx = w - 22;
        foreach (var b in new[] { _openData, _openClient, _openWeb })
        {
            b.Location = new Point(rx - b.Width, y);
            rx = b.Left - 8;
        }
    }

    private void AddRecent(LogLine l)
    {
        _recent.SelectionStart = _recent.TextLength;
        _recent.SelectionColor = l.Level == "ERROR" ? Theme.Red : Theme.Yellow;
        _recent.AppendText($"{l.Time:HH:mm:ss} {l.Level,-5} [{l.Category}] {l.Message}\n");
        if (_recent.Lines.Length > 60) { _recent.Select(0, _recent.GetFirstCharIndexFromLine(20)); _recent.SelectedText = ""; }
        _recent.ScrollToEnd();
    }

    private void StartServer()
    {
        if (_starting) return;
        var err = App.Host.Start();
        if (err != null) Dlg.Info(this, "Cannot start the server", err);
    }

    private async void StopServer()
    {
        if (!Dlg.Confirm(this, "Stop the server", App.Host.Stats is { Users: > 0 } s ? $"{s.Users} user(s) are online and will be disconnected. Stop the server now?" : "Stop the server now?", "Stop", true)) return;
        _stop.Enabled = false;
        await App.Host.StopAsync();
    }

    private void KillServer()
    {
        if (Dlg.Confirm(this, "Force kill", "Terminate the server process tree immediately without a clean shutdown?", "Kill", true)) App.Host.Kill();
    }

    private void RestartIn()
    {
        var v = Dlg.Input(this, "Restart with countdown", "Seconds until the restart (online users are warned):", App.Settings.Int("restartWarnSeconds").ToString(), false,
            s => int.TryParse(s, out var n) && n is >= 1 and <= 86400 ? null : "enter a number between 1 and 86400");
        if (v != null) App.Host.RestartGraceful(int.Parse(v));
    }

    private void OpenClient()
    {
        var bat = Path.Combine(Paths.Root, "start-client.bat");
        if (!File.Exists(bat)) { Dlg.Info(this, "Not found", "start-client.bat is not in the server folder."); return; }
        try { Process.Start(new ProcessStartInfo(bat) { WorkingDirectory = Paths.Root, UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden }); } catch { }
    }

    private void ApplyStats(ServerStats s)
    {
        _users.Set(s.Users.ToString(), $"{s.Conns} connection(s)");
        _users.Chart?.Add(s.Users);
        _cpu.Set($"{s.Cpu:0.#}%", s.Load == "" ? "" : "load " + s.Load);
        _cpu.Chart?.Add(s.Cpu);
        _cpu.Chart!.Max = 100;
        _mem.Set($"{s.Rss:0} MB", $"heap {s.HeapUsed:0}/{s.HeapTotal:0} MB, host free {s.SysFree / 1024:0.0} GB");
        _mem.Chart?.Add(s.Rss);
        _req.Set($"{s.ReqMin:0}", $"5xx: {s.Err5xx:0}", s.Err5xx > 0 ? Theme.Yellow : null);
        _req.Chart?.Add(s.ReqMin);
        _lag.Set($"{s.Lag:0.#} ms", s.Lag > 100 ? "blocked, check load" : "healthy", s.Lag > 100 ? Theme.Red : null);
        _lag.Chart?.Add(s.Lag);
        _db.Set($"{s.DbMb:0.#} MB", $"WAL {s.WalMb:0.#} MB");
        _turn.Set(s.Turn.ToString(), "active allocations");
        _warn.Set($"{s.Warn1h} / {s.Err1h}", "warnings / errors", s.Err1h > 0 ? Theme.Red : s.Warn1h > 0 ? Theme.Yellow : null);
    }

    private void Refresh2()
    {
        var h = App.Host;
        var st = h.State;
        _dot.Invalidate();
        _state.Text = st switch
        {
            SState.Running => "Server is running", SState.Starting => "Starting...", SState.Stopping => "Stopping...", SState.Restarting => "Restarting...",
            SState.Backoff => "Waiting to restart", SState.Crashed => "Server crashed", _ => "Server is stopped"
        };
        _state.ForeColor = st == SState.Stopped ? Theme.TextBright : App.StateColor(st);
        string detail = st switch
        {
            SState.Running => h.NextAction != null ? $"Scheduled: {h.NextAction}" : "Accepting connections.",
            SState.Backoff when h.BackoffUntil.HasValue => $"Crash recovery: restart in {Math.Max(0, (int)(h.BackoffUntil.Value - DateTime.Now).TotalSeconds)} s (Stop cancels).",
            SState.Crashed => h.StateDetail,
            SState.Stopped => Paths.ServerPresent ? "Press Start server. The launcher keeps it supervised while this window is open." : "server\\supervisor.js not found: place Launcher.exe in the server folder.",
            _ => h.StateDetail
        };
        _detail.Text = detail;
        _detail.ForeColor = st == SState.Crashed ? Theme.Red : Theme.Muted;
        var parts = new List<string>();
        if (h.Pid > 0) parts.Add($"PID {h.Pid}");
        if (h.Version != "") parts.Add($"version {h.Version}");
        if (h.RunningSince.HasValue) parts.Add($"up {Ui.FormatSpan(DateTime.Now - h.RunningSince.Value)}");
        parts.Add(App.LocalUrl());
        _meta.Text = string.Join("   |   ", parts);

        bool active = h.IsActive;
        _start.Visible = !active && st != SState.Backoff;
        _stop.Visible = active || st == SState.Backoff;
        _stop.Enabled = st != SState.Stopping;
        _restart.Visible = st == SState.Running;
        _restartIn.Visible = st == SState.Running;
        _cancel.Visible = st == SState.Running && h.NextAction != null;
        _kill.Visible = active;
        LayoutHero();

        _restarts.Set(h.Restarts.ToString(), "supervisor relaunches");
        _crashes.Set(h.Crashes.ToString(), $"{h.WatchdogRestarts} by watchdog", h.Crashes > 0 ? Theme.Yellow : null);
        var f24 = App.Events.RunningFraction(TimeSpan.FromHours(24));
        var f7 = App.Events.RunningFraction(TimeSpan.FromDays(7));
        _up24.Set($"{f24 * 100:0.#}%", "seen by this launcher");
        _up7.Set($"{f7 * 100:0.#}%", "seen by this launcher");
        if (st != SState.Running && h.Stats != null)
        {
            _users.Set("-", "server not running");
        }
    }

    public override void OnShown() { _clock.Start(); Refresh2(); LayoutAll(); }
    public override void OnHidden() { _clock.Stop(); }
}
