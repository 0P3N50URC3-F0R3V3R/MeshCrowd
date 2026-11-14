using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace MeshCrowd.Launcher;

public enum SState { Stopped, Starting, Running, Stopping, Restarting, Backoff, Crashed }

public sealed record LogLine(DateTime Time, string Level, string Category, string Message, string Raw);

public sealed class ServerStats
{
    public double Cpu, Rss, HeapUsed, HeapTotal, SysFree, SysTotal, Lag, ReqMin, Err5xx, DbMb, WalMb;
    public int Users, Conns, Turn, Warn1h, Err1h;
    public string Uptime = "", Load = "";
    public DateTime At = DateTime.Now;

    private static double D(string s) => double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : 0;

    public static ServerStats? Parse(string text)
    {
        var s = new ServerStats();
        bool any = false;
        foreach (var raw in text.Split('\n'))
        {
            var l = raw.Trim();
            Match m;
            if ((m = Regex.Match(l, @"^cpu\s+([\d.]+)%")).Success) { s.Cpu = D(m.Groups[1].Value); any = true; }
            else if ((m = Regex.Match(l, @"^load avg\s+(.*)$")).Success) s.Load = m.Groups[1].Value;
            else if ((m = Regex.Match(l, @"^memory\s+rss ([\d.]+) MB, heap ([\d.]+)/([\d.]+) MB, system free ([\d.]+)/([\d.]+) MB")).Success)
            { s.Rss = D(m.Groups[1].Value); s.HeapUsed = D(m.Groups[2].Value); s.HeapTotal = D(m.Groups[3].Value); s.SysFree = D(m.Groups[4].Value); s.SysTotal = D(m.Groups[5].Value); any = true; }
            else if ((m = Regex.Match(l, @"^event loop lag\s+([\d.]+)")).Success) s.Lag = D(m.Groups[1].Value);
            else if ((m = Regex.Match(l, @"^uptime\s+(.+)$")).Success) s.Uptime = m.Groups[1].Value;
            else if ((m = Regex.Match(l, @"^online\s+(\d+) users, (\d+) connections")).Success) { s.Users = int.Parse(m.Groups[1].Value); s.Conns = int.Parse(m.Groups[2].Value); }
            else if ((m = Regex.Match(l, @"^requests/min\s+([\d.]+) \(5xx: ([\d.]+)\)")).Success) { s.ReqMin = D(m.Groups[1].Value); s.Err5xx = D(m.Groups[2].Value); }
            else if ((m = Regex.Match(l, @"^db\s+([\d.]+) MB, wal ([\d.]+) MB")).Success) { s.DbMb = D(m.Groups[1].Value); s.WalMb = D(m.Groups[2].Value); }
            else if ((m = Regex.Match(l, @"^turn allocations\s+(\d+)")).Success) s.Turn = int.Parse(m.Groups[1].Value);
            else if ((m = Regex.Match(l, @"^warn/error \(1h\)\s+(\d+) / (\d+)")).Success) { s.Warn1h = int.Parse(m.Groups[1].Value); s.Err1h = int.Parse(m.Groups[2].Value); }
        }
        return any ? s : null;
    }
}

