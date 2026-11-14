using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace MeshCrowd.Launcher;

public enum BtnKind { Primary, Secondary, Success, Danger, Ghost }

public sealed class DButton : Control
{
    private bool _hover, _down;
    public BtnKind Kind { get; set; } = BtnKind.Primary;
    private string _glyph = "";
    public string Glyph { get => _glyph; set { _glyph = value; if (AutoSize) Size = GetPreferredSize(Size.Empty); Invalidate(); } }

    public DButton()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.Selectable | ControlStyles.StandardClick, true);
        Cursor = Cursors.Hand;
        Font = Theme.UiBold;
        Height = 32;
        AutoSize = true;
        TabStop = true;
    }

    public DButton(string text, BtnKind kind = BtnKind.Secondary, string glyph = "") : this()
    {
        Text = text; Kind = kind; Glyph = glyph;
        Size = GetPreferredSize(Size.Empty);
    }

    public override Size GetPreferredSize(Size proposed)
    {
        int w = 24;
        if (Glyph != "") w += 22;
        if (Text != "") w += TextRenderer.MeasureText(Text, Font, new Size(2000, 40), Theme.Flags).Width;
        return new Size(Math.Max(w, 34), 32);
    }

    protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = false; _down = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { _down = true; Focus(); Invalidate(); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { _down = false; Invalidate(); base.OnMouseUp(e); }
    protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
    protected override void OnTextChanged(EventArgs e) { base.OnTextChanged(e); if (AutoSize) Size = GetPreferredSize(Size.Empty); Invalidate(); }
    protected override bool IsInputKey(Keys keyData) => keyData == Keys.Enter || base.IsInputKey(keyData);
    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode is Keys.Space or Keys.Enter) { OnClick(EventArgs.Empty); e.Handled = true; }
        base.OnKeyDown(e);
    }
    protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
    protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        Theme.Quality(g);
        g.Clear(Parent?.BackColor ?? Theme.Bg2);
        Color bg, fg = Theme.TextBright;
        switch (Kind)
        {
            case BtnKind.Primary: bg = _down || _hover ? Theme.AccentHover : Theme.Accent; break;
            case BtnKind.Success: bg = _down || _hover ? Theme.GreenHover : Theme.Green; break;
            case BtnKind.Danger: bg = _down || _hover ? Theme.RedHover : Theme.Red; break;
            case BtnKind.Ghost: bg = _hover ? Theme.Bg3 : Color.Transparent; fg = Theme.Text; break;
            default: bg = _down ? Theme.Bg4 : _hover ? Theme.Bg4 : Theme.Bg3; break;
        }
        if (!Enabled) { bg = Kind == BtnKind.Ghost ? Color.Transparent : Theme.Bg3; fg = Theme.Muted; }
        var r = new Rectangle(0, 0, Width - 1, Height - 1);
        if (bg != Color.Transparent)
        {
            using var path = Theme.Round(r, 4);
            using var br = new SolidBrush(bg);
            g.FillPath(br, path);
        }
        if (Focused && ShowFocusCues)
        {
            using var path = Theme.Round(Rectangle.Inflate(r, -1, -1), 4);
            using var pen = new Pen(Theme.Link, 1.5f);
            g.DrawPath(pen, path);
        }
        int textW = Text == "" ? 0 : TextRenderer.MeasureText(Text, Font, new Size(2000, 40), Theme.Flags).Width;
        int gw = Glyph != "" ? 18 : 0;
        int total = textW + gw + (textW > 0 && gw > 0 ? 4 : 0);
        int x = Math.Max(8, (Width - total) / 2);
        if (Glyph != "")
        {
            TextRenderer.DrawText(g, Glyph, Theme.IconsSmall, new Rectangle(x, 0, gw, Height), fg, TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.HorizontalCenter);
            x += gw + 4;
        }
        if (Text != "")
            TextRenderer.DrawText(g, Text, Font, new Rectangle(x, 0, Math.Max(10, Width - x - 6), Height), fg, TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
    }
}

public sealed class DToggle : Control
{
    private bool _checked, _hover;
    public event EventHandler? CheckedChanged;
    public bool Checked
    {
        get => _checked;
        set { if (_checked == value) return; _checked = value; Invalidate(); CheckedChanged?.Invoke(this, EventArgs.Empty); }
    }

