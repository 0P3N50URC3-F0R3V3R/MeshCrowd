using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;

namespace MeshCrowd.Client;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        string exeDir = Path.GetDirectoryName(Environment.ProcessPath)!;
        string dataDir = Path.Combine(exeDir, "data");
        Directory.CreateDirectory(dataDir);

        string id = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(dataDir.ToLowerInvariant())))[..16];
        using var mutex = new Mutex(true, $"Local\\MeshCrowd-{id}", out bool first);
        string pipeName = $"MeshCrowd-{id}";

        if (!first)
        {
            ForwardToRunningInstance(pipeName, args);
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => Fatal(e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Fatal(e.ExceptionObject as Exception);

        bool dev = args.Contains("--dev") || args.Contains("-dev");
        var cfg = new AppConfig(dataDir);
        var form = new MainForm(dataDir, cfg, dev, InviteUrl.Find(args));

        var cts = new CancellationTokenSource();
        _ = Task.Run(() => ListenForSecondInstances(pipeName, form, cts.Token));

        Application.Run(form);
        cts.Cancel();
    }

    private static void Fatal(Exception? ex)
    {
        MessageBox.Show(ex?.ToString() ?? "Unknown error", "MeshCrowd", MessageBoxButtons.OK, MessageBoxIcon.Error);
        Environment.Exit(1);
    }

    private static void ForwardToRunningInstance(string pipeName, string[] args)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.Out);
            client.Connect(3000);
            using var w = new StreamWriter(client, Encoding.UTF8) { AutoFlush = true };
            foreach (var a in args) w.WriteLine(a);
        }
        catch { }
    }

    private static async Task ListenForSecondInstances(string pipeName, MainForm form, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await using var server = new NamedPipeServerStream(pipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
                await server.WaitForConnectionAsync(ct);
                using var r = new StreamReader(server, Encoding.UTF8);
                var argv = new List<string>();
                string? line;
                while ((line = await r.ReadLineAsync(ct)) is not null) argv.Add(line);
                if (form.IsHandleCreated) form.BeginInvoke(() => form.OnSecondInstance(argv.ToArray()));
            }
            catch (OperationCanceledException) { return; }
            catch { await Task.Delay(200, CancellationToken.None); }
        }
    }
}
