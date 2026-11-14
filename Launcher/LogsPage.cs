using System.Text;
using System.Text.RegularExpressions;

namespace MeshCrowd.Launcher;

public sealed class LogsPage : Page
{
    private readonly DList _files = new() { Dock = DockStyle.Fill };
    private readonly RichTextBox _view = Ui.LogBox();
    private readonly DCombo _level = new() { Width = 150 };
    private readonly DInput _filter = new() { Width = 260, Placeholder = "Filter text (re:regex)" };
    private readonly DToggle _follow = new() { Checked = true };
    private readonly DLabel _info = new() { Wrap = false, ForeColor = Theme.Muted, Align = ContentAlignment.MiddleRight };
    private readonly Panel _bar = new() { Dock = DockStyle.Top, Height = 54 };
    private readonly System.Windows.Forms.Timer _tail = new() { Interval = 1500 };
    private string? _path;
    private long _pos;
    private readonly List<string> _lines = new();
    private static readonly Regex Re = new(@"^\[(\d{4}-\d\d-\d\dT[\d:.]+Z?)\] \[(DEBUG|INFO|WARN|ERROR)\] \[([^\]]*)\] (.*)$");

    private sealed record FileItem(string Path, string Name, long Size, DateTime Time);

    public LogsPage()
    {
        Title = "Logs";
        Subtitle = "Browse the server's log files in data\\logs (rotated per day and size).";
        var side = new Panel { Dock = DockStyle.Left, Width = 280, BackColor = Theme.Bg1, Padding = new Padding(12) };
        var top = new Panel { Dock = DockStyle.Top, Height = 44, BackColor = Theme.Bg1 };
        var refresh = Ui.Button("Refresh", BtnKind.Secondary, G.Refresh, LoadFiles, "Rescan the log folder");
        var folder = Ui.Button("Folder", BtnKind.Secondary, G.Folder, () => Sys.OpenFolder(Paths.LogsDir), "Open data\\logs in Explorer");
        var del = Ui.Button("", BtnKind.Ghost, G.Delete, DeleteSelected, "Delete the selected log file", "Cannot be undone. The server keeps writing to today's file.");
        top.Controls.AddRange([refresh, folder, del]);
        folder.Location = new Point(refresh.Right + 6, 0); del.Location = new Point(folder.Right + 6, 0);
        _files.HeightOf = _ => 46;
        _files.DrawRow = (g, b, o, sel) =>
        {
            var f = (FileItem)o;
            if (sel) { using var br = new SolidBrush(Theme.Accent); g.FillRectangle(br, b.X, b.Y + 4, 3, b.Height - 8); }
            TextRenderer.DrawText(g, f.Name, Theme.Ui, new Rectangle(b.X + 12, b.Y + 5, b.Width - 20, 20), sel ? Theme.TextBright : Theme.Text, TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            TextRenderer.DrawText(g, $"{Ui.FormatSize(f.Size)}   {f.Time:yyyy-MM-dd HH:mm}", Theme.UiSmall, new Rectangle(b.X + 12, b.Y + 25, b.Width - 20, 16), Theme.Muted, TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
        };
        _files.SelectedIndexChanged += (_, _) => { if (_files.SelectedItem is FileItem f) Open(f.Path); };
        side.Controls.Add(_files);
        side.Controls.Add(new Panel { Dock = DockStyle.Top, Height = 8, BackColor = Theme.Bg1 });
        side.Controls.Add(top);

        _level.Items = ["All messages", "Info and above", "Warnings and errors", "Errors only"];
        _level.SelectedIndex = 0;
        _level.SelectedChanged += (_, _) => Render();
        _filter.TextChanged += (_, _) => Render();
        var followLbl = new DLabel { Text = "Follow", Wrap = false, Size = new Size(50, 24), Align = ContentAlignment.MiddleLeft };
        Tip.Set(_follow, "Follow the file", "Reloads new lines every 1.5 seconds and scrolls to the end.");
        var exp = Ui.Button("Export view...", BtnKind.Secondary, G.Export, Export, "Save the filtered lines to a file");
        _bar.Controls.AddRange([_level, _filter, _follow, followLbl, exp, _info]);
        _bar.Resize += (_, _) =>
        {
            int x = 24, y = 11;
            _level.Location = new Point(x, y); x += _level.Width + 8;
            _filter.Location = new Point(x, y); x += _filter.Width + 12;
            _follow.Location = new Point(x, y + 4); x += _follow.Width + 6;
            followLbl.Location = new Point(x, y + 4); x += followLbl.Width + 8;
            exp.Location = new Point(x, y); x += exp.Width + 8;
            _info.SetBounds(x, 0, Math.Max(40, _bar.Width - x - 30), _bar.Height);
        };
        _view.Dock = DockStyle.Fill;
        var pad = new Panel { Dock = DockStyle.Fill, Padding = new Padding(24, 0, 24, 24) };
        pad.Controls.Add(_view);
        Controls.Add(pad);
        Controls.Add(_bar);
        Controls.Add(side);
        _tail.Tick += (_, _) => Tail();
    }

    private void LoadFiles()
    {
        var keep = (_files.SelectedItem as FileItem)?.Path;
        _files.BeginUpdate();
        _files.Items.Clear();
        try
        {
            foreach (var fi in new DirectoryInfo(Paths.LogsDir).GetFiles("*.log").OrderByDescending(f => f.LastWriteTime))
                _files.Items.Add(new FileItem(fi.FullName, fi.Name, fi.Length, fi.LastWriteTime));
        }
        catch { }
        _files.EndUpdate();
        var again = _files.Items.Cast<FileItem>().FirstOrDefault(f => f.Path == keep);
        if (again != null) _files.SelectedItem = again;
        else if (_files.Items.Count > 0) _files.SelectedIndex = 0;
    }

    private void Open(string path)
    {
        _path = path; _pos = 0; _lines.Clear();
        ReadMore();
        Render();
    }

    private void ReadMore()
    {
        if (_path == null) return;
        try
        {
            using var fs = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            if (fs.Length < _pos) { _pos = 0; _lines.Clear(); }
            if (_pos == 0 && fs.Length > 40_000_000) _pos = fs.Length - 40_000_000;
            fs.Seek(_pos, SeekOrigin.Begin);
            using var r = new StreamReader(fs, Encoding.UTF8);
            string? line;
            while ((line = r.ReadLine()) != null) _lines.Add(line);
            _pos = fs.Length;
            if (_lines.Count > 300_000) _lines.RemoveRange(0, _lines.Count - 250_000);
        }
        catch { }
    }

    private void Tail()
    {
        if (!_follow.Checked || _path == null) return;
        long before = _lines.Count;
        ReadMore();
        if (_lines.Count != before) Render();
    }

    private bool Pass(string line, out string level)
    {
        level = "";
        var m = Re.Match(line);
        if (m.Success) level = m.Groups[2].Value;
        int lv = _level.SelectedIndex;
        if (level != "" && ((lv >= 1 && level == "DEBUG") || (lv >= 2 && level == "INFO") || (lv >= 3 && level == "WARN"))) return false;
        if (level == "" && lv >= 2) return false;
        var f = _filter.Text.Trim();
        if (f == "") return true;
        if (f.StartsWith("re:")) { try { return Regex.IsMatch(line, f[3..], RegexOptions.IgnoreCase); } catch { return true; } }
        return line.Contains(f, StringComparison.OrdinalIgnoreCase);
    }

    private void Render()
    {
        _view.Suspend();
        _view.Clear();
        int shown = 0;
        var matched = new List<(string, string)>();
        foreach (var l in _lines) if (Pass(l, out var lv)) matched.Add((l, lv));
        foreach (var (l, lv) in matched.TakeLast(6000))
        {
            _view.SelectionStart = _view.TextLength;
            _view.SelectionColor = lv switch { "ERROR" => Theme.Red, "WARN" => Theme.Yellow, "DEBUG" => Color.FromArgb(0x6D, 0x72, 0x7B), _ => Theme.Text };
            _view.AppendText(l + "\n");
            shown++;
        }
        _view.Resume();
        if (_follow.Checked) _view.ScrollToEnd();
        _info.Text = $"{shown:N0} of {_lines.Count:N0} lines";
    }

    private void Export()
    {
        using var d = new SaveFileDialog { Filter = "Text (*.txt)|*.txt|Log (*.log)|*.log", FileName = "meshcrowd-log-view.txt" };
        if (d.ShowDialog(FindForm()) != DialogResult.OK) return;
        try { File.WriteAllLines(d.FileName, _lines.Where(l => Pass(l, out _))); } catch (Exception e) { Dlg.Info(this, "Export failed", e.Message); }
    }

    private void DeleteSelected()
    {
        if (_files.SelectedItem is not FileItem f) return;
        if (!Dlg.Confirm(this, "Delete log file", $"Delete {f.Name}?", "Delete", true)) return;
        try { File.Delete(f.Path); _path = null; _lines.Clear(); LoadFiles(); Render(); } catch (Exception e) { Dlg.Info(this, "Delete failed", e.Message); }
    }

    public override void OnShown() { LoadFiles(); _tail.Start(); }
    public override void OnHidden() { _tail.Stop(); }
}
