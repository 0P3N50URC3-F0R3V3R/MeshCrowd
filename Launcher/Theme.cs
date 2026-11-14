using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace MeshCrowd.Launcher;

public static class Theme
{
    public static readonly Color Bg0 = Color.FromArgb(0x1E, 0x1F, 0x22);
    public static readonly Color Bg1 = Color.FromArgb(0x2B, 0x2D, 0x31);
    public static readonly Color Bg2 = Color.FromArgb(0x31, 0x33, 0x38);
    public static readonly Color Bg3 = Color.FromArgb(0x38, 0x3A, 0x40);
    public static readonly Color Bg4 = Color.FromArgb(0x40, 0x43, 0x4A);
    public static readonly Color Divider = Color.FromArgb(0x3F, 0x41, 0x47);
    public static readonly Color Text = Color.FromArgb(0xDB, 0xDE, 0xE1);
    public static readonly Color TextBright = Color.FromArgb(0xF2, 0xF3, 0xF5);
    public static readonly Color Muted = Color.FromArgb(0x94, 0x9B, 0xA4);
    public static readonly Color Accent = Color.FromArgb(0x58, 0x65, 0xF2);
    public static readonly Color AccentHover = Color.FromArgb(0x47, 0x52, 0xC4);
    public static readonly Color Green = Color.FromArgb(0x23, 0xA5, 0x5A);
    public static readonly Color GreenHover = Color.FromArgb(0x1A, 0x80, 0x45);
    public static readonly Color Red = Color.FromArgb(0xDA, 0x37, 0x3C);
    public static readonly Color RedHover = Color.FromArgb(0xA1, 0x28, 0x2D);
    public static readonly Color Yellow = Color.FromArgb(0xF0, 0xB2, 0x32);
    public static readonly Color Link = Color.FromArgb(0x00, 0xA8, 0xFC);

    public static readonly Font Ui = new("Segoe UI", 9.5f);
    public static readonly Font UiSmall = new("Segoe UI", 8.5f);
    public static readonly Font UiBold = new("Segoe UI Semibold", 9.5f);
    public static readonly Font UiTitle = new("Segoe UI Semibold", 15f);
    public static readonly Font UiBig = new("Segoe UI Semibold", 20f);
    public static readonly Font Mono = new("Consolas", 10f);
    public static readonly Font MonoSmall = new("Consolas", 9f);
    public static readonly Font Icons = new("Segoe MDL2 Assets", 11f);
    public static readonly Font IconsSmall = new("Segoe MDL2 Assets", 9f);

    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)] private static extern int SetWindowTheme(IntPtr hwnd, string? app, string? idList);

    public static void DarkCaption(IntPtr hwnd)
    {
        int on = 1;
        if (DwmSetWindowAttribute(hwnd, 20, ref on, 4) != 0) DwmSetWindowAttribute(hwnd, 19, ref on, 4);
        int caption = 0x221F1E;
        DwmSetWindowAttribute(hwnd, 35, ref caption, 4);
        int text = 0xE1DEDB;
        DwmSetWindowAttribute(hwnd, 36, ref text, 4);
    }

    public static void DarkScroll(Control c)
    {
        void apply() { try { SetWindowTheme(c.Handle, "DarkMode_Explorer", null); } catch { } }
        if (c.IsHandleCreated) apply(); else c.HandleCreated += (_, _) => apply();
    }

    public static GraphicsPath Round(Rectangle r, int radius)
    {
        var p = new GraphicsPath();
        int d = Math.Max(1, radius * 2);
        d = Math.Min(d, Math.Min(r.Width, r.Height));
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    public static void Quality(Graphics g)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
    }

    public static Color Blend(Color a, Color b, float t) => Color.FromArgb(
        (int)(a.R + (b.R - a.R) * t), (int)(a.G + (b.G - a.G) * t), (int)(a.B + (b.B - a.B) * t));

    public const TextFormatFlags Flags = TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis;

    public static int Measure(string text, Font f, int width) =>
        TextRenderer.MeasureText(text, f, new Size(width, 0), TextFormatFlags.WordBreak | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix).Height;
}

public static class G
{
    public const string Play = "", Stop = "", Restart = "", Refresh = "", Settings = "", Home = "",
        Console = "", List = "", Doc = "", Folder = "", Shield = "", Tool = "",
        Help = "", Save = "", Undo = "", Search = "", Copy = "", Delete = "",
        Warning = "", Check = "", Cancel = "", Globe = "", Down = "", Eye = "",
        Link = "", Pause = "", Clear = "", Export = "", Import = "", Add = "",
        People = "", Database = "", Clock = "", Pulse = "", Send = "", Info = "",
        Flash = "", Key = "", Page = "", Power = "", Heart = "", Chart = "", Lock = "";
}
