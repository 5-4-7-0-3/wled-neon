# Prints a JSON line whenever one of the few game buttons the game profiles react to changes:
# Q (scan) and left Alt (hold breath) on the keyboard, and the right bumper on a controller (scan
# and hold breath in one there). Only these keys are looked at, and only while a profile needs it.
# Xbox-style pads are read through XInput; a DualSense does not show up there, so its own input
# reports are read, shared with the game.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type @'
using System;
using System.IO;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class In {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [StructLayout(LayoutKind.Sequential)] public struct Pad { public ushort Buttons; public byte LT, RT; public short LX, LY, RX, RY; }
  [StructLayout(LayoutKind.Sequential)] public struct State { public uint Packet; public Pad Pad; }
  [DllImport("xinput1_4.dll")] public static extern uint XInputGetState(uint user, out State state);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);

  public static volatile bool DualSenseR1;

  public static bool Down(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }

  public static bool Bumper() {
    if (DualSenseR1) return true;
    for (uint i = 0; i < 4; i++) {
      State s;
      if (XInputGetState(i, out s) == 0 && (s.Pad.Buttons & 0x0200) != 0) return true;
    }
    return false;
  }

  // R1 sits in a different byte depending on the connection and on which report the controller
  // sends: over Bluetooth the full report (0x31) once a game has switched it on, the short one
  // (0x01) before that; over USB always report 0x01.
  public static void WatchDualSense(string path, bool bluetooth) {
    var t = new Thread(() => {
      // One report per read: a bigger buffer gets several queued reports at once
      var buf = new byte[bluetooth ? 78 : 64];
      while (true) {
        try {
          using (var h = CreateFile(path, 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
            if (h.IsInvalid) { Thread.Sleep(3000); continue; }
            using (var fs = new FileStream(h, FileAccess.Read, 1, false)) {
              while (true) {
                int n = fs.Read(buf, 0, buf.Length);
                if (n <= 0) break;
                if (bluetooth && buf[0] == 0x31 && n > 10) DualSenseR1 = (buf[10] & 0x02) != 0;
                else if (bluetooth && buf[0] == 0x01 && n > 6) DualSenseR1 = (buf[6] & 0x02) != 0;
                else if (!bluetooth && buf[0] == 0x01 && n > 9) DualSenseR1 = (buf[9] & 0x02) != 0;
              }
            }
          }
        } catch { Thread.Sleep(3000); }
        DualSenseR1 = false;
      }
    });
    t.IsBackground = true;
    t.Start();
  }
}
'@

# DualSense (054C:0CE6) and DualSense Edge (054C:0DF2), over USB or Bluetooth
$pad = Get-PnpDevice -PresentOnly -Class HIDClass -ErrorAction SilentlyContinue |
  Where-Object { $_.InstanceId -like 'HID\*' -and $_.InstanceId -match '054C.*PID&?_?(0CE6|0DF2)' } | Select-Object -First 1
if ($pad) {
  $path = '\\?\' + $pad.InstanceId.Replace('\', '#') + '#{4d1e55b2-f16f-11cf-88cb-001111000030}'
  [In]::WatchDualSense($path, $pad.InstanceId -match '00001124-0000-1000-8000-00805F9B34FB')
}

$last = ''
while ($true) {
  $line = ConvertTo-Json -Compress -InputObject @{ scan = [In]::Down(0x51); breath = [In]::Down(0xA4); bumper = [In]::Bumper() }
  if ($line -ne $last) { $line; $last = $line }
  Start-Sleep -Milliseconds 25
}
