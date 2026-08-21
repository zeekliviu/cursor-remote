import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Best-effort: un-minimize / foreground the Cursor app so CDP clicks land.
 *
 * Important (Windows): Cursor's CDP build does NOT expose
 * Browser.getWindowForTarget, so OS-level restore is the only path.
 * The activator PowerShell must compile (Add-Type) and actually run —
 * prior versions failed silently due to unsupported C# syntax.
 */
export async function activateCursorApp(): Promise<void> {
  try {
    if (process.platform === "darwin") {
      await runAndWait(
        "osascript",
        [
          "-e",
          'tell application "Cursor" to reopen',
          "-e",
          'tell application "Cursor" to activate',
          "-e",
          'tell application "System Events" to tell process "Cursor" to set frontmost to true',
        ],
        2500,
      );
      return;
    }
    if (process.platform === "win32") {
      const script = windowsActivateScriptPath();
      if (!script) {
        console.warn("[cursor-remote] activate-cursor.ps1 missing");
        return;
      }
      const result = await runAndWait(
        "powershell.exe",
        [
          "-NoProfile",
          "-STA",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
        ],
        12_000,
        { windowsHide: true, capture: true },
      );
      if (result.stderr && /error|fail|exception/i.test(result.stderr)) {
        console.warn(
          "[cursor-remote] activate-cursor.ps1:",
          result.stderr.slice(0, 500),
        );
      }
    }
  } catch (err) {
    console.warn(
      "[cursor-remote] activateCursorApp failed:",
      (err as Error).message,
    );
  }
}

function windowsActivateScriptPath(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "activate-cursor.ps1"),
    path.join(here, "..", "src", "activate-cursor.ps1"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function runAndWait(
  cmd: string,
  args: string[],
  timeoutMs: number,
  opts: { windowsHide?: boolean; capture?: boolean } = {},
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = "";
    const done = (code: number | null = null) => {
      if (settled) return;
      settled = true;
      resolve({ code, stderr });
    };
    const child = spawn(cmd, args, {
      stdio: opts.capture ? ["ignore", "ignore", "pipe"] : "ignore",
      shell: false,
      windowsHide: opts.windowsHide ?? true,
    });
    if (opts.capture && child.stderr) {
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
    }
    child.on("error", () => done(1));
    child.on("exit", (code) => done(code));
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      done(-1);
    }, timeoutMs);
  });
}