    public DToggle()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.Selectable, true);
        Size = new Size(44, 24);
        Cursor = Cursors.Hand;
        TabStop = true;
    }

    protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnClick(EventArgs e) { if (Enabled) Checked = !Checked; base.OnClick(e); }
    protected override bool IsInputKey(Keys k) => k == Keys.Space || base.IsInputKey(k);
    protected override void OnKeyDown(KeyEventArgs e) { if (e.KeyCode == Keys.Space) { Checked = !Checked; e.Handled = true; } base.OnKeyDown(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        Theme.Quality(g);
        g.Clear(Parent?.BackColor ?? Theme.Bg2);
        var track = new Rectangle(0, 2, Width - 1, Height - 5);
        Color c = _checked ? Theme.Green : Theme.Muted;
        if (_hover) c = Theme.Blend(c, Color.White, 0.08f);
        if (!Enabled) c = Theme.Bg4;
        using (var path = Theme.Round(track, track.Height / 2)) using (var br = new SolidBrush(c)) g.FillPath(br, path);
        int d = track.Height - 4;
        int x = _checked ? track.Right - d - 3 : track.X + 3;
        using var knob = new SolidBrush(Color.White);
        g.FillEllipse(knob, x, track.Y + 2, d, d);
        if (_checked)
            TextRenderer.DrawText(g, G.Check, Theme.IconsSmall, new Rectangle(track.X + 5, track.Y, 14, track.Height), Color.White, TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
        if (Focused && ShowFocusCues)
        {
            using var pen = new Pen(Theme.Link, 1.5f);
            using var path = Theme.Round(track, track.Height / 2);
            g.DrawPath(pen, path);
        }
    }
}

public sealed class DInput : Control
{
    private readonly TextBox _tb = new() { BorderStyle = BorderStyle.None, BackColor = Theme.Bg0, ForeColor = Theme.Text, Font = Theme.Ui };
    private bool _focus, _invalid, _secret, _reveal;
    private Rectangle _eye;
    public event EventHandler? EnterPressed;
    public Func<string, string?>? Validator;
    public string? Error { get; private set; }

    public DInput()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.ContainerControl, true);
        Controls.Add(_tb);
        Height = 32;
        _tb.GotFocus += (_, _) => { _focus = true; Invalidate(); };
        _tb.LostFocus += (_, _) => { _focus = false; Invalidate(); };
        _tb.TextChanged += (_, _) => { Revalidate(); OnTextChanged(EventArgs.Empty); };
        _tb.KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Enter && !_tb.Multiline) { e.SuppressKeyPress = true; EnterPressed?.Invoke(this, EventArgs.Empty); }
            else if (e.Control && e.KeyCode == Keys.A) { _tb.SelectAll(); e.SuppressKeyPress = true; }
            OnKeyDown(e);
        };
        _tb.KeyPress += (_, e) => OnKeyPress(e);
        Theme.DarkScroll(_tb);
    }

    public override string Text { get => _tb.Text; set { _tb.Text = value; } }
    public TextBox Inner => _tb;
    public bool ReadOnly { get => _tb.ReadOnly; set => _tb.ReadOnly = value; }
    public bool Multiline
    {
        get => _tb.Multiline;
        set { _tb.Multiline = value; _tb.AcceptsReturn = value; _tb.ScrollBars = value ? ScrollBars.Vertical : ScrollBars.None; _tb.WordWrap = !value || WrapLines; PerformLayout(); }
    }
    public bool WrapLines { get; set; } = true;
    public bool MonoFont { get => _tb.Font == Theme.Mono; set { _tb.Font = value ? Theme.Mono : Theme.Ui; PerformLayout(); } }
    public string Placeholder
    {
        get => _placeholder;
        set { _placeholder = value; SendMessage(_tb.Handle, 0x1501, 1, value); }
    }
    private string _placeholder = "";
    public bool Secret { get => _secret; set { _secret = value; _tb.UseSystemPasswordChar = value && !_reveal; PerformLayout(); Invalidate(); } }
    public bool Invalid { get => _invalid; set { _invalid = value; Invalidate(); } }
    public int MaxLength { get => _tb.MaxLength; set => _tb.MaxLength = value; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessage(IntPtr h, int msg, int w, string l);

    public void Revalidate()
    {
        Error = Validator?.Invoke(_tb.Text);
        Invalid = Error != null;
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        if (_placeholder != "") SendMessage(_tb.Handle, 0x1501, 1, _placeholder);
    }

    protected override void OnLayout(LayoutEventArgs e)
    {
        base.OnLayout(e);
        int right = _secret ? 30 : 0;
        if (_tb.Multiline) _tb.SetBounds(8, 6, Math.Max(10, Width - 16 - right), Math.Max(10, Height - 12));
        else
        {
            int th = _tb.PreferredHeight;
            _tb.SetBounds(8, Math.Max(0, (Height - th) / 2), Math.Max(10, Width - 16 - right), th);
        }
        _eye = new Rectangle(Width - 30, 0, 28, Height);
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (_secret && _eye.Contains(e.Location)) { _reveal = !_reveal; _tb.UseSystemPasswordChar = !_reveal; Invalidate(); }
        else _tb.Focus();
        base.OnMouseDown(e);
    }

    protected override void OnGotFocus(EventArgs e) { _tb.Focus(); base.OnGotFocus(e); }
    protected override void OnEnabledChanged(EventArgs e) { _tb.Enabled = Enabled; _tb.BackColor = Enabled ? Theme.Bg0 : Theme.Bg1; Invalidate(); base.OnEnabledChanged(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        Theme.Quality(g);
        g.Clear(Parent?.BackColor ?? Theme.Bg2);
        var r = new Rectangle(0, 0, Width - 1, Height - 1);
        using var path = Theme.Round(r, 4);
        using (var br = new SolidBrush(Enabled ? Theme.Bg0 : Theme.Bg1)) g.FillPath(br, path);
        using (var pen = new Pen(_invalid ? Theme.Red : _focus ? Theme.Accent : Theme.Bg0, 1.5f)) g.DrawPath(pen, path);
        if (_secret)
            TextRenderer.DrawText(g, G.Eye, Theme.Icons, _eye, _reveal ? Theme.Link : Theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.HorizontalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
    }
}

public sealed class DCombo : Control
{
    private bool _hover;
    private string[] _items = [];
    private int _index = -1;
    public event EventHandler? SelectedChanged;

    public DCombo()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.Selectable, true);
        Height = 32; Cursor = Cursors.Hand; Font = Theme.Ui; TabStop = true;
    }

    public string[] Items { get => _items; set { _items = value; if (_index >= value.Length) _index = -1; Invalidate(); } }
    public int SelectedIndex { get => _index; set { if (value == _index) return; _index = value; Invalidate(); SelectedChanged?.Invoke(this, EventArgs.Empty); } }
    public string Value
    {
        get => _index >= 0 && _index < _items.Length ? _items[_index] : "";
        set { int i = Array.IndexOf(_items, value); if (i >= 0) SelectedIndex = i; }
    }

    protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }
    protected override bool IsInputKey(Keys k) => k is Keys.Down or Keys.Up || base.IsInputKey(k);
    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Down && _index < _items.Length - 1) SelectedIndex = _index + 1;
        else if (e.KeyCode == Keys.Up && _index > 0) SelectedIndex = _index - 1;
        else if (e.KeyCode is Keys.Space or Keys.Enter) Open();
        base.OnKeyDown(e);
    }

    protected override void OnMouseDown(MouseEventArgs e) { Focus(); if (Enabled) Open(); base.OnMouseDown(e); }

    private void Open()
    {
        var menu = DarkMenu.Create();
        menu.MinimumSize = new Size(Width, 0);
        for (int i = 0; i < _items.Length; i++)
        {
            int idx = i;
            var it = new ToolStripMenuItem(_items[i]) { Checked = i == _index };
            it.Click += (_, _) => SelectedIndex = idx;
            menu.Items.Add(it);
        }
        menu.Show(this, new Point(0, Height + 2));
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        Theme.Quality(g);
        g.Clear(Parent?.BackColor ?? Theme.Bg2);
        var r = new Rectangle(0, 0, Width - 1, Height - 1);
        using var path = Theme.Round(r, 4);
        using (var br = new SolidBrush(Theme.Bg0)) g.FillPath(br, path);
        using (var pen = new Pen(Focused ? Theme.Accent : _hover ? Theme.Bg4 : Theme.Bg0, 1.5f)) g.DrawPath(pen, path);
        TextRenderer.DrawText(g, Value, Font, new Rectangle(10, 0, Width - 34, Height), Enabled ? Theme.Text : Theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
        TextRenderer.DrawText(g, G.Down, Theme.IconsSmall, new Rectangle(Width - 28, 0, 22, Height), Theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.HorizontalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
    }
}

public static class DarkMenu
{
    private sealed class Colors : ProfessionalColorTable
    {
        public override Color ToolStripDropDownBackground => Theme.Bg0;
        public override Color ImageMarginGradientBegin => Theme.Bg0;
        public override Color ImageMarginGradientMiddle => Theme.Bg0;
        public override Color ImageMarginGradientEnd => Theme.Bg0;
        public override Color MenuBorder => Theme.Bg4;
        public override Color MenuItemBorder => Theme.Accent;
        public override Color MenuItemSelected => Theme.Accent;
        public override Color MenuItemSelectedGradientBegin => Theme.Accent;
        public override Color MenuItemSelectedGradientEnd => Theme.Accent;
        public override Color SeparatorDark => Theme.Divider;
        public override Color SeparatorLight => Theme.Divider;
        public override Color CheckBackground => Theme.Accent;
        public override Color CheckSelectedBackground => Theme.Accent;
        public override Color CheckPressedBackground => Theme.Accent;
    }

    private sealed class Renderer : ToolStripProfessionalRenderer
    {
        public Renderer() : base(new Colors()) { RoundedEdges = false; }
        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            e.TextColor = e.Item.Enabled ? Theme.Text : Theme.Muted;
            if (e.Item.Selected) e.TextColor = Color.White;
            base.OnRenderItemText(e);
        }
    }

    public static ContextMenuStrip Create()
    {
        var m = new ContextMenuStrip { Renderer = new Renderer(), BackColor = Theme.Bg0, ForeColor = Theme.Text, Font = Theme.Ui, ShowImageMargin = false, ShowCheckMargin = true };
        return m;
    }
}

