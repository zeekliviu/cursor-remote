import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  ChatChangedFile,
  ChatDetail,
  ChatImage,
  ChatMessage,
  ChatSummary,
  Project,
} from "@cursor-remote/shared";
import { lineDiff } from "./line-diff.js";
import type { CursorPaths } from "./paths.js";

type ComposerData = {
  composerId?: string;
  name?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  unifiedMode?: string;
  filesChangedCount?: number;
  isDraft?: boolean;
  isAgentic?: boolean;
  isBestOfNSubcomposer?: boolean;
  isBestOfNParent?: boolean;
  isSpec?: boolean;
  subComposerIds?: string[];
  subagentComposerIds?: string[];
  newlyCreatedFiles?: Array<{ uri?: { fsPath?: string; path?: string; external?: string } }>;
  originalFileStates?: Record<
    string,
    {
      firstEditBubbleId?: string;
      isNewlyCreated?: boolean;
      contentKey?: string;
    }
  >;
  workspaceIdentifier?: {
    id?: string;
    uri?: { fsPath?: string; path?: string; external?: string };
  };
  fullConversationHeadersOnly?: Array<{
    bubbleId: string;
    type?: number;
    createdAt?: string;
  }>;
};

function openReadonly(dbPath: string): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function fileUriToPath(uri: string): string {
  if (uri.startsWith("vscode-remote://")) {
    // vscode-remote://ssh-remote%2Bhost/home/user/proj
    try {
      const without = uri.replace(/^vscode-remote:\/\//, "");
      const slash = without.indexOf("/");
      if (slash >= 0) {
        return decodeURIComponent(without.slice(slash));
      }
      return decodeURIComponent(without);
    } catch {
      return uri;
    }
  }
  try {
    const u = new URL(uri);
    let p = decodeURIComponent(u.pathname);
    if (process.platform === "win32" && p.startsWith("/")) {
      p = p.slice(1);
    }
    return p;
  } catch {
    return uri.replace(/^file:\/\//, "");
  }
}

function projectNameFromPath(projectPath: string, uri: string): string {
  const base = path.basename(projectPath);
  if (base && base !== "/" && base !== ".") return base;
  if (uri.startsWith("vscode-remote://")) {
    const auth = uri.replace(/^vscode-remote:\/\//, "").split("/")[0];
    return decodeURIComponent(auth);
  }
  return projectPath || "workspace";
}

function isAgentSystemNoise(text: string): boolean {
  return (
    /<system_notification>/i.test(text) ||
    /<\/user_query>/i.test(text) ||
    /^<timestamp>/i.test(text.trim())
  );
}

function summarizeSystemNoise(text: string): string {
  const title = text.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim();
  const detail = text.match(/detail:\s*([^\n<]+)/i)?.[1]?.trim();
  const status = text.match(/status:\s*(\w+)/i)?.[1]?.trim();
  const bits = [
    title ? `Task finished: ${title}` : "Background task finished",
    status ? `(${status})` : null,
    detail || null,
  ].filter(Boolean);
  return bits.join(" · ");
}

function basenamePath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|heic)$/i;
const PHONE_ATTACH_RE =
  /\[Phone attachments — read on host:\s*([^\](]+?)(?:\s*\([^)]*\))?\]/gi;

function isImagePath(p: string): boolean {
  return IMAGE_EXT_RE.test(p.trim());
}

function mimeForImagePath(p: string): string | undefined {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".heic") return "image/heic";
  return undefined;
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function extractImagePathFromTool(params: unknown, rawArgs?: unknown): string | null {
  const obj = parseJsonObject(params) || parseJsonObject(rawArgs);
  if (!obj) return null;
  for (const key of [
    "targetFile",
    "effectiveUri",
    "path",
    "relativeWorkspacePath",
    "file",
  ]) {
    const v = obj[key];
    if (typeof v === "string" && isImagePath(v)) return v;
  }
  return null;
}

function extractPhoneAttachmentPaths(text: string): {
  paths: string[];
  cleaned: string;
} {
  const paths: string[] = [];
  const cleaned = text
    .replace(PHONE_ATTACH_RE, (_, p: string) => {
      const trimmed = String(p || "").trim();
      if (trimmed && isImagePath(trimmed)) paths.push(trimmed);
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { paths, cleaned };
}

/** Cursor stores Composer images under workspaceStorage/<id>/images/<uuid>-….ext */
function resolveImageUuid(
  workspaceStorage: string,
  uuid: string,
): string | null {
  if (!uuid || !fs.existsSync(workspaceStorage)) return null;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(workspaceStorage);
  } catch {
    return null;
  }
  for (const ws of entries) {
    const imgDir = path.join(workspaceStorage, ws, "images");
    if (!fs.existsSync(imgDir)) continue;
    let files: string[] = [];
    try {
      files = fs.readdirSync(imgDir);
    } catch {
      continue;
    }
    const match = files.find(
      (f) => f.startsWith(uuid) && isImagePath(f),
    );
    if (match) return path.join(imgDir, match);
  }
  return null;
}

function chatImageFromPath(
  filePath: string,
  dims?: { width?: number; height?: number },
): ChatImage | null {
  const resolved = path.resolve(filePath);
  if (!isImagePath(resolved)) return null;
  if (!fs.existsSync(resolved)) return null;
  return {
    path: resolved,
    name: basenamePath(resolved),
    mime: mimeForImagePath(resolved),
    width: dims?.width,
    height: dims?.height,
  };
}

function mergeImages(
  into: ChatImage[] | undefined,
  add: ChatImage[],
): ChatImage[] {
  const out = [...(into || [])];
  const seen = new Set(out.map((i) => i.path.toLowerCase()));
  for (const img of add) {
    const key = img.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(img);
  }
  return out;
}

/**
 * Fold image-only read tools onto the preceding user bubble and drop them from
 * the tool stream so Expo shows photos under the user's message.
 */
function attachImagesToUserMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const toolPath =
      m.role === "tool" || m.hasTools
        ? extractImagePathFromTool(m.tool?.params)
        : null;
    const isImageRead =
      Boolean(toolPath) &&
      (m.tool?.name === "read_file_v2" || m.tool?.name === "read_file");

    if (isImageRead && toolPath) {
      const img = chatImageFromPath(toolPath);
      if (img) {
        for (let i = out.length - 1; i >= 0; i--) {
          if (out[i].role === "user") {
            out[i] = {
              ...out[i],
              images: mergeImages(out[i].images, [img]),
            };
            break;
          }
        }
        // Skip rendering this as a tool row — the photo sits on the user bubble.
        continue;
      }
    }
    out.push(m);
  }
  return out;
}

