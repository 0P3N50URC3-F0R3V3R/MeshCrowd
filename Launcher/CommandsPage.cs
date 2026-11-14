using System.Text;
using System.Text.RegularExpressions;

namespace MeshCrowd.Launcher;

public sealed class CommandsPage : Page
{
    private sealed record ArgSpec(string Label, bool Optional, string[]? Choices, bool Flag, string? Default, bool Secret, string Raw);

    private readonly DList _list = new() { Dock = DockStyle.Fill };
    private readonly DInput _search = new() { Placeholder = "Search commands..." };
    private readonly ScrollPanel _detail = new() { Dock = DockStyle.Fill };
    private readonly RichTextBox _result = Ui.LogBox();
    private CmdDef? _cur;
    private readonly List<(ArgSpec spec, Control ctl)> _args = new();
    private DButton? _run, _toConsole, _copy;
    private readonly DLabel _empty = new() { Text = "Pick a command on the left.", ForeColor = Theme.Muted };

    private static readonly Dictionary<string, string> AreaTitle = new()
    {
        ["general"] = "General", ["account"] = "Accounts", ["moderation"] = "Moderation", ["config"] = "Configuration", ["backup"] = "Backups",
        ["purge"] = "Factory reset", ["server"] = "Server", ["log"] = "Logs", ["ssh"] = "SSH console"
    };