public class DCard : Panel
{
    public int Radius { get; set; } = 8;
    public Color Fill { get; set; } = Theme.Bg1;
    public DCard() { SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint, true); BackColor = Theme.Bg1; }
    protected override void OnPaint(PaintEventArgs e)
    {
        Theme.Quality(e.Graphics);
        e.Graphics.Clear(Parent?.BackColor ?? Theme.Bg2);
        using var path = Theme.Round(new Rectangle(0, 0, Width - 1, Height - 1), Radius);
        using var br = new SolidBrush(Fill);
        e.Graphics.FillPath(br, path);
    }
}

public sealed class DLabel : Control
{
    public DLabel()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
        ForeColor = Theme.Text; Font = Theme.Ui; BackColor = Color.Transparent;
    }
    public bool Wrap { get; set; } = true;
    public bool Mono { get; set; }
    public ContentAlignment Align { get; set; } = ContentAlignment.TopLeft;
    public override Size GetPreferredSize(Size proposed)
    {
        int w = proposed.Width > 0 ? proposed.Width : Width;
        if (!Wrap) { var s = TextRenderer.MeasureText(Text, Font, new Size(4000, 100), Theme.Flags); return new Size(s.Width, s.Height); }
        return new Size(w, Theme.Measure(Text, Font, Math.Max(10, w)));
    }
    protected override void OnTextChanged(EventArgs e) { base.OnTextChanged(e); Invalidate(); }
    protected override void OnPaint(PaintEventArgs e)
    {
        var f = TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix;
        if (Wrap) f |= TextFormatFlags.WordBreak; else f |= TextFormatFlags.EndEllipsis | TextFormatFlags.SingleLine;
        f |= Align switch
        {
            ContentAlignment.MiddleLeft => TextFormatFlags.VerticalCenter,
            ContentAlignment.MiddleCenter => TextFormatFlags.VerticalCenter | TextFormatFlags.HorizontalCenter,
            ContentAlignment.MiddleRight => TextFormatFlags.VerticalCenter | TextFormatFlags.Right,
            ContentAlignment.TopRight => TextFormatFlags.Right,
            _ => 0
        };
        TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, Enabled ? ForeColor : Theme.Muted, f);
    }
}

