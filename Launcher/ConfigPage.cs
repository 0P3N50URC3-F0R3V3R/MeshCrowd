using System.Text;
using System.Text.Json.Nodes;

namespace MeshCrowd.Launcher;

public sealed class ConfigPage : Page
{
    private readonly JsonStore _store = new(Paths.ConfigFile);
    private SettingsForm _form = null!;
    private readonly DList _groups = new() { Dock = DockStyle.Fill };
    private readonly DInput _search = new() { Placeholder = "Search every setting..." };
    private readonly Panel _bar = new() { Dock = DockStyle.Top, Height = 58, BackColor = Theme.Bg2 };
    private readonly DLabel _status = new() { Wrap = false, ForeColor = Theme.Muted, Align = ContentAlignment.MiddleLeft };
    private readonly DButton _save, _saveRestart, _discard, _raw, _more;
    private readonly Panel _body = new() { Dock = DockStyle.Fill };
    private readonly Panel _rawPanel = new() { Dock = DockStyle.Fill, Visible = false, BackColor = Theme.Bg2 };
    private readonly DInput _rawText = new() { Multiline = true, MonoFont = true, WrapLines = false };
    private readonly Panel _banner = new() { Dock = DockStyle.Top, Height = 38, Visible = false, BackColor = Color.FromArgb(0x5C, 0x45, 0x10) };
    private DateTime _loadedWrite;
    private readonly System.Windows.Forms.Timer _watch = new() { Interval = 2500 };

