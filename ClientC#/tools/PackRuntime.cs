// Packs a directory into one Brotli stream: [count][(path, length)...] then the raw file bytes.
// Usage: dotnet run tools/PackRuntime.cs -- <srcDir> <outFile>
using System.IO.Compression;
using System.Text;

string src = Path.GetFullPath(args[0]);
string outFile = args[1];
var files = Directory.GetFiles(src, "*", SearchOption.AllDirectories).OrderBy(f => f, StringComparer.Ordinal).ToArray();

using var fs = File.Create(outFile);
using var br = new BrotliStream(fs, CompressionLevel.SmallestSize);
using var w = new BinaryWriter(br, Encoding.UTF8, leaveOpen: true);
w.Write(files.Length);
foreach (var f in files)
{
    w.Write(Path.GetRelativePath(src, f).Replace(Path.DirectorySeparatorChar, '/'));
    w.Write(new FileInfo(f).Length);
}
var buf = new byte[1 << 20];
foreach (var f in files)
{
    using var s = File.OpenRead(f);
    int n;
    while ((n = s.Read(buf, 0, buf.Length)) > 0) w.Write(buf, 0, n);
}
w.Flush();
Console.WriteLine($"{files.Length} files");
