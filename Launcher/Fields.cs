using System.Text.Json.Nodes;

namespace MeshCrowd.Launcher;

public static class Fields
{
    private static JsonNode? N(object? v) => v switch
    {
        null => null, bool b => JsonValue.Create(b), int i => JsonValue.Create((long)i), long l => JsonValue.Create(l), string s => JsonValue.Create(s), _ => null
    };

    private static FieldDef Bool(string key, string group, string label, bool def, string shortText, string help, bool restart = true, string? example = null) =>
        new() { Key = key, Group = group, Label = label, Type = FType.Bool, Default = N(def), Short = shortText, Help = help, Restart = restart, Example = example };

    private static FieldDef Int(string key, string group, string label, long def, long min, long max, string shortText, string help, bool restart = true, string? example = null) =>
        new() { Key = key, Group = group, Label = label, Type = FType.Int, Default = N(def), Min = min, Max = max, Short = shortText, Help = help, Restart = restart, Example = example };

    private static FieldDef Text(string key, string group, string label, string def, string shortText, string help, bool restart = true, string? example = null, string? check = null, string? placeholder = null) =>
        new() { Key = key, Group = group, Label = label, Type = FType.Text, Default = N(def), Short = shortText, Help = help, Restart = restart, Example = example, Check = check, Placeholder = placeholder };

    private static FieldDef Enum(string key, string group, string label, string def, string[] opts, string shortText, string help, bool restart = true) =>
        new() { Key = key, Group = group, Label = label, Type = FType.Enum, Default = N(def), Options = opts, Short = shortText, Help = help, Restart = restart };

    private static FieldDef Json(string key, string group, string label, string defJson, string shortText, string help, string? check, string? example = null, bool restart = true) =>
        new() { Key = key, Group = group, Label = label, Type = FType.Json, Default = JsonNode.Parse(defJson), Short = shortText, Help = help, Check = check, Example = example, Restart = restart };

    private static FieldDef Secret(string key, string group, string label, string shortText, string help, bool generate) =>
        new() { Key = key, Group = group, Label = label, Type = FType.Secret, Default = N(""), Short = shortText, Help = help, Generate = generate, Restart = true };

    private static FieldDef FileF(string key, string group, string label, string shortText, string help, string? example = null) =>
        new() { Key = key, Group = group, Label = label, Type = FType.File, Default = N(""), Short = shortText, Help = help, Example = example, Restart = true };

    public const string GNet = "Network & HTTPS", GAcc = "Accounts & limits", GVoice = "Voice & ICE", GTurn = "TURN relay", GTurnIp = "TURN dynamic IP",
        GTurnLim = "TURN limits", GFed = "Federation", GSites = "Sites (PHP)", GLinks = "Push & links", GLog = "Logging", GSsh = "SSH console", GBackup = "Backups";

    public static readonly string[] ServerGroups = [GNet, GAcc, GVoice, GTurn, GTurnIp, GTurnLim, GFed, GSites, GLinks, GLog, GSsh, GBackup];

    public static readonly Dictionary<string, string> GroupInfo = new()
    {
        [GNet] = "Ports, the public address and TLS certificates. These decide how users and other servers reach this instance.",
        [GAcc] = "Who may register, upload size and message size limits, and the factory-reset password.",
        [GVoice] = "How voice and video calls find a network path between users when no relay is used.",
        [GTurn] = "Built-in STUN/TURN relay so calls connect across routers and NAT without a third-party service. Off by default: LAN-only installs never open a UDP port.",
        [GTurnIp] = "For servers with a changing (dynamic) public IP: re-read the address periodically and restart the relay when it changes.",
        [GTurnLim] = "Resource limits so the relay cannot be abused or exhaust bandwidth.",
        [GFed] = "Mesh federation between MeshCrowd instances. Off by default; a stand-alone server never opens a federation route.",
        [GSites] = "Sites are small PHP intranet servers hosted by MeshCrowd. Needs a PHP binary.",
        [GLinks] = "Download links shown in the web UI and push-notification safety switches.",
        [GLog] = "Log verbosity, retention and rotation. Logs live in data/logs and stream into the Console tab.",
        [GSsh] = "Remote admin console over SSH, the same command set as the Commands tab. Authentication uses accounts with the console permission.",
        [GBackup] = "How many backups are kept, the automatic schedule and what a backup contains.",
    };

    private static readonly string[] Ports = [];

