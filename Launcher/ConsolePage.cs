using System.Collections.Concurrent;
using System.Text;
using System.Text.RegularExpressions;

namespace MeshCrowd.Launcher;

public sealed class ConsolePage : Page
{
    private readonly RichTextBox _out = Ui.LogBox();
    private readonly DInput _cmd = new() { Placeholder = "Type a command, Tab completes, Up/Down = history, 'help' lists everything" };
    private readonly DInput _filter = new() { Placeholder = "Filter text" };
    private readonly DCombo _level = new() { Width = 150 };
    private readonly DButton _pause, _send;
    private readonly DLabel _info = new() { Wrap = false, ForeColor = Theme.Muted, Align = ContentAlignment.MiddleRight };
    private readonly Panel _bar = new() { Dock = DockStyle.Top, Height = 54 };
    private readonly Panel _bottom = new() { Dock = DockStyle.Bottom, Height = 62 };
    private readonly ConcurrentQueue<LogLine> _queue = new();
    private readonly System.Windows.Forms.Timer _flush = new() { Interval = 120 };
    private readonly List<string> _history = new();
    private int _histPos;
    private bool _paused;
    private string[] _completions = [];
    private int _compIdx = -1;
    private string _compBase = "";
    private int _shown;

    public ConsolePage()
    {
        Title = "Console";
        Subtitle = "Live server log and the interactive admin console (the same commands as a terminal window).";
        _level.Items = ["All messages", "Info and above", "Warnings and errors", "Errors only"];
        _level.SelectedIndex = 0;
        _level.SelectedChanged += (_, _) => Rerender();
        Tip.Set(_level, "Log level filter", "Only changes what is shown here. The server's own log level is a setting (Config > Logging) or the 'log level' command.");
        _filter.Width = 260;
        _filter.TextChanged += (_, _) => Rerender();
        Tip.Set(_filter, "Text filter", "Shows only lines containing this text (case-insensitive). Prefix with re: for a regular expression.");
        _pause = Ui.Button("Pause", BtnKind.Secondary, G.Pause, TogglePause, "Pause / resume output", "Freezes the view so you can read. New lines keep being collected and appear when you resume.");
        var clear = Ui.Button("Clear", BtnKind.Secondary, G.Clear, () => { _out.Clear(); _shown = 0; }, "Clear the view", "Only clears this window. Logs on disk and the buffer stay.");
        var copy = Ui.Button("Copy", BtnKind.Secondary, G.Copy, () => { try { Clipboard.SetText(_out.Text); } catch { } }, "Copy the visible text");
        var save = Ui.Button("Save...", BtnKind.Secondary, G.Save, SaveAs, "Save the visible text to a file");
        _bar.Controls.AddRange([_level, _filter, _pause, clear, copy, save, _info]);
        _bar.Resize += (_, _) =>
        {
            int x = 24, y = 11;
            _level.Location = new Point(x, y); x += _level.Width + 8;
            _filter.Location = new Point(x, y); x += _filter.Width + 8;
            foreach (var b in new[] { _pause, clear, copy, save }) { b.Location = new Point(x, y); x += b.Width + 6; }
            _info.SetBounds(x + 6, 0, Math.Max(40, _bar.Width - x - 30), _bar.Height);
        };

        _out.Dock = DockStyle.Fill;
        _out.Margin = new Padding(0);
        var pad = new Panel { Dock = DockStyle.Fill, Padding = new Padding(24, 0, 24, 0) };
        pad.Controls.Add(_out);

        _send = Ui.Button("Send", BtnKind.Primary, G.Send, SendCommand, "Run the command", "Enter does the same.");
        var prompt = new DLabel { Text = "›", Font = new Font("Segoe UI", 18f), ForeColor = Theme.Accent, Size = new Size(20, 32), Wrap = false, Align = ContentAlignment.MiddleCenter };
        _bottom.Controls.AddRange([prompt, _cmd, _send]);
        _bottom.Resize += (_, _) =>
        {
            prompt.Location = new Point(24, 15);
            _send.Location = new Point(_bottom.Width - 24 - _send.Width, 15);
            _cmd.SetBounds(48, 15, _bottom.Width - 48 - 24 - _send.Width - 8, 32);
        };
        _cmd.EnterPressed += (_, _) => SendCommand();
        _cmd.KeyDown += CmdKey;

        Controls.Add(pad);
        Controls.Add(_bottom);
        Controls.Add(_bar);

        var ctx = DarkMenu.Create();
        ctx.Items.Add("Copy", null, (_, _) => { if (_out.SelectionLength > 0) Clipboard.SetText(_out.SelectedText); });
        ctx.Items.Add("Select all", null, (_, _) => _out.SelectAll());
        _out.ContextMenuStrip = ctx;

        App.Host.LineAdded += l => _queue.Enqueue(l);
        _flush.Tick += (_, _) => Flush();
        _flush.Start();
        Rerender();
    }

