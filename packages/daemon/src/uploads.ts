import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AttachmentMeta } from "@cursor-remote/shared";
import { ensureDir } from "./paths.js";

export function uploadsRoot(dataDir: string): string {
  const dir = path.join(dataDir, "uploads");
  ensureDir(dir);
  return dir;
}

export function saveBase64Upload(
  dataDir: string,
  name: string,
  mime: string,
  base64: string,
): AttachmentMeta {
  const id = crypto.randomBytes(8).toString("hex");
  const safe = name.replace(/[^\w.\-()+ ]+/g, "_").slice(0, 120) || "file";
  const dir = path.join(uploadsRoot(dataDir), id);
  ensureDir(dir);
  const filePath = path.join(dir, safe);
  const buf = Buffer.from(base64, "base64");
  fs.writeFileSync(filePath, buf);
  return {
    id,
    name: safe,
    mime,
    path: filePath,
    size: buf.length,
  };
}

function quotePreviewPath(filePath: string): string {
  if (/[;\s]/.test(filePath)) return `"${filePath.replace(/"/g, '\\"')}"`;
  return filePath;
}

export function formatAttachmentsForPrompt(files: AttachmentMeta[]): string {
  if (!files.length) return "";
  // Keep on one line — bare newlines in Composer submit/queue as a separate message.
  const remote = files.some((f) => f.remotePath);
  const segments = files.map((f) => {
    if (f.remotePath) {
      return `${f.remotePath} (${f.mime}; preview=${quotePreviewPath(f.path)})`;
    }
    return `${f.path} (${f.mime})`;
  });
  const label = remote ? "read in workspace" : "read on host";
  return ` [Phone attachments — ${label}: ${segments.join("; ")}]`;
}

export function defaultDataDir(): string {
  return path.join(os.homedir(), ".cursor-remote");
}
