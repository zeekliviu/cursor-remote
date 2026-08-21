import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "selectors");
const dest = path.join(root, "dist", "selectors");
fs.mkdirSync(dest, { recursive: true });
for (const name of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, name), path.join(dest, name));
}
console.log("copied selectors -> dist/selectors");

const activatePs1 = path.join(root, "src", "activate-cursor.ps1");
if (fs.existsSync(activatePs1)) {
  fs.copyFileSync(activatePs1, path.join(root, "dist", "activate-cursor.ps1"));
  console.log("copied activate-cursor.ps1 -> dist/");
}