public sealed class HelpIcon : Control
{
    private bool _hover;
    public Action? OnOpen;
    public HelpIcon()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
        Size = new Size(20, 20); Cursor = Cursors.Help;
    }
    protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnClick(EventArgs e) { OnOpen?.Invoke(); base.OnClick(e); }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        Theme.Quality(g);
        g.Clear(Parent?.BackColor ?? Theme.Bg2);
        var r = new Rectangle(1, 1, Width - 3, Height - 3);
        using var br = new SolidBrush(_hover ? Theme.Accent : Theme.Bg4);
        g.FillEllipse(br, r);
        TextRenderer.DrawText(g, "?", Theme.UiSmall, new Rectangle(0, 0, Width, Height), Color.White, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
    }
}

public sealed class Badge : Control
{
    public Color Fill { get; set; } = Theme.Bg4;
    public Color Fore { get; set; } = Theme.Text;
    public Badge()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
        Font = Theme.UiSmall; Height = 18;
    }
    public override Size GetPreferredSize(Size proposed) => new(TextRenderer.MeasureText(Text, Font, new Size(500, 30), Theme.Flags).Width + 14, 18);
    protected override void OnTextChanged(EventArgs e) { base.OnTextChanged(e); Width = GetPreferredSize(Size.Empty).Width; Invalidate(); }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        Theme.Quality(g);
        g.Clear(Parent?.BackColor ?? Theme.Bg2);
        using var path = Theme.Round(new Rectangle(0, 0, Width - 1, Height - 1), 4);
        using var br = new SolidBrush(Fill);
        g.FillPath(br, path);
        TextRenderer.DrawText(g, Text, Font, ClientRectangle, Fore, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
    }
}

