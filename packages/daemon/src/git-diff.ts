import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiffFile, DiffResponse } from "@cursor-remote/shared";

const execFileAsync = promisify(execFile);

async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    encoding: "utf8",
  });
}

export async function getProjectDiff(
  projectId: string,
  projectPath: string,
): Promise<DiffResponse> {
  let branch: string | undefined;
  try {
    const { stdout } = await git(projectPath, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    branch = stdout.trim();
  } catch {
    branch = undefined;
  }

  let statusOut = "";
  try {
    const { stdout } = await git(projectPath, [
      "status",
      "--porcelain",
      "-uall",
    ]);
    statusOut = stdout;
  } catch (err) {
    throw new Error(`not a git repo or git failed: ${(err as Error).message}`);
  }

  const files: DiffFile[] = [];
  for (const line of statusOut.split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2).trim() || line.slice(0, 2);
    const filePath = line.slice(3).trim();
    if (!filePath) continue;
    files.push({ path: filePath, status });
  }

  let patch = "";
  try {
    const unstaged = await git(projectPath, ["diff", "--no-color"]);
    const staged = await git(projectPath, ["diff", "--cached", "--no-color"]);
    patch = [staged.stdout, unstaged.stdout].filter(Boolean).join("\n");
  } catch {
    patch = "";
  }

  return { projectId, branch, files, patch };
}
