using System.Text.Json.Nodes;

namespace MeshCrowd.Launcher;

public sealed class FieldRow : Panel
{
    public FieldDef Def { get; }
    public JsonNode? Baseline { get; private set; }
    private readonly Control _editor;
    private readonly DLabel _title, _desc, _err, _groupTag;
    private readonly Badge _badge;
    private readonly HelpIcon _help;
    private readonly DButton _reset;
    private readonly Label _dot;
    private readonly DLabel? _state;
    private readonly DButton? _extra;
    private bool _loading;
    public event Action? Changed;
    public string? Error { get; private set; }

    public FieldRow(FieldDef def)
    {
        Def = def;
        BackColor = Theme.Bg2;
        _dot = new Label { Text = "●", ForeColor = Theme.Yellow, AutoSize = true, Visible = false, Font = Theme.UiSmall, BackColor = Color.Transparent };
        _title = new DLabel { Text = def.Label, Font = Theme.UiBold, ForeColor = Theme.TextBright, Wrap = false };
        _badge = new Badge { Text = def.Restart ? "restart needed" : "live", Fill = def.Restart ? Color.FromArgb(0x5C, 0x45, 0x10) : Color.FromArgb(0x16, 0x5A, 0x33), Fore = def.Restart ? Theme.Yellow : Color.FromArgb(0x7B, 0xE0, 0xA0) };
        _help = new HelpIcon();
        _badge.Visible = !def.NoBadge;
        _groupTag = new DLabel { Text = def.Group, Font = Theme.UiSmall, ForeColor = Theme.Muted, Wrap = false, Visible = false };
        _desc = new DLabel { Text = def.Short, ForeColor = Theme.Muted, Font = Theme.Ui };
        _err = new DLabel { ForeColor = Theme.Red, Font = Theme.UiSmall, Visible = false };
        _reset = new DButton("", BtnKind.Ghost, G.Undo) { Visible = false };
        Tip.Set(_reset, "Reset to default", $"Restores {def.DefaultText()}.");
        _reset.Click += (_, _) => { SetValue(def.Default); };
        Tip.Set(_title, def.Label + (def.Key.Length > 0 ? $"   ({def.Key})" : ""), def.Tooltip());
        Tip.Set(_help, def.Label, def.Tooltip());
        _help.OnOpen = () => Dlg.Text(this, def.Label, def.Tooltip(), $"{def.Label}", 640, 420);
        Tip.Set(_badge, def.Restart ? "Restart needed" : "Applies live", def.Restart ? "The running server reads this value at start. Restart it after saving." : "The running server picks this up without a restart.");

        switch (def.Type)
        {
            case FType.Bool:
                var t = new DToggle();
                t.CheckedChanged += (_, _) => { if (_state != null) _state.Text = t.Checked ? "On" : "Off"; OnEdit(); };
                _editor = t;
                _state = new DLabel { Text = "Off", ForeColor = Theme.Muted, Wrap = false, Width = 50, Height = 24, Align = ContentAlignment.MiddleLeft };
                break;
            case FType.Enum:
                var c = new DCombo { Items = def.Options ?? [], Width = 220 };
                c.SelectedChanged += (_, _) => OnEdit();
                _editor = c;
                break;
            default:
                var inp = new DInput { Placeholder = def.Placeholder ?? def.Example ?? "" };
                if (def.Type == FType.Json) { inp.Multiline = true; inp.MonoFont = true; inp.WrapLines = true; inp.Height = 76; }
                if (def.Type == FType.Secret) inp.Secret = true;
                inp.Validator = _ => null;
                inp.TextChanged += (_, _) => OnEdit();
                _editor = inp;
                if (def.Type is FType.File or FType.Folder)
                {
                    _extra = new DButton("Browse...", BtnKind.Secondary, G.Folder);
                    _extra.Click += (_, _) => Browse(inp);
                }
                else if (def.Type == FType.Secret && def.Generate)
                {
                    _extra = new DButton("Generate", BtnKind.Secondary, G.Key);
                    Tip.Set(_extra, "Generate a new random secret", "Creates 32 random bytes (64 hex characters). Existing credentials signed with the old secret stop working.");
                    _extra.Click += (_, _) => { if (inp.Text == "" || Dlg.Confirm(this, "Replace secret", "Replace the current secret with a new random one?", "Replace", true)) inp.Text = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)).ToLowerInvariant(); };
                }
                break;
        }
        Controls.AddRange([_dot, _title, _badge, _help, _groupTag, _reset, _desc, _editor, _err]);
        if (_state != null) Controls.Add(_state);
        if (_extra != null) Controls.Add(_extra);
    }

    private void Browse(DInput inp)
    {
        if (Def.Type == FType.Folder)
        {
            using var d = new FolderBrowserDialog { SelectedPath = inp.Text };
            if (d.ShowDialog(FindForm()) == DialogResult.OK) inp.Text = d.SelectedPath;
        }
        else
        {
            using var d = new OpenFileDialog { InitialDirectory = Paths.Root, Title = Def.Label, CheckFileExists = true };
            if (d.ShowDialog(FindForm()) == DialogResult.OK)
            {
                var full = d.FileName;
                inp.Text = full.StartsWith(Paths.Root, StringComparison.OrdinalIgnoreCase) ? full[Paths.Root.Length..].TrimStart('\\', '/') : full;
            }
        }
    }

    private bool def2Badge() => !Def.NoBadge;

    public void ShowGroupTag(bool on) { _groupTag.Visible = on; }

    public void Load(JsonNode? stored)
    {
        _loading = true;
        Baseline = JsonStore.Clone(stored ?? Def.Default);
        SetValueInternal(Baseline);
        _loading = false;
        Evaluate();
    }

    public void SetValue(JsonNode? v) { SetValueInternal(v); OnEdit(); }

    private void SetValueInternal(JsonNode? v)
    {
        switch (_editor)
        {
            case DToggle t: t.Checked = v is JsonValue bv && bv.TryGetValue<bool>(out var b) && b; if (_state != null) _state.Text = t.Checked ? "On" : "Off"; break;
            case DCombo c: c.Value = v?.ToString() ?? ""; if (c.SelectedIndex < 0 && c.Items.Length > 0) c.SelectedIndex = 0; break;
            case DInput i:
                i.Text = Def.Type == FType.Json ? (v == null ? "" : v.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = false })) : v?.ToString() ?? "";
                break;
        }
    }

    public JsonNode? Value()
    {
        switch (_editor)
        {
            case DToggle t: return JsonValue.Create(t.Checked);
            case DCombo c: return JsonValue.Create(c.Value);
            case DInput i:
                var text = i.Text;
                if (Def.Type == FType.Int) return long.TryParse(text.Trim(), out var l) ? JsonValue.Create(l) : null;
                if (Def.Type == FType.Json)
                {
                    try { return JsonNode.Parse(text.Trim() == "" ? "null" : text); }
                    catch { return Def.Check == "trustProxy" ? JsonValue.Create(text.Trim()) : null; }
                }
                return JsonValue.Create(text.Trim() == "" ? "" : Def.Type == FType.Secret ? text : text.Trim());
        }
        return null;
    }

    public bool Modified => (Value()?.ToJsonString() ?? "?") != (Baseline?.ToJsonString() ?? "null");
    public bool IsDefault => (Value()?.ToJsonString() ?? "?") == (Def.Default?.ToJsonString() ?? "null");

    private void OnEdit() { if (_loading) return; Evaluate(); Changed?.Invoke(); }

    private void Evaluate()
    {
        var v = Value();
        Error = v == null && Def.Type == FType.Int ? "must be a whole number"
              : v == null && Def.Type == FType.Json ? "not valid JSON"
              : Validate.Field(Def, v);
        if (_editor is DInput inp) inp.Invalid = Error != null;
        _err.Text = Error ?? "";
        bool showErr = Error != null;
        if (_err.Visible != showErr) { _err.Visible = showErr; Relayout(Width); }
        _dot.Visible = Modified;
        _reset.Visible = !IsDefault;
    }

    public void MarkUnmodified() { Baseline = JsonStore.Clone(Value()); Evaluate(); }

    public int Relayout(int width)
    {
        Width = width;
        int y = 0;
        _dot.Location = new Point(0, 3);
        int x = _dot.Visible ? 0 : 0;
        _title.Location = new Point(14, 0);
        _title.Size = _title.GetPreferredSize(Size.Empty);
        _title.Height = 22;
        int tx = _title.Right + 8;
        _badge.Location = new Point(tx, 2);
        _help.Location = new Point(def2Badge() ? _badge.Right + 6 : tx, 1);
        _groupTag.Location = new Point(_help.Right + 10, 3);
        _groupTag.Size = new Size(200, 18);
        _reset.Size = new Size(34, 26);
        _reset.Location = new Point(width - 34, -2);
        y = 26;
        int dh = Theme.Measure(_desc.Text, _desc.Font, Math.Max(100, width - 14));
        _desc.SetBounds(14, y, Math.Max(100, width - 14), dh);
        y += dh + 8;
        int ew = Math.Min(width - 14, _editor is DInput { Multiline: true } ? 640 : 560);
        switch (_editor)
        {
            case DToggle t:
                t.Location = new Point(14, y); y += 28;
                _state!.Location = new Point(14 + t.Width + 10, y - 28); _state.Height = 24;
                break;
            case DCombo c: c.SetBounds(14, y, 220, 32); y += 36; break;
            case DInput i:
                int w2 = Def.Type == FType.Int ? 200 : ew;
                if (_extra != null) { _extra.Location = new Point(14 + w2 + 8, y); w2 = Math.Min(w2, width - 14 - _extra.Width - 16); }
                i.SetBounds(14, y, Math.Max(120, w2), i.Multiline ? 76 : 32);
                if (_extra != null) { _extra.Location = new Point(i.Right + 8, y); }
                y += i.Height + 4;
                break;
        }
        if (_err.Visible)
        {
            int eh = Theme.Measure(_err.Text, _err.Font, Math.Max(100, width - 14));
            _err.SetBounds(14, y, Math.Max(100, width - 14), eh);
            y += eh + 4;
        }
        Height = y + 6;
        return Height;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        using var pen = new Pen(Theme.Divider);
        e.Graphics.DrawLine(pen, 14, Height - 1, Width, Height - 1);
    }
}

