using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace MeshCrowd.Client;

public static class Native
{
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    [DllImport("shell32.dll")] private static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid rfid, uint flags, IntPtr token, out IntPtr path);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);

    private const int SwRestore = 9;
    private const int SwShowMinNoActive = 7;
    private const int SwShowNoActivate = 4;

    public static void StyleCaption(IntPtr hwnd)
    {
        int on = 1;
        DwmSetWindowAttribute(hwnd, 20, ref on, sizeof(int));
        int caption = 0x221f1e; // #1e1f22 as 0x00BBGGRR
        DwmSetWindowAttribute(hwnd, 35, ref caption, sizeof(int));
        int text = 0xe1deDB; // #dbdee1
        DwmSetWindowAttribute(hwnd, 36, ref text, sizeof(int));
    }

    public static string DownloadsFolder()
    {
        try
        {
            if (SHGetKnownFolderPath(new Guid("374DE290-123F-4565-9164-39C4925E467B"), 0, IntPtr.Zero, out var p) == 0)
            {
                string s = Marshal.PtrToStringUni(p)!;
                Marshal.FreeCoTaskMem(p);
                return s;
            }
        }
        catch { }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
    }

    public static void Restore(IntPtr hwnd) => ShowWindow(hwnd, SwRestore);
    public static void ShowMinimizedInactive(IntPtr hwnd) => ShowWindow(hwnd, SwShowMinNoActive);
    public static void Foreground(IntPtr hwnd) => SetForegroundWindow(hwnd);

    public static void OpenExternal(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }

    public static bool IsExternalSafe(Uri u) => u.Scheme is "http" or "https" or "mailto";

    private static string ExePath => Environment.ProcessPath ?? "";

    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    public static void SetLoginItem(bool on)
    {
        try
        {
            using var k = Registry.CurrentUser.CreateSubKey(RunKey);
            if (on) k.SetValue("MeshCrowdCS", $"\"{ExePath}\"");
            else k.DeleteValue("MeshCrowdCS", false);
        }
        catch { }
    }

    private const string ProtocolKey = @"Software\Classes\mcr";

    public static bool HasProtocolHandler()
    {
        try
        {
            using var k = Registry.CurrentUser.OpenSubKey(ProtocolKey + @"\shell\open\command");
            return !string.IsNullOrEmpty(k?.GetValue("") as string);
        }
        catch { return false; }
    }

    public static void SetProtocolRegistered(bool on)
    {
        try
        {
            if (!on)
            {
                using var cur = Registry.CurrentUser.OpenSubKey(ProtocolKey + @"\shell\open\command");
                if (cur?.GetValue("") as string == $"\"{ExePath}\" \"%1\"") Registry.CurrentUser.DeleteSubKeyTree(ProtocolKey, false);
                return;
            }
            using var k = Registry.CurrentUser.CreateSubKey(ProtocolKey);
            k.SetValue("", "URL:MeshCrowd");
            k.SetValue("URL Protocol", "");
            using var cmd = k.CreateSubKey(@"shell\open\command");
            cmd.SetValue("", $"\"{ExePath}\" \"%1\"");
        }
        catch { }
    }
}

public static class TaskbarProgress
{
    [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090"), ClassInterface(ClassInterfaceType.None)]
    private class TaskbarList { }

    [ComImport, Guid("ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ITaskbarList3
    {
        void HrInit();
        void AddTab(IntPtr hwnd);
        void DeleteTab(IntPtr hwnd);
        void ActivateTab(IntPtr hwnd);
        void SetActiveAlt(IntPtr hwnd);
        void MarkFullscreenWindow(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool fullscreen);
        void SetProgressValue(IntPtr hwnd, ulong completed, ulong total);
        void SetProgressState(IntPtr hwnd, int flags);
    }

    private static ITaskbarList3? _list;
    public static string? LastError;

    // fraction < 0: none, > 1: indeterminate, otherwise 0..1
    public static void Set(IntPtr hwnd, double fraction)
    {
        try
        {
            _list ??= (ITaskbarList3)new TaskbarList();
            _list.HrInit();
            if (fraction < 0) _list.SetProgressState(hwnd, 0);
            else if (fraction > 1) _list.SetProgressState(hwnd, 1);
            else
            {
                _list.SetProgressState(hwnd, 2);
                _list.SetProgressValue(hwnd, (ulong)(fraction * 1000), 1000);
            }
        }
        catch (Exception ex) { LastError = ex.Message; }
    }
}
