#!/usr/bin/env node
/**
 * Validates Google Play listing assets under store/google-play/.
 * Run from repo root: node scripts/validate-play-assets.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const play = path.join(root, "store", "google-play");

function pngSize(filePath) {
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(24);
  fs.readSync(fd, buf, 0, 24, 0);
  fs.closeSync(fd);
  if (buf.toString("ascii", 1, 4) !== "PNG") {
    throw new Error(`${filePath} is not a PNG`);
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function mustExist(rel) {
  const p = path.join(play, rel);
  if (!fs.existsSync(p)) throw new Error(`Missing ${rel}`);
  return p;
}

const errors = [];

try {
  const fg = mustExist("feature-graphic.png");
  const { width: fw, height: fh } = pngSize(fg);
  if (fw !== 1024 || fh !== 500) {
    errors.push(`feature-graphic.png must be 1024x500 (got ${fw}x${fh})`);
  }
} catch (e) {
  errors.push(String(e.message || e));
}

try {
  const icon = mustExist("icon-512.png");
  const { width: iw, height: ih } = pngSize(icon);
  if (iw !== 512 || ih !== 512) {
    errors.push(`icon-512.png must be 512x512 (got ${iw}x${ih})`);
  }
} catch (e) {
  errors.push(String(e.message || e));
}

const short = fs.readFileSync(path.join(play, "short-description.txt"), "utf8").trim();
if (short.length === 0 || short.length > 80) {
  errors.push(`short-description.txt length ${short.length} (need 1–80)`);
}

const full = fs.readFileSync(path.join(play, "full-description.txt"), "utf8").trim();
if (full.length === 0 || full.length > 4000) {
  errors.push(`full-description.txt length ${full.length} (need 1–4000)`);
}

const shotDir = path.join(play, "screenshots");
const shots = fs.existsSync(shotDir)
  ? fs.readdirSync(shotDir).filter((f) => /\.(png|jpe?g)$/i.test(f))
  : [];
if (shots.length < 2) {
  errors.push(`Need ≥2 phone screenshots in screenshots/ (found ${shots.length})`);
} else {
  for (const name of shots) {
    const { width, height } = pngSize(path.join(shotDir, name));
    const min = Math.min(width, height);
    const max = Math.max(width, height);
    if (min < 320 || max > 3840) {
      errors.push(`${name}: ${width}x${height} outside Play phone bounds`);
    }
  }
}

const appJson = JSON.parse(
  fs.readFileSync(path.join(root, "packages", "mobile", "app.json"), "utf8"),
);
const android = appJson.expo?.android || {};
if (android.package !== "com.cursorremote.app") {
  errors.push(`android.package expected com.cursorremote.app`);
}
if (android.versionCode !== 1 && typeof android.versionCode !== "number") {
  errors.push(`android.versionCode missing`);
}
if (appJson.expo?.version !== "1.0.0") {
  errors.push(`expo.version expected 1.0.0 for first release (got ${appJson.expo?.version})`);
}

if (errors.length) {
  console.error("Play asset validation FAILED:");
  for (const e of errors) console.error(" -", e);
  process.exit(1);
}

console.log("Play asset validation OK");
console.log(` - feature-graphic 1024x500`);
console.log(` - icon-512 512x512`);
console.log(` - short ${short.length} chars, full ${full.length} chars`);
console.log(` - ${shots.length} screenshots: ${shots.join(", ")}`);