public sealed class SettingsForm : Panel
{
    private readonly JsonStore _store;
    private readonly List<FieldRow> _rows = new();
    private readonly Dictionary<string, string> _info;
    private readonly ScrollPanel _scroll = new();
    private readonly DLabel _header = new() { Font = Theme.UiTitle, ForeColor = Theme.TextBright, Wrap = false };
    private readonly DLabel _sub = new() { ForeColor = Theme.Muted };
    private readonly DLabel _empty = new() { Text = "Nothing matches.", ForeColor = Theme.Muted, Visible = false };
    private string? _group;
    private string _filter = "";
    public event Action? Modified;

    public SettingsForm(JsonStore store, IEnumerable<FieldDef> fields, Dictionary<string, string> groupInfo)
    {
        _store = store; _info = groupInfo;
        BackColor = Theme.Bg2;
        _scroll.Dock = DockStyle.Fill;
        _scroll.Padding = new Padding(0);
        Controls.Add(_scroll);
        _scroll.Controls.AddRange([_header, _sub, _empty]);
        foreach (var f in fields)
        {
            var row = new FieldRow(f);
            row.Changed += () => Modified?.Invoke();
            row.Visible = false;
            _rows.Add(row);
            _scroll.Controls.Add(row);
        }
        Reload();
        _scroll.Resize += (_, _) => Relayout();
    }

