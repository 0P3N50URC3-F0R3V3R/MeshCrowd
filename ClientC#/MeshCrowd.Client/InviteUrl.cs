using System.Text.RegularExpressions;

namespace MeshCrowd.Client;

public sealed record McrLink(string Host, string Code);

public sealed record InviteTarget(string Origin, bool SameServer, string Url);

// Port of electron/inviteUrl.js. mcr:// links come from web pages and other apps: untrusted input.
public static partial class InviteUrl
{
    [GeneratedRegex(@"^[A-Za-z0-9_.@-]{1,128}$")]
    private static partial Regex CodeRe();

    [GeneratedRegex(@"^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])$")]
    private static partial Regex HostRe();

    public static McrLink? Parse(string? arg)
    {
        if (arg is null || arg.Length > 300 || !arg.StartsWith("mcr://", StringComparison.OrdinalIgnoreCase)) return null;
        if (!Uri.TryCreate(arg, UriKind.Absolute, out var u)) return null;
        if (u.UserInfo.Length > 0 || u.Query.Length > 0 || u.Fragment.Length > 0) return null;
        string hostname = u.Host.ToLowerInvariant();
        if (!HostRe().IsMatch(hostname)) return null;
        bool hasPort = !u.IsDefaultPort && u.Port != -1;
        if (hasPort && (u.Port < 1 || u.Port > 65535)) return null;
        string code;
        try { code = Uri.UnescapeDataString(u.AbsolutePath.TrimStart('/').TrimEnd('/')); } catch { return null; }
        if (!CodeRe().IsMatch(code)) return null;
        return new McrLink(hasPort ? $"{hostname}:{u.Port}" : hostname, code);
    }

    public static McrLink? Find(IEnumerable<string>? argv)
    {
        foreach (var a in argv ?? []) { var link = Parse(a); if (link is not null) return link; }
        return null;
    }

    public static InviteTarget Target(McrLink link, string? serverUrl)
    {
        string origin = $"https://{link.Host}";
        bool same = false;
        if (serverUrl is not null && Uri.TryCreate(serverUrl, UriKind.Absolute, out var cur))
        {
            string curHost = cur.IsDefaultPort ? cur.Host : $"{cur.Host}:{cur.Port}";
            if (curHost.Equals(link.Host, StringComparison.OrdinalIgnoreCase))
            {
                origin = cur.GetLeftPart(UriPartial.Authority);
                same = true;
            }
        }
        return new InviteTarget(origin, same, $"{origin}/#invite={Uri.EscapeDataString(link.Code)}");
    }
}
