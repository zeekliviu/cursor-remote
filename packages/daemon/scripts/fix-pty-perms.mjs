#!/usr/bin/env node
/**
 * node-pty's darwin spawn-helper is sometimes installed without +x,
 * which surfaces as: "pty spawn failed: posix_spawnp failed."
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function chmodTree(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) n += chmodTree(full);
    else if (name === "spawn-helper" || name.endsWith(".node")) {
      fs.chmodSync(full, 0o755);
      n++;
    }
  }
  return n;
}

try {
  const ptyRoot = path.dirname(require.resolve("node-pty/package.json"));
  const count = chmodTree(path.join(ptyRoot, "prebuilds"));
  if (count) {
    console.log(`[cursor-remote] fixed node-pty permissions (${count} files)`);
  }
} catch (err) {
  console.warn("[cursor-remote] node-pty chmod skipped:", err?.message ?? err);
}
