# Prints one JSON line every two seconds about the window in front: its process, window handle,
# the program's path and whether it covers the whole monitor, so the app can tell when a game is
# being played.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Fg {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  public static bool Full(IntPtr h) {
    RECT r; if (!GetWindowRect(h, out r)) return false;
    var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(mi);
    if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return false;
    return r.L <= mi.rcMonitor.L && r.T <= mi.rcMonitor.T && r.R >= mi.rcMonitor.R && r.B >= mi.rcMonitor.B;
  }
}
'@
while ($true) {
  $h = [Fg]::GetForegroundWindow()
  $procId = [uint32]0
  [void][Fg]::GetWindowThreadProcessId($h, [ref]$procId)
  $path = ''
  try { $path = (Get-Process -Id $procId -ErrorAction Stop).Path } catch {}
  ConvertTo-Json -Compress -InputObject @{ pid = $procId; hwnd = $h.ToInt64(); path = "$path"; full = [Fg]::Full($h) }
  Start-Sleep -Seconds 2
}
