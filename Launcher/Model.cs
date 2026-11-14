using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace MeshCrowd.Launcher;

public enum FType { Bool, Int, Text, Enum, Json, Secret, File, Folder }

public sealed class FieldDef
{
    public string Key = "";
    public string Group = "";
    public string Label = "";
    public FType Type;
    public JsonNode? Default;
    public string Short = "";
    public string Help = "";
    public string? Example;
    public bool Restart;
    public long? Min, Max;
    public string[]? Options;
    public string? Check;
    public bool Generate;
    public string? Placeholder;
    public bool Advanced;
    public bool NoBadge;

    public string Tooltip()
    {
        var s = Help;
        if (Min != null || Max != null) s += $"\n\nAllowed: {(Min?.ToString() ?? "...")} to {(Max?.ToString() ?? "...")}.";
        if (Options != null) s += $"\n\nAllowed values: {string.Join(", ", Options)}.";
        s += $"\n\nDefault: {DefaultText()}.";
        if (Example != null) s += $"\nExample: {Example}";
        s += Restart ? "\n\nChanges need a server restart." : "\n\nApplies live while the server runs.";
        return s;
    }

    public string DefaultText()
    {
        if (Type == FType.Secret) return Generate ? "generated automatically" : "(empty)";
        var d = Default?.ToJsonString();
        return string.IsNullOrEmpty(d) || d == "\"\"" ? "(empty)" : d.Trim('"');
    }
}

public sealed class JsonStore
{
    public string Path { get; }
    public JsonObject Root { get; private set; } = new();
    public string? LoadError { get; private set; }
    private static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public JsonStore(string path) { Path = path; }

    public void Load()
    {
        LoadError = null;
        Root = new JsonObject();
        if (!File.Exists(Path)) return;
        try
        {
            var text = File.ReadAllText(Path);
            if (string.IsNullOrWhiteSpace(text)) return;
            Root = JsonNode.Parse(text, null, new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip }) as JsonObject ?? new JsonObject();
        }
        catch (Exception e) { LoadError = e.Message; }
    }

    public void SetRoot(JsonObject o) { Root = o; }

    public static JsonNode? Clone(JsonNode? n) => n == null ? null : JsonNode.Parse(n.ToJsonString());

    public JsonNode? Get(string key)
    {
        JsonNode? cur = Root;
        foreach (var part in key.Split('.'))
        {
            if (cur is not JsonObject o || !o.TryGetPropertyValue(part, out var next)) return null;
            cur = next;
        }
        return cur;
    }

    public void Set(string key, JsonNode? value)
    {
        var parts = key.Split('.');
        JsonObject cur = Root;
        for (int i = 0; i < parts.Length - 1; i++)
        {
            if (cur[parts[i]] is not JsonObject next) { next = new JsonObject(); cur[parts[i]] = next; }
            cur = next;
        }
        cur[parts[^1]] = Clone(value);
    }

    public string ToText() => Root.ToJsonString(Pretty);

    public void Save()
    {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
        var tmp = Path + ".tmp";
        File.WriteAllText(tmp, ToText());
        File.Move(tmp, Path, true);
    }
}

public static class Validate
{
    private static readonly Regex Cidr = new(@"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/(\d{1,2})$");

    public static string? Field(FieldDef f, JsonNode? v)
    {
        switch (f.Type)
        {
            case FType.Int:
                if (v is not JsonValue jv || !jv.TryGetValue<long>(out var n)) return "must be a whole number";
                if (f.Min != null && n < f.Min) return $"must be at least {f.Min}";
                if (f.Max != null && n > f.Max) return $"must be at most {f.Max}";
                return null;
            case FType.Enum:
                var s = v?.ToString() ?? "";
                return f.Options != null && !f.Options.Contains(s) ? $"must be one of: {string.Join(", ", f.Options)}" : null;
            case FType.File:
                if (v?.ToString() is { Length: > 0 } p && !File.Exists(Paths.Resolve(p))) return "file not found (relative paths start at the server folder)";
                return null;
            case FType.Json:
                return Json(f, v);
            case FType.Text:
                return f.Check switch
                {
                    "host" => Host(v?.ToString() ?? ""),
                    "https" => HttpsUrl(v?.ToString() ?? "", f.Key.StartsWith("downloads")),
                    "ipv4" => string.IsNullOrEmpty(v?.ToString()) || System.Net.IPAddress.TryParse(v!.ToString(), out var ip) && ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork ? null : "must be an IPv4 address",
                    "time" => string.IsNullOrEmpty(v?.ToString()) || Regex.IsMatch(v!.ToString(), @"^([01]\d|2[0-3]):[0-5]\d$") ? null : "use HH:MM, 24-hour (for example 03:30), or leave empty",
                    "bind" => string.IsNullOrWhiteSpace(v?.ToString()) ? "required (for example 0.0.0.0 or 127.0.0.1)" : System.Net.IPAddress.TryParse(v!.ToString(), out _) ? null : "must be an IP address",
                    _ => null
                };
        }
        return null;
    }

