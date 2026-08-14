import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CursorPaths } from "./paths.js";

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|heic)$/i;

export function isAllowedMediaPath(
  filePath: string,
  paths: CursorPaths,
  dataDir: string,
): { ok: true; resolved: string } | { ok: false; error: string } {
  let resolved: string;
  try {
    resolved = path.resolve(filePath);
  } catch {
    return { ok: false, error: "invalid path" };
  }
  if (!IMAGE_EXT_RE.test(resolved)) {
    return { ok: false, error: "not an image" };
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return { ok: false, error: "not found" };
  }

  const allowedRoots = [
    paths.workspaceStorage,
    paths.userDir,
    paths.globalStorage,
    dataDir,
    path.join(os.homedir(), ".cursor"),
    path.join(os.homedir(), ".cursor-remote"),
  ].map((p) => path.resolve(p));

  const ok = allowedRoots.some((root) => {
    const rel = path.relative(root, resolved);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
  if (!ok) return { ok: false, error: "path not allowed" };
  return { ok: true, resolved };
}

export function contentTypeForImage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".heic":
      return "image/heic";
    default:
      return "application/octet-stream";
  }
}