    public ConfigPage()
    {
        Title = "Server configuration";
        Subtitle = "Edits data\\config.json. Hover the ? icon of any field for the full documentation.";
        _store.Load();
        _form = new SettingsForm(_store, Fields.Server, Fields.GroupInfo) { Dock = DockStyle.Fill };

        var side = new Panel { Dock = DockStyle.Left, Width = 230, BackColor = Theme.Bg1, Padding = new Padding(12, 12, 12, 12) };
        _search.Dock = DockStyle.Top;
        _groups.Dock = DockStyle.Fill;
        _groups.Items.AddRange(Fields.ServerGroups.Cast<object>().ToArray());
        _groups.HeightOf = _ => 34;
        _groups.DrawRow = (g, b, o, sel) =>
        {
            var name = (string)o;
            int mods = _form.Rows.Count(r => r.Def.Group == name && r.Modified);
            int errs = _form.Rows.Count(r => r.Def.Group == name && r.Error != null);
            if (sel) { using var br = new SolidBrush(Theme.Accent); g.FillRectangle(br, b.X, b.Y + 4, 3, b.Height - 8); }
            TextRenderer.DrawText(g, name, Theme.Ui, new Rectangle(b.X + 12, b.Y, b.Width - 50, b.Height), sel ? Theme.TextBright : Theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            if (errs > 0) TextRenderer.DrawText(g, "●", Theme.UiSmall, new Rectangle(b.Right - 26, b.Y, 20, b.Height), Theme.Red, TextFormatFlags.VerticalCenter | TextFormatFlags.HorizontalCenter);
            else if (mods > 0) TextRenderer.DrawText(g, "●", Theme.UiSmall, new Rectangle(b.Right - 26, b.Y, 20, b.Height), Theme.Yellow, TextFormatFlags.VerticalCenter | TextFormatFlags.HorizontalCenter);
        };
        _groups.SelectedIndexChanged += (_, _) =>
        {
            if (_groups.SelectedIndex < 0) return;
            if (_search.Text != "") { _search.Text = ""; }
            _form.ShowGroup((string)_groups.SelectedItem!);
        };
        var gap = new Panel { Dock = DockStyle.Top, Height = 8, BackColor = Theme.Bg1 };
        side.Controls.Add(_groups);
        side.Controls.Add(gap);
        side.Controls.Add(_search);

        _save = Ui.Button("Save", BtnKind.Success, G.Save, () => Save(false), "Save to data\\config.json", "Validates everything, shows what changed, makes a backup of the old file and writes the new one. Live settings are applied immediately.");
        _saveRestart = Ui.Button("Save & restart", BtnKind.Primary, G.Restart, () => Save(true), "Save and restart the server", "Saves like Save, then restarts the running server with a countdown announced to online users.");
        _discard = Ui.Button("Discard", BtnKind.Secondary, G.Undo, DiscardAll, "Throw away unsaved edits", "Reloads every field from the file on disk.");
        _raw = Ui.Button("Raw JSON", BtnKind.Secondary, G.Page, () => ToggleRaw(true), "Edit the file as text", "For advanced use. Unknown keys are preserved either way.");
        _more = Ui.Button("More", BtnKind.Secondary, G.Down, ShowMore, "More actions", "Restore a backup, import/export, reset a section, open the file.");
        _bar.Controls.AddRange([_status, _more, _raw, _discard, _saveRestart, _save]);
        _bar.Resize += (_, _) => LayoutBar();
        _bar.Paint += (_, e) => { using var p = new Pen(Theme.Divider); e.Graphics.DrawLine(p, 0, _bar.Height - 1, _bar.Width, _bar.Height - 1); };

        var bannerText = new DLabel { Text = "data\\config.json changed on disk (the server or another editor wrote it).", ForeColor = Theme.Yellow, Location = new Point(16, 0), Height = 38, Width = 700, Wrap = false, Align = ContentAlignment.MiddleLeft };
        var reload = Ui.Button("Reload", BtnKind.Secondary, G.Refresh, () => { Reload(); }, null);
        reload.Location = new Point(740, 3);
        _banner.Controls.AddRange([bannerText, reload]);

        _rawPanel.Padding = new Padding(24);
        var rawBar = new Panel { Dock = DockStyle.Top, Height = 44, BackColor = Theme.Bg2 };
        var rawTitle = new DLabel { Text = "Raw data\\config.json", Font = Theme.UiTitle, ForeColor = Theme.TextBright, Location = new Point(0, 4), Size = new Size(300, 30), Wrap = false };
        var rawSave = Ui.Button("Validate & save file", BtnKind.Success, G.Save, SaveRaw);
        var rawBack = Ui.Button("Back to form", BtnKind.Secondary, G.Undo, () => ToggleRaw(false));
        rawBar.Controls.AddRange([rawTitle, rawBack, rawSave]);
        rawBar.Resize += (_, _) => { rawSave.Location = new Point(rawBar.Width - rawSave.Width, 0); rawBack.Location = new Point(rawSave.Left - rawBack.Width - 8, 0); };
        _rawText.Dock = DockStyle.Fill;
        _rawPanel.Controls.Add(_rawText);
        _rawPanel.Controls.Add(rawBar);

        _body.Controls.Add(_form);
        _body.Controls.Add(_rawPanel);
        _body.Controls.Add(_banner);
        _body.Controls.Add(_bar);
        Controls.Add(_body);
        Controls.Add(side);

        _form.Modified += () => { UpdateStatus(); _groups.Invalidate(); };
        _search.TextChanged += (_, _) =>
        {
            if (_search.Text.Trim() == "") { if (_groups.SelectedIndex >= 0) _form.ShowGroup((string)_groups.SelectedItem!); }
            else { _groups.ClearSelected(); _form.SetFilter(_search.Text); }
        };
        _groups.SelectedIndex = 0;
        _loadedWrite = LastWrite();
        _watch.Tick += (_, _) => CheckDisk();
        UpdateStatus();
    }

    private void LayoutBar()
    {
        int h = _bar.Height;
        int x = _bar.Width - 24;
        foreach (var b in new[] { _save, _saveRestart, _discard, _raw, _more })
        {
            b.Location = new Point(x - b.Width, (h - b.Height) / 2);
            x = b.Left - 8;
        }
        _status.SetBounds(24, 0, Math.Max(100, x - 24), h);
    }

    private static DateTime LastWrite() { try { return File.GetLastWriteTimeUtc(Paths.ConfigFile); } catch { return DateTime.MinValue; } }

    public override void OnShown()
    {
        _watch.Start();
        LayoutBar();
        CheckDisk();
        App.Host.StateChanged += UpdateStatusSafe;
    }

    public override void OnHidden() { _watch.Stop(); App.Host.StateChanged -= UpdateStatusSafe; }

    private void UpdateStatusSafe() => OnUi(UpdateStatus);

    private void CheckDisk()
    {
        var w = LastWrite();
        if (w == _loadedWrite) return;
        var probe = new JsonStore(Paths.ConfigFile);
        probe.Load();
        if (probe.LoadError == null && probe.ToText() == _store.ToText()) { _loadedWrite = w; return; }
        if (!_form.IsDirty && !_rawPanel.Visible) { Reload(); return; }
        _banner.Visible = true;
    }

    private void Reload()
    {
        _store.Load();
        _loadedWrite = LastWrite();
        _form.Reload();
        _banner.Visible = false;
        _groups.Invalidate();
        UpdateStatus();
        if (_rawPanel.Visible) _rawText.Text = _store.ToText();
    }

    private void DiscardAll()
    {
        if (_form.IsDirty && !Dlg.Confirm(this, "Discard changes", "Throw away all unsaved edits?", "Discard", true)) return;
        Reload();
    }

    private void UpdateStatus()
    {
        int n = _form.Rows.Count(r => r.Modified);
        int errs = _form.Rows.Count(r => r.Error != null);
        _status.ForeColor = errs > 0 ? Theme.Red : n > 0 ? Theme.Yellow : Theme.Muted;
        _status.Text = errs > 0 ? $"{errs} field(s) have problems. Fix them before saving." : n > 0 ? $"{n} unsaved change(s)" : _store.LoadError != null ? "config.json is not valid JSON: " + _store.LoadError : "No unsaved changes";
        _save.Enabled = n > 0 && errs == 0;
        _saveRestart.Enabled = n > 0 && errs == 0 && App.Host.State == SState.Running;
        _discard.Enabled = n > 0;
    }

    private static string Show(FieldDef f, JsonNode? v)
    {
        if (f.Type == FType.Secret) return string.IsNullOrEmpty(v?.ToString()) ? "(empty)" : "***";
        var t = v?.ToJsonString() ?? "null";
        return t.Length > 90 ? t[..90] + "..." : t;
    }

    private bool PreSave(out List<(FieldDef def, JsonNode? oldV, JsonNode? newV)> changes)
    {
        changes = _form.Changes();
        var errs = _form.Errors();
        if (errs.Count > 0)
        {
            Dlg.Info(this, "Cannot save", string.Join("\n", errs.Take(8).Select(e => $"- {e.row.Def.Label}: {e.error}")));
            _form.ShowRow(errs[0].row);
            _groups.SelectedItem = errs[0].row.Def.Group;
            return false;
        }
        var probe = new JsonStore("");
        probe.SetRoot((JsonObject)JsonNode.Parse(_store.Root.ToJsonString())!);
        foreach (var r in _form.Rows) probe.Set(r.Def.Key, r.Value());
        var cross = Validate.Cross(probe);
        if (cross.Count > 0) { Dlg.Info(this, "Settings conflict", string.Join("\n", cross.Select(c => "- " + c))); return false; }
        return true;
    }

    private void Save(bool restart)
    {
        if (!PreSave(out var changes) || changes.Count == 0) return;
        var sb = new StringBuilder();
        foreach (var (def, o, n) in changes)
            sb.AppendLine($"{def.Key}\n    {Show(def, o)}  ->  {Show(def, n)}{(def.Restart ? "   [restart needed]" : "   [live]")}\n");
        int needRestart = changes.Count(c => c.def.Restart);
        var head = $"{changes.Count} change(s) will be written to data\\config.json" + (needRestart > 0 ? $" ({needRestart} need a server restart)" : "");
        if (!Dlg2.Review(this, "Review changes", head, sb.ToString(), restart ? "Save & restart" : "Save")) return;
        try
        {
            BackupFile();
            _store.Load();
            _form.ApplyToStore();
            _store.Save();
            _loadedWrite = LastWrite();
            App.Events.Add("config", $"Configuration saved ({changes.Count} change(s))", string.Join(", ", changes.Select(c => c.def.Key)));
            if (App.Host.State == SState.Running)
                foreach (var (def, _, n) in changes.Where(c => !c.def.Restart))
                {
                    try { App.Host.Send(def.Key == "logging.level" ? $"log level {n}" : $"config set {def.Key} {n}"); } catch { }
                }
        }
        catch (Exception e) { Dlg.Info(this, "Save failed", e.Message); return; }
        _banner.Visible = false;
        _groups.Invalidate();
        UpdateStatus();
        if (App.Host.IsActive && needRestart > 0)
        {
            if (restart || Dlg.Confirm(this, "Restart needed", $"{needRestart} changed setting(s) only apply after a restart. Restart the server now?\nOnline users get a countdown of {App.Settings.Int("restartWarnSeconds")} s.", "Restart now"))
                App.Host.RestartGraceful(App.Settings.Int("restartWarnSeconds"));
        }
    }

    private static void BackupFile()
    {
        try
        {
            if (!File.Exists(Paths.ConfigFile)) return;
            Directory.CreateDirectory(Paths.ConfigBackupsDir);
            File.Copy(Paths.ConfigFile, Path.Combine(Paths.ConfigBackupsDir, $"config-{DateTime.Now:yyyyMMdd-HHmmss}.json"), true);
            foreach (var old in Directory.GetFiles(Paths.ConfigBackupsDir, "config-*.json").OrderByDescending(x => x).Skip(30)) File.Delete(old);
        }
        catch { }
    }

    private void ToggleRaw(bool on)
    {
        if (on)
        {
            if (_form.IsDirty && !Dlg.Confirm(this, "Unsaved form edits", "The raw editor shows the file on disk. Unsaved form edits will be lost. Continue?", "Continue")) return;
            Reload();
            _rawText.Text = _store.ToText();
        }
        _rawPanel.Visible = on;
        _form.Visible = !on;
        _raw.Enabled = !on;
        if (on) _rawPanel.BringToFront();
    }

    private void SaveRaw()
    {
        JsonObject? obj;
        try { obj = JsonNode.Parse(_rawText.Text, null, new System.Text.Json.JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = System.Text.Json.JsonCommentHandling.Skip }) as JsonObject; }
        catch (Exception e) { Dlg.Info(this, "Invalid JSON", e.Message); return; }
        if (obj == null) { Dlg.Info(this, "Invalid JSON", "The top level must be an object { ... }."); return; }
        var probe = new JsonStore(""); probe.SetRoot(obj);
        var problems = new List<string>();
        foreach (var f in Fields.Server)
        {
            var v = probe.Get(f.Key);
            if (v == null) continue;
            var err = Validate.Field(f, v);
            if (err != null) problems.Add($"{f.Key}: {err}");
        }
        problems.AddRange(Validate.Cross(probe));
        if (problems.Count > 0 && !Dlg.Confirm(this, "Validation warnings", string.Join("\n", problems.Take(10).Select(p => "- " + p)) + "\n\nSave anyway? The server may refuse to start.", "Save anyway", true)) return;
        try
        {
            BackupFile();
            _store.SetRoot(obj);
            _store.Save();
            App.Events.Add("config", "Configuration saved from the raw editor");
            Reload();
            _rawText.Text = _store.ToText();
            Dlg.Info(this, "Saved", "data\\config.json written. A backup of the previous file was kept.");
        }
        catch (Exception e) { Dlg.Info(this, "Save failed", e.Message); }
    }

