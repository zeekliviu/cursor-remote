#!/usr/bin/env node
/**
 * First-run setup for a fresh clone (macOS / Windows / Linux).
 *   npm run setup
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const isWin = process.platform === "win32";

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: isWin,
    ...opts,
  });
  if (r.status !== 0) {
    process.exit(r.status || 1);
  }
}

function chmodScripts() {
  if (isWin) return;
  const dir = path.join(root, "scripts");
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(".sh")) {
      fs.chmodSync(path.join(dir, name), 0o755);
    }
  }
}

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`Node >= 20 required (found ${process.version}).`);
  process.exit(1);
}

console.log(`[cursor-remote] setup on ${process.platform} · Node ${process.version}`);
console.log(`[cursor-remote] repo: ${root}`);

chmodScripts();
run("npm", ["install"]);
run("npm", ["run", "build"]);

// node-pty darwin spawn-helper sometimes lacks +x after install
const fixPty = path.join(
  root,
  "packages",
  "daemon",
  "scripts",
  "fix-pty-perms.mjs",
);
if (fs.existsSync(fixPty)) {
  run("node", [fixPty]);
}

const dataHint = path.join(os.homedir(), ".cursor-remote");
console.log(`
[cursor-remote] setup OK

Next (local test):
  1) Quit Cursor completely, then start it with CDP:
       npm run cursor
  2) In another terminal, start the daemon:
       npm run daemon:start
  3) Open http://127.0.0.1:7843  → scan QR in the phone app
     Token file: ${path.join(dataHint, "auth.json")}
  4) Phone UI (Expo Go):
       npm run mobile

Windows notes: Visual C++ Build Tools may be required for node-pty / better-sqlite3.
Docs: README.md · docs/windows.md
`);
