#!/usr/bin/env node
/**
 * Cross-platform daemon start (build if needed).
 *   npm run daemon:start
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const isWin = process.platform === "win32";

process.env.PORT ||= "7843";
process.env.BIND_HOST ||= "0.0.0.0";
process.env.CDP_URL ||= `http://127.0.0.1:${process.env.CDP_PORT || "9222"}`;
process.env.DATA_DIR ||= path.join(os.homedir(), ".cursor-remote");

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

console.log(
  `[cursor-remote] daemon PORT=${process.env.PORT} DATA_DIR=${process.env.DATA_DIR}`,
);

const child = spawn("npm", ["run", "daemon"], {
  cwd: root,
  stdio: "inherit",
  shell: isWin,
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));