    public CommandsPage()
    {
        Title = "Commands";
        Subtitle = "Every console command with its documentation. Fill in the arguments and run it, or send it to the console.";
        var side = new Panel { Dock = DockStyle.Left, Width = 300, BackColor = Theme.Bg1, Padding = new Padding(12) };
        _search.Dock = DockStyle.Top;
        _search.TextChanged += (_, _) => Fill();
        side.Controls.Add(_list);
        side.Controls.Add(new Panel { Dock = DockStyle.Top, Height = 8, BackColor = Theme.Bg1 });
        side.Controls.Add(_search);
        _list.HeightOf = o => o is string ? 34 : 30;
        _list.DrawRow = (g, b, o, sel) =>
        {
            if (o is string area)
            {
                using var br = new SolidBrush(Theme.Bg1); g.FillRectangle(br, b);
                TextRenderer.DrawText(g, area.ToUpperInvariant(), Theme.UiSmall, new Rectangle(b.X + 8, b.Y + 8, b.Width - 16, b.Height - 8), Theme.Muted, TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.Bottom);
                return;
            }
            var c = (CmdDef)o;
            if (sel) { using var br = new SolidBrush(Theme.Accent); g.FillRectangle(br, b.X, b.Y + 4, 3, b.Height - 8); }
            TextRenderer.DrawText(g, c.name, Theme.Mono, new Rectangle(b.X + 14, b.Y, b.Width - 40, b.Height), sel ? Theme.TextBright : Theme.Text, TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            if (App.Dangerous.Contains(c.name)) TextRenderer.DrawText(g, "●", Theme.UiSmall, new Rectangle(b.Right - 26, b.Y, 20, b.Height), Theme.Red, TextFormatFlags.VerticalCenter | TextFormatFlags.HorizontalCenter);
        };
        _list.SelectedIndexChanged += (_, _) => { if (_list.SelectedItem is CmdDef c) Show(c); else if (_list.SelectedItem is string) { } };
        _detail.Controls.Add(_empty);
        _empty.SetBounds(32, 32, 400, 24);
        Controls.Add(_detail);
        Controls.Add(side);
        Fill();
    }

    private void Fill()
    {
        var q = _search.Text.Trim().ToLowerInvariant();
        _list.BeginUpdate();
        _list.Items.Clear();
        foreach (var grp in App.Commands.Where(c => q == "" || c.name.Contains(q) || c.summary.ToLowerInvariant().Contains(q) || c.aliases.Any(a => a.Contains(q))).GroupBy(c => c.area))
        {
            _list.Items.Add(AreaTitle.GetValueOrDefault(grp.Key, grp.Key));
            foreach (var c in grp) _list.Items.Add(c);
        }
        _list.EndUpdate();
        if (_cur != null && _list.Items.Contains(_cur)) _list.SelectedItem = _cur;
        else if (_cur == null && _list.Items.Count > 1) _list.SelectedIndex = 1;
    }

    private static List<ArgSpec> ParseUsage(CmdDef c)
    {
        var rest = c.usage.Length > c.name.Length && c.usage.StartsWith(c.name) ? c.usage[c.name.Length..].Trim() : "";
        var list = new List<ArgSpec>();
        foreach (Match m in Regex.Matches(rest, @"\[[^\]]*\]|<[^>]*>|\S+"))
        {
            var raw = m.Value;
            bool opt = raw.StartsWith("[");
            var inner = raw.Trim('[', ']', '<', '>');
            if (inner == "--yes") { list.Add(new ArgSpec("Skip the confirmation question", true, null, true, "--yes", false, raw)); continue; }
            string? def = null;
            var eq = Regex.Match(inner, @"^(\w+)=(.+)$");
            if (eq.Success) { inner = eq.Groups[1].Value; def = eq.Groups[2].Value; }
            string[]? choices = null;
            if (inner.Contains('|') && !raw.StartsWith("<"))
            {
                var parts = inner.Split('|');
                if (!(parts.Length == 2 && parts[0] == "command")) choices = parts;
            }
            list.Add(new ArgSpec(inner.Replace("|", " or "), opt, choices, false, def, inner.Contains("password", StringComparison.OrdinalIgnoreCase), raw));
        }
        return list;
    }

    private void Show(CmdDef c)
    {
        _cur = c;
        _detail.SuspendLayout();
        foreach (Control x in _detail.Controls.Cast<Control>().ToList()) { _detail.Controls.Remove(x); x.Dispose(); }
        _args.Clear();
        int w = Math.Max(400, _detail.ClientSize.Width - 64);
        int y = 28, x0 = 32;
        bool danger = App.Dangerous.Contains(c.name);

        var title = new DLabel { Text = c.name, Font = new Font("Consolas", 18f, FontStyle.Bold), ForeColor = Theme.TextBright, Location = new Point(x0, y), Size = new Size(w, 34), Wrap = false };
        _detail.Controls.Add(title);
        y += 40;
        int bx = x0;
        var area = new Badge { Text = AreaTitle.GetValueOrDefault(c.area, c.area), Fill = Theme.Bg4, Location = new Point(bx, y) }; bx += area.Width + 6;
        _detail.Controls.Add(area);
        if (c.audit) { var a = new Badge { Text = "audited", Fill = Color.FromArgb(0x1E, 0x3A, 0x6E), Fore = Theme.Link, Location = new Point(bx, y) }; Tip.Set(a, "Audited", "Every use is written to the server log at warning level, with who ran it."); _detail.Controls.Add(a); bx += a.Width + 6; }
        if (danger) { var d = new Badge { Text = "destructive", Fill = Color.FromArgb(0x6B, 0x1D, 0x20), Fore = Color.FromArgb(0xFF, 0x9B, 0x9E), Location = new Point(bx, y) }; Tip.Set(d, "Destructive", "Changes or removes data or interrupts users. Asks for confirmation."); _detail.Controls.Add(d); bx += d.Width + 6; }
        if (c.local) { var l = new Badge { Text = "local console only", Fill = Color.FromArgb(0x16, 0x5A, 0x33), Fore = Color.FromArgb(0x7B, 0xE0, 0xA0), Location = new Point(bx, y) }; Tip.Set(l, "Local console only", "Not available over SSH. The launcher is the local console, so it works here."); _detail.Controls.Add(l); bx += l.Width + 6; }
        if (c.aliases.Length > 0) { var al = new DLabel { Text = "alias: " + string.Join(", ", c.aliases), ForeColor = Theme.Muted, Font = Theme.UiSmall, Location = new Point(bx + 6, y + 1), Size = new Size(300, 18), Wrap = false }; _detail.Controls.Add(al); }
        y += 34;

        var sum = new DLabel { Text = c.summary, Font = new Font("Segoe UI", 11f), Location = new Point(x0, y), Width = w };
        sum.Height = Theme.Measure(sum.Text, sum.Font, w);
        _detail.Controls.Add(sum);
        y += sum.Height + 18;

        _detail.Controls.Add(new DLabel { Text = "USAGE", Font = Theme.UiSmall, ForeColor = Theme.Muted, Location = new Point(x0, y), Size = new Size(100, 16), Wrap = false });
        y += 20;
        var usage = new DCard { Fill = Theme.Bg0, Location = new Point(x0, y), Size = new Size(w, 38), Radius = 4 };
        usage.Controls.Add(new DLabel { Text = c.usage, Font = Theme.Mono, ForeColor = Color.FromArgb(0xA5, 0xAE, 0xFF), Location = new Point(12, 9), Size = new Size(w - 24, 22), Wrap = false });
        _detail.Controls.Add(usage);
        y += 54;

        var specs = ParseUsage(c);
        if (specs.Count > 0)
        {
            _detail.Controls.Add(new DLabel { Text = "ARGUMENTS", Font = Theme.UiSmall, ForeColor = Theme.Muted, Location = new Point(x0, y), Size = new Size(200, 16), Wrap = false });
            y += 22;
            foreach (var s in specs)
            {
                Control ctl;
                if (s.Flag)
                {
                    var t = new DToggle { Location = new Point(x0, y) };
                    Tip.Set(t, "--yes", "Skips the 'are you sure' question. The launcher still confirms destructive commands itself.");
                    _detail.Controls.Add(t);
                    _detail.Controls.Add(new DLabel { Text = s.Label + "  (--yes)", Location = new Point(x0 + 54, y + 3), Size = new Size(400, 20), Wrap = false });
                    ctl = t;
                    y += 34;
                }
                else
                {
                    _detail.Controls.Add(new DLabel { Text = s.Label + (s.Optional ? "   optional" : "   required"), Font = Theme.UiBold, ForeColor = s.Optional ? Theme.Text : Theme.TextBright, Location = new Point(x0, y), Size = new Size(w, 20), Wrap = false });
                    y += 22;
                    if (s.Choices != null)
                    {
                        var cb = new DCombo { Items = s.Optional ? new[] { "" }.Concat(s.Choices).ToArray() : s.Choices, Location = new Point(x0, y), Width = 260 };
                        cb.SelectedIndex = 0;
                        ctl = cb;
                    }
                    else
                    {
                        var inp = new DInput { Location = new Point(x0, y), Width = Math.Min(w, 460), Secret = s.Secret, Placeholder = s.Default != null ? $"default {s.Default}" : "" };
                        ctl = inp;
                    }
                    _detail.Controls.Add(ctl);
                    y += 42;
                }
                _args.Add((s, ctl));
            }
            y += 4;
        }

        _run = new DButton("Run now", danger ? BtnKind.Danger : BtnKind.Success, G.Play) { Location = new Point(x0, y) };
        _run.Click += async (_, _) => await RunNow();
        Tip.Set(_run, "Run this command on the server", "The result appears below and in the Console tab.");
        _toConsole = new DButton("Put in console", BtnKind.Secondary, G.Console) { Location = new Point(_run.Right + 8, y) };
        _toConsole.Click += (_, _) => { if (Build(out var line)) { App.Main.GoTo("Console"); (App.Main.Page("Console") as ConsolePage)?.Prefill(line, false); } };
        _copy = new DButton("Copy", BtnKind.Secondary, G.Copy) { Location = new Point(_toConsole.Right + 8, y) };
        _copy.Click += (_, _) => { if (Build(out var line)) try { Clipboard.SetText(line); } catch { } };
        _detail.Controls.AddRange([_run, _toConsole, _copy]);
        y += 50;

        if (c.examples.Length > 0)
        {
            _detail.Controls.Add(new DLabel { Text = "EXAMPLES  (click to use)", Font = Theme.UiSmall, ForeColor = Theme.Muted, Location = new Point(x0, y), Size = new Size(300, 16), Wrap = false });
            y += 22;
            foreach (var ex in c.examples)
            {
                var card = new DCard { Fill = Theme.Bg0, Radius = 4, Location = new Point(x0, y), Size = new Size(w, 32), Cursor = Cursors.Hand };
                var lbl = new DLabel { Text = ex, Font = Theme.Mono, ForeColor = Theme.Text, Location = new Point(12, 6), Size = new Size(w - 24, 20), Wrap = false, Cursor = Cursors.Hand };
                card.Controls.Add(lbl);
                void use() { App.Main.GoTo("Console"); (App.Main.Page("Console") as ConsolePage)?.Prefill(ex, false); }
                card.Click += (_, _) => use(); lbl.Click += (_, _) => use();
                Tip.Set(card, "Use this example", "Copies it to the Console input without running it.");
                _detail.Controls.Add(card);
                y += 38;
            }
            y += 8;
        }

        _detail.Controls.Add(new DLabel { Text = "RESULT", Font = Theme.UiSmall, ForeColor = Theme.Muted, Location = new Point(x0, y), Size = new Size(200, 16), Wrap = false });
        y += 22;
        _result.Clear();
        _result.SetBounds(x0, y, w, 200);
        _detail.Controls.Add(_result);
        y += 224;
        _detail.AutoScrollMinSize = new Size(0, y);
        _detail.ResumeLayout();
        _detail.AutoScrollPosition = Point.Empty;
    }

    private bool Build(out string line)
    {
        var sb = new StringBuilder(_cur!.name);
        bool gap = false;
        line = "";
        foreach (var (s, ctl) in _args)
        {
            string v = ctl switch { DToggle t => t.Checked ? "--yes" : "", DCombo c => c.Value, DInput i => i.Text.Trim(), _ => "" };
            if (v == "")
            {
                if (!s.Optional) { Dlg.Info(this, "Missing argument", $"\"{s.Label}\" is required."); return false; }
                gap = true; continue;
            }
            if (gap && !s.Flag) { Dlg.Info(this, "Fill in order", $"Fill the optional arguments before \"{s.Label}\" too: they are positional."); return false; }
            sb.Append(' ').Append(s.Flag ? v : Quote(v));
        }
        line = sb.ToString();
        return true;
    }

    private static string Quote(string v) => v.Any(char.IsWhiteSpace) || v.Contains('"') || v.Contains('\'') ? "\"" + v.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"" : v;

    private async Task RunNow()
    {
        if (_cur == null || !Build(out var line)) return;
        if (App.Host.State != SState.Running) { Dlg.Info(this, "Server not running", "Start the server on the Dashboard first. Commands run inside the server process."); return; }
        if (App.Settings.Bool("confirmDangerous") && App.Dangerous.Contains(_cur.name)
            && !Dlg.Confirm(this, "Run destructive command", $"{line}\n\nThis can remove data or interrupt users. Run it?", "Run", true)) return;
        _run!.Enabled = false;
        _result.Clear();
        _result.SelectionColor = Color.FromArgb(0xA5, 0xAE, 0xFF);
        _result.AppendText("› " + (line.Contains("password", StringComparison.OrdinalIgnoreCase) || _cur.name is "account create" or "account passwd" ? _cur.name + " ..." : line) + "\n");
        App.Host.PostLine(new LogLine(DateTime.Now, "CMD", "commands", line, line));
        string text = await App.Host.RunAsync(line, 15000);
        _result.SelectionColor = Theme.Text;
        _result.AppendText(text == "" ? "(no output)\n" : text + "\n");
        _run.Enabled = true;
    }
}