    private void ShowMore()
    {
        var m = DarkMenu.Create();
        m.Items.Add("Restore a previous version...", null, (_, _) => RestoreBackup());
        m.Items.Add("Import values from a file...", null, (_, _) => Import());
        m.Items.Add("Export (secrets removed)...", null, (_, _) => Export());
        m.Items.Add(new ToolStripSeparator());
        m.Items.Add("Reset this section to defaults", null, (_, _) => { if (_groups.SelectedItem is string g && Dlg.Confirm(this, "Reset section", $"Set every field of \"{g}\" back to its default? (Not saved until you press Save.)", "Reset", true)) _form.ResetGroupToDefaults(g); });
        m.Items.Add(new ToolStripSeparator());
        m.Items.Add("Open config.json in editor", null, (_, _) => Sys.OpenFile(Paths.ConfigFile));
        m.Items.Add("Open data folder", null, (_, _) => Sys.OpenFolder(Paths.DataDir));
        foreach (ToolStripItem i in m.Items) i.ForeColor = Theme.Text;
        m.Show(_more, new Point(0, _more.Height + 2));
    }

    private void LoadValuesFrom(string path)
    {
        try
        {
            var src = new JsonStore(path);
            src.Load();
            if (src.LoadError != null) { Dlg.Info(this, "Not valid JSON", src.LoadError); return; }
            int n = 0;
            foreach (var r in _form.Rows)
            {
                var v = src.Get(r.Def.Key);
                if (v == null) continue;
                r.SetValue(v);
                n++;
            }
            Dlg.Info(this, "Loaded into the form", $"{n} value(s) were copied into the form. Review them and press Save to write them.");
        }
        catch (Exception e) { Dlg.Info(this, "Failed", e.Message); }
    }

