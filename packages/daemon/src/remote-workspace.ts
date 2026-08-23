import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AttachmentMeta, Project } from "@cursor-remote/shared";

export type SshRemoteProject = {
  sshHost: string;
  workspacePath: string;
};

/** Parse vscode-remote://ssh-remote+host/path → SSH host alias + Linux workspace root. */
export function parseSshRemoteProject(
  project: Pick<Project, "uri" | "path">,
): SshRemoteProject | null {
  const uri = project.uri || "";
  if (!uri.startsWith("vscode-remote://")) return null;
  const without = uri.replace(/^vscode-remote:\/\//, "");
  const slash = without.indexOf("/");
  if (slash < 0) return null;
  const authority = decodeURIComponent(without.slice(0, slash));
  if (!authority.startsWith("ssh-remote+")) return null;
  const sshHost = decodeURIComponent(authority.slice("ssh-remote+".length));
  if (!sshHost) return null;
  const workspacePath = project.path?.replace(/\/+$/, "") || "";
  if (!workspacePath.startsWith("/")) return null;
  return { sshHost, workspacePath };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runCommand(
  file: string,
  args: string[],
  stdin?: Buffer,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(file, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve({ code: code ?? 1, stderr });
    });
    if (stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }
  });
}

async function sshExec(host: string, remoteCommand: string): Promise<void> {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "StrictHostKeyChecking=accept-new",
    host,
    remoteCommand,
  ];
  const { code, stderr } = await runCommand("ssh", args);
  if (code !== 0) {
    throw new Error(
      `ssh ${host} failed (${code}): ${stderr.trim() || "unknown error"}`,
    );
  }
}

async function scpToRemote(
  localPath: string,
  host: string,
  remotePath: string,
): Promise<void> {
  const remoteDir = path.posix.dirname(remotePath);
  await sshExec(host, `mkdir -p ${shellQuote(remoteDir)}`);
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "StrictHostKeyChecking=accept-new",
    localPath,
    `${host}:${remotePath}`,
  ];
  const { code, stderr } = await runCommand("scp", args);
  if (code !== 0) {
    throw new Error(
      `scp to ${host}:${remotePath} failed (${code}): ${stderr.trim() || "unknown error"}`,
    );
  }
}

function remoteUploadPath(
  workspacePath: string,
  file: AttachmentMeta,
): string {
  const folder = file.id || path.basename(path.dirname(file.path));
  const name = file.name || path.basename(file.path);
  return path.posix.join(
    workspacePath,
    ".cursor-remote-uploads",
    folder,
    name,
  );
}

/**
 * For SSH-remote Cursor workspaces, copy phone uploads into the remote project
 * so agent tools can read them. Local copies are kept for /media preview.
 */
export async function stageAttachmentsForProject(
  files: AttachmentMeta[],
  project: Pick<Project, "uri" | "path">,
): Promise<AttachmentMeta[]> {
  const remote = parseSshRemoteProject(project);
  if (!remote || !files.length) return files;

  const staged: AttachmentMeta[] = [];
  for (const file of files) {
    if (!fs.existsSync(file.path)) {
      throw new Error(`upload missing on daemon host: ${file.path}`);
    }
    const remotePath = remoteUploadPath(remote.workspacePath, file);
    await scpToRemote(file.path, remote.sshHost, remotePath);
    staged.push({ ...file, remotePath });
  }
  return staged;
}
