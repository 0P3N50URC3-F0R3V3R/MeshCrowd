namespace MeshCrowd.Launcher;

public sealed class SettingsPage : Page
{
    private readonly SettingsForm _form;
    private readonly DList _groups = new() { Dock = DockStyle.Fill };
    private readonly Panel _bar = new() { Dock = DockStyle.Top, Height = 58 };
    private readonly DLabel _status = new() { Wrap = false, ForeColor = Theme.Muted, Align = ContentAlignment.MiddleLeft };
    private readonly DButton _save, _discard;

    public SettingsPage()
    {
        Title = "Launcher settings";
        Subtitle = "How the launcher supervises the server. Stored in data\\launcher\\launcher.json, separate from the server config.";
        _form = new SettingsForm(App.Settings.Store, Fields.Launcher, Fields.LauncherInfo) { Dock = DockStyle.Fill };
        var side = new Panel { Dock = DockStyle.Left, Width = 230, BackColor = Theme.Bg1, Padding = new Padding(12) };
        _groups.Items.AddRange(Fields.LauncherGroups.Cast<object>().ToArray());
        _groups.HeightOf = _ => 34;
        _groups.DrawRow = (g, b, o, sel) =>
        {
            var name = (string)o;
            if (sel) { using var br = new SolidBrush(Theme.Accent); g.FillRectangle(br, b.X, b.Y + 4, 3, b.Height - 8); }
            TextRenderer.DrawText(g, name, Theme.Ui, new Rectangle(b.X + 12, b.Y, b.Width - 40, b.Height), sel ? Theme.TextBright : Theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            if (_form.Rows.Any(r => r.Def.Group == name && r.Modified)) TextRenderer.DrawText(g, "●", Theme.UiSmall, new Rectangle(b.Right - 26, b.Y, 20, b.Height), Theme.Yellow, TextFormatFlags.VerticalCenter | TextFormatFlags.HorizontalCenter);
        };
        _groups.SelectedIndexChanged += (_, _) => { if (_groups.SelectedIndex >= 0) _form.ShowGroup((string)_groups.SelectedItem!); };
        side.Controls.Add(_groups);

        _save = Ui.Button("Save", BtnKind.Success, G.Save, Save, "Save launcher settings", "Applies immediately; no server restart is involved.");
        _discard = Ui.Button("Discard", BtnKind.Secondary, G.Undo, () => { _form.Reload(); Update2(); }, "Throw away unsaved edits");
        _bar.Controls.AddRange([_status, _discard, _save]);
        _bar.Resize += (_, _) =>
        {
            _save.Location = new Point(_bar.Width - 24 - _save.Width, 13);
            _discard.Location = new Point(_save.Left - 8 - _discard.Width, 13);
            _status.SetBounds(24, 0, Math.Max(100, _discard.Left - 32), _bar.Height);
        };
        _bar.Paint += (_, e) => { using var p = new Pen(Theme.Divider); e.Graphics.DrawLine(p, 0, _bar.Height - 1, _bar.Width, _bar.Height - 1); };
        var body = new Panel { Dock = DockStyle.Fill };
        body.Controls.Add(_form);
        body.Controls.Add(_bar);
        Controls.Add(body);
        Controls.Add(side);
        _form.Modified += () => { Update2(); _groups.Invalidate(); };
        _groups.SelectedIndex = 0;
        Update2();
    }

    private void Update2()
    {
        int n = _form.Rows.Count(r => r.Modified);
        int e = _form.Rows.Count(r => r.Error != null);
        _status.ForeColor = e > 0 ? Theme.Red : n > 0 ? Theme.Yellow : Theme.Muted;
        _status.Text = e > 0 ? $"{e} field(s) have problems." : n > 0 ? $"{n} unsaved change(s)" : "No unsaved changes";
        _save.Enabled = n > 0 && e == 0;
        _discard.Enabled = n > 0;
    }

    private void Save()
    {
        bool startWin = _form.Rows.First(r => r.Def.Key == "startWithWindows").Modified;
        bool dataDir = _form.Rows.First(r => r.Def.Key == "dataDir").Modified;
        _form.ApplyToStore();
        try { App.Settings.Save(); }
        catch (Exception ex) { Dlg.Info(this, "Save failed", ex.Message); return; }
        if (startWin) Sys.SetStartWithWindows(App.Settings.Bool("startWithWindows"));
        App.Events.Add("settings", "Launcher settings saved");
        Update2();
        _groups.Invalidate();
        if (dataDir) Dlg.Info(this, "Restart the launcher", "The data folder changes after you restart Launcher.exe.");
    }

    public override void OnShown() { Update2(); }
}
