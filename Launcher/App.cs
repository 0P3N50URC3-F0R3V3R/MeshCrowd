using System.Reflection;
using System.Text.Json;

namespace MeshCrowd.Launcher;

public sealed class CmdDef
{
    public string name { get; set; } = "";
    public string[] aliases { get; set; } = [];
    public string area { get; set; } = "";
    public string summary { get; set; } = "";
    public string usage { get; set; } = "";
    public string[] examples { get; set; } = [];
    public bool audit { get; set; }
    public bool local { get; set; }
}

public static class App
{
    public static LauncherSettings Settings = null!;
    public static EventLog Events = null!;
    public static ServerHost Host = null!;
    public static MainForm Main = null!;
    public static List<CmdDef> Commands = new();

    public static readonly HashSet<string> Dangerous = ["purge", "server stop", "server restart", "account delete", "backup delete", "backup restore", "ban", "ipban", "account passwd", "account disable"];

    public static void LoadCommands()
    {
        try
        {
            using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("commands.json")!;
            Commands = JsonSerializer.Deserialize<List<CmdDef>>(s) ?? new();
        }
        catch { }
    }

    public static Icon AppIcon()
    {
        try { return Icon.ExtractAssociatedIcon(Paths.ExePath) ?? SystemIcons.Application; } catch { return SystemIcons.Application; }
    }

    public static string WebUrl()
    {
        var cfg = new JsonStore(Paths.ConfigFile);
        cfg.Load();
        bool https = cfg.Get("useHttps") is not System.Text.Json.Nodes.JsonValue hv || !hv.TryGetValue<bool>(out var hb) || hb;
        var host = cfg.Get("publicHost")?.ToString();
        if (string.IsNullOrWhiteSpace(host)) host = "localhost";
        var port = (https ? cfg.Get("httpsPort") : cfg.Get("port"))?.ToString() ?? (https ? "8443" : "8080");
        if (host is "0.0.0.0") host = "localhost";
        return $"{(https ? "https" : "http")}://{host}:{port}/";
    }

    public static string LocalUrl()
    {
        var u = WebUrl();
        var cfg = new JsonStore(Paths.ConfigFile);
        cfg.Load();
        bool https = cfg.Get("useHttps") is not System.Text.Json.Nodes.JsonValue hv || !hv.TryGetValue<bool>(out var hb) || hb;
        var port = (https ? cfg.Get("httpsPort") : cfg.Get("port"))?.ToString() ?? (https ? "8443" : "8080");
        return $"{(https ? "https" : "http")}://localhost:{port}/";
    }

    public static Color StateColor(SState s) => s switch
    {
        SState.Running => Theme.Green,
        SState.Starting or SState.Restarting or SState.Stopping or SState.Backoff => Theme.Yellow,
        SState.Crashed => Theme.Red,
        _ => Theme.Muted
    };
}

public abstract class Page : Panel
{
    public string Title { get; protected set; } = "";
    public string Subtitle { get; protected set; } = "";
    protected Page() { BackColor = Theme.Bg2; Dock = DockStyle.Fill; DoubleBuffered = true; }
    public virtual void OnShown() { }
    public virtual void OnHidden() { }

    protected void OnUi(Action a)
    {
        if (IsDisposed) return;
        if (InvokeRequired) { try { BeginInvoke(a); } catch { } } else a();
    }
}

public sealed class DList : ListBox
{
    public Func<object, int>? HeightOf;
    public Action<Graphics, Rectangle, object, bool>? DrawRow;

    public DList()
    {
        DrawMode = DrawMode.OwnerDrawVariable;
        BorderStyle = BorderStyle.None;
        BackColor = Theme.Bg1;
        ForeColor = Theme.Text;
        Font = Theme.Ui;
        IntegralHeight = false;
        ItemHeight = 28;
        Theme.DarkScroll(this);
        SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
    }

    protected override void OnMeasureItem(MeasureItemEventArgs e)
    {
        e.ItemHeight = e.Index >= 0 && e.Index < Items.Count && HeightOf != null ? HeightOf(Items[e.Index]) : 28;
    }

    protected override void OnDrawItem(DrawItemEventArgs e)
    {
        if (e.Index < 0 || e.Index >= Items.Count) return;
        var g = e.Graphics;
        Theme.Quality(g);
        bool sel = (e.State & DrawItemState.Selected) != 0;
        using (var br = new SolidBrush(sel ? Theme.Bg4 : BackColor)) g.FillRectangle(br, e.Bounds);
        if (DrawRow != null) DrawRow(g, e.Bounds, Items[e.Index], sel);
        else TextRenderer.DrawText(g, Items[e.Index].ToString(), Font, new Rectangle(e.Bounds.X + 10, e.Bounds.Y, e.Bounds.Width - 20, e.Bounds.Height), Theme.Text, TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
    }
}