    public static readonly List<FieldDef> Server =
    [
        Int("port", GNet, "HTTP port", 8080, 1, 65535, "Plain HTTP port. With HTTPS on it only redirects to the HTTPS port.",
            "The port the server listens on for plain HTTP. When \"Use HTTPS\" is on, this port only redirects visitors to the HTTPS port. When HTTPS is off, this is the port everybody uses. Ports below 1024 need administrator rights on some systems.", example: "8080"),
        Int("httpsPort", GNet, "HTTPS port", 8443, 1, 65535, "Port for encrypted connections. Browsers need HTTPS for microphone and camera.",
            "Main port when \"Use HTTPS\" is on. Open this port in your firewall and forward it on your router for access from the internet. It must differ from the HTTP port.", example: "8443"),
        Text("publicHost", GNet, "Public host", "localhost", "Name or IP people use to reach this server from outside (not a URL).",
            "Host name or IP address clients and other servers use to reach this instance, without http:// or a port. It is used to build invite links, passport origins, TURN advertisement and federation addresses. Keep \"localhost\" for a local-only test server; set your domain or public IP for real use.",
            example: "chat.example.com", check: "host"),
        Bool("useHttps", GNet, "Use HTTPS", true, "Serve over TLS. Required for microphone, camera and screen sharing in browsers.",
            "Browsers only allow microphone, camera and screen capture on secure origins. With no certificate configured below, a self-signed certificate is generated into data/certs and reused (browsers will show a warning until you trust it)."),
        FileF("serverCrt", GNet, "Certificate file (PEM)", "Your own TLS certificate. Leave empty for the automatic self-signed one.",
            "Path to a PEM certificate chain (for example from Let's Encrypt). Absolute, or relative to the server folder. Must be set together with the key file. Empty = self-signed certificate under data/certs.", "certs\\fullchain.pem"),
        FileF("serverKey", GNet, "Private key file (PEM)", "Private key that belongs to the certificate above.",
            "Path to the PEM private key matching the certificate. Keep this file private. Must be set together with the certificate file.", "certs\\privkey.pem"),
        Json("trustProxy", GNet, "Trust proxy", "false", "Set when running behind a reverse proxy (nginx, Caddy, Cloudflare).",
            "Express \"trust proxy\" setting. false = no proxy. true = trust the first proxy. A number = trust that many proxy hops. A text = a subnet or list of trusted proxies. Without this behind a proxy, every user appears with the proxy's IP, which breaks rate limiting and audit logs.", "trustProxy", "false   or   1   or   \"loopback\""),

        Enum("registrationMode", GAcc, "Registration mode", "open", ["open", "closed", "invite"], "Who may create an account.",
            "open = anyone can register. closed = nobody can; admins still add users in the console. invite = only with a valid invite link or code. The first account on an empty instance is always allowed.", restart: false),
        Int("maxUploadMb", GAcc, "Max upload size (MB)", 25, 1, 10240, "Largest file a user may upload.",
            "Maximum size of one uploaded file in megabytes. Larger values need more disk space and bandwidth. Reverse proxies have their own limit too (nginx: client_max_body_size).", restart: false, example: "25"),
        Int("maxMessageChars", GAcc, "Max message length (characters)", 15000, 100, 100000, "Longest plain-text chat message. Encrypted DMs keep a fixed 4000.",
            "Maximum characters in one plaintext message. Very large values let users paste walls of text into channels."),
        Secret("purgePassword", GAcc, "Purge password", "Password the console's purge command asks for. Empty disables purge.",
            "The console command \"purge\" resets the whole server to factory state (all accounts, servers, messages and media). It asks for this password first. Leave empty to disable the command completely. Store a strong value if you set it.", false),

        Json("iceServers", GVoice, "ICE servers (STUN/TURN)", "[]", "External STUN/TURN servers for voice. Empty = LAN-only calls.",
            "A JSON list of WebRTC ICE servers. Empty by default: voice stays on the local network and contacts no external service. If participants are not all on the same LAN (WAN, VLANs, strict NAT) add at least one STUN entry. Prefer the built-in TURN relay below if you want to host everything yourself.", "iceServers",
            "[{\"urls\":\"stun:stun.l.google.com:19302\"}]"),
        Json("lanNetworks", GVoice, "LAN/VPN subnets", "[]", "Subnets voice peers should prefer (CIDR). Empty = automatic.",
            "Optional list of LAN or VPN subnets (IPv4 CIDR). When set, private addresses outside these subnets (Docker, WSL, other adapters) are not tried, so calls settle on the right path faster. STUN/TURN stay available as fallback.", "lanNetworks",
            "[\"26.0.0.0/8\",\"192.168.3.0/24\"]"),

        Bool("turn.enabled", GTurn, "Enable built-in TURN/STUN", false, "Run the relay inside the server.",
            "Starts a STUN/TURN server on the port below (UDP and TCP). Needed when callers sit behind different routers. Opens a UDP port, so also open it in the firewall (setup-turn.bat in the Tools tab does that)."),
        Int("turn.port", GTurn, "TURN port", 3478, 1, 65535, "Listening port (UDP and TCP).", "Standard TURN/STUN port is 3478. Forward it on your router to this machine.", example: "3478"),
        Text("turn.listenAddress", GTurn, "Listen address", "0.0.0.0", "Network interface to bind: 0.0.0.0 = all.",
            "IP of the interface the relay listens on. 0.0.0.0 listens on every interface. Use a specific address to bind to one adapter only.", check: "bind", example: "0.0.0.0"),
        Bool("turn.tcp", GTurn, "Allow TCP", true, "Also accept TURN over TCP (helps behind strict firewalls).",
            "UDP is preferred for media. TCP fallback lets clients in restrictive networks connect, at higher latency."),
        Text("turn.externalIp", GTurn, "External IPv4", "", "Public IPv4 of this machine as the internet sees it.",
            "Needed when the server sits behind a router doing NAT. Empty = the first public address of a local interface. Filled automatically when dynamic IP is on.", check: "ipv4", example: "203.0.113.10"),
        Text("turn.advertisedHost", GTurn, "Advertised host", "", "Host name or IP clients are told to use for TURN.",
            "Empty = external IP, else the public host, else the address the browser used. Set a DNS name here if clients should use a stable name instead of an IP.", example: "turn.example.com"),
        Text("turn.realm", GTurn, "Realm", "meshcrowd", "TURN authentication realm (a name, rarely changed).", "Identifies the TURN service in authentication. Any short text works; clients receive it with their credentials."),
        Secret("turn.secret", GTurn, "Signing secret", "Secret that signs the short-lived credentials handed to signed-in users.",
            "Generated automatically on first start. Anyone who knows it can mint TURN credentials, so keep it private. Changing it makes all issued credentials invalid until clients reconnect.", true),
        Int("turn.credentialTtlSeconds", GTurn, "Credential lifetime (s)", 86400, 60, 31536000, "How long issued TURN credentials stay valid.", "Credentials are short-lived by design. 86400 = one day.", example: "86400"),
        Int("turn.relayPortMin", GTurn, "Relay port range start", 49152, 1, 65535, "First UDP port used for relayed media.",
            "Media is relayed over ports in this range. Forward the whole range on your router and open it in the firewall. The range limits how many calls can be relayed at the same time."),
        Int("turn.relayPortMax", GTurn, "Relay port range end", 49999, 1, 65535, "Last UDP port used for relayed media.", "Must not be below the range start."),

        Bool("turn.autoIp", GTurnIp, "Detect public IP automatically", false, "Re-read the public IPv4 regularly (dynamic IP).",
            "When the address changes, it is stored in External IPv4 (the old one goes to Previous IP) and the relay restarts."),
        Enum("turn.autoIpSource", GTurnIp, "Detection source", "upnp", ["upnp", "stun", "http"], "How the public IP is found.",
            "upnp asks your router. stun asks the STUN server below. http reads a URL that returns your IP as plain text."),
        Text("turn.autoIpStun", GTurnIp, "STUN server", "", "Used when the source is stun (host:port).", "A STUN server address, used only with source stun.", example: "stun.l.google.com:19302"),
        Text("turn.autoIpUrl", GTurnIp, "IP lookup URL", "", "Used when the source is http.", "A URL that returns your public IP as plain text, used only with source http.", example: "https://api.ipify.org", check: "https"),
        Int("turn.autoIpIntervalMinutes", GTurnIp, "Check interval (minutes)", 5, 1, 1440, "How often the public IP is re-read.", "Shorter = faster recovery after an IP change, slightly more router/STUN traffic."),
        Text("turn.previousIp", GTurnIp, "Previous IP (read-only record)", "", "Last address before the most recent change.", "Written by the server. You normally never edit it.", check: "ipv4"),
        Text("turn.ipChangedAt", GTurnIp, "IP changed at (read-only record)", "", "Timestamp of the most recent IP change.", "Written by the server. You normally never edit it."),

        Bool("turn.allowPrivatePeers", GTurnLim, "Allow relaying to private addresses", false, "Lets the relay reach 10.x / 192.168.x / loopback targets.",
            "Off by default so a TURN server cannot be used to reach into the LAN it sits in. Enable only when you understand the risk."),
        Int("turn.maxAllocations", GTurnLim, "Max allocations (total)", 500, 1, 1000000, "Upper limit of concurrent relay sessions.", "Each active relayed call uses allocations. Raise for busy servers, lower on small machines."),
        Int("turn.maxAllocationsPerUser", GTurnLim, "Max allocations per user", 20, 1, 1000000, "Upper limit of relay sessions for one user.", "Stops a single account from exhausting the relay."),
        Int("turn.maxKbps", GTurnLim, "Bandwidth cap per allocation (kbps)", 0, 0, 10000000, "0 = unlimited.", "Caps the bandwidth of each relayed session. 0 disables the cap.", example: "2000"),

        Bool("federation.enabled", GFed, "Enable federation", false, "Allow this server to peer with other MeshCrowd servers.",
            "Opens the federation routes and background workers. Passport identity works regardless of this switch."),
        Text("federationPublicUrl", GFed, "Public federation URL", "", "Own public HTTPS origin peers use to reach this instance.",
            "Defaults to publicHost:httpsPort. Override when the server sits behind a reverse proxy on a different externally visible URL.", example: "https://chat.example.com", check: "https"),
        Json("passportOrigins", GFed, "Extra passport origins", "[]", "Additional origins a Passport may be signed for.",
            "On top of the origins derived from publicHost and the ports. Use when users reach the instance through several names.", "origins", "[\"https://chat.example.com\"]"),

        FileF("sites.phpPath", GSites, "PHP binary", "Explicit php.exe. Empty = runtime\\php\\php.exe, then PATH.", "Path to the PHP executable used to run Sites. Leave empty to use the bundled runtime or whatever is on PATH.", "C:\\php\\php.exe"),
        Int("sites.maxWorkers", GSites, "Workers per site", 4, 1, 16, "Parallel php processes per Site.", "php -S handles one request at a time, so several workers allow parallel requests. More workers use more memory."),

        Bool("pushAllowPrivateEndpoints", GLinks, "Allow private push endpoints", false, "Allow UnifiedPush endpoints on your LAN (e.g. a local ntfy).",
            "Users hand endpoint addresses to the server, which then POSTs to them. Private addresses are refused unless you enable this, to stop the server being used to probe your network."),
        Text("downloads.server", GLinks, "Server download link", "https://#", "Recorded only; not shown in the UI.", "Link to the server package. Placeholder https://# means \"not set\".", check: "https"),
        Text("downloads.clientDesktop", GLinks, "Desktop client link", "https://#", "Shown in the web UI.", "Where users download the desktop client. https:// only; anything else is ignored.", check: "https"),
        Text("downloads.clientAndroid", GLinks, "Android app link", "https://#", "Shown in the web UI.", "Where users download the Android app. https:// only.", check: "https"),
        Text("downloads.website", GLinks, "Website link", "https://#", "Shown in the web UI.", "Project or community website. https:// only.", check: "https"),

        Enum("logging.level", GLog, "Log level", "info", ["debug", "info", "warn", "error"], "Minimum severity that is logged and streamed.",
            "debug = everything (noisy). info = normal. warn = problems only. error = failures only. Also changeable live from the Console.", restart: false),
        Int("logging.keepDays", GLog, "Keep logs (days)", 30, 1, 3650, "Older log files are deleted.", "Retention for rotated log files in data/logs.", restart: false),
        Int("logging.maxFileMb", GLog, "Max log file size (MB)", 10, 1, 1024, "A new file starts when this size is reached.", "Per-file rotation size. Files rotate per day and per size.", restart: false),

        Bool("ssh.enabled", GSsh, "Enable SSH console", false, "Remote admin console over SSH.",
            "Starts an SSH server giving the same console as this launcher. Only accounts holding the console permission can log in. Keep it on 127.0.0.1 unless you really need remote access."),
        Int("ssh.port", GSsh, "SSH port", 2222, 1, 65535, "TCP port of the SSH console.", "Must not clash with another service.", example: "2222"),
        Text("ssh.listenAddress", GSsh, "Listen address", "127.0.0.1", "127.0.0.1 = this machine only. 0.0.0.0 = every interface.",
            "Binding to a public interface exposes the console to the internet; prefer an SSH tunnel or VPN.", check: "bind"),
        Int("ssh.maxSessions", GSsh, "Max sessions", 3, 1, 100, "Concurrent SSH console sessions.", "Extra logins are refused."),
        Int("ssh.idleTimeoutMinutes", GSsh, "Idle timeout (minutes)", 15, 1, 1440, "Idle sessions are disconnected after this time.", "Protects against forgotten open sessions."),
        Bool("ssh.allowPublicKeys", GSsh, "Allow public-key login", false, "Accept SSH keys in addition to passwords.", "Lets accounts authenticate with SSH public keys registered in the console."),

        Int("backup.keep", GBackup, "Backups to keep", 7, 1, 100, "Older normal backups are pruned.", "Number of normal backups kept; pre-restore safety copies are counted separately.", example: "7"),
        Text("backup.schedule", GBackup, "Daily backup time", "", "HH:MM in server local time. Empty = no automatic backups.",
            "Creates one backup every day at this time. Example 03:30.", example: "03:30", check: "time"),
        Int("backup.maxFileMb", GBackup, "Max media file in a backup (MB)", 5, 1, 1024, "Larger media files are skipped.", "Only small media (avatars, icons, emoji) is included, so backups stay small."),
        Bool("backup.includeSecrets", GBackup, "Include secrets", false, "Put passwords/keys/secrets into backups.",
            "Off = the config copy in a backup has secrets removed. On = backups can fully restore the server but must be guarded like passwords."),
        Int("backup.preRestoreKeep", GBackup, "Pre-restore copies to keep", 3, 0, 100, "Safety backups made before a restore.", "Before every restore a copy of the current state is saved. 0 = no safety copies."),
    ];

