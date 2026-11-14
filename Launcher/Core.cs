using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Win32;

namespace MeshCrowd.Launcher;

public static class Paths
{
    public static string Root { get; private set; } = "";
    public static string DataDir { get; private set; } = "";
    public static string ConfigFile => Path.Combine(DataDir, "config.json");
    public static string LogsDir => Path.Combine(DataDir, "logs");
    public static string BackupsDir => Path.Combine(DataDir, "backups");
    public static string LauncherDir => Path.Combine(DataDir, "launcher");
    public static string ReportsDir => Path.Combine(LauncherDir, "reports");
    public static string ConfigBackupsDir => Path.Combine(LauncherDir, "config-backups");
    public static string EventsFile => Path.Combine(LauncherDir, "events.jsonl");
    public static string LauncherSettings => Path.Combine(LauncherDir, "launcher.json");
    public static string SupervisorJs => Path.Combine(Root, "server", "supervisor.js");
    public static string ExePath => Environment.ProcessPath ?? Path.Combine(Root, "Launcher.exe");

    public static void Init(string? rootOverride)
    {
        Root = rootOverride != null ? Path.GetFullPath(rootOverride) : Path.GetDirectoryName(Environment.ProcessPath) ?? AppContext.BaseDirectory;
        var env = Environment.GetEnvironmentVariable("DISMESH_DATA_DIR");
        DataDir = !string.IsNullOrWhiteSpace(env) ? Path.GetFullPath(env) : Path.Combine(Root, "data");
        try
        {
            var bootstrap = Path.Combine(DataDir, "launcher", "launcher.json");
            if (File.Exists(bootstrap) && JsonNode.Parse(File.ReadAllText(bootstrap)) is JsonObject o && o["dataDir"]?.ToString() is { Length: > 0 } custom && string.IsNullOrWhiteSpace(env))
                DataDir = Path.GetFullPath(custom, Root);
        }
        catch { }
    }

    public static string Resolve(string p) => Path.IsPathRooted(p) ? p : Path.GetFullPath(Path.Combine(Root, p));

    public static string NodeExe(LauncherSettings? s)
    {
        var custom = s?.Str("nodePath");
        if (!string.IsNullOrWhiteSpace(custom)) return Resolve(custom);
        var bundled = Path.Combine(Root, "runtime", "node.exe");
        return File.Exists(bundled) ? bundled : "node";
    }

    public static bool ServerPresent => File.Exists(SupervisorJs);
}

public sealed record SkeletonResult(List<string> Created, List<string> Problems);

public static class Skeleton
{
    public static readonly string[] DataFolders =
    [
        "attachments", "avatars", "banners", "cards", "certs", "channelicons", "emoji", "foldericons", "logs", "notefiles", "roleicons",
        "servericons", "sites", "sounds", "stickers", "threadicons", "webhookicons", "backups", "launcher", "launcher\\reports", "launcher\\config-backups"
    ];

    public static SkeletonResult Ensure()
    {
        var created = new List<string>();
        var problems = new List<string>();
        try
        {
            if (!Directory.Exists(Paths.DataDir)) { Directory.CreateDirectory(Paths.DataDir); created.Add("data\\"); }
            foreach (var f in DataFolders)
            {
                var p = Path.Combine(Paths.DataDir, f);
                if (!Directory.Exists(p)) { Directory.CreateDirectory(p); created.Add($"data\\{f}\\"); }
            }
            if (!File.Exists(Paths.ConfigFile))
            {
                var store = new JsonStore(Paths.ConfigFile);
                store.SetRoot(Fields.DefaultServerConfig());
                store.Save();
                created.Add("data\\config.json (defaults, new TURN secret)");
            }
            else
            {
                var probe = new JsonStore(Paths.ConfigFile);
                probe.Load();
                if (probe.LoadError != null) problems.Add($"data\\config.json is not valid JSON: {probe.LoadError}");
            }
        }
        catch (Exception e) { problems.Add($"cannot prepare the data folder: {e.Message}"); }
        if (!Paths.ServerPresent) problems.Add($"server\\supervisor.js not found in {Paths.Root}. Launcher.exe must sit next to the start-server.bat of the server package.");
        return new SkeletonResult(created, problems);
    }
}

public sealed record EventRec(DateTime Time, string Type, string Message, string? Detail = null);

public sealed class EventLog
{
    private readonly List<EventRec> _events = new();
    private readonly object _lock = new();
    public event Action<EventRec>? Added;

    public IReadOnlyList<EventRec> Snapshot() { lock (_lock) return _events.ToList(); }

    public void Load()
    {
        try
        {
            if (!File.Exists(Paths.EventsFile)) return;
            foreach (var line in File.ReadLines(Paths.EventsFile).TakeLast(1500))
            {
                try
                {
                    var o = JsonNode.Parse(line)!;
                    _events.Add(new EventRec(DateTime.Parse(o["t"]!.ToString(), null, System.Globalization.DateTimeStyles.RoundtripKind), o["type"]!.ToString(), o["msg"]!.ToString(), o["detail"]?.ToString()));
                }
                catch { }
            }
        }
        catch { }
    }

