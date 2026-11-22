using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace MeshCrowd.Client;

public sealed record TrayBadge(string Status, int Count);

public sealed record TrayTheme(string? BaseColor, IReadOnlyDictionary<string, string?> BadgeColors, string? NumberColor = null);

// Port of electron/trayIcon.js: the same hand-drawn pixel icon (brand circle, ghost, unread badge,
// blink frames), so both clients look identical in the tray.
public static class TrayIconRenderer
{
    public const int IconSize = 48;

    private static readonly int[] Brand = [0x0d, 0x94, 0x88];
    private static readonly Dictionary<string, int[]> StatusColors = new()
    {
        ["online"] = [0x23, 0xa5, 0x5a],
        ["idle"] = [0xf0, 0xb2, 0x32],
        ["dnd"] = [0xf2, 0x3f, 0x43],
        ["invisible"] = [0x80, 0x84, 0x8e],
        ["offline"] = [0x80, 0x84, 0x8e],
    };

    private static readonly Dictionary<char, string[]> DigitFont = new()
    {
        ['0'] = ["111", "101", "101", "101", "111"],
        ['1'] = ["010", "110", "010", "010", "111"],
        ['2'] = ["111", "001", "111", "100", "111"],
        ['3'] = ["111", "001", "111", "001", "111"],
        ['4'] = ["101", "101", "111", "001", "001"],
        ['5'] = ["111", "100", "111", "001", "111"],
        ['6'] = ["111", "100", "111", "101", "111"],
        ['7'] = ["111", "001", "010", "010", "010"],
        ['8'] = ["111", "101", "111", "101", "111"],
        ['9'] = ["111", "101", "111", "001", "111"],
        ['+'] = ["000", "010", "111", "010", "000"],
    };

    private const int GlyphScale = 2;
    private const int GlyphGap = 1;
    private const int BadgePillH = 28;
    private const int BadgePadX = 4;
    private const int BadgeRing = 2;

    private static byte[] NewCanvas() => new byte[IconSize * IconSize * 4];

    private static void SetPx(byte[] buf, int x, int y, int r, int g, int b, int a)
    {
        if (x < 0 || y < 0 || x >= IconSize || y >= IconSize) return;
        int p = (y * IconSize + x) * 4;
        double srcA = a / 255.0;
        buf[p] = (byte)Math.Round(r * srcA + buf[p] * (1 - srcA));
        buf[p + 1] = (byte)Math.Round(g * srcA + buf[p + 1] * (1 - srcA));
        buf[p + 2] = (byte)Math.Round(b * srcA + buf[p + 2] * (1 - srcA));
        buf[p + 3] = (byte)Math.Round(a + buf[p + 3] * (1 - srcA));
    }

    private static void FillCircle(byte[] buf, double cx, double cy, double radius, int[] c)
    {
        for (int y = (int)Math.Floor(cy - radius) - 1; y <= (int)Math.Ceiling(cy + radius) + 1; y++)
        for (int x = (int)Math.Floor(cx - radius) - 1; x <= (int)Math.Ceiling(cx + radius) + 1; x++)
        {
            double dx = x + 0.5 - cx, dy = y + 0.5 - cy;
            if (dx * dx + dy * dy <= radius * radius) SetPx(buf, x, y, c[0], c[1], c[2], 255);
        }
    }

    private static void FillRoundedRect(byte[] buf, double x0, double y0, double w, double h, double radius, int[] c)
    {
        for (int y = (int)Math.Floor(y0) - 1; y <= (int)Math.Ceiling(y0 + h) + 1; y++)
        for (int x = (int)Math.Floor(x0) - 1; x <= (int)Math.Ceiling(x0 + w) + 1; x++)
        {
            double cx = Math.Min(Math.Max(x + 0.5, x0 + radius), x0 + w - radius);
            double cy = Math.Min(Math.Max(y + 0.5, y0 + radius), y0 + h - radius);
            double dx = x + 0.5 - cx, dy = y + 0.5 - cy;
            if (dx * dx + dy * dy <= radius * radius) SetPx(buf, x, y, c[0], c[1], c[2], 255);
        }
    }

    private static int TextWidth(string text, int scale) => text.Length * 3 * scale + (text.Length - 1) * GlyphGap;

    private static void DrawText(byte[] buf, string text, double left, double top, int[] c, int scale)
    {
        double x = left;
        foreach (char ch in text)
        {
            if (DigitFont.TryGetValue(ch, out var glyph))
            {
                for (int gy = 0; gy < 5; gy++)
                for (int gx = 0; gx < 3; gx++)
                {
                    if (glyph[gy][gx] != '1') continue;
                    for (int sy = 0; sy < scale; sy++)
                    for (int sx = 0; sx < scale; sx++)
                        SetPx(buf, (int)(x + gx * scale + sx), (int)(top + gy * scale + sy), c[0], c[1], c[2], 255);
                }
            }
            x += 3 * scale + GlyphGap;
        }
    }

