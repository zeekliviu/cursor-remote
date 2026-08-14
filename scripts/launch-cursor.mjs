#!/usr/bin/env node
/**
 * Cross-platform Cursor launch with CDP on localhost.
 *   npm run cursor
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cdpPort = process.env.CDP_PORT || "9222";

function defaultBin() {
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

const bin = defaultBin();
if (process.platform !== "linux" && !fs.existsSync(bin)) {
  console.error(`Cursor not found at: ${bin}`);
  console.error("Set CURSOR_BIN to your Cursor executable, then retry.");
  process.exit(1);
}

console.log(`Starting Cursor with remote debugging on 127.0.0.1:${cdpPort}`);
console.log("Keep CDP localhost-only. Phone talks to the daemon only.");

const child = spawn(bin, [`--remote-debugging-port=${cdpPort}`, ...process.argv.slice(2)], {
  stdio: "inherit",
  detached: process.platform === "win32",
  shell: false,
});

if (process.platform === "win32") {
  child.unref();
  process.exit(0);
}

child.on("exit", (code) => process.exit(code ?? 0));
