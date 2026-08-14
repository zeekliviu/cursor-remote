import { spawn } from "node:child_process";

/**
 * Best-effort: un-minimize / foreground the Cursor app so CDP clicks land.
 * Project/chat switching is done by clicking Agents → Repositories in the
 * existing window (see CdpDriver.selectInAgentsPanel).
 */
export async function activateCursorApp(): Promise<void> {
  try {
    if (process.platform === "darwin") {
      await runDetached("osascript", [
        "-e",
        'tell application "Cursor" to activate',
      ]);
      return;
    }
    if (process.platform === "win32") {
      await runDetached("powershell.exe", [
        "-NoProfile",
        "-Command",
        `(New-Object -ComObject WScript.Shell).AppActivate('Cursor'); Start-Sleep -Milliseconds 200`,
      ]);
    }
  } catch {
    // ignore — CDP may still work if the window is already focused
  }
}

function runDetached(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
    child.on("error", () => resolve());
    child.unref();
    setTimeout(resolve, 80);
  });
}