    private static bool InsideGhost(double u, double v)
    {
        if (v >= 4 && v < 8) { double dx = (u - 12) / 6, dy = (v - 8) / 4; return dx * dx + dy * dy <= 1; }
        if (v >= 8 && v <= 14.5) return u >= 6 && u <= 18;
        if (v > 14.5 && v <= 20) { double dx = (u - 12) / 6, dy = (v - 14.5) / 5.5; return dx * dx + dy * dy <= 1; }
        return false;
    }

    private static bool InsideEye(double u, double v) =>
        (u - 9.5) * (u - 9.5) + (v - 12) * (v - 12) <= 1.3 * 1.3 || (u - 14.5) * (u - 14.5) + (v - 12) * (v - 12) <= 1.3 * 1.3;

    private static void DrawGhost(byte[] buf, int[] baseColor)
    {
        double luminance = (0.2126 * baseColor[0] + 0.7152 * baseColor[1] + 0.0722 * baseColor[2]) / 255;
        int[] ghostColor = luminance > 0.72 ? [0x1e, 0x1f, 0x22] : [255, 255, 255];
        double scale = IconSize * 0.58 / 16;
        double ox = IconSize / 2.0 - 12 * scale, oy = IconSize / 2.0 - 12 * scale;
        const int ss = 4;
        for (int y = 0; y < IconSize; y++)
        for (int x = 0; x < IconSize; x++)
        {
            int ghost = 0, eyes = 0;
            for (int sy = 0; sy < ss; sy++)
            for (int sx = 0; sx < ss; sx++)
            {
                double u = (x + (sx + 0.5) / ss - ox) / scale;
                double v = (y + (sy + 0.5) / ss - oy) / scale;
                if (InsideGhost(u, v)) { ghost++; if (InsideEye(u, v)) eyes++; }
            }
            if (ghost - eyes > 0) SetPx(buf, x, y, ghostColor[0], ghostColor[1], ghostColor[2], (int)Math.Round(255.0 * (ghost - eyes) / (ss * ss)));
        }
    }

    private static int[] HexToRgb(string? hex, int[] fallback)
    {
        if (hex is null || hex.Length != 7 || hex[0] != '#' || !int.TryParse(hex.AsSpan(1), System.Globalization.NumberStyles.HexNumber, null, out int n)) return fallback;
        return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    }

    private static int[] StatusColor(string status) => StatusColors.TryGetValue(status, out var c) ? c : StatusColors["online"];

    private static int[] BadgeColor(TrayBadge badge, TrayTheme theme) =>
        HexToRgb(theme.BadgeColors.TryGetValue(badge.Status, out var hex) ? hex : null, StatusColor(badge.Status));

    private static int[] NumberColor(TrayTheme theme) => HexToRgb(theme.NumberColor, [255, 255, 255]);

    private static byte[] NormalCanvas(TrayTheme theme)
    {
        var baseColor = HexToRgb(theme.BaseColor, Brand);
        var buf = NewCanvas();
        FillCircle(buf, IconSize / 2.0, IconSize / 2.0, IconSize / 2.0 - 1, baseColor);
        DrawGhost(buf, baseColor);
        return buf;
    }

    private static byte[] BadgedCanvas(TrayBadge badge, TrayTheme theme)
    {
        var buf = NormalCanvas(theme);
        string label = badge.Count > 99 ? "99+" : badge.Count.ToString();
        int glyphScale = label.Length == 1 ? 4 : label.Length == 2 ? 3 : 2;
        int pillH = BadgePillH;
        int pillW = Math.Max(pillH, TextWidth(label, glyphScale) + BadgePadX * 2);
        int pillX = IconSize - pillW - BadgeRing - 1;
        int pillY = IconSize - pillH - BadgeRing - 1;
        double textX = pillX + (pillW - TextWidth(label, glyphScale)) / 2.0;
        double textY = pillY + (pillH - 5 * glyphScale) / 2.0;
        FillRoundedRect(buf, pillX - BadgeRing, pillY - BadgeRing, pillW + BadgeRing * 2, pillH + BadgeRing * 2, pillH / 2.0 + BadgeRing, [255, 255, 255]);
        FillRoundedRect(buf, pillX, pillY, pillW, pillH, pillH / 2.0, BadgeColor(badge, theme));
        DrawText(buf, label, textX, textY, NumberColor(theme), glyphScale);
        return buf;
    }

    private static byte[] AlertCanvas(TrayBadge badge, TrayTheme theme)
    {
        var buf = NewCanvas();
        FillCircle(buf, IconSize / 2.0, IconSize / 2.0, IconSize / 2.0 - 1, [255, 255, 255]);
        FillCircle(buf, IconSize / 2.0, IconSize / 2.0, IconSize / 2.0 - 3, BadgeColor(badge, theme));
        string label = badge.Count > 9 ? "9+" : badge.Count.ToString();
        int scale = label.Length == 1 ? 8 : 6;
        double x = Math.Round((IconSize - TextWidth(label, scale)) / 2.0);
        double y = Math.Round((IconSize - 5 * scale) / 2.0);
        int o = scale >= 6 ? 2 : 1;
        var num = NumberColor(theme);
        int[] outline = (0.299 * num[0] + 0.587 * num[1] + 0.114 * num[2]) / 255 > 0.5 ? [0x1e, 0x1f, 0x22] : [255, 255, 255];
        (int, int)[] offsets = [(-o, 0), (o, 0), (0, -o), (0, o), (-o, -o), (o, o), (-o, o), (o, -o)];
        foreach (var (dx, dy) in offsets) DrawText(buf, label, x + dx, y + dy, outline, scale);
        DrawText(buf, label, x, y, num, scale);
        return buf;
    }

