using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;

namespace MeshCrowd.Launcher;

public sealed class ToolsPage : Page
{
    private readonly DSubTabs _tabs = new() { Tabs = ["Users", "Accounts", "Backups", "Doctor", "Maintenance"] };
    private readonly Panel[] _panels = new Panel[5];
    private readonly DList _players = new(), _accounts = new(), _backups = new(), _doctor = new();
    private readonly DInput _announce = new() { Placeholder = "Message to every online user" };
    private readonly DLabel _playerInfo = new() { Wrap = false, ForeColor = Theme.Muted, Align = ContentAlignment.MiddleRight };
    private readonly DLabel _backupInfo = new() { Wrap = false, ForeColor = Theme.Muted, Align = ContentAlignment.MiddleRight };
    private readonly DLabel _accInfo = new() { Wrap = false, ForeColor = Theme.Muted, Align = ContentAlignment.MiddleRight };
    private readonly DLabel _docSummary = new() { Wrap = false, ForeColor = Theme.Muted, Align = ContentAlignment.MiddleLeft };
    private readonly DLabel _docDetail = new() { ForeColor = Theme.Text };
    private DButton _fixBtn = null!;
    private enum Sev { Ok, Info, Warn, Fail }
    private sealed record Check(Sev Sev, string Name, string Detail, string? FixLabel = null, Func<Task>? Fix = null);
    private List<Check> _checks = new();

    public ToolsPage()
    {
        Title = "Tools";
        Subtitle = "Online users, accounts, backups, a health check and maintenance helpers.";
        for (int i = 0; i < _panels.Length; i++) _panels[i] = new Panel { Dock = DockStyle.Fill, Visible = i == 0 };
        BuildPlayers(); BuildAccounts(); BuildBackups(); BuildDoctor(); BuildMaintenance();
        var host = new Panel { Dock = DockStyle.Fill };
        host.Controls.AddRange(_panels);
        var tabPad = new Panel { Dock = DockStyle.Top, Height = 44, Padding = new Padding(24, 8, 24, 0) };
        _tabs.Dock = DockStyle.Fill;
        tabPad.Controls.Add(_tabs);
        Controls.Add(host);
        Controls.Add(tabPad);
        App.Host.StateChanged += () => OnUi(() => { if (Visible && App.Host.State == SState.Running) Enter(_tabs.Selected); });
        _tabs.SelectedChanged += (_, _) => { for (int i = 0; i < _panels.Length; i++) _panels[i].Visible = i == _tabs.Selected; Enter(_tabs.Selected); };
    }

    private void Enter(int tab)
    {
        if (tab == 0) _ = RefreshPlayers();
        else if (tab == 1) _ = RefreshAccounts();
        else if (tab == 2) _ = RefreshBackups();
        else if (tab == 3 && _checks.Count == 0) _ = RunDoctor();
    }

    public override void OnShown() { Enter(_tabs.Selected); }

    private static Panel Bar() => new() { Dock = DockStyle.Top, Height = 54 };

    private static void Pad(Panel parent, Control fill, Control bar)
    {
        var pad = new Panel { Dock = DockStyle.Fill, Padding = new Padding(24, 0, 24, 24) };
        fill.Dock = DockStyle.Fill;
        pad.Controls.Add(fill);
        parent.Controls.Add(pad);
        parent.Controls.Add(bar);
    }

    private static void Row(Panel bar, DLabel? info, params Control[] ctl)
    {
        int x = 24;
        foreach (var c in ctl) { c.Location = new Point(x, 11); bar.Controls.Add(c); x += c.Width + 8; }
        if (info != null) { bar.Controls.Add(info); bar.Resize += (_, _) => info.SetBounds(x, 0, Math.Max(40, bar.Width - x - 30), bar.Height); }
    }

    private bool NeedServer()
    {
        if (App.Host.State == SState.Running) return false;
        Dlg.Info(this, "Server not running", "These tools talk to the running server. Start it on the Dashboard first.");
        return true;
    }

    private static string? Selected(DList l)
    {
        return l.SelectedItem as string;
    }

