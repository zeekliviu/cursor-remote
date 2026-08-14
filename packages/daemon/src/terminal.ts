import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import * as pty from "node-pty";
import type { WebSocket } from "ws";
import type {
  TerminalClientMessage,
  TerminalServerMessage,
} from "@cursor-remote/shared";

const require = createRequire(import.meta.url);

type Session = {
  term: pty.IPty;
  projectId: string;
  cwd: string;
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
  private sessions = new WeakMap<WebSocket, Session>();

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
        this.dispose(ws);
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
        term.onData((data) => send(ws, { type: "data", data }));
        term.onExit(({ exitCode }) => {
          send(ws, { type: "exit", code: exitCode });
          this.dispose(ws);
        });
        this.sessions.set(ws, { term, projectId: msg.projectId, cwd });
        send(ws, { type: "ready", projectId: msg.projectId, cwd });
        return;
      }

      const session = this.sessions.get(ws);
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

    ws.on("close", () => this.dispose(ws));
  }

  private dispose(ws: WebSocket): void {
    const session = this.sessions.get(ws);
    if (!session) return;
    try {
      session.term.kill();
    } catch {
      // ignore
    }
    this.sessions.delete(ws);
  }
}

export function defaultShellHint(): string {
  return process.env.SHELL || (os.platform() === "win32" ? "powershell" : "zsh");
}