    private static string? Host(string s)
    {
        if (s.Trim() == "") return "required (use localhost for a local-only server)";
        return s.Contains(' ') || s.Contains('/') ? "must be a host name or IP, no spaces or slashes" : null;
    }

    private static string? HttpsUrl(string s, bool allowPlaceholder)
    {
        if (s == "") return null;
        if (allowPlaceholder && s == "https://#") return null;
        return Uri.TryCreate(s, UriKind.Absolute, out var u) && u.Scheme == "https" ? null : "must be an https:// address";
    }

    private static string? Json(FieldDef f, JsonNode? v)
    {
        if (f.Check == "trustProxy")
            return v is JsonValue tv && (tv.TryGetValue<bool>(out _) || tv.TryGetValue<string>(out _) || tv.TryGetValue<long>(out var l) && l >= 0) ? null : "must be true, false, a whole number (hops) or a subnet text";
        if (v is not JsonArray arr) return "must be a JSON array like []";
        if (f.Check == "iceServers")
        {
            for (int i = 0; i < arr.Count; i++)
            {
                var urls = (arr[i] as JsonObject)?["urls"];
                bool ok = urls is JsonValue uv && uv.TryGetValue<string>(out var us) && us != ""
                    || urls is JsonArray ua && ua.Count > 0 && ua.All(x => x is JsonValue xv && xv.TryGetValue<string>(out var xs) && xs != "");
                if (!ok) return $"entry {i + 1} needs an object with \"urls\", e.g. {{\"urls\":\"stun:stun.l.google.com:19302\"}}";
            }
        }
        if (f.Check == "lanNetworks")
        {
            if (arr.Count > 32) return "at most 32 entries";
            for (int i = 0; i < arr.Count; i++)
            {
                var m = arr[i] is JsonValue sv && sv.TryGetValue<string>(out var s) ? Cidr.Match(s.Trim()) : null;
                if (m == null || !m.Success || Enumerable.Range(1, 4).Any(g => int.Parse(m.Groups[g].Value) > 255) || int.Parse(m.Groups[5].Value) > 32)
                    return $"entry {i + 1} must be an IPv4 CIDR like \"192.168.3.0/24\"";
            }
        }
        if (f.Check == "origins")
        {
            for (int i = 0; i < arr.Count; i++)
                if (arr[i] is not JsonValue ov || !ov.TryGetValue<string>(out var os) || !Uri.TryCreate(os, UriKind.Absolute, out _))
                    return $"entry {i + 1} must be an origin like \"https://chat.example.com\"";
        }
        return null;
    }

    public static List<string> Cross(JsonStore s)
    {
        var errs = new List<string>();
        long L(string k) => s.Get(k) is JsonValue v && v.TryGetValue<long>(out var l) ? l : 0;
        bool B(string k) => s.Get(k) is JsonValue v && v.TryGetValue<bool>(out var b) && b;
        string T(string k) => s.Get(k)?.ToString() ?? "";
        if (B("useHttps") && L("port") == L("httpsPort")) errs.Add("port and httpsPort must differ (the HTTP port redirects to HTTPS).");
        if ((T("serverCrt") == "") != (T("serverKey") == "")) errs.Add("serverCrt and serverKey must be set together (or both empty for the automatic self-signed certificate).");
        if (L("turn.relayPortMin") > L("turn.relayPortMax")) errs.Add("turn.relayPortMin must not be above turn.relayPortMax.");
        if (B("turn.enabled") && B("ssh.enabled") && L("turn.port") == L("ssh.port")) errs.Add("turn.port and ssh.port must differ.");
        if (B("turn.autoIp") && T("turn.autoIpSource") == "stun" && T("turn.autoIpStun") == "") errs.Add("turn.autoIpStun is required when the dynamic IP source is stun.");
        if (B("turn.autoIp") && T("turn.autoIpSource") == "http" && T("turn.autoIpUrl") == "") errs.Add("turn.autoIpUrl is required when the dynamic IP source is http.");
        return errs;
    }
}

public sealed class LauncherSettings
{
    private readonly JsonStore _store = new(Paths.LauncherSettings);
    public JsonStore Store => _store;
    public event Action? Changed;

    public LauncherSettings() { _store.Load(); }

    public void Load() { _store.Load(); Changed?.Invoke(); }
    public void Save() { _store.Save(); Changed?.Invoke(); }

    private JsonNode? Raw(string key) => _store.Get(key) ?? Fields.Launcher.First(f => f.Key == key).Default;
    public bool Bool(string key) => Raw(key) is JsonValue v && v.TryGetValue<bool>(out var b) && b;
    public int Int(string key) => Raw(key) is JsonValue v && v.TryGetValue<long>(out var l) ? (int)l : 0;
    public string Str(string key) => Raw(key)?.ToString() ?? "";
}