export class CursorStore {
  constructor(private readonly paths: CursorPaths) {}

  listProjects(): Project[] {
    const root = this.paths.workspaceStorage;
    if (!fs.existsSync(root)) return [];
    const projects: Project[] = [];
    for (const id of fs.readdirSync(root)) {
      const dir = path.join(root, id);
      if (!fs.statSync(dir).isDirectory()) continue;
      const metaPath = path.join(dir, "workspace.json");
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
          folder?: string;
          workspace?: string;
        };
        const uri = meta.folder || meta.workspace;
        if (!uri) continue;
        const projectPath = fileUriToPath(uri);
        projects.push({
          id,
          name: projectNameFromPath(projectPath, uri),
          path: projectPath,
          uri,
        });
      } catch {
        // skip corrupt workspace.json
      }
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name));
  }

  getProject(projectId: string): Project | undefined {
    return this.listProjects().find((p) => p.id === projectId);
  }

  listChats(projectId: string): ChatSummary[] {
    const project = this.getProject(projectId);
    if (!project) return [];

    const childIds = this.collectSubagentComposerIds();

    let list: ChatSummary[] = [];
    const fromWorkspace = this.chatsFromWorkspaceDb(projectId);
    if (fromWorkspace.length > 0) list = fromWorkspace;
    else {
      const fromGlobal = this.chatsFromGlobalComposerData(
        projectId,
        project.path,
      );
      if (fromGlobal.length > 0) list = fromGlobal;
      else list = this.chatsFromSearchIndex(projectId);
    }

    return this.annotateMessageable(list, childIds).sort((a, b) => {
      // Messageable first, then recency
      if (Boolean(a.messageable) !== Boolean(b.messageable)) {
        return a.messageable ? -1 : 1;
      }
      return (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0);
    });
  }

  getChat(chatId: string): ChatDetail | null {
    const globalDb = openReadonly(this.paths.globalDb);
    if (!globalDb) return null;
    try {
      const row = globalDb
        .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
        .get(`composerData:${chatId}`) as { value: string } | undefined;
      if (!row) return null;
      const data = JSON.parse(row.value) as ComposerData;
      const projectId = data.workspaceIdentifier?.id || "unknown";
      const headers = data.fullConversationHeadersOnly || [];
      const readKv = (key: string): string | null => {
        const r = globalDb
          .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
          .get(key) as { value: string } | undefined;
        return r?.value ?? null;
      };

      const messages: ChatMessage[] = [];
      for (const h of headers) {
        const bubbleRow = globalDb
          .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
          .get(`bubbleId:${chatId}:${h.bubbleId}`) as
          | { value: string }
          | undefined;
        if (!bubbleRow) continue;
        const bubble = JSON.parse(bubbleRow.value) as {
          bubbleId?: string;
          type?: number;
          text?: string;
          createdAt?: string;
          thinking?: { text?: string };
          thinkingDurationMs?: number;
          images?: Array<{
            uuid?: string;
            path?: string;
            dimension?: { width?: number; height?: number };
          }>;
          toolFormerData?: {
            name?: string;
            status?: string;
            params?: unknown;
            rawArgs?: unknown;
            result?: unknown;
            additionalData?: unknown;
          };
        };
        let text = (bubble.text || "").trim();
        const thinkingText = (bubble.thinking?.text || "").trim();
        const tfd = bubble.toolFormerData;
        const hasTools = Boolean(tfd);

        const bubbleImages: ChatImage[] = [];
        for (const img of bubble.images || []) {
          if (img.path && isImagePath(img.path)) {
            const resolved = chatImageFromPath(img.path, img.dimension);
            if (resolved) bubbleImages.push(resolved);
            continue;
          }
          if (img.uuid) {
            const filePath = resolveImageUuid(
              this.paths.workspaceStorage,
              img.uuid,
            );
            if (filePath) {
              const resolved = chatImageFromPath(filePath, img.dimension);
              if (resolved) bubbleImages.push(resolved);
            }
          }
        }
        if (text) {
          const phone = extractPhoneAttachmentPaths(text);
          for (const p of phone.paths) {
            const resolved = chatImageFromPath(p);
            if (resolved) bubbleImages.push(resolved);
          }
          if (phone.paths.length) text = phone.cleaned;
        }

        if (!text && !hasTools && !thinkingText && bubbleImages.length === 0) {
          continue;
        }

        // Agent harness noise stored as type=1 "user" bubbles
        if (bubble.type === 1 && text && isAgentSystemNoise(text)) {
          messages.push({
            id: bubble.bubbleId || h.bubbleId,
            role: "system",
            text: summarizeSystemNoise(text),
            createdAt: bubble.createdAt || h.createdAt,
          });
          continue;
        }

        let tool:
          | {
              name: string;
              status?: string;
              params?: string;
              resultPreview?: string;
              diffPatch?: string;
              additions?: number;
              deletions?: number;
              exitCode?: number;
              output?: string;
            }
          | undefined;

        if (tfd && typeof tfd === "object") {
          const paramsObj =
            typeof tfd.params === "string"
              ? (() => {
                  try {
                    return JSON.parse(tfd.params) as Record<string, unknown>;
                  } catch {
                    return null;
                  }
                })()
              : tfd.params && typeof tfd.params === "object"
                ? (tfd.params as Record<string, unknown>)
                : null;
          const paramsStr = paramsObj
            ? JSON.stringify(paramsObj)
            : typeof tfd.params === "string"
              ? tfd.params
              : undefined;

          let resultObj: Record<string, unknown> | null = null;
          if (typeof tfd.result === "string") {
            try {
              const parsed = JSON.parse(tfd.result);
              if (parsed && typeof parsed === "object") {
                resultObj = parsed as Record<string, unknown>;
              }
            } catch {
              resultObj = null;
            }
          } else if (tfd.result && typeof tfd.result === "object") {
            resultObj = tfd.result as Record<string, unknown>;
          }

          const add =
            tfd.additionalData && typeof tfd.additionalData === "object"
              ? (tfd.additionalData as Record<string, unknown>)
              : {};

          const status =
            tfd.status ||
            (typeof add.status === "string" ? add.status : undefined);

          let diffPatch: string | undefined;
          let additions: number | undefined;
          let deletions: number | undefined;
          let exitCode: number | undefined;
          let output: string | undefined;

          if (tfd.name === "edit_file_v2" && resultObj) {
            const beforeId = String(resultObj.beforeContentId || "");
            const afterId = String(resultObj.afterContentId || "");
            const before = beforeId ? readKv(beforeId) : null;
            const after = afterId ? readKv(afterId) : null;
            const filePath = String(
              paramsObj?.relativeWorkspacePath || paramsObj?.path || "file",
            );
            if (before != null && after != null) {
              // Cheap path for huge blobs: only count when reasonably sized
              const lines =
                before.split("\n").length + after.split("\n").length;
              if (lines <= 2500) {
                const d = lineDiff(before, after, basenamePath(filePath), 80);
                additions = d.additions;
                deletions = d.deletions;
                diffPatch = d.patch;
              } else {
                additions = Math.max(0, after.split("\n").length - before.split("\n").length);
                deletions = Math.max(0, before.split("\n").length - after.split("\n").length);
                diffPatch = `--- a/${basenamePath(filePath)}\n+++ b/${basenamePath(filePath)}\n(large edit · open Files Changed for full diff)`;
              }
            }
          }

          if (tfd.name === "run_terminal_command_v2") {
            if (resultObj && typeof resultObj.output === "string") {
              output = resultObj.output.slice(0, 4000);
            }
            if (typeof resultObj?.exitCode === "number") {
              exitCode = resultObj.exitCode as number;
            } else if (typeof add.exitCode === "number") {
              exitCode = add.exitCode as number;
            }
          }

          let resultStr = resultObj
            ? JSON.stringify({
                ...resultObj,
                output:
                  typeof resultObj.output === "string"
                    ? resultObj.output.slice(0, 2000)
                    : resultObj.output,
              })
            : typeof tfd.result === "string"
              ? tfd.result
              : tfd.result
                ? JSON.stringify(tfd.result)
                : undefined;

          tool = {
            name: tfd.name || "tool",
            status,
            params: paramsStr?.slice(0, 4000),
            resultPreview: resultStr?.slice(0, 3500),
            diffPatch,
            additions,
            deletions,
            exitCode,
            output,
          };
        }

        const toolLabel = tool
          ? tool.name === "run_terminal_command_v2"
            ? "terminal"
            : tool.name.replace(/_v2$/, "").replace(/_/g, " ")
          : undefined;

        if (thinkingText && !text && !hasTools) {
          const dur = bubble.thinkingDurationMs;
          const durLabel =
            dur == null
              ? ""
              : dur < 1000
                ? "briefly"
                : `${Math.max(1, Math.round(dur / 1000))}s`;
          messages.push({
            id: bubble.bubbleId || h.bubbleId,
            role: "thinking",
            text: durLabel ? `Thought · ${durLabel}` : "Thinking…",
            createdAt: bubble.createdAt || h.createdAt,
            thinking: thinkingText,
            thinkingDurationMs: dur,
          });
          continue;
        }

        messages.push({
          id: bubble.bubbleId || h.bubbleId,
          role:
            bubble.type === 1
              ? "user"
              : hasTools && !text
                ? "tool"
                : "assistant",
          text:
            text ||
            (tool
              ? `${toolLabel}${tool.status ? ` (${tool.status})` : ""}`
              : bubbleImages.length
                ? ""
                : "[tool call]"),
          createdAt: bubble.createdAt || h.createdAt,
          hasTools,
          tool,
          thinking: thinkingText || undefined,
          thinkingDurationMs: bubble.thinkingDurationMs,
          images: bubbleImages.length ? bubbleImages : undefined,
        });
      }

      const withImages = attachImagesToUserMessages(messages);
      const filesChanged = this.buildFilesChangedFromLatestTurn(withImages);
      const childIds = this.collectSubagentComposerIds();
      const messageable = this.isMessageableComposer(chatId, data, childIds);

      return {
        id: chatId,
        projectId,
        name: data.name || "Untitled",
        createdAt: data.createdAt,
        lastUpdatedAt: data.lastUpdatedAt,
        mode: data.unifiedMode,
        messageable,
        messages: withImages,
        filesChangedCount: filesChanged.length || undefined,
        filesChanged,
      };
    } finally {
      globalDb.close();
    }
  }

  /**
   * Files changed for the latest assistant turn only — matches Cursor's
   * "N File(s) Changed" card under the last response (not the whole chat).
   */
  private buildFilesChangedFromLatestTurn(
    messages: ChatMessage[],
  ): ChatChangedFile[] {
    const byPath = new Map<string, ChatChangedFile>();
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "user") break;
      const tool = m.tool;
      if (!tool?.name) continue;
      if (
        !/edit|write|search_replace|apply_patch|create_file|delete_file|StrReplace|Write|Delete/i.test(
          tool.name,
        )
      ) {
        continue;
      }
      let filePath = "";
      if (tool.params) {
        try {
          const p = JSON.parse(tool.params) as Record<string, unknown>;
          filePath = String(
            p.relativeWorkspacePath ||
              p.targetFile ||
              p.path ||
              p.file ||
              p.uri ||
              "",
          );
        } catch {
          filePath = "";
        }
      }
      if (!filePath && tool.diffPatch) {
        const m2 = tool.diffPatch.match(/^\+\+\+\s+b\/(.+)$/m);
        if (m2) filePath = m2[1];
      }
      if (!filePath) continue;
      const prev = byPath.get(filePath);
      byPath.set(filePath, {
        path: filePath,
        additions:
          tool.additions != null || prev?.additions != null
            ? (prev?.additions || 0) + (tool.additions || 0)
            : undefined,
        deletions:
          tool.deletions != null || prev?.deletions != null
            ? (prev?.deletions || 0) + (tool.deletions || 0)
            : undefined,
        patch: tool.diffPatch || prev?.patch,
        isNew: /create_file|^Write$/i.test(tool.name) || prev?.isNew,
      });
    }
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Diff for one changed file vs its original snapshot in Cursor storage. */
  getChangedFileDiff(
    chatId: string,
    filePath: string,
  ): ChatChangedFile | null {
    const globalDb = openReadonly(this.paths.globalDb);
    if (!globalDb) return null;
    try {
      const row = globalDb
        .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
        .get(`composerData:${chatId}`) as { value: string } | undefined;
      if (!row) return null;
      const data = JSON.parse(row.value) as ComposerData;
      const readKv = (key: string): string | null => {
        const r = globalDb
          .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
          .get(key) as { value: string } | undefined;
        return r?.value ?? null;
      };
      const files = this.buildFilesChanged(data, readKv, filePath, true);
      return files[0] || null;
    } finally {
      globalDb.close();
    }
  }

  private buildFilesChanged(
    data: ComposerData,
    readKv: (key: string) => string | null,
    onlyPath?: string,
    withFullPatch = false,
  ): ChatChangedFile[] {
    const states = data.originalFileStates || {};
    const out: ChatChangedFile[] = [];
    for (const [uri, st] of Object.entries(states)) {
      const fsPath = fileUriToPath(uri);
      if (onlyPath && fsPath !== onlyPath && !fsPath.endsWith(onlyPath)) {
        continue;
      }
      // List mode: metadata only (chat poll must stay cheap)
      if (!withFullPatch && !onlyPath) {
        out.push({
          path: fsPath,
          isNew: Boolean(st.isNewlyCreated),
        });
        continue;
      }

      let additions: number | undefined;
      let deletions: number | undefined;
      let patch: string | undefined;
      const original = st.contentKey ? readKv(st.contentKey) : null;
      let current: string | null = null;
      try {
        if (fs.existsSync(fsPath) && fs.statSync(fsPath).isFile()) {
          current = fs.readFileSync(fsPath, "utf8");
        }
      } catch {
        current = null;
      }
      if (original != null && current != null) {
        const d = lineDiff(
          original,
          current,
          basenamePath(fsPath),
          withFullPatch ? 400 : 80,
        );
        additions = d.additions;
        deletions = d.deletions;
        patch = d.patch;
      } else if (st.isNewlyCreated && current != null) {
        additions = current.split("\n").length;
        deletions = 0;
        patch = `--- /dev/null\n+++ b/${basenamePath(fsPath)}\n@@\n${current
          .split("\n")
          .slice(0, 80)
          .map((l) => `+${l}`)
          .join("\n")}`;
      }
      out.push({
        path: fsPath,
        isNew: Boolean(st.isNewlyCreated),
        additions,
        deletions,
        patch,
      });
      if (onlyPath) break;
    }
    return out
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, onlyPath ? 1 : 80);
  }

  /**
   * Subagent / explore transcripts are referenced from a parent agent and
   * have no Composer input in Cursor — treat as view-only.
   */
  private collectSubagentComposerIds(): Set<string> {
    const out = new Set<string>();
    const db = openReadonly(this.paths.globalDb);
    if (!db) return out;
    try {
      const rows = db
        .prepare(
          "SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%'",
        )
        .all() as Array<{ value: string }>;
      for (const row of rows) {
        try {
          const data = JSON.parse(row.value) as ComposerData;
          for (const id of data.subagentComposerIds || []) {
            if (id) out.add(id);
          }
          for (const id of data.subComposerIds || []) {
            if (id) out.add(id);
          }
        } catch {
          // skip bad rows
        }
      }
    } finally {
      db.close();
    }
    return out;
  }

  private isMessageableComposer(
    chatId: string,
    data: ComposerData | undefined,
    childIds: Set<string>,
  ): boolean {
    if (childIds.has(chatId)) return false;
    if (data?.isBestOfNSubcomposer) return false;
    return true;
  }

  private annotateMessageable(
    list: ChatSummary[],
    childIds: Set<string>,
  ): ChatSummary[] {
    const db = openReadonly(this.paths.globalDb);
    const dataById = new Map<string, ComposerData>();
    if (db) {
      try {
        for (const c of list) {
          const row = db
            .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
            .get(`composerData:${c.id}`) as { value: string } | undefined;
          if (!row) continue;
          try {
            dataById.set(c.id, JSON.parse(row.value) as ComposerData);
          } catch {
            // skip
          }
        }
      } finally {
        db.close();
      }
    }
    return list.map((c) => ({
      ...c,
      messageable: this.isMessageableComposer(c.id, dataById.get(c.id), childIds),
    }));
  }

  private chatsFromWorkspaceDb(projectId: string): ChatSummary[] {
    const dbPath = path.join(this.paths.workspaceStorage, projectId, "state.vscdb");
    const db = openReadonly(dbPath);
    if (!db) return [];
    try {
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = ?")
        .get("composer.composerData") as { value: string } | undefined;
      if (!row) return [];
      const data = JSON.parse(row.value) as {
        allComposers?: Array<{
          composerId: string;
          name?: string;
          createdAt?: number;
          lastUpdatedAt?: number;
          unifiedMode?: string;
        }>;
      };
      const all = data.allComposers;
      if (!Array.isArray(all) || all.length === 0) return [];
      return all
        .filter((c) => c.composerId && c.composerId !== "empty-state-draft")
        .map((c) => ({
          id: c.composerId,
          projectId,
          name: c.name || "Untitled",
          createdAt: c.createdAt,
          lastUpdatedAt: c.lastUpdatedAt,
          mode: c.unifiedMode,
        }))
        .sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0));
    } catch {
      return [];
    } finally {
      db.close();
    }
  }

  private chatsFromGlobalComposerData(projectId: string, projectPath: string): ChatSummary[] {
    const db = openReadonly(this.paths.globalDb);
    if (!db) return [];
    try {
      const rows = db
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
        .all() as Array<{ key: string; value: string }>;
      const out: ChatSummary[] = [];
      for (const row of rows) {
        const id = row.key.slice("composerData:".length);
        if (!id || id === "empty-state-draft") continue;
        let data: ComposerData;
        try {
          data = JSON.parse(row.value) as ComposerData;
        } catch {
          continue;
        }
        const wsId = data.workspaceIdentifier?.id;
        const fsPath =
          data.workspaceIdentifier?.uri?.fsPath ||
          data.workspaceIdentifier?.uri?.path;
        const match =
          wsId === projectId ||
          (fsPath && path.resolve(fsPath) === path.resolve(projectPath));
        if (!match) continue;
        out.push({
          id,
          projectId,
          name: data.name || "Untitled",
          createdAt: data.createdAt,
          lastUpdatedAt: data.lastUpdatedAt,
          mode: data.unifiedMode,
        });
      }
      return out.sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0));
    } finally {
      db.close();
    }
  }

  private chatsFromSearchIndex(projectId: string): ChatSummary[] {
    const searchDb = openReadonly(this.paths.conversationSearchDb);
    const globalDb = openReadonly(this.paths.globalDb);
    if (!searchDb || !globalDb) {
      searchDb?.close();
      globalDb?.close();
      return [];
    }
    try {
      const rows = searchDb
        .prepare(
          "SELECT id, title, updated_at, is_archived FROM conversations WHERE source = 'local' ORDER BY updated_at DESC",
        )
        .all() as Array<{
        id: string;
        title: string;
        updated_at: number;
        is_archived: number;
      }>;
      const out: ChatSummary[] = [];
      for (const row of rows) {
        const composerRow = globalDb
          .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
          .get(`composerData:${row.id}`) as { value: string } | undefined;
        if (!composerRow) continue;
        let data: ComposerData;
        try {
          data = JSON.parse(composerRow.value) as ComposerData;
        } catch {
          continue;
        }
        if (data.workspaceIdentifier?.id !== projectId) continue;
        out.push({
          id: row.id,
          projectId,
          name: row.title || data.name || "Untitled",
          lastUpdatedAt: row.updated_at,
          createdAt: data.createdAt,
          mode: data.unifiedMode,
          isArchived: Boolean(row.is_archived),
        });
      }
      return out;
    } finally {
      searchDb.close();
      globalDb.close();
    }
  }
}