    private static byte[] Blend(byte[] a, byte[] b, double f)
    {
        var o = new byte[a.Length];
        for (int i = 0; i < a.Length; i++) o[i] = (byte)Math.Round(a[i] * (1 - f) + b[i] * f);
        return o;
    }

    private static readonly int[] ErrorRed = [0xed, 0x42, 0x45];

    // Red "forbidden" sign (ring + diagonal bar) shown while the server connection is lost.
    private static byte[] ForbiddenCanvas()
    {
        var buf = NewCanvas();
        double c = IconSize / 2.0;
        FillCircle(buf, c, c, c - 1, ErrorRed);
        FillCircle(buf, c, c, c - 8, [255, 255, 255]);
        for (int y = 0; y < IconSize; y++)
        for (int x = 0; x < IconSize; x++)
        {
            double dx = x + 0.5 - c, dy = y + 0.5 - c;
            if (dx * dx + dy * dy <= (c - 1) * (c - 1) && Math.Abs(dx - dy) / Math.Sqrt(2) <= 4) SetPx(buf, x, y, ErrorRed[0], ErrorRed[1], ErrorRed[2], 255);
        }
        return buf;
    }

    public static byte[] BuildForbidden() => ForbiddenCanvas();

    public static List<byte[]> BuildErrorFrames(TrayTheme theme, int steps)
    {
        var normal = NormalCanvas(theme);
        var err = ForbiddenCanvas();
        var frames = new List<byte[]>();
        for (int i = 0; i <= steps; i++) frames.Add(Blend(normal, err, (double)i / steps));
        return frames;
    }

    public static byte[] BuildPlain(TrayTheme theme) => NormalCanvas(theme);

    public static byte[] BuildBadged(TrayBadge badge, TrayTheme theme) =>
        badge.Count > 0 ? BadgedCanvas(badge, theme) : NormalCanvas(theme);

    public static List<byte[]> BuildBlinkFrames(TrayBadge badge, TrayTheme theme, int steps)
    {
        var normal = NormalCanvas(theme);
        var alert = AlertCanvas(badge, theme);
        var frames = new List<byte[]>();
        for (int i = 0; i <= steps; i++) frames.Add(Blend(normal, alert, (double)i / steps));
        return frames;
    }

    // Straight-alpha RGBA pixels -> a tray-sized Icon. The caller owns the handle (see TrayIconHandle).
    public static TrayIconHandle ToIcon(byte[] rgba)
    {
        using var full = new Bitmap(IconSize, IconSize, PixelFormat.Format32bppArgb);
        var data = full.LockBits(new Rectangle(0, 0, IconSize, IconSize), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        var bgra = new byte[rgba.Length];
        for (int i = 0; i < rgba.Length; i += 4)
        {
            bgra[i] = rgba[i + 2]; bgra[i + 1] = rgba[i + 1]; bgra[i + 2] = rgba[i]; bgra[i + 3] = rgba[i + 3];
        }
        Marshal.Copy(bgra, 0, data.Scan0, bgra.Length);
        full.UnlockBits(data);

        var size = SystemInformation.SmallIconSize;
        using var scaled = new Bitmap(size.Width, size.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(scaled))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.CompositingMode = CompositingMode.SourceCopy;
            g.DrawImage(full, new Rectangle(0, 0, size.Width, size.Height));
        }
        IntPtr hIcon = scaled.GetHicon();
        return new TrayIconHandle(hIcon);
    }

    public static byte[] ToPng(byte[] rgba)
    {
        using var bmp = new Bitmap(IconSize, IconSize, PixelFormat.Format32bppArgb);
        var data = bmp.LockBits(new Rectangle(0, 0, IconSize, IconSize), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        var bgra = new byte[rgba.Length];
        for (int i = 0; i < rgba.Length; i += 4)
        {
            bgra[i] = rgba[i + 2]; bgra[i + 1] = rgba[i + 1]; bgra[i + 2] = rgba[i]; bgra[i + 3] = rgba[i + 3];
        }
        Marshal.Copy(bgra, 0, data.Scan0, bgra.Length);
        bmp.UnlockBits(data);
        using var ms = new MemoryStream();
        bmp.Save(ms, ImageFormat.Png);
        return ms.ToArray();
    }
}

public sealed class TrayIconHandle : IDisposable
{
    [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr hIcon);

    private IntPtr _handle;
    public Icon Icon { get; }

    public TrayIconHandle(IntPtr handle)
    {
        _handle = handle;
        Icon = Icon.FromHandle(handle);
    }

    public void Dispose()
    {
        if (_handle == IntPtr.Zero) return;
        DestroyIcon(_handle);
        _handle = IntPtr.Zero;
    }
}