public sealed class DSubTabs : Control
{
    private string[] _tabs = [];
    private int _sel, _hover = -1;
    private int[] _x = [], _w = [];
    public event EventHandler? SelectedChanged;
    public DSubTabs()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        Height = 36; Font = Theme.UiBold; Cursor = Cursors.Hand;
    }
    public string[] Tabs { get => _tabs; set { _tabs = value; Measure(); Invalidate(); } }
    public int Selected { get => _sel; set { if (_sel == value) return; _sel = value; Invalidate(); SelectedChanged?.Invoke(this, EventArgs.Empty); } }

    private void Measure()
    {
        _x = new int[_tabs.Length]; _w = new int[_tabs.Length];
        int x = 0;
        for (int i = 0; i < _tabs.Length; i++)
        {
            _w[i] = TextRenderer.MeasureText(_tabs[i], Font, new Size(1000, 40), Theme.Flags).Width + 28;
            _x[i] = x; x += _w[i];
        }
    }

    private int At(Point p) { for (int i = 0; i < _tabs.Length; i++) if (p.X >= _x[i] && p.X < _x[i] + _w[i]) return i; return -1; }
    protected override void OnMouseMove(MouseEventArgs e) { int h = At(e.Location); if (h != _hover) { _hover = h; Invalidate(); } base.OnMouseMove(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = -1; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { int i = At(e.Location); if (i >= 0) Selected = i; base.OnMouseDown(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(Parent?.BackColor ?? Theme.Bg2);
        using (var pen = new Pen(Theme.Divider)) g.DrawLine(pen, 0, Height - 1, Width, Height - 1);
        for (int i = 0; i < _tabs.Length; i++)
        {
            bool sel = i == _sel;
            TextRenderer.DrawText(g, _tabs[i], Font, new Rectangle(_x[i], 0, _w[i], Height - 2), sel ? Theme.TextBright : i == _hover ? Theme.Text : Theme.Muted, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            if (sel) { using var br = new SolidBrush(Theme.Accent); g.FillRectangle(br, _x[i] + 8, Height - 3, _w[i] - 16, 3); }
        }
    }
}

public sealed class Spark : Control
{
    private readonly List<double> _vals = new();
    public Color Line { get; set; } = Theme.Accent;
    public double Max { get; set; } = 0;
    public Spark() { SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true); Height = 36; }
    public void Add(double v) { _vals.Add(v); if (_vals.Count > 60) _vals.RemoveAt(0); Invalidate(); }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        Theme.Quality(g);
        g.Clear(Parent?.BackColor ?? Theme.Bg1);
        if (_vals.Count < 2) return;
        double max = Max > 0 ? Max : Math.Max(1, _vals.Max() * 1.15);
        var pts = new PointF[_vals.Count];
        for (int i = 0; i < _vals.Count; i++)
            pts[i] = new PointF(i * (Width - 2f) / 59f + (Width - 2f) * (60 - _vals.Count) / 59f, Height - 2 - (float)(Math.Min(_vals[i], max) / max) * (Height - 6));
        var fill = new List<PointF>(pts) { new(pts[^1].X, Height), new(pts[0].X, Height) };
        using (var br = new SolidBrush(Color.FromArgb(40, Line))) g.FillPolygon(br, fill.ToArray());
        using var pen = new Pen(Line, 1.8f) { LineJoin = LineJoin.Round };
        g.DrawLines(pen, pts);
    }
}

public sealed class ScrollPanel : Panel
{
    [DllImport("user32.dll")] private static extern bool ShowScrollBar(IntPtr h, int bar, bool show);
    protected override void WndProc(ref Message m)
    {
        if (IsHandleCreated) ShowScrollBar(Handle, 0, false);
        base.WndProc(ref m);
    }

    public ScrollPanel()
    {
        AutoScroll = true; BackColor = Theme.Bg2;
        DoubleBuffered = true;
        Theme.DarkScroll(this);
        MouseEnter += (_, _) => { if (!ContainsFocus) Focus(); };
    }
    protected override void OnMouseWheel(MouseEventArgs e)
    {
        base.OnMouseWheel(e);
    }
    protected override Point ScrollToControl(Control activeControl) => AutoScrollPosition.IsEmpty ? DisplayRectangle.Location : new Point(-AutoScrollPosition.X, -AutoScrollPosition.Y);
}

public static class Tip
{
    private static readonly ToolTip Tt = Make();

    private static ToolTip Make()
    {
        var t = new ToolTip { OwnerDraw = true, InitialDelay = 350, ReshowDelay = 100, AutoPopDelay = 30000, ShowAlways = true };
        t.Popup += (_, e) =>
        {
            var (title, body) = Split(t.GetToolTip(e.AssociatedControl!));
            e.ToolTipSize = Size(title, body);
        };
        t.Draw += (_, e) =>
        {
            var (title, body) = Split(e.ToolTipText);
            var g = e.Graphics;
            Theme.Quality(g);
            using (var br = new SolidBrush(Theme.Bg0)) g.FillRectangle(br, e.Bounds);
            using (var pen = new Pen(Theme.Accent)) g.DrawRectangle(pen, 0, 0, e.Bounds.Width - 1, e.Bounds.Height - 1);
            int y = 8;
            if (title != "")
            {
                TextRenderer.DrawText(g, title, Theme.UiBold, new Point(10, y), Theme.TextBright, TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
                y += 22;
            }
            if (body != "")
                TextRenderer.DrawText(g, body, Theme.Ui, new Rectangle(10, y, e.Bounds.Width - 20, e.Bounds.Height - y - 6), Theme.Text, TextFormatFlags.WordBreak | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
        };
        return t;
    }

    private static (string, string) Split(string s)
    {
        int i = s.IndexOf('\u0001');
        return i < 0 ? ("", s) : (s[..i], s[(i + 1)..]);
    }

    private static Size Size(string title, string body)
    {
        const int w = 340;
        int h = 14;
        if (title != "") h += 22;
        if (body != "") h += Theme.Measure(body, Theme.Ui, w - 20) + 2;
        return new Size(w, h);
    }

    public static void Set(Control c, string title, string body = "") => Tt.SetToolTip(c, title + "\u0001" + body);
    public static void Set(Control c, string text) => Tt.SetToolTip(c, "\u0001" + text);
}

public static class Dlg
{
    private static Form Base(Control? owner, string title, int w, int h)
    {
        var f = new Form
        {
            Text = title, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false, ShowInTaskbar = false,
            StartPosition = FormStartPosition.CenterParent, BackColor = Theme.Bg2, ForeColor = Theme.Text, Font = Theme.Ui,
            ClientSize = new Size(w, h), KeyPreview = true, AutoScaleMode = AutoScaleMode.None
        };
        f.HandleCreated += (_, _) => Theme.DarkCaption(f.Handle);
        f.KeyDown += (_, e) => { if (e.KeyCode == Keys.Escape) f.DialogResult = DialogResult.Cancel; };
        return f;
    }

    private static DialogResult Run(Form f, Control? owner)
    {
        var top = owner?.FindForm();
        return top != null && top.Visible ? f.ShowDialog(top) : f.ShowDialog();
    }

    public static void Info(Control? owner, string title, string text)
    {
        using var f = Base(owner, title, 460, 40);
        var lbl = new DLabel { Text = text, Location = new Point(20, 20), Width = 420 };
        lbl.Height = lbl.GetPreferredSize(new Size(420, 0)).Height;
        var ok = new DButton("OK", BtnKind.Primary) { Width = 90 };
        f.ClientSize = new Size(460, 20 + lbl.Height + 20 + 32 + 16);
        ok.Location = new Point(460 - 20 - 90, f.ClientSize.Height - 16 - 32);
        ok.Click += (_, _) => f.DialogResult = DialogResult.OK;
        f.Controls.AddRange([lbl, ok]);
        f.AcceptButton = null;
        Run(f, owner);
    }

    public static bool Confirm(Control? owner, string title, string text, string okText = "OK", bool danger = false)
    {
        using var f = Base(owner, title, 480, 40);
        var lbl = new DLabel { Text = text, Location = new Point(20, 20), Width = 440 };
        lbl.Height = lbl.GetPreferredSize(new Size(440, 0)).Height;
        var ok = new DButton(okText, danger ? BtnKind.Danger : BtnKind.Primary) { MinimumSize = new Size(90, 32) };
        var cancel = new DButton("Cancel", BtnKind.Secondary) { MinimumSize = new Size(90, 32) };
        f.ClientSize = new Size(480, 20 + lbl.Height + 20 + 32 + 16);
        int y = f.ClientSize.Height - 16 - 32;
        ok.Location = new Point(480 - 20 - ok.Width, y);
        cancel.Location = new Point(ok.Left - 10 - cancel.Width, y);
        ok.Click += (_, _) => f.DialogResult = DialogResult.OK;
        cancel.Click += (_, _) => f.DialogResult = DialogResult.Cancel;
        f.Controls.AddRange([lbl, ok, cancel]);
        return Run(f, owner) == DialogResult.OK;
    }

    public static int Choose(Control? owner, string title, string text, params string[] buttons)
    {
        using var f = Base(owner, title, 520, 40);
        var lbl = new DLabel { Text = text, Location = new Point(20, 20), Width = 480 };
        lbl.Height = lbl.GetPreferredSize(new Size(480, 0)).Height;
        f.ClientSize = new Size(520, 20 + lbl.Height + 20 + 32 + 16);
        int y = f.ClientSize.Height - 16 - 32;
        int result = -1, x = 520 - 20;
        f.Controls.Add(lbl);
        for (int i = buttons.Length - 1; i >= 0; i--)
        {
            int idx = i;
            var b = new DButton(buttons[i], i == 0 ? BtnKind.Primary : BtnKind.Secondary) { MinimumSize = new Size(90, 32) };
            x -= b.Width;
            b.Location = new Point(x, y);
            x -= 10;
            b.Click += (_, _) => { result = idx; f.DialogResult = DialogResult.OK; };
            f.Controls.Add(b);
        }
        Run(f, owner);
        return result;
    }

    public static string? Input(Control? owner, string title, string prompt, string initial = "", bool password = false, Func<string, string?>? validate = null)
    {
        using var f = Base(owner, title, 480, 40);
        var lbl = new DLabel { Text = prompt, Location = new Point(20, 20), Width = 440 };
        lbl.Height = lbl.GetPreferredSize(new Size(440, 0)).Height;
        var input = new DInput { Location = new Point(20, 20 + lbl.Height + 10), Width = 440, Text = initial, Secret = password, Validator = validate };
        var err = new DLabel { Location = new Point(20, input.Bottom + 4), Width = 440, Height = 18, ForeColor = Theme.Red, Wrap = false };
        var ok = new DButton("OK", BtnKind.Primary) { MinimumSize = new Size(90, 32) };
        var cancel = new DButton("Cancel", BtnKind.Secondary) { MinimumSize = new Size(90, 32) };
        f.ClientSize = new Size(480, err.Bottom + 12 + 32 + 16);
        int y = f.ClientSize.Height - 16 - 32;
        ok.Location = new Point(480 - 20 - ok.Width, y);
        cancel.Location = new Point(ok.Left - 10 - cancel.Width, y);
        void accept() { input.Revalidate(); if (input.Error != null) { err.Text = input.Error; return; } f.DialogResult = DialogResult.OK; }
        ok.Click += (_, _) => accept();
        input.EnterPressed += (_, _) => accept();
        cancel.Click += (_, _) => f.DialogResult = DialogResult.Cancel;
        f.Controls.AddRange([lbl, input, err, ok, cancel]);
        f.Shown += (_, _) => { input.Focus(); input.Inner.SelectAll(); };
        return Run(f, owner) == DialogResult.OK ? input.Text : null;
    }

    public static void Text(Control? owner, string title, string body, string? heading = null, int width = 760, int height = 520)
    {
        using var f = Base(owner, title, width, height);
        f.FormBorderStyle = FormBorderStyle.Sizable;
        f.MinimizeBox = false;
        var y = 14;
        if (heading != null) { f.Controls.Add(new DLabel { Text = heading, Font = Theme.UiTitle, ForeColor = Theme.TextBright, Location = new Point(20, y), Width = width - 40, Height = 30, Wrap = false }); y += 40; }
        var box = new DInput { Multiline = true, MonoFont = true, ReadOnly = true, WrapLines = true, Text = body, Location = new Point(20, y), Size = new Size(width - 40, height - y - 64), Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom };
        var copy = new DButton("Copy", BtnKind.Secondary, G.Copy) { Anchor = AnchorStyles.Bottom | AnchorStyles.Right };
        var close = new DButton("Close", BtnKind.Primary) { MinimumSize = new Size(90, 32), Anchor = AnchorStyles.Bottom | AnchorStyles.Right };
        close.Location = new Point(width - 20 - close.Width, height - 16 - 32);
        copy.Location = new Point(close.Left - 10 - copy.Width, close.Top);
        copy.Click += (_, _) => { try { Clipboard.SetText(body); } catch { } };
        close.Click += (_, _) => f.DialogResult = DialogResult.OK;
        f.Controls.AddRange([box, copy, close]);
        Run(f, owner);
    }
}

public static class Ui
{
    public static DButton Button(string text, BtnKind kind, string glyph, Action click, string? tipTitle = null, string? tipBody = null)
    {
        var b = new DButton(text, kind, glyph);
        b.Click += (_, _) => click();
        if (tipTitle != null) Tip.Set(b, tipTitle, tipBody ?? "");
        return b;
    }

    public static void Flow(Control host, int gap, params Control[] controls)
    {
        int x = 0;
        foreach (var c in controls)
        {
            c.Location = new Point(x, c.Top);
            host.Controls.Add(c);
            x += c.Width + gap;
        }
    }

    public static DLabel Label(string text, Font? font = null, Color? color = null, bool wrap = true)
        => new() { Text = text, Font = font ?? Theme.Ui, ForeColor = color ?? Theme.Text, Wrap = wrap };

    public static RichTextBox LogBox()
    {
        var rtb = new RichTextBox
        {
            ReadOnly = true, BackColor = Theme.Bg0, ForeColor = Theme.Text, Font = Theme.MonoSmall, BorderStyle = BorderStyle.None,
            DetectUrls = false, WordWrap = false, HideSelection = false, ScrollBars = RichTextBoxScrollBars.Both
        };
        Theme.DarkScroll(rtb);
        return rtb;
    }

    public static string FormatSize(long bytes) =>
        bytes < 1024 ? $"{bytes} B" : bytes < 1048576 ? $"{bytes / 1024.0:0.0} KB" : bytes < 1073741824 ? $"{bytes / 1048576.0:0.0} MB" : $"{bytes / 1073741824.0:0.00} GB";

    public static string FormatSpan(TimeSpan t)
    {
        if (t.TotalDays >= 1) return $"{(int)t.TotalDays}d {t.Hours}h {t.Minutes}m";
        if (t.TotalHours >= 1) return $"{(int)t.TotalHours}h {t.Minutes}m {t.Seconds}s";
        return $"{t.Minutes}m {t.Seconds}s";
    }
}

public static class RtbExt
{
    [DllImport("user32.dll")] private static extern int SendMessage(IntPtr h, int msg, int w, int l);
    [DllImport("user32.dll")] private static extern bool GetScrollInfo(IntPtr h, int bar, ref ScrollInfo si);
    [StructLayout(LayoutKind.Sequential)] private struct ScrollInfo { public int cbSize, fMask, nMin, nMax, nPage, nPos, nTrackPos; }

    public static void Suspend(this Control c) => SendMessage(c.Handle, 0x000B, 0, 0);
    public static void Resume(this Control c) { SendMessage(c.Handle, 0x000B, 1, 0); c.Invalidate(); }

    public static bool AtBottom(this RichTextBox r)
    {
        var si = new ScrollInfo { cbSize = Marshal.SizeOf<ScrollInfo>(), fMask = 0x17 };
        if (!GetScrollInfo(r.Handle, 1, ref si)) return true;
        return si.nPos + si.nPage >= si.nMax - 2;
    }

    public static void ScrollToEnd(this RichTextBox r) { SendMessage(r.Handle, 0x0115, 7, 0); }
}

public static class Dlg2
{
    public static bool Review(Control? owner, string title, string heading, string body, string okText, bool danger = false)
    {
        using var f = new Form
        {
            Text = title, FormBorderStyle = FormBorderStyle.Sizable, MaximizeBox = false, MinimizeBox = false, ShowInTaskbar = false,
            StartPosition = FormStartPosition.CenterParent, BackColor = Theme.Bg2, ForeColor = Theme.Text, Font = Theme.Ui,
            ClientSize = new Size(700, 460), MinimumSize = new Size(480, 320), AutoScaleMode = AutoScaleMode.None
        };
        f.HandleCreated += (_, _) => Theme.DarkCaption(f.Handle);
        var h = new DLabel { Text = heading, Font = Theme.UiBold, ForeColor = Theme.TextBright, Location = new Point(20, 16), Width = 660, Height = 24, Wrap = false, Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right };
        var box = new DInput { Multiline = true, MonoFont = true, ReadOnly = true, Text = body, Location = new Point(20, 48), Size = new Size(660, 340), Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom };
        var ok = new DButton(okText, danger ? BtnKind.Danger : BtnKind.Primary) { MinimumSize = new Size(100, 32), Anchor = AnchorStyles.Bottom | AnchorStyles.Right };
        var cancel = new DButton("Cancel", BtnKind.Secondary) { MinimumSize = new Size(90, 32), Anchor = AnchorStyles.Bottom | AnchorStyles.Right };
        ok.Location = new Point(700 - 20 - ok.Width, 460 - 16 - 32);
        cancel.Location = new Point(ok.Left - 10 - cancel.Width, ok.Top);
        ok.Click += (_, _) => f.DialogResult = DialogResult.OK;
        cancel.Click += (_, _) => f.DialogResult = DialogResult.Cancel;
        f.KeyPreview = true;
        f.KeyDown += (_, e) => { if (e.KeyCode == Keys.Escape) f.DialogResult = DialogResult.Cancel; };
        f.Controls.AddRange([h, box, ok, cancel]);
        var top = owner?.FindForm();
        return (top != null && top.Visible ? f.ShowDialog(top) : f.ShowDialog()) == DialogResult.OK;
    }
}
