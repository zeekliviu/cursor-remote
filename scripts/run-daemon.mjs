#!/usr/bin/env node
/**
 * Cross-platform daemon start (build if needed, ensure Cursor CDP).
 *   npm run daemon:start
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCursorCdp } from "./ensure-cursor-cdp.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const isWin = process.platform === "win32";

process.env.PORT ||= "7843";
process.env.BIND_HOST ||= "0.0.0.0";
process.env.CDP_URL ||= `http://127.0.0.1:${process.env.CDP_PORT || "9222"}`;
process.env.DATA_DIR ||= path.join(os.homedir(), ".cursor-remote");

/** Prefer private LAN / VPN addresses (same idea as daemon advertise-host). */
function pickLanHost() {
  const fromEnv = process.env.PAIR_HOST?.trim() || process.env.EXPO_HOST?.trim();
  if (fromEnv) return fromEnv;
  const preferred = [];
  const others = [];
  try {
    for (const infos of Object.values(os.networkInterfaces())) {
      if (!infos) continue;
      for (const info of infos) {
        if (info.internal) continue;
        const family = String(info.family);
        if (family !== "IPv4" && family !== "4") continue;
        const addr = info.address;
        if (!addr || addr.startsWith("169.254.")) continue;
        if (
          addr.startsWith("10.") ||
          addr.startsWith("192.168.") ||
          /^172\.(1[6-9]|2\d|3[0-1])\./.test(addr)
        ) {
          preferred.push(addr);
        } else {
          others.push(addr);
        }
      }
    }
  } catch {
    // fall through
  }
  return preferred[0] || others[0] || "127.0.0.1";
}

function portOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(400);
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

async function printExpoLink() {
  const host = pickLanHost();
  const port = Number(
    process.env.EXPO_PORT || process.env.RCT_METRO_PORT || 8081,
  );
  const url = `exp://${host}:${port}`;
  const listening = await portOpen("127.0.0.1", port);
  console.log(`[cursor-remote] Expo Go: ${url}`);
  if (!listening) {
    console.log(
      `[cursor-remote] Metro not detected on :${port} — run \`npm run mobile\` then open the link in Expo Go`,
    );
  } else {
    console.log(
      `[cursor-remote] Open that link in Expo Go (same Wi‑Fi), then pair with the daemon QR on :${process.env.PORT}`,
    );
  }
}

const dist = path.join(root, "packages", "daemon", "dist", "index.js");
if (!fs.existsSync(dist)) {
  console.log("[cursor-remote] dist missing — building…");
  const b = spawnSync("npm", ["run", "build"], {
    cwd: root,
    stdio: "inherit",
    shell: isWin,
  });
  if (b.status !== 0) process.exit(b.status || 1);
}

const fixPty = path.join(root, "packages", "daemon", "scripts", "fix-pty-perms.mjs");
if (fs.existsSync(fixPty)) {
  spawnSync(process.execPath, [fixPty], { cwd: root, stdio: "ignore" });
}

const cdp = await ensureCursorCdp();
console.log(`[cursor-remote] ${cdp.message}`);
if (!cdp.ok) {
  console.error(
    "[cursor-remote] Continuing without CDP — Composer actions will fail until Cursor is launched with remote debugging.",
  );
}

console.log(
  `[cursor-remote] daemon PORT=${process.env.PORT} DATA_DIR=${process.env.DATA_DIR}`,
);
await printExpoLink();

const child = spawn("npm", ["run", "daemon"], {
  cwd: root,
  stdio: "inherit",
  shell: isWin,
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));