    public IReadOnlyList<FieldRow> Rows => _rows;

    public void Reload()
    {
        foreach (var r in _rows) r.Load(_store.Get(r.Def.Key));
        Relayout();
    }

    public bool IsDirty => _rows.Any(r => r.Modified);

    public void ShowGroup(string? group) { _group = group; _filter = ""; Relayout(); _scroll.AutoScrollPosition = Point.Empty; }
    public void SetFilter(string text) { _filter = text.Trim(); Relayout(); _scroll.AutoScrollPosition = Point.Empty; }

    public List<(FieldRow row, string error)> Errors() => _rows.Where(r => r.Error != null).Select(r => (r, r.Error!)).ToList();

    public List<(FieldDef def, JsonNode? oldV, JsonNode? newV)> Changes() =>
        _rows.Where(r => r.Modified).Select(r => (r.Def, r.Baseline, r.Value())).ToList();

    public void ApplyToStore()
    {
        foreach (var r in _rows)
            if (r.Modified || _store.Get(r.Def.Key) != null) _store.Set(r.Def.Key, r.Value());
        foreach (var r in _rows) r.MarkUnmodified();
        Modified?.Invoke();
    }

    public void ResetGroupToDefaults(string group)
    {
        foreach (var r in _rows.Where(r => r.Def.Group == group)) r.SetValue(r.Def.Default);
    }

    public void ShowRow(FieldRow row) { _group = row.Def.Group; _filter = ""; Relayout(); _scroll.ScrollControlIntoView(row); }

    private bool Match(FieldRow r)
    {
        if (_filter == "") return r.Def.Group == _group;
        var f = _filter.ToLowerInvariant();
        return r.Def.Key.ToLowerInvariant().Contains(f) || r.Def.Label.ToLowerInvariant().Contains(f) || r.Def.Short.ToLowerInvariant().Contains(f) || r.Def.Help.ToLowerInvariant().Contains(f);
    }

    public void Relayout()
    {
        if (_scroll.ClientSize.Width < 200) return;
        _scroll.SuspendLayout();
        int w = Math.Max(300, _scroll.ClientSize.Width - 48);
        int x = 24, y = 20;
        _header.Text = _filter != "" ? $"Search: {_filter}" : _group ?? "";
        _header.SetBounds(x, y, w, 30);
        y += 32;
        var subText = _filter != "" ? "Matches across every section." : _group != null && _info.TryGetValue(_group, out var s) ? s : "";
        _sub.Text = subText;
        int sh = subText == "" ? 0 : Theme.Measure(subText, Theme.Ui, w);
        _sub.SetBounds(x, y, w, sh);
        y += sh + 14;
        int shown = 0;
        foreach (var r in _rows)
        {
            bool vis = Match(r);
            r.Visible = vis;
            if (!vis) continue;
            shown++;
            r.ShowGroupTag(_filter != "");
            r.Location = new Point(x, y);
            y += r.Relayout(w) + 14;
        }
        _empty.Visible = shown == 0;
        _empty.SetBounds(x, y, w, 24);
        _scroll.AutoScrollMinSize = new Size(0, y + 20);
        _scroll.ResumeLayout();
    }
}
