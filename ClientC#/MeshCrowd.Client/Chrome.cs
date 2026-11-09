using System.Runtime.InteropServices;

namespace MeshCrowd.Client;

public enum CaptionKind { Minimize, Maximize, Close }

// Minimize / maximize / close drawn in the page's top bar row, like Electron's titleBarOverlay.
public sealed class CaptionButton : Control
{
    private static readonly Color Bar = Color.FromArgb(0x1e, 0x1f, 0x22);
    private static readonly Color Fg = Color.FromArgb(0xdb, 0xde, 0xe1);
    private static readonly Color Hot = Color.FromArgb(0x3a, 0x3c, 0x41);
    private static readonly Color Down = Color.FromArgb(0x2c, 0x2e, 0x32);
    private static readonly Color CloseHot = Color.FromArgb(0xc4, 0x2b, 0x1c);
    private static readonly Color CloseDown = Color.FromArgb(0x9c, 0x22, 0x16);

    private bool _hot;
    private bool _down;
    private bool _restored;

    public CaptionKind Kind { get; }

    [System.ComponentModel.DesignerSerializationVisibility(System.ComponentModel.DesignerSerializationVisibility.Hidden)]
    public bool Restored
    {
        get => _restored;
        set { if (_restored != value) { _restored = value; Invalidate(); } }
    }

    public CaptionButton(CaptionKind kind)
    {
        Kind = kind;
        SetStyle(ControlStyles.Selectable, false);
        SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.ResizeRedraw, true);
        TabStop = false;
    }

    protected override void OnMouseEnter(EventArgs e) { _hot = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hot = false; _down = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { if (e.Button == MouseButtons.Left) { _down = true; Invalidate(); } base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { _down = false; Invalidate(); base.OnMouseUp(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        bool close = Kind == CaptionKind.Close;
        Color back = _down ? (close ? CloseDown : Down) : _hot ? (close ? CloseHot : Hot) : Bar;
        Color fore = close && (_hot || _down) ? Color.White : Fg;
        e.Graphics.Clear(back);
        string glyph = Kind switch
        {
            CaptionKind.Minimize => "",
            CaptionKind.Maximize => _restored ? "" : "",
            _ => "",
        };
        float px = 10f * DeviceDpi / 96f;
        using var font = new Font("Segoe MDL2 Assets", px, FontStyle.Regular, GraphicsUnit.Pixel);
        TextRenderer.DrawText(e.Graphics, glyph, font, ClientRectangle, fore,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
    }
}

internal static class Nc
{
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct NcCalcSizeParams { public Rect Rgrc0, Rgrc1, Rgrc2; public IntPtr Lppos; }

    [DllImport("user32.dll")] private static extern int GetSystemMetricsForDpi(int index, uint dpi);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

    public const int WmNcCalcSize = 0x0083;
    public const int WmNcHitTest = 0x0084;
    public const int HtClient = 1;
    public const int HtTop = 12;
    public const int HtTopLeft = 13;
    public const int HtTopRight = 14;

    // Height of the resize frame a maximized window overhangs the work area by.
    public static int FrameTop(uint dpi) => GetSystemMetricsForDpi(33, dpi) + GetSystemMetricsForDpi(92, dpi);

    public static void FrameChanged(IntPtr hwnd) =>
        SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, 0x0020 | 0x0002 | 0x0001 | 0x0004 | 0x0010); // FRAMECHANGED|NOMOVE|NOSIZE|NOZORDER|NOACTIVATE
}
