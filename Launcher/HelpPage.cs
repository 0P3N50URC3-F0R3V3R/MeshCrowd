namespace MeshCrowd.Launcher;

public sealed class HelpPage : Page
{
    private readonly ScrollPanel _scroll;

    public override void OnShown() { _scroll.AutoScrollPosition = Point.Empty; }

    public HelpPage()
    {
        Title = "Help";
        Subtitle = "How the launcher works, in one page.";
        var scroll = new ScrollPanel { Dock = DockStyle.Fill };
        _scroll = scroll;
        int y = 24;
        int W() => Math.Max(500, scroll.ClientSize.Width - 64);
        var blocks = new List<(Control c, bool heading)>();

        void H(string t) { var l = new DLabel { Text = t, Font = Theme.UiTitle, ForeColor = Theme.TextBright, Wrap = false, Height = 30 }; blocks.Add((l, true)); }
        void P(string t) { blocks.Add((new DLabel { Text = t, Font = new Font("Segoe UI", 10f) }, false)); }
        void Code(string t) { blocks.Add((new DLabel { Text = t, Font = Theme.Mono, ForeColor = Color.FromArgb(0xA5, 0xAE, 0xFF) }, false)); }

        H("What this is");
        P("An optional control panel for the MeshCrowd server. It starts and supervises the server process, edits data\\config.json with documentation on every field, shows the live log, runs every console command and keeps a history of restarts and crashes. The server works exactly as before without it: start-server.bat is untouched.");
        H("Quick start");
        P("1. Put Launcher.exe in the server folder, next to start-server.bat.\n2. Open it. Missing data folders and a default config.json are created automatically.\n3. Config tab: set Public host and the ports, then Save.\n4. Dashboard: Start server. Console shows the live log. Tools > Doctor checks the setup.");
        H("The tabs");
        P("Dashboard   state, start / stop / restart, live statistics.\nConsole   live log with filters, and a command line with history and Tab completion.\nCommands   all console commands with usage, examples and an argument form.\nConfig   every server setting with description, range, default and a hint whether it needs a restart. Shows a diff before saving and keeps backups.\nLogs   browse and search the log files in data\\logs.\nSupervisor   events timeline, crash reports and the active policy.\nTools   online users, accounts, backups, the Doctor health check, maintenance helpers and a diagnostics bundle.\nSettings   crash recovery, watchdog, scheduled restarts, alerts and launcher behaviour.");
        H("How supervision works");
        P("The launcher runs server\\supervisor.js, which restarts the server by itself after the restart command. On top of that the launcher notices:\n\n- Crash: the server exits with an error. It writes a report, waits (doubling the delay up to 60 s) and starts it again. After too many crashes in a short time it stops retrying and alerts you.\n- Hang: the watchdog connects to the HTTP(S) port regularly. Several failures in a row kill and restart the process.\n- Schedule: an optional daily restart and an optional memory limit trigger a restart with a countdown that online users see.\n\nStopping from the launcher (or the server stop command) is never treated as a crash.");
        H("Safe to close?");
        P("The server runs as a child of the launcher. Closing the window hides it to the tray (configurable). Exit from the tray menu stops the server cleanly first. If the launcher is killed, Windows ends the server with it, so no orphan process is left behind.");
        H("Prompts");
        P("Some commands ask questions (are you sure, passwords). The launcher shows them as dialogs. Destructive commands in the Commands tab ask once more before running.");
        H("Files the launcher uses");
        Code("Launcher.exe                       this program\ndata\\config.json                   server configuration (edited by the Config tab)\ndata\\launcher\\launcher.json        launcher settings\ndata\\launcher\\events.jsonl         event history\ndata\\launcher\\reports\\             crash reports and snapshots\ndata\\launcher\\config-backups\\      automatic copies made before every config save");
        H("Keyboard");
        P("Ctrl+1 to Ctrl+9   jump to a tab\nConsole: Enter sends, Up/Down history, Tab completes a command, Esc clears the line\nTray icon: left click shows the window, right click opens the menu");
        H("Troubleshooting");
        P("\"Port is already in use\": another server instance runs (maybe start-server.bat in a console window). Close it, or change the port in Config > Network.\n\"Node.js not found\": runtime\\node.exe is missing and node is not on PATH. Tools > Doctor explains and can install dependencies.\nServer starts but the browser warns: the automatic certificate is self-signed. Provide serverCrt / serverKey in Config > Network.\nSomething is wrong but not crashing: Supervisor > Overview > Create snapshot report, or Tools > Maintenance > diagnostics bundle.");

        foreach (var (c, h) in blocks)
        {
            c.Width = W();
            if (c is DLabel l && !h) c.Height = Theme.Measure(l.Text, l.Font, c.Width);
            c.Location = new Point(32, y);
            scroll.Controls.Add(c);
            y += c.Height + (h ? 6 : 18);
        }
        scroll.AutoScrollMinSize = new Size(0, y + 24);
        scroll.Resize += (_, _) =>
        {
            int yy = 24;
            foreach (var (c, h) in blocks)
            {
                c.Width = W();
                if (c is DLabel l && !h) c.Height = Theme.Measure(l.Text, l.Font, c.Width);
                c.Location = new Point(32, yy);
                yy += c.Height + (h ? 6 : 18);
            }
            scroll.AutoScrollMinSize = new Size(0, yy + 24);
        };
        Controls.Add(scroll);
    }
}