    public const string LSup = "Supervision", LWatch = "Watchdog", LSched = "Scheduling", LNote = "Reports & alerts", LApp = "Launcher", LPaths = "Paths & runtime";

    public static readonly string[] LauncherGroups = [LSup, LWatch, LSched, LNote, LApp, LPaths];

    public static readonly Dictionary<string, string> LauncherInfo = new()
    {
        [LSup] = "What the launcher does when the server stops on its own.",
        [LWatch] = "Detect a server that is running but no longer answering.",
        [LSched] = "Planned restarts and resource limits.",
        [LNote] = "Crash reports, desktop alerts and an optional Discord webhook.",
        [LApp] = "Behaviour of this window.",
        [LPaths] = "Where the launcher finds Node.js and the data folder.",
    };

    public static readonly List<FieldDef> Launcher =
    [
        Bool("autoStart", LSup, "Start the server when the launcher opens", false, "Launch the server immediately on startup.", "Convenient on a dedicated host: put a shortcut to Launcher.exe in the Windows Startup folder or enable \"Start with Windows\" below.", false),
        Bool("autoRestart", LSup, "Restart after a crash", true, "Bring the server back when it dies unexpectedly.", "Applies when the server exits with an error or is killed. A normal stop (console command or Stop button) is never restarted.", false),
        Int("maxCrashes", LSup, "Give up after N crashes", 5, 1, 100, "Crash-loop protection.", "If the server crashes this many times inside the window below, the launcher stops retrying and raises an alert.", false),
        Int("crashWindowMinutes", LSup, "...within minutes", 10, 1, 1440, "Window for the crash counter.", "Crashes older than this do not count towards the limit.", false),
        Int("backoffSeconds", LSup, "First restart delay (s)", 3, 0, 600, "Waiting time before the first retry; doubles each time up to 60 s.", "Gives ports and files time to be released before the new start.", false),
        Int("stopTimeoutSeconds", LSup, "Graceful stop timeout (s)", 20, 3, 600, "Then the process tree is killed.", "The launcher asks the server to stop cleanly (flushes the database). When it has not exited in this time, it is terminated.", false),

        Bool("watchdog", LWatch, "Enable watchdog", true, "Restart the server when it stops answering.", "Every interval the launcher opens a connection to the server's HTTP(S) port. A hung process (alive but not responding) is restarted after the configured number of failures.", false),
        Int("watchdogIntervalSeconds", LWatch, "Check interval (s)", 30, 5, 3600, "Time between probes.", "Each probe is one cheap local connection.", false),
        Int("watchdogFailures", LWatch, "Failures before restart", 3, 1, 50, "Consecutive failed probes.", "Avoids restarting because of a single slow answer.", false),
        Int("watchdogGraceSeconds", LWatch, "Startup grace (s)", 60, 0, 900, "No probing right after a start.", "Large databases can take a while to open.", false),

        Text("dailyRestart", LSched, "Daily restart time", "", "HH:MM local time, empty = off.", "Restarts the server every day at this time using \"server restart\", which warns online users with a countdown first.", false, "04:00", "time"),
        Int("restartWarnSeconds", LSched, "Warn users before planned restarts (s)", 60, 0, 3600, "Countdown announced to online users.", "Used for the daily restart, the memory limit and the Restart-with-countdown button.", false),
        Int("memoryLimitMb", LSched, "Restart when memory exceeds (MB)", 0, 0, 1048576, "0 = off.", "Restarts the server (with countdown) when its memory use stays above this for 3 checks. Works around leaks on long-running hosts.", false, "1500"),

        Bool("reportOnCrash", LNote, "Write crash reports", true, "Save a text report for each crash.", "Reports contain time, exit code, uptime, system info and the last console lines. See the Supervisor tab.", false),
        Bool("trayAlerts", LNote, "Desktop alerts", true, "Tray balloon on crash, restart and give-up.", "Shown by the notification area icon.", false),
        new FieldDef { Key = "discordWebhook", Group = LNote, Label = "Discord/Slack webhook URL", Type = FType.Secret, Default = N(""), Short = "Optional: post crash and restart events to a channel.", Help = "A webhook URL (https://discord.com/api/webhooks/...). The launcher posts a one-line message when the server crashes, restarts or the launcher gives up. Empty = nothing is sent anywhere." },
        Bool("webhookOnStartStop", LNote, "Also post start and stop", false, "Include normal start/stop events in the webhook.", "Off = only crashes, auto-restarts, watchdog restarts and give-up.", false),

        Bool("minimizeToTray", LApp, "Close button hides to tray", true, "The window closes into the notification area; the server keeps running.", "Use the tray menu or the Exit button in the window to quit and stop the server.", false),
        Bool("startMinimized", LApp, "Start hidden in tray", false, "Open without showing the window.", "Useful together with auto-start.", false),
        Bool("startWithWindows", LApp, "Start with Windows", false, "Add Launcher.exe to the current user's startup list.", "Writes HKCU\\...\\Run. Removed again when you turn this off.", false),
        Int("logBufferLines", LApp, "Console buffer (lines)", 5000, 500, 50000, "Lines kept in memory for the Console.", "Higher uses more memory. The full logs always stay on disk.", false),
        Int("statsIntervalSeconds", LApp, "Statistics refresh (s)", 10, 3, 600, "How often the Dashboard asks the server for numbers.", "Only while the window is visible and the server runs.", false),
        Bool("confirmDangerous", LApp, "Confirm dangerous commands", true, "Ask before purge, delete, ban, restore and stop.", "Extra confirmation in the Commands tab. Server-side prompts still apply.", false),

        new FieldDef { Key = "nodePath", Group = LPaths, Label = "Node.js executable", Type = FType.File, Default = N(""), Short = "Empty = runtime\\node.exe, then node on PATH.", Help = "The bundled runtime\\node.exe is preferred. Set a path to use another Node.js 22.5 or newer." },
        new FieldDef { Key = "dataDir", Group = LPaths, Label = "Data folder", Type = FType.Folder, Default = N(""), Short = "Empty = the data folder next to Launcher.exe.", Help = "Passed to the server as DISMESH_DATA_DIR. Changing it needs a launcher restart. The launcher's own files (events, reports, settings) are stored in <data>\\launcher." },
        new FieldDef { Key = "extraNodeArgs", Group = LPaths, Label = "Extra server environment", Type = FType.Text, Default = N(""), Short = "Optional KEY=VALUE pairs separated by ;", Help = "Added to the server's environment, for example MESHCROWD_NO_CONSOLE is not allowed here but NODE_OPTIONS=--max-old-space-size=2048 is.", Example = "NODE_OPTIONS=--max-old-space-size=2048" },
    ];

    static Fields() { foreach (var f in Launcher) f.NoBadge = true; }

    public static FieldDef? FindServer(string key) => Server.FirstOrDefault(f => f.Key == key);

    public static JsonObject DefaultServerConfig()
    {
        var root = new JsonObject();
        var s = new JsonStore("");
        s.SetRoot(root);
        foreach (var f in Server)
        {
            if (f.Key == "turn.secret") { s.Set(f.Key, JsonValue.Create(Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)).ToLowerInvariant())); continue; }
            s.Set(f.Key, f.Default);
        }
        return s.Root;
    }
}