    private static void Mono(DList l)
    {
        l.BackColor = Theme.Bg1;
        l.HeightOf = _ => 28;
        l.DrawRow = (g, b, o, sel) => TextRenderer.DrawText(g, (string)o, Theme.Mono, new Rectangle(b.X + 12, b.Y, b.Width - 24, b.Height), sel ? Theme.TextBright : Theme.Text, TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
    }

    private static void Fill(DList l, string text)
    {
        l.BeginUpdate(); l.Items.Clear();
        foreach (var line in text.Split('\n')) { var t = line.TrimEnd('\r'); if (t.Trim() != "") l.Items.Add(t); }
        l.EndUpdate();
    }

    private async Task Run(string cmd, string? done = null, Action? after = null)
    {
        if (NeedServer()) return;
        var r = await App.Host.RunAsync(cmd, 20000);
        if (done != null) App.Events.Add("launcher", done);
        if (!string.IsNullOrWhiteSpace(r)) Dlg.Info(this, cmd.Split(' ')[0] + " " + (cmd.Split(' ').Length > 1 ? cmd.Split(' ')[1] : ""), r);
        after?.Invoke();
    }

    // ---------------- players ----------------

    private void BuildPlayers()
    {
        var bar = Bar();
        Mono(_players);
        var refresh = Ui.Button("Refresh", BtnKind.Secondary, G.Refresh, () => _ = RefreshPlayers(), "Reload the list of online users", "Runs the 'list' command.");
        var kick = Ui.Button("Kick", BtnKind.Secondary, G.Cancel, async () =>
        {
            var u = UserOf(_players, 1); if (u == null) return;
            await Run($"kick {u}", $"Kicked {u}", () => _ = RefreshPlayers());
        }, "Disconnect the selected user", "Ends the live connections only; the account stays enabled and the user may reconnect.");
        var ban = Ui.Button("Ban", BtnKind.Danger, G.Lock, async () =>
        {
            var u = UserOf(_players, 1); if (u == null) return;
            var reason = Dlg.Input(this, "Ban account", $"Reason for banning {u} (optional):", "");
            if (reason == null) return;
            await Run(string.IsNullOrWhiteSpace(reason) ? $"ban {u} --yes" : $"ban {u} {Q(reason)} --yes", $"Banned {u}", () => _ = RefreshPlayers());
        }, "Ban the selected user", "Disables the account and ends all its sessions. Undo with 'unban' in the Commands tab.");
        _announce.Width = 320;
        var send = Ui.Button("Announce", BtnKind.Primary, G.Send, async () =>
        {
            var t = _announce.Text.Trim(); if (t == "") return;
            await Run($"announce {Q(t)}", "Announcement sent"); _announce.Text = "";
        }, "Show a notice to every online user");
        Row(bar, _playerInfo, refresh, kick, ban, _announce, send);
        Pad(_panels[0], _players, bar);
    }

    private static string Q(string v) => "\"" + v.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

    private string? UserOf(DList l, int tokenIdx)
    {
        if (Selected(l) is not { } line) { Dlg.Info(this, "Select a row", "Click a user in the list first."); return null; }
        var t = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (t.Length <= tokenIdx || line.Contains("online,")) { Dlg.Info(this, "Select a user row", "That row is not a user."); return null; }
        return t[tokenIdx];
    }

    private async Task RefreshPlayers()
    {
        if (App.Host.State != SState.Running) { Fill(_players, "(server is not running)"); _playerInfo.Text = ""; return; }
        Fill(_players, await App.Host.RunAsync("list", 8000, true));
        _playerInfo.Text = "id  username  display name  connections  roles";
    }

    // ---------------- accounts ----------------

    private void BuildAccounts()
    {
        var bar = Bar();
        Mono(_accounts);
        var refresh = Ui.Button("Refresh", BtnKind.Secondary, G.Refresh, () => _ = RefreshAccounts(), "Reload accounts", "Runs 'account list' (200 accounts at most).");
        var info = Ui.Button("Info", BtnKind.Secondary, G.Info, async () => { var u = UserOf(_accounts, 1); if (u != null) await Run($"account info {u}"); }, "Show details of the selected account");
        var create = Ui.Button("Create...", BtnKind.Success, G.Add, CreateAccount, "Create an account", "Password accounts only. The first account can be given the owner role afterwards.");
        var pass = Ui.Button("Reset password", BtnKind.Secondary, G.Key, async () =>
        {
            var u = UserOf(_accounts, 1); if (u == null) return;
            var p = Dlg.Input(this, "Reset password", $"New password for {u}. Sessions and live connections of the account end.", "", true, s => s.Length >= 8 ? null : "at least 8 characters");
            if (p != null) await Run($"account passwd {u} {Q(p)}", $"Password reset for {u}");
        }, "Set a new password for the selected account");
        var dis = Ui.Button("Disable", BtnKind.Secondary, G.Lock, async () => { var u = UserOf(_accounts, 1); if (u != null) await Run($"account disable {u}", $"Disabled {u}", () => _ = RefreshAccounts()); }, "Disable the selected account", "Ends its sessions; the account cannot log in until enabled again.");
        var en = Ui.Button("Enable", BtnKind.Secondary, G.Check, async () => { var u = UserOf(_accounts, 1); if (u != null) await Run($"account enable {u}", $"Enabled {u}", () => _ = RefreshAccounts()); }, "Enable the selected account");
        var roles = Ui.Button("Roles...", BtnKind.Secondary, G.People, RolesMenu, "Site roles", "List roles and give or remove them from the selected account.");
        Row(bar, _accInfo, refresh, info, create, pass, dis, en, roles);
        Pad(_panels[1], _accounts, bar);
    }

    private async void CreateAccount()
    {
        var u = Dlg.Input(this, "Create account", "Username:", "", false, s => System.Text.RegularExpressions.Regex.IsMatch(s, @"^[A-Za-z0-9_.-]{3,32}$") ? null : "3-32 letters, digits, _ . -");
        if (u == null) return;
        var e = Dlg.Input(this, "Create account", "E-mail address:", "", false, s => s.Contains('@') ? null : "enter an e-mail address");
        if (e == null) return;
        var p = Dlg.Input(this, "Create account", "Password (at least 8 characters):", "", true, s => s.Length >= 8 ? null : "at least 8 characters");
        if (p == null) return;
        await Run($"account create {u} {e} {Q(p)}", $"Created account {u}", () => _ = RefreshAccounts());
    }

    private async void RolesMenu()
    {
        if (NeedServer()) return;
        var user = (Selected(_accounts) is { } l && !l.Contains("no matching")) ? l.Split(' ', StringSplitOptions.RemoveEmptyEntries).ElementAtOrDefault(1) : null;
        var list = await App.Host.RunAsync("account roles", 8000, true);
        var role = Dlg.Input(this, "Site roles", $"{list}\n\nRole name to {(user != null ? $"give to / remove from {user}" : "use")}  (select an account first):", "");
        if (string.IsNullOrWhiteSpace(role) || user == null) return;
        int c = Dlg.Choose(this, "Role action", $"{role} for {user}:", "Give role", "Remove role", "Cancel");
        if (c == 0) await Run($"account setrole {user} {Q(role)}", $"Gave {role} to {user}");
        else if (c == 1) await Run($"account unsetrole {user} {Q(role)}", $"Removed {role} from {user}");
    }

    private async Task RefreshAccounts()
    {
        if (App.Host.State != SState.Running) { Fill(_accounts, "(server is not running)"); return; }
        Fill(_accounts, await App.Host.RunAsync("account list", 8000, true));
        _accInfo.Text = "id  username  e-mail";
    }

    // ---------------- backups ----------------

    private void BuildBackups()
    {
        var bar = Bar();
        Mono(_backups);
        var refresh = Ui.Button("Refresh", BtnKind.Secondary, G.Refresh, () => _ = RefreshBackups(), "Reload the backup list");
        var create = Ui.Button("Create backup", BtnKind.Success, G.Database, async () => { await Run("backup create", "Backup created", () => _ = RefreshBackups()); }, "Create a backup now", "Database, config and small media. Same as the 'backup create' command.");
        var verify = Ui.Button("Verify", BtnKind.Secondary, G.Check, async () => { var n = Name(); if (n != null) await Run($"backup verify {n}"); }, "Check the selected backup against its hashes");
        var restore = Ui.Button("Restore", BtnKind.Danger, G.Undo, async () =>
        {
            var n = Name(); if (n == null) return;
            if (!Dlg.Confirm(this, "Restore backup", $"Restore {n}?\n\nThe server stops, a safety copy of the current state is made, the database, media and config are replaced, then it restarts. Users are disconnected.", "Restore", true)) return;
            await Run($"backup restore {n} --yes", $"Restore of {n} requested");
        }, "Replace the live data with the selected backup");
        var del = Ui.Button("Delete", BtnKind.Ghost, G.Delete, async () => { var n = Name(); if (n != null && Dlg.Confirm(this, "Delete backup", $"Delete {n}?", "Delete", true)) await Run($"backup delete {n} --yes", null, () => _ = RefreshBackups()); }, "Delete the selected backup");
        var folder = Ui.Button("Folder", BtnKind.Secondary, G.Folder, () => Sys.OpenFolder(Paths.BackupsDir), "Open the backup folder");
        Row(bar, _backupInfo, refresh, create, verify, restore, del, folder);
        Pad(_panels[2], _backups, bar);
    }

    private string? Name()
    {
        if (Selected(_backups) is not { } l || l.StartsWith("no backups") || l.StartsWith("(")) { Dlg.Info(this, "Select a backup", "Click a backup in the list first."); return null; }
        return l.Split(' ', StringSplitOptions.RemoveEmptyEntries)[0];
    }

    private async Task RefreshBackups()
    {
        if (App.Host.State != SState.Running) { Fill(_backups, "(server is not running: backups can still be browsed with the Folder button)"); return; }
        Fill(_backups, await App.Host.RunAsync("backup list", 8000, true));
        _backupInfo.Text = "name  size  reason";
    }

    // ---------------- doctor ----------------

    private void BuildDoctor()
    {
        var bar = Bar();
        _doctor.HeightOf = _ => 40;
        _doctor.DrawRow = (g, b, o, sel) =>
        {
            var c = (Check)o;
            var (glyph, col) = c.Sev switch { Sev.Ok => (G.Check, Theme.Green), Sev.Info => (G.Info, Theme.Link), Sev.Warn => (G.Warning, Theme.Yellow), _ => (G.Cancel, Theme.Red) };
            TextRenderer.DrawText(g, glyph, Theme.Icons, new Rectangle(b.X + 8, b.Y, 28, b.Height), col, TextFormatFlags.VerticalCenter | TextFormatFlags.HorizontalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            TextRenderer.DrawText(g, c.Name, Theme.UiBold, new Rectangle(b.X + 44, b.Y, 230, b.Height), Theme.TextBright, TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
            TextRenderer.DrawText(g, c.Detail.Replace('\n', ' '), Theme.Ui, new Rectangle(b.X + 280, b.Y, b.Width - 296, b.Height), Theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
        };
        _doctor.SelectedIndexChanged += (_, _) =>
        {
            if (_doctor.SelectedItem is Check c) { _docDetail.Text = c.Detail; _fixBtn.Visible = c.Fix != null; _fixBtn.Text = c.FixLabel ?? "Fix"; }
        };
        var run = Ui.Button("Run checks", BtnKind.Primary, G.Pulse, () => _ = RunDoctor(), "Run every check again", "Looks at files, Node.js, dependencies, config, ports, certificates, disk space, backups and the running server.");
        _fixBtn = new DButton("Fix", BtnKind.Success, G.Tool) { Visible = false };
        _fixBtn.Click += async (_, _) => { if (_doctor.SelectedItem is Check { Fix: { } fix }) { await fix(); await RunDoctor(); } };
        Row(bar, _docSummary, run, _fixBtn);
        var detailCard = new DCard { Dock = DockStyle.Bottom, Height = 90, Fill = Theme.Bg1 };
        _docDetail.SetBounds(16, 12, 900, 66);
        detailCard.Controls.Add(_docDetail);
        detailCard.Resize += (_, _) => _docDetail.Width = Math.Max(100, detailCard.Width - 32);
        var pad = new Panel { Dock = DockStyle.Fill, Padding = new Padding(24, 0, 24, 24) };
        _doctor.Dock = DockStyle.Fill;
        var inner = new Panel { Dock = DockStyle.Fill };
        inner.Controls.Add(_doctor);
        inner.Controls.Add(detailCard);
        detailCard.Dock = DockStyle.Bottom;
        pad.Controls.Add(inner);
        _panels[3].Controls.Add(pad);
        _panels[3].Controls.Add(bar);
    }

    private static JsonValue? Num(JsonStore s, string k) => s.Get(k) as JsonValue;
    private static int PortOf(JsonStore s, string k, int def) => Num(s, k) is { } v && v.TryGetValue<long>(out var l) ? (int)l : def;
    private static bool BoolOf(JsonStore s, string k, bool def) => s.Get(k) is JsonValue v && v.TryGetValue<bool>(out var b) ? b : def;

    private async Task<List<Check>> Collect()
    {
        var res = new List<Check>();
        var running = App.Host.State == SState.Running;
        void Add(Sev s, string n, string d, string? fl = null, Func<Task>? fix = null) => res.Add(new Check(s, n, d, fl, fix));

        bool filesOk = File.Exists(Paths.SupervisorJs) && File.Exists(Path.Combine(Paths.Root, "server", "index.js")) && Directory.Exists(Path.Combine(Paths.Root, "web"));
        Add(filesOk ? Sev.Ok : Sev.Fail, "Server files", filesOk ? $"server\\ and web\\ found in {Paths.Root}" : $"server\\supervisor.js, server\\index.js or web\\ missing in {Paths.Root}. Put Launcher.exe in the server folder (next to start-server.bat).");

        var node = Paths.NodeExe(App.Settings);
        var ver = await Sys.RunCaptureAsync(node, "--version", Paths.Root, 8000);
        if (ver.StartsWith("v") && Version.TryParse(ver[1..], out var v))
            Add(v >= new Version(22, 5) ? Sev.Ok : Sev.Fail, "Node.js", $"{ver} ({(node == "node" ? "from PATH" : node)}). The server needs 22.5 or newer.");
        else Add(Sev.Fail, "Node.js", $"Cannot run {node}: {ver}. The bundled runtime\\node.exe is missing and node is not on PATH.");

        bool deps = Directory.Exists(Path.Combine(Paths.Root, "node_modules", "express"));
        Add(deps ? Sev.Ok : Sev.Fail, "Dependencies", deps ? "node_modules present" : "node_modules is missing or incomplete.", deps ? null : "Install (npm)", deps ? null : InstallDeps);

        try
        {
            Directory.CreateDirectory(Paths.DataDir);
            var probe = Path.Combine(Paths.DataDir, ".launcher-write-test");
            File.WriteAllText(probe, "x"); File.Delete(probe);
            Add(Sev.Ok, "Data folder", $"{Paths.DataDir} is writable");
        }
        catch (Exception e) { Add(Sev.Fail, "Data folder", $"{Paths.DataDir} is not writable: {e.Message}"); }
        var missing = Skeleton.DataFolders.Where(f => !Directory.Exists(Path.Combine(Paths.DataDir, f))).ToList();
        if (missing.Count > 0) Add(Sev.Warn, "Folder layout", $"{missing.Count} data subfolder(s) missing (the server creates them on start).", "Create folders", () => { Skeleton.Ensure(); return Task.CompletedTask; });
        try
        {
            var free = new DriveInfo(Path.GetPathRoot(Paths.DataDir)!).AvailableFreeSpace;
            Add(free < 200L << 20 ? Sev.Fail : free < 1L << 30 ? Sev.Warn : Sev.Ok, "Disk space", $"{Ui.FormatSize(free)} free on the data drive");
        }
        catch { }

        var cfg = new JsonStore(Paths.ConfigFile);
        cfg.Load();
        if (!File.Exists(Paths.ConfigFile)) Add(Sev.Warn, "Configuration", "data\\config.json does not exist yet.", "Create defaults", () => { Skeleton.Ensure(); return Task.CompletedTask; });
        else if (cfg.LoadError != null) Add(Sev.Fail, "Configuration", $"config.json is not valid JSON: {cfg.LoadError}");
        else
        {
            var probs = new List<string>();
            foreach (var f in Fields.Server) { var val = cfg.Get(f.Key); if (val != null && Validate.Field(f, val) is { } err) probs.Add($"{f.Key}: {err}"); }
            probs.AddRange(Validate.Cross(cfg));
            Add(probs.Count == 0 ? Sev.Ok : Sev.Fail, "Configuration", probs.Count == 0 ? "config.json is valid" : string.Join("\n", probs));
            if (BoolOf(cfg, "useHttps", true) && cfg.Get("publicHost")?.ToString() is "localhost" or "" or null)
                Add(Sev.Info, "Public host", "publicHost is \"localhost\": invite links and other servers cannot reach this instance from outside. Fine for a local test server.");
        }

        bool https = BoolOf(cfg, "useHttps", true);
        int port = PortOf(cfg, "port", 8080), sport = PortOf(cfg, "httpsPort", 8443);
        var ports = new List<(string, int)> { ("HTTP", port) };
        if (https) ports.Add(("HTTPS", sport));
        foreach (var (name, p) in ports)
        {
            if (running)
            {
                bool up = await Net.TcpConnectAsync("127.0.0.1", p);
                Add(up ? Sev.Ok : Sev.Fail, $"{name} port {p}", up ? "the running server accepts connections" : "the server is running but nothing answers on this port");
            }
            else
            {
                bool free = Net.PortFree(p);
                Add(free ? Sev.Ok : Sev.Fail, $"{name} port {p}", free ? "free" : "already in use by another program (another server instance?). Change the port or stop the other program.");
            }
        }
        if (BoolOf(cfg, "turn.enabled", false))
        {
            int tp = PortOf(cfg, "turn.port", 3478);
            Add(running || Net.UdpFree(tp) ? Sev.Ok : Sev.Fail, $"TURN port {tp}/udp", running ? "managed by the running server" : Net.UdpFree(tp) ? "free" : "in use");
            Add(Sev.Info, "TURN firewall", "Relay ports must be open in Windows Firewall and forwarded on the router. The Maintenance tab can run setup-turn.bat as administrator.");
        }
        if (BoolOf(cfg, "ssh.enabled", false))
        {
            int sp = PortOf(cfg, "ssh.port", 2222);
            Add(running || Net.PortFree(sp) ? Sev.Ok : Sev.Fail, $"SSH port {sp}", running ? "managed by the running server" : Net.PortFree(sp) ? "free" : "in use");
            if (cfg.Get("ssh.listenAddress")?.ToString() is not ("127.0.0.1" or "localhost"))
                Add(Sev.Warn, "SSH exposure", "The SSH console listens on a non-loopback address: it is reachable from the network.");
        }

        var crt = cfg.Get("serverCrt")?.ToString() ?? "";
        if (crt != "") Add(File.Exists(Paths.Resolve(crt)) && File.Exists(Paths.Resolve(cfg.Get("serverKey")?.ToString() ?? "")) ? Sev.Ok : Sev.Fail, "TLS certificate", "custom certificate configured");
        else if (https) Add(Sev.Info, "TLS certificate", Directory.GetFiles(Path.Combine(Paths.DataDir, "certs")).Length > 0 ? "self-signed certificate in data\\certs (browsers warn until trusted; use serverCrt/serverKey for a real one)" : "a self-signed certificate is generated on the first start");

        var host = cfg.Get("publicHost")?.ToString() ?? "";
        if (host != "" && host != "localhost" && !IPAddress.TryParse(host, out _))
        {
            try { await Dns.GetHostAddressesAsync(host); Add(Sev.Ok, "Public host DNS", $"{host} resolves"); }
            catch { Add(Sev.Warn, "Public host DNS", $"{host} does not resolve from this machine"); }
        }

        var db = Path.Combine(Paths.DataDir, "dismesh.db");
        Add(File.Exists(db) ? Sev.Ok : Sev.Info, "Database", File.Exists(db) ? $"dismesh.db {Ui.FormatSize(new FileInfo(db).Length)}" : "not created yet (the server creates it on first start)");

        try
        {
            var newest = new DirectoryInfo(Paths.BackupsDir).GetDirectories().Select(d => d.LastWriteTime).Concat(new DirectoryInfo(Paths.BackupsDir).GetFiles().Select(f => f.LastWriteTime)).DefaultIfEmpty(DateTime.MinValue).Max();
            if (newest == DateTime.MinValue) Add(Sev.Warn, "Backups", "no backups yet. Set a daily time in Config > Backups or create one in the Backups tab.");
            else Add((DateTime.Now - newest).TotalDays > 7 ? Sev.Warn : Sev.Ok, "Backups", $"newest backup {newest:yyyy-MM-dd HH:mm}");
        }
        catch { }

        var phpCfg = cfg.Get("sites.phpPath")?.ToString() ?? "";
        if (phpCfg != "") Add(File.Exists(Paths.Resolve(phpCfg)) ? Sev.Ok : Sev.Fail, "PHP (Sites)", phpCfg);
        Add(Sys.IsAdmin() ? Sev.Info : Sev.Info, "Privileges", Sys.IsAdmin() ? "running as administrator" : "standard user. Opening firewall ports (setup-turn.bat) asks for administrator rights.");
        Add(running ? Sev.Ok : Sev.Info, "Server process", running ? $"running under this launcher (PID {App.Host.Pid})" : "not running");
        return res;
    }

    private async Task RunDoctor()
    {
        _docSummary.Text = "checking...";
        _checks = await Task.Run(Collect);
        _doctor.BeginUpdate(); _doctor.Items.Clear();
        foreach (var c in _checks.OrderByDescending(c => c.Sev == Sev.Fail).ThenByDescending(c => c.Sev == Sev.Warn)) _doctor.Items.Add(c);
        _doctor.EndUpdate();
        int f = _checks.Count(c => c.Sev == Sev.Fail), w = _checks.Count(c => c.Sev == Sev.Warn);
        _docSummary.ForeColor = f > 0 ? Theme.Red : w > 0 ? Theme.Yellow : Theme.Green;
        _docSummary.Text = f > 0 ? $"{f} problem(s), {w} warning(s)" : w > 0 ? $"{w} warning(s), no problems" : "Everything looks good";
        _fixBtn.Visible = false;
        _docDetail.Text = "Select a row for details.";
    }

    private async Task InstallDeps()
    {
        var npm = Path.Combine(Paths.Root, "runtime", "node_modules", "npm", "bin", "npm-cli.js");
        var node = Paths.NodeExe(App.Settings);
        if (!File.Exists(npm)) { Dlg.Info(this, "npm not found", "runtime\\node_modules\\npm is missing. Run \"npm install\" in the server folder with a normal Node.js installation."); return; }
        _docSummary.Text = "installing dependencies, this can take a minute...";
        var o = await Sys.RunCaptureAsync(node, $"\"{npm}\" install --omit=dev", Paths.Root, 600000);
        Dlg.Text(this, "npm install", o, "npm install finished");
    }

    // ---------------- maintenance ----------------

    private void BuildMaintenance()
    {
        var scroll = new ScrollPanel { Dock = DockStyle.Fill };
        int y = 24;
        void Item(string title, string desc, string btn, string glyph, Action act, BtnKind kind = BtnKind.Secondary)
        {
            var card = new DCard { Location = new Point(24, y), Height = 76, Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right };
            card.Width = Math.Max(500, scroll.ClientSize.Width - 48);
            var t = new DLabel { Text = title, Font = Theme.UiBold, ForeColor = Theme.TextBright, Location = new Point(18, 12), Size = new Size(600, 22), Wrap = false };
            var d = new DLabel { Text = desc, ForeColor = Theme.Muted, Location = new Point(18, 36), Size = new Size(640, 34), Anchor = AnchorStyles.Left | AnchorStyles.Top };
            var b = new DButton(btn, kind, glyph) { Anchor = AnchorStyles.Right | AnchorStyles.Top };
            b.Location = new Point(card.Width - 18 - b.Width, 22);
            b.Click += (_, _) => act();
            card.Controls.AddRange([t, d, b]);
            card.Resize += (_, _) => { b.Left = card.Width - 18 - b.Width; d.Width = Math.Max(100, b.Left - 40); };
            scroll.Controls.Add(card);
            y += 88;
        }
        Item("Open the server folder", "The folder that holds Launcher.exe, the bat files, server\\ and web\\.", "Open", G.Folder, () => Sys.OpenFolder(Paths.Root));
        Item("Open the data folder", "Database, config, uploads, certificates, logs and backups.", "Open", G.Folder, () => Sys.OpenFolder(Paths.DataDir));
        Item("Open firewall and relay ports (setup-turn.bat)", "Runs the TURN setup as administrator (Windows asks for permission): opens the firewall for the relay and prints the router ports to forward.", "Run as admin", G.Shield, () =>
        {
            var bat = Path.Combine(Paths.Root, "setup-turn.bat");
            if (!File.Exists(bat)) { Dlg.Info(this, "Not found", "setup-turn.bat is not in the server folder."); return; }
            Sys.OpenFile(bat);
        });
        Item("Create a diagnostics bundle", "A zip with the doctor results, the config with secrets removed, recent logs, events and crash reports. Attach it when asking for help.", "Create zip", G.Export, () => _ = Bundle(), BtnKind.Primary);
        Item("Install or repair dependencies", "Runs npm install for the server with the bundled Node.js. Needs an internet connection.", "Install", G.Down, () => _ = InstallDeps());
        Item("Reset the self-signed certificate", "Deletes the generated certificate in data\\certs. A new one is created at the next start; browsers and clients must trust it again. Custom certificates are not touched.", "Reset...", G.Lock, ResetCert, BtnKind.Danger);
        scroll.AutoScrollMinSize = new Size(0, y + 20);
        scroll.Resize += (_, _) => { foreach (var c in scroll.Controls.OfType<DCard>()) c.Width = Math.Max(500, scroll.ClientSize.Width - 48); };
        _panels[4].Controls.Add(scroll);
    }

    private void ResetCert()
    {
        if (App.Host.IsActive) { Dlg.Info(this, "Stop the server first", "The certificate cannot be replaced while the server runs."); return; }
        if (!Dlg.Confirm(this, "Reset certificate", "Delete the generated self-signed certificate files in data\\certs?", "Delete", true)) return;
        try
        {
            int n = 0;
            foreach (var f in Directory.GetFiles(Path.Combine(Paths.DataDir, "certs")).Where(f => !f.EndsWith(".gitkeep"))) { File.Delete(f); n++; }
            App.Events.Add("launcher", $"Certificate files deleted ({n})");
            Dlg.Info(this, "Done", $"{n} file(s) removed.");
        }
        catch (Exception e) { Dlg.Info(this, "Failed", e.Message); }
    }

    private async Task Bundle()
    {
        try
        {
            var checks = await Task.Run(Collect);
            var path = Path.Combine(Paths.LauncherDir, $"diagnostics-{DateTime.Now:yyyyMMdd-HHmmss}.zip");
            Directory.CreateDirectory(Paths.LauncherDir);
            using (var zip = ZipFile.Open(path, ZipArchiveMode.Create))
            {
                void Text(string name, string text) { var e = zip.CreateEntry(name); using var w = new StreamWriter(e.Open(), new UTF8Encoding(false)); w.Write(text); }
                var sb = new StringBuilder();
                sb.AppendLine($"MeshCrowd diagnostics {DateTime.Now:yyyy-MM-dd HH:mm:ss}");
                sb.AppendLine($"{Environment.MachineName}, {Environment.OSVersion}, {Environment.ProcessorCount} cores, launcher {typeof(ToolsPage).Assembly.GetName().Version}");
                sb.AppendLine($"server state: {App.Host.State}, version {App.Host.Version}, restarts {App.Host.Restarts}, crashes {App.Host.Crashes}");
                sb.AppendLine();
                foreach (var c in checks) sb.AppendLine($"[{c.Sev}] {c.Name}: {c.Detail.Replace('\n', ' ')}");
                Text("doctor.txt", sb.ToString());
                if (File.Exists(Paths.ConfigFile))
                {
                    var cfg = new JsonStore(Paths.ConfigFile); cfg.Load();
                    foreach (var f in Fields.Server.Where(f => f.Type == FType.Secret)) if (cfg.Get(f.Key) != null) cfg.Set(f.Key, JsonValue.Create("***"));
                    Text("config.sanitized.json", cfg.ToText());
                }
                var ls = new JsonStore(Paths.LauncherSettings); ls.Load();
                if (ls.Get("discordWebhook") != null) ls.Set("discordWebhook", JsonValue.Create("***"));
                Text("launcher.sanitized.json", ls.ToText());
                if (File.Exists(Paths.EventsFile)) Text("events.jsonl", string.Join('\n', File.ReadLines(Paths.EventsFile).TakeLast(1000)));
                Text("console-buffer.txt", string.Join('\n', App.Host.Snapshot().TakeLast(1500).Select(l => $"{l.Time:HH:mm:ss} {l.Level,-5} [{l.Category}] {l.Message}")));
                try
                {
                    foreach (var f in new DirectoryInfo(Paths.LogsDir).GetFiles("*.log").OrderByDescending(f => f.LastWriteTime).Take(2))
                    {
                        using var fs = new FileStream(f.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                        var lines = new Queue<string>();
                        using var r = new StreamReader(fs);
                        string? ln; while ((ln = r.ReadLine()) != null) { lines.Enqueue(ln); if (lines.Count > 4000) lines.Dequeue(); }
                        Text("logs/" + f.Name, string.Join('\n', lines));
                    }
                    foreach (var f in new DirectoryInfo(Paths.ReportsDir).GetFiles("*.txt").OrderByDescending(f => f.LastWriteTime).Take(5)) zip.CreateEntryFromFile(f.FullName, "reports/" + f.Name);
                }
                catch { }
            }
            App.Events.Add("launcher", "Diagnostics bundle created", Path.GetFileName(path));
            if (Dlg.Confirm(this, "Bundle created", $"{path}\n\nSecrets (TURN secret, purge password, webhook) are replaced with ***. Show it in Explorer?", "Show")) System.Diagnostics.Process.Start("explorer.exe", $"/select,\"{path}\"");
        }
        catch (Exception e) { Dlg.Info(this, "Failed", e.Message); }
    }
}
