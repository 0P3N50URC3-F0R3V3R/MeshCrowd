using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace MeshCrowd.Launcher;

public sealed class NavBar : Control
{
    public sealed record Item(string Name, string Glyph, string Tip);
    private readonly List<Item> _items = new();
    private int _sel, _hover = -1;
    public event Action<string>? Navigate;
    public Func<string, int>? Badge;

    public NavBar()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        Cursor = Cursors.Hand;
    }

    public void Add(string name, string glyph, string tip) { _items.Add(new Item(name, glyph, tip)); Invalidate(); }
    public string Selected { get => _items[_sel].Name; set { int i = _items.FindIndex(x => x.Name == value); if (i >= 0 && i != _sel) { _sel = i; Invalidate(); } } }

    private int At(Point p) { int i = (p.Y - 6) / 42; return p.Y >= 6 && i >= 0 && i < _items.Count ? i : -1; }
    protected override void OnMouseMove(MouseEventArgs e) { int h = At(e.Location); if (h != _hover) { _hover = h; Invalidate(); } base.OnMouseMove(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = -1; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { int i = At(e.Location); if (i >= 0) { _sel = i; Invalidate(); Navigate?.Invoke(_items[i].Name); } base.OnMouseDown(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        Theme.Quality(g);
        g.Clear(Theme.Bg1);
        for (int i = 0; i < _items.Count; i++)
        {
            var r = new Rectangle(10, 6 + i * 42, Width - 20, 38);
            bool sel = i == _sel;
            if (sel || i == _hover)
            {
                using var path = Theme.Round(r, 5);
                using var br = new SolidBrush(sel ? Theme.Bg4 : Theme.Bg3);
                g.FillPath(br, path);
            }
            if (sel) { using var br = new SolidBrush(Theme.Accent); g.FillRoundedRect(br, new Rectangle(2, r.Y + 8, 4, r.Height - 16)); }
            var fore = sel ? Theme.TextBright : i == _hover ? Theme.Text : Theme.Muted;
            TextRenderer.DrawText(g, _items[i].Glyph, Theme.Icons, new Rectangle(r.X + 6, r.Y, 30, r.Height), fore, TextFormatFlags.VerticalCenter | TextFormatFlags.HorizontalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            TextRenderer.DrawText(g, _items[i].Name, sel ? Theme.UiBold : Theme.Ui, new Rectangle(r.X + 44, r.Y, r.Width - 60, r.Height), fore, TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            int b = Badge?.Invoke(_items[i].Name) ?? 0;
            if (b > 0)
            {
                var br2 = new Rectangle(r.Right - 30, r.Y + 11, 20, 16);
                using var path = Theme.Round(br2, 8);
                using var fill = new SolidBrush(Theme.Red);
                g.FillPath(fill, path);
                TextRenderer.DrawText(g, b > 99 ? "99+" : b.ToString(), Theme.UiSmall, br2, Color.White, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            }
        }
    }
}

internal static class GfxExt
{
    public static void FillRoundedRect(this Graphics g, Brush b, Rectangle r)
    {
        using var p = Theme.Round(r, 2);
        g.FillPath(b, p);
    }
}

public sealed class MainForm : Form
{
    private readonly NavBar _nav = new() { Dock = DockStyle.Fill };
    private readonly Panel _content = new() { Dock = DockStyle.Fill, BackColor = Theme.Bg2 };
    private readonly Dictionary<string, Page> _pages = new();
    private readonly DLabel _title = new() { Font = Theme.UiTitle, ForeColor = Theme.TextBright, Wrap = false };
    private readonly DLabel _subtitle = new() { ForeColor = Theme.Muted, Wrap = false };
    private readonly Panel _header = new() { Dock = DockStyle.Top, Height = 74, BackColor = Theme.Bg2 };
    private readonly Panel _statusPanel = new() { Dock = DockStyle.Bottom, Height = 96, BackColor = Theme.Bg0 };
    private readonly DButton _quick;
    private readonly NotifyIcon _tray = new();
    private readonly Dictionary<Color, Icon> _icons = new();
    private readonly System.Windows.Forms.Timer _clock = new() { Interval = 1000 };
    private Page? _current;
    private bool _exiting;

    public MainForm()
    {
        App.Main = this;
        Text = "MeshCrowd Launcher";
        Icon = App.AppIcon();
        BackColor = Theme.Bg2;
        ForeColor = Theme.Text;
        Font = Theme.Ui;
        MinimumSize = new Size(1040, 660);
        Size = new Size(1320, 840);
        StartPosition = FormStartPosition.CenterScreen;
        KeyPreview = true;
        DoubleBuffered = true;
        HandleCreated += (_, _) => Theme.DarkCaption(Handle);

        var side = new Panel { Dock = DockStyle.Left, Width = 244, BackColor = Theme.Bg1 };
        var brand = new Panel { Dock = DockStyle.Top, Height = 76, BackColor = Theme.Bg1 };
        brand.Paint += (_, e) =>
        {
            Theme.Quality(e.Graphics);
            try { using var bmp = new Bitmap(new MemoryStream(ReadResource("icon.png"))); e.Graphics.DrawImage(bmp, new Rectangle(18, 18, 40, 40)); } catch { }
            TextRenderer.DrawText(e.Graphics, "MeshCrowd", Theme.UiTitle, new Point(66, 14), Theme.TextBright, TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            TextRenderer.DrawText(e.Graphics, "Server launcher", Theme.UiSmall, new Point(68, 42), Theme.Muted, TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            using var pen = new Pen(Theme.Bg0); e.Graphics.DrawLine(pen, 0, brand.Height - 1, brand.Width, brand.Height - 1);
        };
        _nav.Add("Dashboard", G.Home, "Server state and one-click control");
        _nav.Add("Console", G.Console, "Live log and interactive commands");
        _nav.Add("Commands", G.List, "Every console command, documented");
        _nav.Add("Config", G.Settings, "Edit data\\config.json with documentation");
        _nav.Add("Logs", G.Doc, "Browse log files");
        _nav.Add("Supervisor", G.Heart, "Restarts, crashes, reports");
        _nav.Add("Tools", G.Tool, "Users, accounts, backups, health check");
        _nav.Add("Settings", G.Key, "Launcher policies");
        _nav.Add("Help", G.Help, "Guide and shortcuts");
        _nav.Navigate += GoTo;
        _nav.Badge = n => n == "Supervisor" ? Math.Min(99, App.Host.Crashes) : 0;

        _quick = new DButton("Start", BtnKind.Success, G.Play) { AutoSize = false, Width = 200 };
        _quick.Click += async (_, _) =>
        {
            if (App.Host.IsActive || App.Host.State == SState.Backoff) { if (Dlg.Confirm(this, "Stop the server", "Stop the server now?", "Stop", true)) await App.Host.StopAsync(); }
            else { var err = App.Host.Start(); if (err != null) Dlg.Info(this, "Cannot start the server", err); }
        };
        _statusPanel.Controls.Add(_quick);
        _statusPanel.Paint += PaintStatus;
        _statusPanel.Resize += (_, _) => _quick.SetBounds(16, 52, _statusPanel.Width - 32, 32);

        side.Controls.Add(_nav);
        side.Controls.Add(_statusPanel);
        side.Controls.Add(brand);

        _header.Controls.AddRange([_title, _subtitle]);
        _title.SetBounds(32, 12, 800, 32);
        _subtitle.SetBounds(34, 44, 1000, 20);
        _header.Resize += (_, _) => { _title.Width = _header.Width - 64; _subtitle.Width = _header.Width - 64; };
        _header.Paint += (_, e) => { using var p = new Pen(Theme.Divider); e.Graphics.DrawLine(p, 0, _header.Height - 1, _header.Width, _header.Height - 1); };

        var pageHost = new Panel { Dock = DockStyle.Fill, BackColor = Theme.Bg2 };
        _content.Controls.Add(pageHost);
        _content.Controls.Add(_header);
        _pagesHost = pageHost;
        Controls.Add(_content);
        Controls.Add(side);

        AddPage("Dashboard", new DashboardPage());
        AddPage("Console", new ConsolePage());
        AddPage("Commands", new CommandsPage());
        AddPage("Config", new ConfigPage());
        AddPage("Logs", new LogsPage());
        AddPage("Supervisor", new SupervisorPage());
        AddPage("Tools", new ToolsPage());
        AddPage("Settings", new SettingsPage());
        AddPage("Help", new HelpPage());

        SetupTray();
        App.Host.StateChanged += () => BeginInvokeSafe(OnState);
        App.Host.PromptRequested += t => BeginInvokeSafe(() => HandlePrompt(t));
        App.Host.Alert += (title, text, err) => BeginInvokeSafe(() => { if (App.Settings.Bool("trayAlerts")) _tray.ShowBalloonTip(8000, title, text, err ? ToolTipIcon.Error : ToolTipIcon.Info); });
        _clock.Tick += (_, _) => _statusPanel.Invalidate();
        _clock.Start();
        Resize += (_, _) => App.Host.UiVisible = Visible && WindowState != FormWindowState.Minimized;
        VisibleChanged += (_, _) => App.Host.UiVisible = Visible && WindowState != FormWindowState.Minimized;
        KeyDown += (_, e) =>
        {
            if (e.Control && e.KeyCode >= Keys.D1 && e.KeyCode <= Keys.D9)
            {
                var names = _pages.Keys.ToList();
                int i = e.KeyCode - Keys.D1;
                if (i < names.Count) { GoTo(names[i]); e.Handled = true; }
            }
        };
        GoTo("Dashboard");
        OnState();
        _hideOnStart = App.Settings.Bool("startMinimized");
    }

    private readonly Panel _pagesHost;

    private static byte[] ReadResource(string name)
    {
        using var s = System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream(name)!;
        using var ms = new MemoryStream(); s.CopyTo(ms); return ms.ToArray();
    }

    private void BeginInvokeSafe(Action a) { if (IsDisposed || !IsHandleCreated) return; try { BeginInvoke(a); } catch { } }

    private void AddPage(string name, Page p)
    {
        p.Visible = false;
        _pages[name] = p;
        _pagesHost.Controls.Add(p);
    }

    public Page? Page(string name) => _pages.GetValueOrDefault(name);

    public void GoTo(string name)
    {
        if (!_pages.TryGetValue(name, out var p) || p == _current) { return; }
        _current?.OnHidden();
        if (_current != null) _current.Visible = false;
        _current = p;
        p.Visible = true;
        p.BringToFront();
        _title.Text = p.Title;
        _subtitle.Text = p.Subtitle;
        _nav.Selected = name;
        p.OnShown();
    }

    private void PaintStatus(object? sender, PaintEventArgs e)
    {
        var g = e.Graphics;
        Theme.Quality(g);
        var h = App.Host;
        using (var b = new SolidBrush(App.StateColor(h.State))) g.FillEllipse(b, 18, 16, 12, 12);
        var text = h.State switch
        {
            SState.Running => "Running", SState.Starting => "Starting", SState.Stopping => "Stopping", SState.Restarting => "Restarting",
            SState.Backoff => "Restarting soon", SState.Crashed => "Crashed", _ => "Stopped"
        };
        TextRenderer.DrawText(g, text, Theme.UiBold, new Point(38, 11), Theme.TextBright, TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
        var sub = h.RunningSince.HasValue && h.State == SState.Running ? $"up {Ui.FormatSpan(DateTime.Now - h.RunningSince.Value)}" : h.Pid > 0 ? $"PID {h.Pid}" : "";
        TextRenderer.DrawText(g, sub, Theme.UiSmall, new Point(38, 30), Theme.Muted, TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
        using var pen = new Pen(Theme.Bg1); g.DrawLine(pen, 0, 0, _statusPanel.Width, 0);
    }

    private void OnState()
    {
        var h = App.Host;
        bool active = h.IsActive || h.State == SState.Backoff;
        _quick.Text = active ? "Stop server" : "Start server";
        _quick.Glyph = active ? G.Stop : G.Play;
        _quick.Kind = active ? BtnKind.Danger : BtnKind.Success;
        _quick.Enabled = h.State != SState.Stopping;
        _quick.Invalidate();
        _statusPanel.Invalidate();
        _nav.Invalidate();
        _tray.Icon = TrayIcon(App.StateColor(h.State));
        _tray.Text = Trim("MeshCrowd server: " + h.State + (h.RunningSince.HasValue && h.State == SState.Running ? $", up {Ui.FormatSpan(DateTime.Now - h.RunningSince.Value)}" : ""));
        _trayStart.Enabled = !active; _trayStop.Enabled = active; _trayRestart.Enabled = h.State == SState.Running;
    }

    private static string Trim(string s) => s.Length > 62 ? s[..62] : s;

    // ---- prompts from the server console (confirm questions, password questions) ----

    private bool _prompting;
    private void HandlePrompt(string text)
    {
        if (_prompting) return;
        _prompting = true;
        try
        {
            if (!Visible) ShowFromTray();
            string answer;
            if (text.Contains("[y/N]", StringComparison.OrdinalIgnoreCase))
                answer = Dlg.Confirm(this, "The server asks", text.Replace("[y/N]", "").Trim(), "Yes", true) ? "y" : "n";
            else
            {
                bool secret = text.Contains("password", StringComparison.OrdinalIgnoreCase);
                answer = Dlg.Input(this, "The server asks", text.TrimEnd(':').Trim() + ":", "", secret) ?? "";
            }
            try { App.Host.Send(answer); } catch { }
            if (!text.Contains("password", StringComparison.OrdinalIgnoreCase))
                App.Host.PostLine(new LogLine(DateTime.Now, "CMD", "console", answer, answer));
        }
        finally { _prompting = false; }
    }

    // ---- tray ----

    private ToolStripMenuItem _trayStart = null!, _trayStop = null!, _trayRestart = null!;

    private Icon TrayIcon(Color dot)
    {
        if (_icons.TryGetValue(dot, out var ic)) return ic;
        using var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            Theme.Quality(g);
            try { using var src = new Bitmap(new MemoryStream(ReadResource("icon.png"))); g.DrawImage(src, new Rectangle(0, 0, 32, 32)); } catch { }
            using var white = new SolidBrush(Color.FromArgb(0x1E, 0x1F, 0x22));
            g.FillEllipse(white, 15, 15, 17, 17);
            using var b = new SolidBrush(dot);
            g.FillEllipse(b, 17, 17, 13, 13);
        }
        var icon = Icon.FromHandle(bmp.GetHicon());
        _icons[dot] = icon;
        return icon;
    }

    private void SetupTray()
    {
        var m = DarkMenu.Create();
        m.Items.Add("Show launcher", null, (_, _) => ShowFromTray());
        m.Items.Add(new ToolStripSeparator());
        _trayStart = (ToolStripMenuItem)m.Items.Add("Start server", null, (_, _) => { var err = App.Host.Start(); if (err != null) _tray.ShowBalloonTip(6000, "Cannot start", err, ToolTipIcon.Error); });
        _trayRestart = (ToolStripMenuItem)m.Items.Add("Restart server", null, (_, _) => App.Host.RestartGraceful(App.Settings.Int("restartWarnSeconds")));
        _trayStop = (ToolStripMenuItem)m.Items.Add("Stop server", null, async (_, _) => await App.Host.StopAsync());
        m.Items.Add(new ToolStripSeparator());
        m.Items.Add("Exit and stop server", null, (_, _) => ExitApp());
        _tray.ContextMenuStrip = m;
        _tray.Icon = TrayIcon(Theme.Muted);
        _tray.Text = "MeshCrowd Launcher";
        _tray.Visible = true;
        _tray.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) ShowFromTray(); };
    }

    public void ShowFromTray()
    {
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
        BringToFront();
        App.Host.UiVisible = true;
    }

    public async void ExitApp()
    {
        if (_exiting) return;
        if (App.Host.IsActive)
        {
            if (!Visible) ShowFromTray();
            var users = App.Host.Stats?.Users ?? 0;
            if (!Dlg.Confirm(this, "Exit the launcher", $"Exiting also stops the server{(users > 0 ? $" and disconnects {users} online user(s)" : "")}. Continue?", "Stop server and exit", true)) return;
            _exiting = true;
            Enabled = false;
            await App.Host.StopAsync();
        }
        _exiting = true;
        _tray.Visible = false;
        App.Host.Dispose();
        Application.Exit();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!_exiting && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            if (App.Settings.Bool("minimizeToTray")) { Hide(); App.Host.UiVisible = false; _tray.ShowBalloonTip(2500, "MeshCrowd Launcher", "Still running in the tray. Right-click the icon to exit.", ToolTipIcon.Info); }
            else ExitApp();
            return;
        }
        if (!_exiting && App.Host.IsActive) { try { App.Host.Kill(); } catch { } }
        base.OnFormClosing(e);
    }

    private bool _hideOnStart;

    protected override void SetVisibleCore(bool value)
    {
        if (_hideOnStart) { _hideOnStart = false; if (!IsHandleCreated) CreateHandle(); value = false; }
        base.SetVisibleCore(value);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == Program.ShowMessage) { ShowFromTray(); return; }
        base.WndProc(ref m);
    }
}
