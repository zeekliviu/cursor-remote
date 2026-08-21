# Restore + foreground Cursor (Windows).
# All Win32 work lives in C# — PowerShell only invokes it.
# Add-Type must stay on older C# (no local functions).

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName Microsoft.VisualBasic

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class CursorRemoteWin {
  const int SW_RESTORE = 9;
  const int SW_SHOW = 5;
  const uint WM_SYSCOMMAND = 0x0112;
  const int SC_RESTORE = 0xF120;
  const byte VK_MENU = 0x12;
  const uint KEYEVENTF_KEYUP = 0x0002;

  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(uint procId);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

  static List<IntPtr> FindMainWindows() {
    HashSet<uint> pids = new HashSet<uint>();
    foreach (Process p in Process.GetProcessesByName("Cursor")) {
      try { pids.Add((uint)p.Id); } catch { }
    }
    List<IntPtr> found = new List<IntPtr>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr l) {
      uint pid = 0;
      GetWindowThreadProcessId(hWnd, out pid);
      if (!pids.Contains(pid)) return true;

      StringBuilder cls = new StringBuilder(256);
      GetClassName(hWnd, cls, cls.Capacity);
      if (!cls.ToString().StartsWith("Chrome_WidgetWin_1")) return true;

      StringBuilder title = new StringBuilder(512);
      GetWindowText(hWnd, title, title.Capacity);
      if (title.Length == 0) return true;

      found.Add(hWnd);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  static bool RestoreAndFocus(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) return false;

    SendMessage(hWnd, WM_SYSCOMMAND, (IntPtr)SC_RESTORE, IntPtr.Zero);
    ShowWindow(hWnd, SW_RESTORE);
    ShowWindow(hWnd, SW_SHOW);

    AllowSetForegroundWindow(unchecked((uint)-1));
    keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
    keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);

    IntPtr fg = GetForegroundWindow();
    uint fgPid = 0;
    uint fgTid = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out fgPid) : 0;
    uint targetPid = 0;
    uint targetTid = GetWindowThreadProcessId(hWnd, out targetPid);
    uint curTid = GetCurrentThreadId();

    bool attachedFg = false;
    bool attachedTarget = false;
    if (fgTid != 0 && fgTid != curTid) attachedFg = AttachThreadInput(curTid, fgTid, true);
    if (targetTid != 0 && targetTid != curTid && targetTid != fgTid) {
      attachedTarget = AttachThreadInput(curTid, targetTid, true);
    }

    BringWindowToTop(hWnd);
    SetForegroundWindow(hWnd);

    if (attachedTarget) AttachThreadInput(curTid, targetTid, false);
    if (attachedFg) AttachThreadInput(curTid, fgTid, false);

    if (GetForegroundWindow() != hWnd) SwitchToThisWindow(hWnd, true);
    return !IsIconic(hWnd);
  }

  public static bool Activate() {
    List<IntPtr> windows = FindMainWindows();
    bool restored = false;
    for (int i = 0; i < windows.Count; i++) {
      if (RestoreAndFocus(windows[i])) restored = true;
    }
    return restored;
  }

  public static bool IsMainIconic() {
    List<IntPtr> windows = FindMainWindows();
    for (int i = 0; i < windows.Count; i++) {
      if (IsIconic(windows[i])) return true;
    }
    return windows.Count == 0;
  }
}
"@

$ok = [CursorRemoteWin]::Activate()
Start-Sleep -Milliseconds 120

Get-Process -Name 'Cursor' -ErrorAction SilentlyContinue | ForEach-Object {
  try { [Microsoft.VisualBasic.Interaction]::AppActivate($_.Id) | Out-Null } catch {}
}

if (-not $ok -or [CursorRemoteWin]::IsMainIconic()) {
  $bin = if ($env:CURSOR_BIN) { $env:CURSOR_BIN } else {
    Join-Path $env:LOCALAPPDATA 'Programs\cursor\Cursor.exe'
  }
  if (Test-Path -LiteralPath $bin) {
    Start-Process -FilePath $bin -WindowStyle Normal | Out-Null
    Start-Sleep -Milliseconds 450
    [void][CursorRemoteWin]::Activate()
    Get-Process -Name 'Cursor' -ErrorAction SilentlyContinue | ForEach-Object {
      try { [Microsoft.VisualBasic.Interaction]::AppActivate($_.Id) | Out-Null } catch {}
    }
  }
}

exit 0
