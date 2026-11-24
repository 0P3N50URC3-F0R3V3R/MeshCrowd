using System.Text.Json.Nodes;

namespace MeshCrowd.Client;

// Port of electron/knownServers.js: the servers this client has connected to, most recent first.
public static class KnownServers
{
    public const int Max = 50;
    private const int MaxName = 60;
    private const int MaxIconUri = 24000;

    public static string? NormalizeOrigin(string? raw)
    {
        if (raw is null || !Uri.TryCreate(raw.Trim(), UriKind.Absolute, out var u)) return null;
        if (u.Scheme is not ("http" or "https") || u.UserInfo.Length > 0) return null;
        return $"{u.Scheme}://{u.Authority}".ToLowerInvariant();
    }

    private static string? SignInOf(JsonNode? e) => e is JsonObject o && o["signIn"] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static string? UrlOf(JsonNode? e) => e is JsonObject o && o["url"] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    public static JsonArray Upsert(JsonArray? list, string? url, string? name, string? icon, long now)
    {
        list ??= new JsonArray();
        string? origin = NormalizeOrigin(url);
        if (origin is null) return list;
        JsonNode? prev = list.FirstOrDefault(e => UrlOf(e) == origin);
        string cleanName = string.Join(' ', (name ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (cleanName.Length > MaxName) cleanName = cleanName[..MaxName];
        if (cleanName.Length == 0) cleanName = new Uri(origin).Authority;
        string cleanIcon = icon is not null && icon.StartsWith("data:image/png;base64,", StringComparison.Ordinal) && icon.Length <= MaxIconUri ? icon : "";
        var entry = new JsonObject { ["url"] = origin, ["name"] = cleanName, ["icon"] = cleanIcon, ["lastUsed"] = now, ["signIn"] = prev is null ? null : SignInOf(prev) };
        var result = new JsonArray { entry };
        foreach (var e in list)
        {
            if (result.Count >= Max) break;
            if (UrlOf(e) != origin && e is not null) result.Add(e.DeepClone());
        }
        return result;
    }

    public static string? SwitchTarget(string? raw, JsonArray? list)
    {
        string? origin = NormalizeOrigin(raw);
        if (origin is null) return null;
        if (origin.StartsWith("https:", StringComparison.Ordinal)) return origin;
        foreach (var e in list ?? new JsonArray()) if (UrlOf(e) == origin) return origin;
        return null;
    }

    public static JsonObject? Find(JsonArray? list, string? url)
    {
        string? origin = NormalizeOrigin(url);
        foreach (var e in list ?? new JsonArray()) if (e is JsonObject o && UrlOf(e) == origin) return o;
        return null;
    }

    public static IEnumerable<string> SessionOrigins(JsonArray? list)
    {
        foreach (var e in list ?? new JsonArray()) if (SignInOf(e) == "session" && UrlOf(e) is { } u) yield return u;
    }

    public static string? ModeOf(JsonNode? entry) => SignInOf(entry);

    public static JsonArray Remove(JsonArray? list, string? url)
    {
        string? origin = NormalizeOrigin(url);
        var result = new JsonArray();
        foreach (var e in list ?? new JsonArray()) if (e is not null && UrlOf(e) != origin) result.Add(e.DeepClone());
        return result;
    }

    public static bool SetSignIn(JsonArray? list, string? url, string? mode)
    {
        if (mode is not (null or "keep" or "session")) return false;
        string? origin = NormalizeOrigin(url);
        foreach (var e in list ?? new JsonArray())
        {
            if (e is JsonObject o && UrlOf(e) == origin) { o["signIn"] = mode; return true; }
        }
        return false;
    }
}
