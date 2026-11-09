using System.Diagnostics;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;

namespace MeshCrowd.Client;

// Port of electron/downloads.js on top of WebView2's DownloadStarting event.
public sealed partial class DownloadManager
{
    public static readonly string[] Modes = ["ask", "folder"];

    private sealed class Entry
    {
        public int Id;
        public required CoreWebView2DownloadOperation Op;
        public required string Name;
        public long Received;
        public long Total;
        public string State = "progressing";
        public string Path = "";
        public bool Announced;
        public bool Dead;
    }

    private readonly Dictionary<int, Entry> _downloads = new();
    private readonly AppConfig _cfg;
    private readonly Action<string, JsonNode?> _post;
    private readonly Func<IntPtr> _hwnd;
    private int _nextId;

    public DownloadManager(AppConfig cfg, Action<string, JsonNode?> post, Func<IntPtr> hwnd)
    {
        _cfg = cfg;
        _post = post;
        _hwnd = hwnd;
    }

    [GeneratedRegex(@"[<>:""/\\|?*\x00-\x1f]")]
    private static partial Regex BadChars();

    public static string SafeName(string? name)
    {
        string baseName = Path.GetFileName(name ?? "");
        baseName = BadChars().Replace(baseName, "_").TrimEnd('.', ' ');
        return baseName.Length == 0 ? "download" : baseName;
    }

    public static string UniquePath(string dir, string name)
    {
        string file = SafeName(name);
        string ext = Path.GetExtension(file);
        string stem = file[..^ext.Length];
        string candidate = Path.Combine(dir, file);
        for (int i = 1; File.Exists(candidate); i++) candidate = Path.Combine(dir, $"{stem} ({i}){ext}");
        return candidate;
    }

    public static string? NormalizeDir(string? value)
    {
        if (value is null) return null;
        string v = value.Trim();
        if (v.Length == 0 || v.Length > 500 || !Path.IsPathFullyQualified(v)) return null;
        try { return Path.GetFullPath(v); } catch { return null; }
    }

    public string DownloadDir => NormalizeDir(_cfg.GetString("downloadDir")) ?? Native.DownloadsFolder();

    public void OnStarting(CoreWebView2DownloadStartingEventArgs e, Form owner)
    {
        string name = SafeName(Path.GetFileName(e.ResultFilePath));
        string dir = DownloadDir;
        var op = e.DownloadOperation;
        int id = ++_nextId;

        if (_cfg.GetString("downloadMode") == "folder")
        {
            try
            {
                Directory.CreateDirectory(dir);
                e.ResultFilePath = UniquePath(dir, name);
                e.Handled = true;
            }
            catch { e.ResultFilePath = Path.Combine(dir, name); }
        }
        else
        {
            // WebView2 would save straight away and show its own flyout, so ask here like a normal save dialog.
            e.ResultFilePath = Path.Combine(dir, name);
            var deferral = e.GetDeferral();
            int askId = id;
            owner.BeginInvoke(() =>
            {
                using var dlg = new SaveFileDialog { FileName = name, InitialDirectory = Directory.Exists(dir) ? dir : null, Filter = "All files (*.*)|*.*", OverwritePrompt = true };
                bool ok = owner.Visible && owner.WindowState != FormWindowState.Minimized ? dlg.ShowDialog(owner) == DialogResult.OK : dlg.ShowDialog() == DialogResult.OK;
                if (ok) { e.ResultFilePath = dlg.FileName; e.Handled = true; }
                else { e.Cancel = true; if (_downloads.Remove(askId, out var gone)) gone.Dead = true; }
                deferral.Complete();
            });
        }

        var d = new Entry { Id = id, Op = op, Name = name, Total = (long)Math.Min(long.MaxValue, op.TotalBytesToReceive ?? 0UL), Path = e.ResultFilePath };
        _downloads[id] = d;

        void Emit() { if (!d.Dead) _post("dismesh:download-event", new JsonObject
        {
            ["id"] = d.Id, ["name"] = d.Name, ["received"] = d.Received, ["total"] = d.Total, ["state"] = d.State, ["path"] = d.Path,
        }); }

        void Refresh()
        {
            d.Path = string.IsNullOrEmpty(op.ResultFilePath) ? d.Path : op.ResultFilePath;
            d.Received = (long)op.BytesReceived;
            d.Total = (long)Math.Min(long.MaxValue, op.TotalBytesToReceive ?? 0UL);
        }

        op.BytesReceivedChanged += (_, _) =>
        {
            if (d.Dead || d.State is "completed" or "cancelled") return;
            Refresh();
            d.Announced = true;
            Emit();
            UpdateTaskbar();
        };
        op.StateChanged += (_, _) =>
        {
            if (d.Dead) return;
            Refresh();
            switch (op.State)
            {
                case CoreWebView2DownloadState.Completed: d.State = "completed"; break;
                case CoreWebView2DownloadState.Interrupted:
                    d.State = op.InterruptReason switch
                    {
                        CoreWebView2DownloadInterruptReason.UserCanceled => "cancelled",
                        CoreWebView2DownloadInterruptReason.UserPaused => "paused",
                        _ => "interrupted",
                    };
                    break;
                default: d.State = "progressing"; break;
            }
            bool terminal = d.State is "completed" or "cancelled" or "interrupted";
            if (!terminal || d.Announced || d.State == "completed") Emit();
            UpdateTaskbar();
            if (terminal && d.State != "completed") _downloads.Remove(d.Id);
        };
    }

    private void UpdateTaskbar()
    {
        long received = 0, total = 0;
        int active = 0;
        foreach (var d in _downloads.Values)
        {
            if (d.State != "progressing") continue;
            active++;
            received += d.Received;
            total += d.Total;
        }
        TaskbarProgress.Set(_hwnd(), active == 0 ? -1 : total > 0 ? Math.Min((double)received / total, 1) : 2);
    }

    public string? SelectDownloadDir(IWin32Window owner)
    {
        using var dlg = new FolderBrowserDialog { InitialDirectory = DownloadDir, UseDescriptionForTitle = false };
        return dlg.ShowDialog(owner) == DialogResult.OK && dlg.SelectedPath.Length > 0 ? dlg.SelectedPath : null;
    }

    public void Show(int id)
    {
        if (_downloads.TryGetValue(id, out var d) && d.Path.Length > 0)
            Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{d.Path}\"") { UseShellExecute = true });
    }

    public JsonObject Open(int id)
    {
        if (!_downloads.TryGetValue(id, out var d) || d.Path.Length == 0 || d.State != "completed") return new JsonObject { ["ok"] = false };
        try
        {
            Process.Start(new ProcessStartInfo(d.Path) { UseShellExecute = true });
            return new JsonObject { ["ok"] = true };
        }
        catch (Exception ex) { return new JsonObject { ["ok"] = false, ["error"] = ex.Message }; }
    }

    public void Cancel(int id)
    {
        if (_downloads.TryGetValue(id, out var d) && d.State != "completed") d.Op.Cancel();
    }

    public string OpenDir()
    {
        try
        {
            Directory.CreateDirectory(DownloadDir);
            Process.Start(new ProcessStartInfo(DownloadDir) { UseShellExecute = true });
            return "";
        }
        catch (Exception ex) { return ex.Message; }
    }
}