    private void TogglePause()
    {
        _paused = !_paused;
        _pause.Text = _paused ? "Resume" : "Pause";
        _pause.Glyph = _paused ? G.Play : G.Pause;
        _pause.Kind = _paused ? BtnKind.Primary : BtnKind.Secondary;
        _pause.Invalidate();
        _info.Text = _paused ? "paused" : "";
    }

    private bool Pass(LogLine l)
    {
        int lv = _level.SelectedIndex;
        bool core = l.Level is "OUT" or "SYS" or "CMD";
        if (!core && ((lv >= 1 && l.Level == "DEBUG") || (lv >= 2 && l.Level == "INFO") || (lv >= 3 && l.Level == "WARN"))) return false;
        var f = _filter.Text.Trim();
        if (f.Length == 0) return true;
        if (f.StartsWith("re:"))
        {
            try { return Regex.IsMatch(l.Raw, f[3..], RegexOptions.IgnoreCase); } catch { return true; }
        }
        return l.Raw.Contains(f, StringComparison.OrdinalIgnoreCase);
    }

    private static Color ColorOf(LogLine l) => l.Level switch
    {
        "ERROR" => Theme.Red,
        "WARN" => Theme.Yellow,
        "DEBUG" => Color.FromArgb(0x6D, 0x72, 0x7B),
        "SYS" => Theme.Link,
        "OUT" => Color.FromArgb(0x7B, 0xE0, 0xA0),
        "CMD" => Color.FromArgb(0xA5, 0xAE, 0xFF),
        _ => Theme.Text
    };

    private static string Fmt(LogLine l) => l.Level switch
    {
        "OUT" => l.Message,
        "CMD" => "› " + l.Message,
        "SYS" => $"{l.Time:HH:mm:ss} --  {l.Message}",
        _ => $"{l.Time:HH:mm:ss} {l.Level,-5} [{l.Category}] {l.Message}"
    };

    private void Rerender()
    {
        _out.Suspend();
        _out.Clear();
        _shown = 0;
        foreach (var l in App.Host.Snapshot().TakeLast(4000)) if (Pass(l)) Append(l);
        _out.Resume();
        _out.ScrollToEnd();
    }

    private void Append(LogLine l)
    {
        _out.SelectionStart = _out.TextLength;
        _out.SelectionLength = 0;
        _out.SelectionColor = ColorOf(l);
        _out.AppendText(Fmt(l) + "\n");
        _shown++;
    }

    private void Flush()
    {
        if (_paused || _queue.IsEmpty) return;
        bool follow = _out.AtBottom();
        _out.Suspend();
        int n = 0;
        while (n < 600 && _queue.TryDequeue(out var l))
        {
            n++;
            if (Pass(l)) Append(l);
        }
        int max = Math.Max(500, App.Settings.Int("logBufferLines"));
        if (_shown > max + 500)
        {
            int cut = _out.GetFirstCharIndexFromLine(_shown - max);
            if (cut > 0) { _out.Select(0, cut); _out.SelectedText = ""; _shown = max; }
        }
        _out.Resume();
        if (follow) _out.ScrollToEnd();
    }

