#!/usr/bin/env node
/**
 * Quick health check before pairing.
 *   npm run doctor
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 7843);
const cdpPort = Number(process.env.CDP_PORT || 9222);

const issues = [];
const ok = [];

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) issues.push(`Node ${process.version} (< 20)`);
else ok.push(`Node ${process.version}`);

const dist = path.join(root, "packages", "daemon", "dist", "index.js");
if (fs.existsSync(dist)) ok.push("daemon build present");
else issues.push("daemon not built — run: npm run setup");

function cursorHint() {
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

const cursorBin = process.env.CURSOR_BIN || cursorHint();
if (cursorBin && fs.existsSync(cursorBin)) ok.push(`Cursor binary: ${cursorBin}`);
else issues.push(`Cursor binary not found (${cursorBin}). Set CURSOR_BIN.`);

async function probe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok || res.status === 200;
  } catch {
    return false;
  }
}

const cdpUp = await probe(`http://127.0.0.1:${cdpPort}/json/version`);
if (cdpUp) ok.push(`CDP up on :${cdpPort}`);
else issues.push(`CDP not reachable on :${cdpPort} — run: npm run daemon:start (auto-launches Cursor) or npm run cursor`);

const daemonUp = await probe(`http://127.0.0.1:${port}/healthz`);
if (daemonUp) ok.push(`daemon up on :${port}`);
else issues.push(`daemon not on :${port} — run: npm run daemon:start`);

const auth = path.join(os.homedir(), ".cursor-remote", "auth.json");
if (fs.existsSync(auth)) ok.push(`auth.json at ${auth}`);
else ok.push(`auth.json will be created on first daemon start (${auth})`);

console.log("[cursor-remote] doctor\n");
for (const line of ok) console.log(`  ✓ ${line}`);
for (const line of issues) console.log(`  ✗ ${line}`);
console.log("");
process.exit(issues.some((i) => i.includes("not built") || i.includes("Node")) ? 1 : 0);