    public void Add(string type, string message, string? detail = null)
    {
        var e = new EventRec(DateTime.Now, type, message, detail);
        lock (_lock)
        {
            _events.Add(e);
            if (_events.Count > 3000) _events.RemoveRange(0, 500);
        }
        try
        {
            Directory.CreateDirectory(Paths.LauncherDir);
            var o = new JsonObject { ["t"] = e.Time.ToString("o"), ["type"] = type, ["msg"] = message };
            if (detail != null) o["detail"] = detail;
            File.AppendAllText(Paths.EventsFile, o.ToJsonString() + "\n");
            var fi = new FileInfo(Paths.EventsFile);
            if (fi.Length > 4_000_000)
            {
                var keep = File.ReadLines(Paths.EventsFile).TakeLast(1000).ToList();
                File.WriteAllLines(Paths.EventsFile, keep);
            }
        }
        catch { }
        Added?.Invoke(e);
    }

    public double RunningFraction(TimeSpan window)
    {
        var now = DateTime.Now;
        var from = now - window;
        List<EventRec> list;
        lock (_lock) list = _events.Where(e => e.Type is "state").ToList();
        if (list.Count == 0) return 0;
        double up = 0;
        DateTime? start = null;
        bool wasRunning = false;
        foreach (var e in list)
        {
            bool running = e.Message == "Running";
            if (e.Time < from) { wasRunning = running; continue; }
            if (start == null) { start = from; }
            if (wasRunning) up += (e.Time - Max(start.Value, from)).TotalSeconds;
            start = e.Time; wasRunning = running;
        }
        if (start == null) start = from;
        if (wasRunning) up += (now - Max(start.Value, from)).TotalSeconds;
        return Math.Clamp(up / window.TotalSeconds, 0, 1);
    }

    private static DateTime Max(DateTime a, DateTime b) => a > b ? a : b;
}

public static class Net
{
    public static bool PortFree(int port, string address = "0.0.0.0")
    {
        try
        {
            using var l = new TcpListener(IPAddress.TryParse(address, out var ip) ? ip : IPAddress.Any, port);
            l.Start();
            l.Stop();
            return true;
        }
        catch { return false; }
    }

    public static bool UdpFree(int port)
    {
        try { using var u = new UdpClient(port); return true; } catch { return false; }
    }

    public static async Task<bool> ProbeAsync(int port, bool https, int timeoutMs = 4000)
    {
        try
        {
            using var handler = new HttpClientHandler { ServerCertificateCustomValidationCallback = (_, _, _, _) => true };
            using var http = new HttpClient(handler) { Timeout = TimeSpan.FromMilliseconds(timeoutMs) };
            using var req = new HttpRequestMessage(HttpMethod.Head, $"{(https ? "https" : "http")}://127.0.0.1:{port}/");
            using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
            return (int)resp.StatusCode < 600;
        }
        catch { return false; }
    }

    public static async Task<bool> TcpConnectAsync(string host, int port, int timeoutMs = 2000)
    {
        try
        {
            using var c = new TcpClient();
            var t = c.ConnectAsync(host, port);
            return await Task.WhenAny(t, Task.Delay(timeoutMs)) == t && c.Connected;
        }
        catch { return false; }
    }
}

public static class Sys
{
    public static void OpenFolder(string path)
    {
        try { Directory.CreateDirectory(path); Process.Start(new ProcessStartInfo("explorer.exe", $"\"{path}\"") { UseShellExecute = true }); } catch { }
    }

    public static void OpenFile(string path)
    {
        try { Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); } catch { }
    }

    public static void OpenUrl(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }

    public static bool IsAdmin()
    {
        try { using var id = System.Security.Principal.WindowsIdentity.GetCurrent(); return new System.Security.Principal.WindowsPrincipal(id).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator); }
        catch { return false; }
    }

    public static void SetStartWithWindows(bool on)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true);
            if (key == null) return;
            const string name = "MeshCrowdLauncher";
            if (on) key.SetValue(name, $"\"{Paths.ExePath}\" --root \"{Paths.Root}\"");
            else key.DeleteValue(name, false);
        }
        catch { }
    }

    public static async Task<string> RunCaptureAsync(string file, string args, string workDir, int timeoutMs = 30000)
    {
        try
        {
            var psi = new ProcessStartInfo(file, args) { WorkingDirectory = workDir, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true, StandardOutputEncoding = Encoding.UTF8 };
            using var p = Process.Start(psi)!;
            var o = p.StandardOutput.ReadToEndAsync();
            var e = p.StandardError.ReadToEndAsync();
            if (!p.WaitForExit(timeoutMs)) { try { p.Kill(true); } catch { } return "timed out"; }
            return (await o + await e).Trim();
        }
        catch (Exception ex) { return ex.Message; }
    }

    public static string FreeSpace(string path)
    {
        try { var d = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(path))!); return Ui.FormatSize(d.AvailableFreeSpace); } catch { return "unknown"; }
    }
}
