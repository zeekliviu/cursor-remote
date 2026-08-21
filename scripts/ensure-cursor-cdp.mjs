#!/usr/bin/env node
/**
 * Ensure Cursor is reachable on the local CDP port.
 * If not, launch (or relaunch) Cursor with --remote-debugging-port.
 *
 * Used by: npm run daemon:start
 * Env:
 *   CDP_PORT / CDP_URL / CURSOR_BIN
 *   CURSOR_REMOTE_SKIP_CDP_ENSURE=1  — skip entirely
 *   CURSOR_REMOTE_NO_RESTART=1      — do not quit an existing non-CDP Cursor
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const cdpPort = String(process.env.CDP_PORT || "9222");
const cdpBase =
  process.env.CDP_URL?.replace(/\/$/, "") || `http://127.0.0.1:${cdpPort}`;
const waitMs = Number(process.env.CURSOR_CDP_WAIT_MS || 45_000);
const pollMs = 500;

export function cursorBin() {
  if (process.env.CURSOR_BIN) return process.env.CURSOR_BIN;
  if (process.platform === "darwin") {
    return "/Applications/Cursor.app/Contents/MacOS/Cursor";
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || "",
      "Programs",
      "cursor",
      "Cursor.exe",
    );
  }
  return "cursor";
}

export async function probeCdp(base = cdpBase) {
  try {
    const res = await fetch(`${base}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function cursorRunning() {
  if (process.platform === "win32") {
    const r = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "if (Get-Process -Name 'Cursor' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    return r.status === 0;
  }
  if (process.platform === "darwin") {
    const r = spawnSync("pgrep", ["-f", "Cursor.app/Contents/MacOS/Cursor"], {
      stdio: "ignore",
    });
    return r.status === 0;
  }
  const r = spawnSync("pgrep", ["-x", "cursor"], { stdio: "ignore" });
  return r.status === 0;
}

async function quitCursor() {
  if (process.platform === "darwin") {
    spawnSync("osascript", ["-e", 'tell application "Cursor" to quit'], {
      stdio: "ignore",
    });
  } else if (process.platform === "win32") {
    spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-Process -Name 'Cursor' -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }; Start-Sleep -Milliseconds 800; Get-Process -Name 'Cursor' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
      ],
      { stdio: "ignore", windowsHide: true },
    );
  } else {
    spawnSync("pkill", ["-x", "cursor"], { stdio: "ignore" });
  }

  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (!cursorRunning()) return;
    await sleep(250);
  }
}

function launchCursor(bin) {
  const child = spawn(bin, [`--remote-debugging-port=${cdpPort}`], {
    stdio: "ignore",
    detached: true,
    shell: false,
    windowsHide: false,
  });
  child.unref();
}

async function waitForCdp(timeoutMs = waitMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeCdp()) return true;
    await sleep(pollMs);
  }
  return false;
}

/**
 * @returns {Promise<{ ok: boolean, launched: boolean, message: string }>}
 */
export async function ensureCursorCdp() {
  if (process.env.CURSOR_REMOTE_SKIP_CDP_ENSURE === "1") {
    return { ok: true, launched: false, message: "CDP ensure skipped" };
  }

  if (await probeCdp()) {
    return {
      ok: true,
      launched: false,
      message: `CDP already up at ${cdpBase}`,
    };
  }

  const bin = cursorBin();
  if (process.platform !== "linux" && !fs.existsSync(bin)) {
    return {
      ok: false,
      launched: false,
      message: `Cursor not found at ${bin} (set CURSOR_BIN)`,
    };
  }

  const running = cursorRunning();
  if (running && process.env.CURSOR_REMOTE_NO_RESTART === "1") {
    return {
      ok: false,
      launched: false,
      message: `CDP not on ${cdpBase} but Cursor is running — quit Cursor and run npm run cursor, or unset CURSOR_REMOTE_NO_RESTART`,
    };
  }

  if (running) {
    console.log(
      "[cursor-remote] Cursor is open without CDP — quitting so it can relaunch with --remote-debugging-port…",
    );
    await quitCursor();
  } else {
    console.log(
      `[cursor-remote] CDP not reachable on ${cdpBase} — starting Cursor with remote debugging…`,
    );
  }

  launchCursor(bin);
  const up = await waitForCdp();
  if (!up) {
    return {
      ok: false,
      launched: true,
      message: `Started Cursor but CDP did not come up on ${cdpBase} within ${waitMs}ms`,
    };
  }

  return {
    ok: true,
    launched: true,
    message: `Cursor ready with CDP on ${cdpBase}`,
  };
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  const result = await ensureCursorCdp();
  console.log(`[cursor-remote] ${result.message}`);
  process.exit(result.ok ? 0 : 1);
}