    private void SaveAs()
    {
        using var d = new SaveFileDialog { Filter = "Text (*.txt)|*.txt", FileName = $"meshcrowd-console-{DateTime.Now:yyyyMMdd-HHmmss}.txt" };
        if (d.ShowDialog(FindForm()) == DialogResult.OK) { try { File.WriteAllText(d.FileName, _out.Text, Encoding.UTF8); } catch (Exception e) { Dlg.Info(this, "Save failed", e.Message); } }
    }

    public void Prefill(string line, bool run)
    {
        _cmd.Text = line;
        _cmd.Inner.SelectionStart = line.Length;
        _cmd.Focus();
        if (run) SendCommand();
    }

    public void SendCommand()
    {
        var line = _cmd.Text.Trim();
        if (line == "") return;
        _cmd.Text = "";
        _history.Remove(line);
        _history.Add(line);
        if (_history.Count > 200) _history.RemoveAt(0);
        _histPos = _history.Count;
        var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var shown = parts.Length >= 3 && parts[0] == "account" && parts[1] is "create" or "passwd" ? string.Join(' ', parts.Take(parts.Length - 1)) + " ***" : line;
        App.Host.PostLine(new LogLine(DateTime.Now, "CMD", "console", shown, shown));
        if (App.Host.State != SState.Running)
        {
            App.Host.PostLine(new LogLine(DateTime.Now, "SYS", "launcher", "the server is not running: start it on the Dashboard first", ""));
            return;
        }
        if (line is "exit" or "quit") { App.Host.PostLine(new LogLine(DateTime.Now, "SYS", "launcher", "the launcher console stays attached. Close the window to leave.", "")); return; }
        try { App.Host.Send(line); } catch (Exception e) { App.Host.PostLine(new LogLine(DateTime.Now, "SYS", "launcher", e.Message, "")); }
    }

    private void CmdKey(object? sender, KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Up && _history.Count > 0) { _histPos = Math.Max(0, _histPos - 1); _cmd.Text = _history[_histPos]; _cmd.Inner.SelectionStart = _cmd.Text.Length; e.Handled = true; }
        else if (e.KeyCode == Keys.Down && _history.Count > 0) { _histPos = Math.Min(_history.Count, _histPos + 1); _cmd.Text = _histPos < _history.Count ? _history[_histPos] : ""; _cmd.Inner.SelectionStart = _cmd.Text.Length; e.Handled = true; }
        else if (e.KeyCode == Keys.Escape) { _cmd.Text = ""; }
        else if (e.KeyCode == Keys.Tab)
        {
            e.SuppressKeyPress = true; e.Handled = true;
            if (_compIdx < 0 || _completions.Length == 0)
            {
                _compBase = _cmd.Text.TrimStart();
                _completions = App.Commands.SelectMany(c => new[] { c.name }.Concat(c.aliases)).Where(n => n.StartsWith(_compBase, StringComparison.OrdinalIgnoreCase)).Distinct().OrderBy(n => n).ToArray();
                _compIdx = -1;
            }
            if (_completions.Length == 0) return;
            _compIdx = (_compIdx + 1) % _completions.Length;
            _cmd.TextChanged -= ResetComp;
            _cmd.Text = _completions[_compIdx] + " ";
            _cmd.Inner.SelectionStart = _cmd.Text.Length;
            _cmd.TextChanged += ResetComp;
        }
    }

    private void ResetComp(object? s, EventArgs e) { _compIdx = -1; _completions = []; }

    public override void OnShown()
    {
        _cmd.TextChanged -= ResetComp;
        _cmd.TextChanged += ResetComp;
        _cmd.Focus();
        _out.ScrollToEnd();
    }
}
