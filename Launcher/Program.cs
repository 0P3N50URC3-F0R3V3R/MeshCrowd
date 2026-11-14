using System.Runtime.InteropServices;

namespace MeshCrowd.Launcher;

internal static class Program
{
    public static int ShowMessage;

    [DllImport("user32.dll")] private static extern int RegisterWindowMessage(string name);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hwnd, int msg, IntPtr w, IntPtr l);

    [STAThread]
    private static void Main(string[] args)
    {
        string? root = null, startPage = null;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--root" && i + 1 < args.Length) root = args[++i];
            else if (args[i] == "--page" && i + 1 < args.Length) startPage = args[++i];
        }

        Paths.Init(root);
        ShowMessage = RegisterWindowMessage("MeshCrowdLauncherShow");

        var id = Convert.ToHexString(System.Security.Cryptography.SHA1.HashData(System.Text.Encoding.UTF8.GetBytes(Paths.Root.ToLowerInvariant())))[..16];
        using var mutex = new Mutex(true, "MeshCrowdLauncher-" + id, out bool first);
        if (!first)
        {
            PostMessage((IntPtr)0xFFFF, ShowMessage, IntPtr.Zero, IntPtr.Zero);
            return;
        }

        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.ThreadException += (_, e) => MessageBox.Show(e.Exception.ToString(), "Launcher error");

        var skeleton = Skeleton.Ensure();
        App.Settings = new LauncherSettings();
        App.Events = new EventLog();
        App.Events.Load();
        App.LoadCommands();
        var lastState = App.Events.Snapshot().LastOrDefault(e => e.Type == "state");
        if (lastState != null && lastState.Message is "Running" or "Starting" or "Stopping" or "Restarting") App.Events.Add("state", "Stopped", "launcher was not closed cleanly");
        foreach (var c in skeleton.Created) App.Events.Add("launcher", "Created " + c);
        foreach (var p in skeleton.Problems) App.Events.Add("error", p);
        App.Events.Add("launcher", "Launcher started", Paths.Root);
        App.Host = new ServerHost(App.Settings, App.Events);

        var form = new MainForm();
        form.Shown += (_, _) =>
        {
            if (startPage != null) form.GoTo(startPage);
            if (skeleton.Created.Count > 0)
                App.Host.PostLine(new LogLine(DateTime.Now, "SYS", "launcher", "prepared: " + string.Join(", ", skeleton.Created.Take(6)) + (skeleton.Created.Count > 6 ? $" and {skeleton.Created.Count - 6} more" : ""), ""));
            foreach (var p in skeleton.Problems) App.Host.PostLine(new LogLine(DateTime.Now, "ERROR", "launcher", p, p));
            if (skeleton.Problems.Count > 0) Dlg.Info(form, "Setup problem", string.Join("\n\n", skeleton.Problems));
            else if (App.Settings.Bool("autoStart"))
            {
                var err = App.Host.Start();
                if (err != null) Dlg.Info(form, "Cannot start the server", err);
            }
        };
        Application.Run(form);
    }
}
