using System.Text.Json;
using System.Text.Json.Nodes;

namespace MeshCrowd.Client;

// Same file name and keys as electron/main.js (dismesh-client-config.json) so a config can be copied
// between the two clients. Unknown keys are kept as they are.
public sealed class AppConfig
{
    private static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true };

    private readonly string _path;
    public JsonObject Data { get; private set; }

    public AppConfig(string dataDir)
    {
        _path = Path.Combine(dataDir, "dismesh-client-config.json");
        Data = Load();
    }

    private JsonObject Load()
    {
        try { if (JsonNode.Parse(File.ReadAllText(_path)) is JsonObject o) return o; } catch { }
        return new JsonObject
        {
            ["serverUrl"] = null,
            ["trustedFingerprints"] = new JsonObject(),
            ["closeToTray"] = false,
            ["startMinimized"] = false,
            ["startWithWindows"] = false,
            ["trayIconColor"] = null,
            ["trayBadgeColors"] = new JsonObject(),
            ["windowBounds"] = null,
            ["handleInviteLinks"] = true,
        };
    }

    public void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        File.WriteAllText(_path, Data.ToJsonString(Pretty));
    }

    public string? GetString(string key) => Data[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    public bool GetBool(string key, bool fallback) => Data[key] is JsonValue v && v.TryGetValue<bool>(out var b) ? b : fallback;

    public int? GetInt(string key)
    {
        if (Data[key] is not JsonValue v) return null;
        if (v.TryGetValue<int>(out var i)) return i;
        return v.TryGetValue<double>(out var d) && d == Math.Floor(d) ? (int)d : null;
    }

    public void Set(string key, JsonNode? value) => Data[key] = value;

    public JsonObject Trusted
    {
        get
        {
            if (Data["trustedFingerprints"] is not JsonObject o) Data["trustedFingerprints"] = o = new JsonObject();
            return o;
        }
    }

    public string? ServerUrl
    {
        get => GetString("serverUrl");
        set => Data["serverUrl"] = value;
    }
}
