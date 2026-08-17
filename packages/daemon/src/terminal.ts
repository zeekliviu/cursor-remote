import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import type { WebSocket } from "ws";
import type {
  TerminalClientMessage,
  TerminalServerMessage,
} from "@cursor-remote/shared";

const require = createRequire(import.meta.url);

type Session = {
  id: string;
  term: pty.IPty;
  projectId: string;
  cwd: string;
  ws: WebSocket | null;
  buffered: string;
  expiry: NodeJS.Timeout | null;
};

function send(ws: WebSocket, msg: TerminalServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/** node-pty darwin spawn-helper is sometimes installed without +x. */
export function ensurePtyPermissions(): void {
  try {
    const ptyRoot = path.dirname(require.resolve("node-pty/package.json"));
    const prebuilds = path.join(ptyRoot, "prebuilds");
    if (!fs.existsSync(prebuilds)) return;
    for (const plat of fs.readdirSync(prebuilds)) {
      const helper = path.join(prebuilds, plat, "spawn-helper");
      if (fs.existsSync(helper)) {
        fs.chmodSync(helper, 0o755);
      }
    }
  } catch {
    // ignore — spawn will surface a clearer error
  }
}

function resolveShell(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile"] };
  }
  const file = process.env.SHELL || "/bin/zsh";
  // Login shell so PATH/aliases match a normal terminal in the project.
  const args = file.includes("zsh") || file.includes("bash") ? ["-l"] : [];
  return { file, args };
}

export class TerminalHub {
  private readonly sessions = new Map<string, Session>();
  private readonly socketSessions = new WeakMap<WebSocket, string>();

  handle(ws: WebSocket, resolveCwd: (projectId: string) => string | undefined): void {
    ws.on("message", (raw) => {
      let msg: TerminalClientMessage;
      try {
        msg = JSON.parse(String(raw)) as TerminalClientMessage;
      } catch {
        send(ws, { type: "error", message: "invalid json" });
        return;
      }

      if (msg.type === "ping") {
        send(ws, { type: "pong" });
        return;
      }

      if (msg.type === "attach") {
        this.detach(ws);
        const cwd = resolveCwd(msg.projectId);
        if (!cwd) {
          send(ws, { type: "error", message: "unknown project" });
          return;
        }
        if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
          send(ws, {
            type: "error",
            message: `project path missing or not a directory: ${cwd}`,
          });
          return;
        }
        const existing = msg.sessionId
          ? this.sessions.get(msg.sessionId)
          : undefined;
        if (existing && existing.projectId === msg.projectId) {
          if (existing.expiry) clearTimeout(existing.expiry);
          existing.expiry = null;
          if (existing.ws && existing.ws !== ws) {
            this.socketSessions.delete(existing.ws);
          }
          existing.ws = ws;
          this.socketSessions.set(ws, existing.id);
          if (msg.cols && msg.rows) {
            existing.term.resize(msg.cols, msg.rows);
          }
          send(ws, {
            type: "ready",
            projectId: existing.projectId,
            cwd: existing.cwd,
            sessionId: existing.id,
          });
          if (existing.buffered) {
            send(ws, { type: "data", data: existing.buffered });
            existing.buffered = "";
          }
          return;
        }
        ensurePtyPermissions();
        const { file, args } = resolveShell();
        let term: pty.IPty;
        try {
          term = pty.spawn(file, args, {
            name: "xterm-256color",
            cols: msg.cols || 80,
            rows: msg.rows || 24,
            cwd,
            env: {
              ...(process.env as Record<string, string>),
              TERM: "dumb",
              COLORTERM: "",
              NO_COLOR: "1",
              FORCE_COLOR: "0",
            },
          });
        } catch (err) {
          send(ws, {
            type: "error",
            message: `pty spawn failed: ${(err as Error).message}`,
          });
          return;
        }
        const id = randomUUID();
        const session: Session = {
          id,
          term,
          projectId: msg.projectId,
          cwd,
          ws,
          buffered: "",
          expiry: null,
        };
        term.onData((data) => {
          if (session.ws) {
            send(session.ws, { type: "data", data });
          } else {
            session.buffered = (session.buffered + data).slice(-65536);
          }
        });
        term.onExit(({ exitCode }) => {
          if (session.ws) {
            send(session.ws, { type: "exit", code: exitCode });
            this.socketSessions.delete(session.ws);
          }
          if (session.expiry) clearTimeout(session.expiry);
          this.sessions.delete(session.id);
        });
        this.sessions.set(id, session);
        this.socketSessions.set(ws, id);
        send(ws, { type: "ready", projectId: msg.projectId, cwd, sessionId: id });
        return;
      }

      const sessionId = this.socketSessions.get(ws);
      const session = sessionId ? this.sessions.get(sessionId) : undefined;
      if (!session) {
        send(ws, { type: "error", message: "not attached" });
        return;
      }

      if (msg.type === "input") {
        session.term.write(msg.data);
        return;
      }
      if (msg.type === "resize") {
        session.term.resize(msg.cols, msg.rows);
      }
    });

    ws.on("close", () => this.detach(ws));
  }

  close(): void {
    for (const session of this.sessions.values()) {
      if (session.expiry) clearTimeout(session.expiry);
      try {
        session.term.kill();
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
  }

  private detach(ws: WebSocket): void {
    const id = this.socketSessions.get(ws);
    if (!id) return;
    const session = this.sessions.get(id);
    if (!session) return;
    this.socketSessions.delete(ws);
    if (session.ws === ws) session.ws = null;
    if (session.expiry) clearTimeout(session.expiry);
    session.expiry = setTimeout(
      () => this.destroySession(id),
      60 * 60 * 1000,
    );
    session.expiry.unref?.();
  }

  private destroySession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.expiry) clearTimeout(session.expiry);
    try {
      session.term.kill();
    } catch {
      // ignore
    }
    this.sessions.delete(id);
  }
}

export function defaultShellHint(): string {
  return process.env.SHELL || (os.platform() === "win32" ? "powershell" : "zsh");
}
