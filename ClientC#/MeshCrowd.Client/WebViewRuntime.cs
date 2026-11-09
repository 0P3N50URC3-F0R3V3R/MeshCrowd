using System.IO.Compression;
using System.Reflection;
using Microsoft.Web.WebView2.Core;

namespace MeshCrowd.Client;

// Machines without the WebView2 Evergreen runtime use the fixed-version runtime embedded in the exe
// (see bundle-webview2.ps1): it is unpacked once into data/webview2-runtime and reused afterwards.
public static class WebViewRuntime
{
    private const string BundleResource = "webview2-runtime.bin";
    private const string VersionResource = "webview2-runtime.version";

    private static Stream? OpenResource(string name) => Assembly.GetExecutingAssembly().GetManifestResourceStream(name);

    public static bool HasBundle
    {
        get { using var s = OpenResource(BundleResource); return s is not null; }
    }

    private static bool EvergreenInstalled()
    {
        try { return !string.IsNullOrEmpty(CoreWebView2Environment.GetAvailableBrowserVersionString()); }
        catch { return false; }
    }

    // null = use whatever is installed on the machine.
    public static string? Resolve(string dataDir, bool forceBundled)
    {
        if (!HasBundle || (!forceBundled && EvergreenInstalled())) return null;

        string dir = Path.Combine(dataDir, "webview2-runtime");
        string version;
        using (var vs = OpenResource(VersionResource))
        {
            version = vs is null ? "bundled" : new StreamReader(vs).ReadToEnd().Trim();
        }
        string marker = Path.Combine(dir, ".bundle-version");
        if (File.Exists(Path.Combine(dir, "msedgewebview2.exe")) && File.Exists(marker) && File.ReadAllText(marker) == version) return dir;

        using var splash = new SplashForm("Preparing MeshCrowd (first start)...");
        splash.Show();
        var work = Task.Run(() => Extract(dir, version));
        while (!work.IsCompleted)
        {
            Application.DoEvents();
            Thread.Sleep(30);
        }
        work.GetAwaiter().GetResult();
        return dir;
    }

    private static void Extract(string dir, string version)
    {
        string tmp = dir + ".tmp";
        if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
        Directory.CreateDirectory(tmp);

        using (var res = OpenResource(BundleResource)!)
        using (var br = new BrotliStream(res, CompressionMode.Decompress))
        using (var r = new BinaryReader(br))
        {
            int count = r.ReadInt32();
            var entries = new List<(string Path, long Length)>(count);
            for (int i = 0; i < count; i++) entries.Add((r.ReadString(), r.ReadInt64()));

            string root = Path.GetFullPath(tmp) + Path.DirectorySeparatorChar;
            var buf = new byte[1 << 20];
            foreach (var (rel, length) in entries)
            {
                string target = Path.GetFullPath(Path.Combine(tmp, rel));
                if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException(rel);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                using var fs = File.Create(target);
                long left = length;
                while (left > 0)
                {
                    int n = r.Read(buf, 0, (int)Math.Min(buf.Length, left));
                    if (n <= 0) throw new EndOfStreamException();
                    fs.Write(buf, 0, n);
                    left -= n;
                }
            }
        }

        File.WriteAllText(Path.Combine(tmp, ".bundle-version"), version);
        if (Directory.Exists(dir)) Directory.Delete(dir, true);
        Directory.Move(tmp, dir);
    }
}

internal sealed class SplashForm : Form
{
    public SplashForm(string text)
    {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        ShowInTaskbar = true;
        TopMost = true;
        Text = "MeshCrowd";
        BackColor = Color.FromArgb(0x1e, 0x1f, 0x22);
        float s = DeviceDpi / 96f;
        ClientSize = new Size((int)(380 * s), (int)(90 * s));
        Controls.Add(new Label
        {
            Text = text,
            Dock = DockStyle.Fill,
            ForeColor = Color.FromArgb(0xdb, 0xde, 0xe1),
            Font = new Font("Segoe UI", 11f),
            TextAlign = ContentAlignment.MiddleCenter,
        });
        try { Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath!); } catch { }
    }
}
