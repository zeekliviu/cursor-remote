import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type CursorPaths = {
  userDir: string;
  globalStorage: string;
  workspaceStorage: string;
  globalDb: string;
  conversationSearchDb: string;
};

export function resolveCursorPaths(override?: string): CursorPaths {
  const userDir =
    override ||
    process.env.CURSOR_USER_DIR ||
    defaultUserDir();
  const globalStorage = path.join(userDir, "globalStorage");
  const workspaceStorage = path.join(userDir, "workspaceStorage");
  return {
    userDir,
    globalStorage,
    workspaceStorage,
    globalDb: path.join(globalStorage, "state.vscdb"),
    conversationSearchDb: path.join(globalStorage, "conversation-search.db"),
  };
}

function defaultUserDir(): string {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Cursor", "User");
    case "win32":
      return path.join(
        process.env.APPDATA || path.join(home, "AppData", "Roaming"),
        "Cursor",
        "User",
      );
    default:
      return path.join(home, ".config", "Cursor", "User");
  }
}

export function defaultCursorAppPath(): string | null {
  switch (process.platform) {
    case "darwin":
      return "/Applications/Cursor.app/Contents/MacOS/Cursor";
    case "win32": {
      const local = process.env.LOCALAPPDATA;
      if (!local) return null;
      const candidate = path.join(local, "Programs", "cursor", "Cursor.exe");
      return fs.existsSync(candidate) ? candidate : null;
    }
    default: {
      const candidates = [
        "/usr/bin/cursor",
        "/usr/local/bin/cursor",
        path.join(os.homedir(), ".local", "bin", "cursor"),
      ];
      return candidates.find((p) => fs.existsSync(p)) ?? null;
    }
  }
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