    private void RestoreBackup()
    {
        Directory.CreateDirectory(Paths.ConfigBackupsDir);
        using var d = new OpenFileDialog { InitialDirectory = Paths.ConfigBackupsDir, Filter = "Config backups (*.json)|*.json", Title = "Choose a previous config version" };
        if (d.ShowDialog(FindForm()) == DialogResult.OK) LoadValuesFrom(d.FileName);
    }

    private void Import()
    {
        using var d = new OpenFileDialog { Filter = "JSON (*.json)|*.json|All files|*.*", Title = "Import config values" };
        if (d.ShowDialog(FindForm()) == DialogResult.OK) LoadValuesFrom(d.FileName);
    }

    private void Export()
    {
        using var d = new SaveFileDialog { Filter = "JSON (*.json)|*.json", FileName = "meshcrowd-config.json" };
        if (d.ShowDialog(FindForm()) != DialogResult.OK) return;
        try
        {
            var copy = new JsonStore("");
            copy.SetRoot((JsonObject)JsonNode.Parse(_store.Root.ToJsonString())!);
            foreach (var f in Fields.Server.Where(f => f.Type == FType.Secret)) if (copy.Get(f.Key) != null) copy.Set(f.Key, JsonValue.Create(""));
            File.WriteAllText(d.FileName, copy.ToText());
        }
        catch (Exception e) { Dlg.Info(this, "Export failed", e.Message); }
    }
}