internal static class Job
{
    [StructLayout(LayoutKind.Sequential)] private struct Basic { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinWs, MaxWs; public uint Active; public UIntPtr Affinity; public uint Priority, Sched; }
    [StructLayout(LayoutKind.Sequential)] private struct Io { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)] private struct Ext { public Basic Basic; public Io Io; public UIntPtr Proc, Job, Peak, PeakJob; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr a, string? name);
    [DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(IntPtr job, int cls, ref Ext info, int len);
    [DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
    private static IntPtr _job;

    public static void Assign(Process p)
    {
        try
        {
            if (_job == IntPtr.Zero)
            {
                _job = CreateJobObject(IntPtr.Zero, null);
                var info = new Ext();
                info.Basic.LimitFlags = 0x2000;
                SetInformationJobObject(_job, 9, ref info, Marshal.SizeOf<Ext>());
            }
            AssignProcessToJobObject(_job, p.Handle);
        }
        catch { }
    }
}

public sealed class ServerHost
{
    private readonly LauncherSettings _cfg;
    private readonly EventLog _events;
    private Process? _proc;
    private StreamWriter? _stdin;
    private readonly List<LogLine> _lines = new();
    private readonly object _lock = new();
    private readonly StringBuilder _cur = new();
    private bool _pendingCr, _inEsc;
    private long _lastChar;
    private bool _stopRequested, _expectRestart, _killedByWatchdog;
    private readonly List<DateTime> _crashTimes = new();
    private int _backoffStep;
    private System.Threading.Timer? _backoffTimer, _tick, _promptTimer;
    private int _watchFails, _memOver;
    private DateTime _lastDailyRestart = DateTime.MinValue;
    private StringBuilder? _capture;
    private bool _captureSilent;
    private long _captureTick;
    private readonly SemaphoreSlim _captureLock = new(1, 1);
    private int _statsBusy;
    private ServerStats? _lastStats;

    public SState State { get; private set; } = SState.Stopped;
    public DateTime? RunningSince { get; private set; }
    public int Pid => _proc is { HasExited: false } ? _proc.Id : 0;
    public string Version { get; private set; } = "";
    public int Restarts { get; private set; }
    public int Crashes { get; private set; }
    public int WatchdogRestarts { get; private set; }
    public string StateDetail { get; private set; } = "";
    public DateTime? BackoffUntil { get; private set; }
    public bool UiVisible { get; set; } = true;
    public ServerStats? Stats => _lastStats;
    public string? NextAction { get; private set; }

    public event Action<LogLine>? LineAdded;
    public event Action? StateChanged;
    public event Action<string>? PromptRequested;
    public event Action<string, string, bool>? Alert;
    public event Action<ServerStats>? StatsUpdated;
    public event Action? ReportsChanged;

    public ServerHost(LauncherSettings cfg, EventLog events)
    {
        _cfg = cfg; _events = events;
        _tick = new System.Threading.Timer(_ => Tick(), null, 5000, 5000);
        _promptTimer = new System.Threading.Timer(_ => PromptCheck(), null, 250, 250);
    }

    public IReadOnlyList<LogLine> Snapshot() { lock (_lock) return _lines.ToList(); }
    public bool IsActive => State is SState.Starting or SState.Running or SState.Stopping or SState.Restarting;

    private void SetState(SState s, string detail = "")
    {
        if (State == s && StateDetail == detail) return;
        State = s; StateDetail = detail;
        if (s == SState.Running) RunningSince ??= DateTime.Now;
        else if (s is SState.Stopped or SState.Crashed or SState.Backoff) RunningSince = null;
        _events.Add("state", s.ToString(), detail == "" ? null : detail);
        StateChanged?.Invoke();
    }

    private void Sys(string text, string level = "SYS")
    {
        var l = new LogLine(DateTime.Now, level, "launcher", text, text);
        AddLine(l);
    }

    public void PostLine(LogLine l) => AddLine(l);

    private void AddLine(LogLine l)
    {
        lock (_lock)
        {
            _lines.Add(l);
            int max = Math.Max(500, _cfg.Int("logBufferLines"));
            if (_lines.Count > max + 500) _lines.RemoveRange(0, _lines.Count - max);
        }
        LineAdded?.Invoke(l);
    }

    // ---------- start / stop ----------

    public string? Start()
    {
        if (IsActive) return "The server is already running.";
        if (!Paths.ServerPresent) return $"server\\supervisor.js not found in {Paths.Root}.";
        var node = Paths.NodeExe(_cfg);
        if (node != "node" && !File.Exists(node)) return $"Node.js not found: {node}";
        var cfg = new JsonStore(Paths.ConfigFile);
        cfg.Load();
        if (cfg.LoadError != null) return $"data\\config.json is invalid: {cfg.LoadError}\nFix it in the Config tab (Raw JSON) first.";
        bool https = cfg.Get("useHttps") is not JsonValue hv || !hv.TryGetValue<bool>(out var hb) || hb;
        int httpPort = cfg.Get("port") is JsonValue pv && pv.TryGetValue<long>(out var pl) ? (int)pl : 8080;
        int httpsPort = cfg.Get("httpsPort") is JsonValue sv && sv.TryGetValue<long>(out var sl) ? (int)sl : 8443;
        var busy = new List<int>();
        if (!Net.PortFree(httpPort)) busy.Add(httpPort);
        if (https && !Net.PortFree(httpsPort)) busy.Add(httpsPort);
        if (busy.Count > 0) return $"Port {string.Join(", ", busy)} is already in use. Another server instance may be running (start-server.bat?). Stop it or change the port in the Config tab.";

        _stopRequested = false; _expectRestart = false; _killedByWatchdog = false; _watchFails = 0; _memOver = 0;
        CancelBackoff();
        SetState(SState.Starting);
        Sys($"starting: {node} server\\supervisor.js");
        try
        {
            var psi = new ProcessStartInfo(node, "\"" + Paths.SupervisorJs + "\"")
            {
                WorkingDirectory = Paths.Root, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            };
            psi.Environment["MESHCROWD_FORCE_CONSOLE"] = "1";
            psi.Environment["NO_COLOR"] = "1";
            psi.Environment["DISMESH_DATA_DIR"] = Paths.DataDir;
            foreach (var pair in _cfg.Str("extraNodeArgs").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                int eq = pair.IndexOf('=');
                if (eq > 0 && !pair[..eq].StartsWith("MESHCROWD_NO_CONSOLE", StringComparison.OrdinalIgnoreCase)) psi.Environment[pair[..eq]] = pair[(eq + 1)..];
            }
            var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
            p.Exited += (_, _) => Task.Run(() => OnExited(p));
            p.Start();
            Job.Assign(p);
            _proc = p;
            _stdin = new StreamWriter(p.StandardInput.BaseStream, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
            _ = Task.Run(() => ReadLoop(p.StandardOutput));
            _ = Task.Run(() => ReadLoop(p.StandardError));
            _events.Add("start", $"Server process started (PID {p.Id})");
        }
        catch (Exception e)
        {
            SetState(SState.Stopped, "failed to start");
            return $"Could not start: {e.Message}";
        }
        return null;
    }

    public async Task StopAsync()
    {
        CancelBackoff();
        if (State is SState.Stopped or SState.Crashed) { SetState(SState.Stopped); return; }
        var p = _proc;
        _stopRequested = true;
        SetState(SState.Stopping);
        _events.Add("stop", "Stop requested");
        try { Send("server stop --yes"); } catch { }
        int ms = _cfg.Int("stopTimeoutSeconds") * 1000;
        var sw = Stopwatch.StartNew();
        while (p != null && !p.HasExited && sw.ElapsedMilliseconds < ms) await Task.Delay(150);
        if (p != null && !p.HasExited)
        {
            Sys($"no clean exit after {ms / 1000}s, terminating the process tree", "WARN");
            _events.Add("kill", "Graceful stop timed out, process tree terminated");
            try { p.Kill(true); } catch { }
            await Task.Delay(300);
        }
    }

    public void Kill()
    {
        CancelBackoff();
        _stopRequested = true;
        var p = _proc;
        if (p == null || p.HasExited) { SetState(SState.Stopped); return; }
        _events.Add("kill", "Server killed by the operator");
        try { p.Kill(true); } catch { }
    }

    public void RestartGraceful(int delaySeconds = 0)
    {
        if (!IsActive) return;
        _expectRestart = true;
        NextAction = delaySeconds > 0 ? $"restart in {delaySeconds}s" : "restart";
        _events.Add("restart", delaySeconds > 0 ? $"Restart requested with {delaySeconds}s countdown" : "Restart requested");
        Send(delaySeconds > 0 ? $"server restart {delaySeconds} --yes" : "server restart --yes");
        StateChanged?.Invoke();
    }

    public void CancelPending()
    {
        if (!IsActive) return;
        Send("server cancel");
        _expectRestart = false; NextAction = null;
        StateChanged?.Invoke();
    }

    public async Task RestartHardAsync(string reason)
    {
        _events.Add("watchdog", reason);
        Sys(reason, "WARN");
        _killedByWatchdog = true;
        var p = _proc;
        try { p?.Kill(true); } catch { }
        await Task.Delay(1500);
    }

    // ---------- process IO ----------

    public void Send(string line)
    {
        var w = _stdin;
        if (w == null) throw new InvalidOperationException("server is not running");
        lock (w) { w.WriteLine(line); }
    }

    private async Task ReadLoop(StreamReader r)
    {
        var buf = new char[2048];
        try
        {
            int n;
            while ((n = await r.ReadAsync(buf, 0, buf.Length)) > 0) Feed(buf, n);
        }
        catch { }
    }

    private void Feed(char[] buf, int n)
    {
        for (int i = 0; i < n; i++)
        {
            char c = buf[i];
            lock (_cur)
            {
                _lastChar = Environment.TickCount64;
                if (_inEsc) { if (char.IsLetter(c)) _inEsc = false; continue; }
                if (c == '\u001b') { _inEsc = true; continue; }
                if (_pendingCr)
                {
                    _pendingCr = false;
                    if (c != '\n') _cur.Clear();
                }
                if (c == '\r') { _pendingCr = true; continue; }
                if (c == '\n') { var s = _cur.ToString(); _cur.Clear(); Emit(s); continue; }
                _cur.Append(c);
            }
        }
    }

    private static readonly Regex LogRe = new(@"^(\d\d:\d\d:\d\d) (DEBUG|INFO|WARN|ERROR) +\[([^\]]*)\] (.*)$");
    private static readonly Regex Banner = new(@"MeshCrowd (\S+) console\. Type help");

    private void Emit(string s)
    {
        while (s.StartsWith("meshcrowd> ")) s = s[11..];
        if (s.Trim() == "") return;
        var m = LogRe.Match(s);
        if (m.Success)
        {
            var utc = DateTime.UtcNow.Date.Add(TimeSpan.Parse(m.Groups[1].Value));
            if (utc > DateTime.UtcNow.AddMinutes(2)) utc = utc.AddDays(-1);
            var t = utc.ToLocalTime();
            var line = new LogLine(t, m.Groups[2].Value, m.Groups[3].Value, m.Groups[4].Value, s);
            AddLine(line);
            if (line.Category == "lifecycle")
            {
                if (line.Message == "restarting") { _expectRestart = true; SetState(SState.Restarting); }
                else if (line.Message == "stopping" && !_expectRestart) SetState(SState.Stopping);
            }
            return;
        }
        var b = Banner.Match(s);
        if (b.Success)
        {
            Version = b.Groups[1].Value;
            if (_expectRestart || State == SState.Restarting)
            {
                Restarts++;
                _events.Add("restart", "Server restarted (supervisor relaunch)");
                if (_cfg.Bool("webhookOnStartStop")) Notifier.Send(_cfg, $"MeshCrowd server restarted ({Environment.MachineName})");
            }
            _expectRestart = false; NextAction = null;
            RunningSince = DateTime.Now;
            SetState(SState.Running);
            AddLine(new LogLine(DateTime.Now, "SYS", "launcher", $"server is up, version {Version}", s));
            return;
        }
        var cap = _capture;
        if (cap != null) { lock (cap) cap.AppendLine(s); _captureTick = Environment.TickCount64; if (_captureSilent) return; }
        AddLine(new LogLine(DateTime.Now, "OUT", "console", s, s));
    }

    private void PromptCheck()
    {
        string? text = null;
        lock (_cur)
        {
            if (_cur.Length == 0 || Environment.TickCount64 - _lastChar < 350) return;
            var s = _cur.ToString().Trim();
            while (s.StartsWith("meshcrowd>")) s = s[10..].Trim();
            if (s.Length == 0) { _cur.Clear(); return; }
            if (s.EndsWith(":") || s.EndsWith("]") || s.EndsWith("?")) { text = s; _cur.Clear(); }
        }
        if (text != null)
        {
            AddLine(new LogLine(DateTime.Now, "OUT", "console", text, text));
            PromptRequested?.Invoke(text);
        }
    }

    public async Task<string> RunAsync(string command, int timeoutMs = 8000, bool silent = false)
    {
        if (State != SState.Running) return "(server is not running)";
        await _captureLock.WaitAsync();
        try
        {
            var sb = new StringBuilder();
            _capture = sb; _captureTick = 0; _captureSilent = silent;
            Send(command);
            var sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < timeoutMs)
            {
                await Task.Delay(60);
                long t = _captureTick;
                if (t != 0 && Environment.TickCount64 - t > 450) break;
                if (t == 0 && sw.ElapsedMilliseconds > 2500) break;
            }
            _capture = null;
            lock (sb) return sb.ToString().TrimEnd();
        }
        catch (Exception e) { return e.Message; }
        finally { _capture = null; _captureLock.Release(); }
    }

    // ---------- exit handling / supervision ----------

    private void OnExited(Process p)
    {
        if (!ReferenceEquals(p, _proc)) return;
        int code = -1;
        try { code = p.ExitCode; } catch { }
        _proc = null; _stdin = null;
        _expectRestart = false; NextAction = null;
        lock (_cur) { _cur.Clear(); }
        var uptime = RunningSince.HasValue ? DateTime.Now - RunningSince.Value : TimeSpan.Zero;

        if (_stopRequested || (code == 0 && !_killedByWatchdog))
        {
            Sys($"server stopped (exit code {code})");
            _events.Add("stop", $"Server stopped (exit code {code})");
            SetState(SState.Stopped);
            if (_cfg.Bool("webhookOnStartStop")) Notifier.Send(_cfg, $"MeshCrowd server stopped ({Environment.MachineName})");
            return;
        }

        bool watchdog = _killedByWatchdog;
        _killedByWatchdog = false;
        Crashes++;
        _crashTimes.Add(DateTime.Now);
        var reason = watchdog ? "Watchdog: server stopped answering and was restarted" : $"Server crashed (exit code {code})";
        Sys(reason, "ERROR");
        _events.Add(watchdog ? "watchdog" : "crash", reason, $"uptime {Ui.FormatSpan(uptime)}");
        if (_cfg.Bool("reportOnCrash")) { var path = WriteReport(reason, code, uptime); if (path != null) ReportsChanged?.Invoke(); }
        SetState(SState.Crashed, reason);
        Alert?.Invoke("MeshCrowd server", reason, true);
        Notifier.Send(_cfg, $"{reason} on {Environment.MachineName}");

        if (!_cfg.Bool("autoRestart")) return;
        var cutoff = DateTime.Now.AddMinutes(-_cfg.Int("crashWindowMinutes"));
        _crashTimes.RemoveAll(t => t < cutoff);
        if (_crashTimes.Count >= _cfg.Int("maxCrashes"))
        {
            var msg = $"{_crashTimes.Count} crashes in {_cfg.Int("crashWindowMinutes")} minutes. Auto-restart stopped, the server stays down.";
            _events.Add("giveup", msg);
            Sys(msg, "ERROR");
            Alert?.Invoke("MeshCrowd server is down", msg, true);
            Notifier.Send(_cfg, $"{msg} ({Environment.MachineName})");
            return;
        }
        if (uptime.TotalMinutes > 5) _backoffStep = 0;
        int delay = _cfg.Int("backoffSeconds") == 0 ? 0 : (int)Math.Min(60, _cfg.Int("backoffSeconds") * Math.Pow(2, _backoffStep));
        _backoffStep++;
        BackoffUntil = DateTime.Now.AddSeconds(delay);
        SetState(SState.Backoff, $"restarting in {delay}s");
        _events.Add("autorestart", $"Auto-restart in {delay}s (crash {_crashTimes.Count} of {_cfg.Int("maxCrashes")} allowed)");
        _backoffTimer?.Dispose();
        _backoffTimer = new System.Threading.Timer(_ =>
        {
            BackoffUntil = null;
            var err = Start();
            if (err != null)
            {
                _events.Add("error", "Auto-restart failed: " + err);
                Sys("auto-restart failed: " + err, "ERROR");
                SetState(SState.Crashed, "auto-restart failed");
            }
        }, null, delay * 1000, Timeout.Infinite);
    }

    private void CancelBackoff()
    {
        _backoffTimer?.Dispose(); _backoffTimer = null; BackoffUntil = null;
    }

    // ---------- periodic work: watchdog, schedule, stats ----------

    private int _tickCount;
    private int _watchCountdown;
    private async void Tick()
    {
        try
        {
            _tickCount++;
            if (State == SState.Backoff && BackoffUntil.HasValue) StateChanged?.Invoke();
            if (State != SState.Running) { _watchFails = 0; return; }

            var now = DateTime.Now;
            var dr = _cfg.Str("dailyRestart");
            if (dr.Length == 5 && now.ToString("HH:mm") == dr && _lastDailyRestart.Date != now.Date)
            {
                _lastDailyRestart = now;
                _events.Add("schedule", $"Daily restart at {dr}");
                RestartGraceful(_cfg.Int("restartWarnSeconds"));
                return;
            }

            if (_cfg.Bool("watchdog"))
            {
                _watchCountdown -= 5;
                bool grace = RunningSince.HasValue && (now - RunningSince.Value).TotalSeconds < _cfg.Int("watchdogGraceSeconds");
                if (_watchCountdown <= 0 && !grace && !_expectRestart)
                {
                    _watchCountdown = _cfg.Int("watchdogIntervalSeconds");
                    var cfg = new JsonStore(Paths.ConfigFile);
                    cfg.Load();
                    bool https = cfg.Get("useHttps") is not JsonValue hv || !hv.TryGetValue<bool>(out var hb) || hb;
                    int port = (https ? cfg.Get("httpsPort") : cfg.Get("port")) is JsonValue pv && pv.TryGetValue<long>(out var pl) ? (int)pl : https ? 8443 : 8080;
                    bool ok = await Net.ProbeAsync(port, https);
                    if (ok) _watchFails = 0;
                    else
                    {
                        _watchFails++;
                        Sys($"watchdog: no answer on port {port} ({_watchFails}/{_cfg.Int("watchdogFailures")})", "WARN");
                        if (_watchFails >= _cfg.Int("watchdogFailures"))
                        {
                            _watchFails = 0;
                            WatchdogRestarts++;
                            await RestartHardAsync($"Watchdog: port {port} did not answer {_cfg.Int("watchdogFailures")} times in a row");
                        }
                    }
                }
            }

            int interval = Math.Max(3, _cfg.Int("statsIntervalSeconds"));
            if ((UiVisible || _cfg.Int("memoryLimitMb") > 0) && _tickCount % Math.Max(1, interval / 5) == 0) _ = PollStats();
        }
        catch { }
    }

    private async Task PollStats()
    {
        if (Interlocked.Exchange(ref _statsBusy, 1) == 1) return;
        try
        {
            var text = await RunAsync("stats", 6000, true);
            var st = ServerStats.Parse(text);
            if (st == null) return;
            _lastStats = st;
            StatsUpdated?.Invoke(st);
            int limit = _cfg.Int("memoryLimitMb");
            if (limit > 0 && st.Rss > limit && !_expectRestart)
            {
                if (++_memOver >= 3)
                {
                    _memOver = 0;
                    _events.Add("schedule", $"Memory {st.Rss:0} MB is above the limit of {limit} MB, restarting");
                    RestartGraceful(_cfg.Int("restartWarnSeconds"));
                }
            }
            else _memOver = 0;
        }
        finally { Interlocked.Exchange(ref _statsBusy, 0); }
    }

    public Task RefreshStatsNow() => State == SState.Running ? PollStats() : Task.CompletedTask;

    // ---------- reports ----------

    public string? WriteReport(string reason, int exitCode, TimeSpan uptime, bool manual = false)
    {
        try
        {
            Directory.CreateDirectory(Paths.ReportsDir);
            var path = Path.Combine(Paths.ReportsDir, $"{(manual ? "snapshot" : "crash")}-{DateTime.Now:yyyyMMdd-HHmmss}.txt");
            var sb = new StringBuilder();
            sb.AppendLine("MeshCrowd server report");
            sb.AppendLine("=======================");
            sb.AppendLine($"Time        : {DateTime.Now:yyyy-MM-dd HH:mm:ss}");
            sb.AppendLine($"Reason      : {reason}");
            if (!manual) sb.AppendLine($"Exit code   : {exitCode}");
            sb.AppendLine($"Uptime      : {Ui.FormatSpan(uptime)}");
            sb.AppendLine($"State       : {State}");
            sb.AppendLine($"Version     : {Version}");
            sb.AppendLine($"Restarts    : {Restarts} (crashes {Crashes}, watchdog {WatchdogRestarts})");
            sb.AppendLine($"Machine     : {Environment.MachineName}, {Environment.OSVersion}, {Environment.ProcessorCount} cores");
            sb.AppendLine($"Free space  : {Sys_FreeSpace()}");
            sb.AppendLine($"Data folder : {Paths.DataDir}");
            if (_lastStats is { } s)
                sb.AppendLine($"Last stats  : cpu {s.Cpu}%, rss {s.Rss} MB, lag {s.Lag} ms, {s.Users} users/{s.Conns} connections, {s.ReqMin} req/min, db {s.DbMb} MB (at {s.At:HH:mm:ss})");
            sb.AppendLine();
            sb.AppendLine("Last console lines");
            sb.AppendLine("------------------");
            foreach (var l in Snapshot().TakeLast(300)) sb.AppendLine($"{l.Time:HH:mm:ss} {l.Level,-5} [{l.Category}] {l.Message}");
            File.WriteAllText(path, sb.ToString());
            return path;
        }
        catch { return null; }
    }

    private static string Sys_FreeSpace() => MeshCrowd.Launcher.Sys.FreeSpace(Paths.DataDir);

    public void Dispose()
    {
        _tick?.Dispose(); _promptTimer?.Dispose(); _backoffTimer?.Dispose();
    }
}

public static class Notifier
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(10) };

    public static void Send(LauncherSettings cfg, string text)
    {
        var url = cfg.Str("discordWebhook");
        if (!url.StartsWith("https://")) return;
        _ = Task.Run(async () =>
        {
            try
            {
                var body = new JsonObject { ["content"] = text, ["text"] = text }.ToJsonString();
                using var content = new StringContent(body, Encoding.UTF8, "application/json");
                await Http.PostAsync(url, content);
            }
            catch { }
        });
    }
}
