import type { ChatMessage } from "@cursor-remote/shared";

export const CHAT_DENSITIES = ["compact", "balanced", "detailed"] as const;
export type ChatDensity = (typeof CHAT_DENSITIES)[number];

export const TOOL_CATEGORIES = [
  "Explore",
  "Edit",
  "Terminal",
  "Web",
  "MCP",
  "PlanTodos",
  "Subagent",
  "Other",
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export type ChatThinkingEntry = {
  id: string;
  messageId: string;
  text: string;
  durationMs?: number;
  message: ChatMessage;
};

export type ToolStats = {
  toolCount: number;
  errorCount: number;
  fileCount: number;
  files: string[];
  additions: number;
  deletions: number;
};

export type ToolCluster = {
  id: string;
  category: ToolCategory;
  messages: ChatMessage[];
  stats: ToolStats;
};

export type ChatTurnTimelineItem =
  | { id: string; kind: "thinking"; entry: ChatThinkingEntry }
  | { id: string; kind: "tools"; cluster: ToolCluster }
  | { id: string; kind: "system"; message: ChatMessage }
  | { id: string; kind: "assistant"; message: ChatMessage };

export type TurnDurationSource = "timestamps" | "thinking";

export type ChatTurn = {
  id: string;
  user?: ChatMessage;
  messages: ChatMessage[];
  thinking: ChatThinkingEntry[];
  systemMessages: ChatMessage[];
  toolMessages: ChatMessage[];
  toolClusters: ToolCluster[];
  timeline: ChatTurnTimelineItem[];
  assistantMessages: ChatMessage[];
  finalAssistant?: ChatMessage;
  stats: ToolStats;
  /** Earliest valid message timestamp, as Unix milliseconds. */
  startedAt?: number;
  /** Latest valid message timestamp, as Unix milliseconds. */
  endedAt?: number;
  durationMs?: number;
  durationSource?: TurnDurationSource;
};

export type ToolClusterVisibility = "summary" | "important" | "all";

export type DefaultExpansionGuidance = {
  turnExpanded: boolean;
  thinkingExpanded: boolean;
  systemExpanded: boolean;
  expandedToolClusterIds: string[];
  reason: "active" | "recent" | "failure" | "older";
};

export type ExpansionGuidanceOptions = {
  density?: ChatDensity;
  isActive?: boolean;
  /** Number of completed turns newer than this one. */
  completedTurnsAfter?: number;
};

const IMPORTANT_CATEGORIES = new Set<ToolCategory>([
  "Edit",
  "Terminal",
  "PlanTodos",
  "Subagent",
]);

function normalizedToolName(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/^functions[./:-]/, "")
    .replace(/[\s./:\\-]+/g, "_")
    .replace(/_+/g, "_");
}

function hasNamePart(name: string, parts: readonly string[]): boolean {
  return parts.some((part) => name.includes(part));
}

/** Classify both Cursor's stored names and the current agent tool names. */
export function classifyToolName(rawName?: string | null): ToolCategory {
  const name = normalizedToolName(rawName || "");
  if (!name) return "Other";

  if (
    name === "get_mcp_tools" ||
    name === "call_mcp_tool" ||
    name === "fetch_mcp_resource" ||
    name.startsWith("mcp_") ||
    name.endsWith("_mcp") ||
    name.includes("_mcp_")
  ) {
    return "MCP";
  }

  if (
    hasNamePart(name, [
      "subagent",
      "sub_agent",
      "delegate_agent",
      "spawn_agent",
      "launch_agent",
      "background_agent",
    ]) ||
    name === "task" ||
    name.startsWith("task_")
  ) {
    return "Subagent";
  }

  if (
    hasNamePart(name, [
      "todo",
      "create_plan",
      "update_plan",
      "plan_create",
      "plan_update",
      "switch_mode",
      "update_current_step",
    ])
  ) {
    return "PlanTodos";
  }

  if (
    hasNamePart(name, [
      "web_search",
      "web_fetch",
      "browser",
      "open_url",
      "fetch_url",
      "http_request",
    ])
  ) {
    return "Web";
  }

  if (
    hasNamePart(name, [
      "run_terminal",
      "terminal_command",
      "shell_command",
      "execute_command",
      "exec_command",
      "await_shell",
    ]) ||
    name === "shell" ||
    name === "terminal" ||
    name === "await"
  ) {
    return "Terminal";
  }

  if (
    hasNamePart(name, [
      "edit_file",
      "write_file",
      "delete_file",
      "apply_patch",
      "edit_notebook",
      "create_file",
      "rename_file",
      "move_file",
    ])
  ) {
    return "Edit";
  }

  if (
    hasNamePart(name, [
      "read_file",
      "glob",
      "grep",
      "ripgrep",
      "codebase_search",
      "file_search",
      "search_files",
      "list_dir",
      "list_files",
    ]) ||
    name === "rg" ||
    name === "search"
  ) {
    return "Explore";
  }

  return "Other";
}

export function classifyToolMessage(message: ChatMessage): ToolCategory {
  return classifyToolName(message.tool?.name);
}

export function isToolMessage(message: ChatMessage): boolean {
  if (message.role === "tool" || message.tool) return true;
  if (message.text === "[tool call]") return true;
  return Boolean(message.hasTools && !message.text.trim());
}

function parseParams(raw?: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Some tool parameters are intentionally truncated by the daemon.
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizedFilePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function patchFilePaths(patch?: string): string[] {
  if (!patch) return [];
  const files: string[] = [];
  const pattern = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(patch))) {
    const path = match[1]?.trim();
    if (path) files.push(normalizedFilePath(path));
  }
  return files;
}

export function toolFilePaths(message: ChatMessage): string[] {
  if (classifyToolMessage(message) !== "Edit") return [];
  const params = parseParams(message.tool?.params);
  const candidates = [
    params?.relativeWorkspacePath,
    params?.targetFile,
    params?.target_file,
    params?.filePath,
    params?.file_path,
    params?.path,
    params?.targetNotebook,
    params?.target_notebook,
  ];
  const files = candidates
    .map(nonEmptyString)
    .filter((path): path is string => Boolean(path))
    .map(normalizedFilePath);

  const patch =
    nonEmptyString(params?.patch) ||
    nonEmptyString(params?.diff) ||
    message.tool?.diffPatch;
  files.push(...patchFilePaths(patch));
  return [...new Set(files)];
}

export function isFailedTool(message: ChatMessage): boolean {
  const status = message.tool?.status?.trim().toLowerCase() || "";
  if (/(?:error|fail|cancel|reject|denied)/.test(status)) return true;
  const exitCode = message.tool?.exitCode;
  return typeof exitCode === "number" && Number.isFinite(exitCode) && exitCode !== 0;
}

function safeCount(value?: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

export function summarizeTools(messages: readonly ChatMessage[]): ToolStats {
  const files = new Set<string>();
  let errorCount = 0;
  let additions = 0;
  let deletions = 0;

  for (const message of messages) {
    if (isFailedTool(message)) errorCount += 1;
    for (const path of toolFilePaths(message)) files.add(path);
    additions += safeCount(message.tool?.additions);
    deletions += safeCount(message.tool?.deletions);
  }

  return {
    toolCount: messages.length,
    errorCount,
    fileCount: files.size,
    files: [...files],
    additions,
    deletions,
  };
}

function makeCluster(
  category: ToolCategory,
  messages: ChatMessage[],
): ToolCluster {
  return {
    id: `tools-${messages[0]?.id || category}`,
    category,
    messages,
    stats: summarizeTools(messages),
  };
}

/**
 * Build contiguous semantic clusters. Non-tool messages are barriers so the
 * activity timeline remains in transcript order.
 */
export function buildToolClusters(
  messages: readonly ChatMessage[],
): ToolCluster[] {
  const clusters: ToolCluster[] = [];
  let category: ToolCategory | undefined;
  let pending: ChatMessage[] = [];

  const flush = () => {
    if (category && pending.length) {
      clusters.push(makeCluster(category, pending));
    }
    category = undefined;
    pending = [];
  };

  for (const message of messages) {
    if (!isToolMessage(message)) {
      flush();
      continue;
    }
    const nextCategory = classifyToolMessage(message);
    if (category !== nextCategory) flush();
    category = nextCategory;
    pending.push(message);
  }
  flush();
  return clusters;
}

export function parseMessageTimestamp(value?: string): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric < 0) return undefined;
    // Accept both Unix seconds and Unix milliseconds.
    return numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function durationForMessages(messages: readonly ChatMessage[]): {
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  durationSource?: TurnDurationSource;
} {
  const timestamps = messages
    .map((message) => parseMessageTimestamp(message.createdAt))
    .filter((timestamp): timestamp is number => timestamp !== undefined);
  const startedAt = timestamps.length ? Math.min(...timestamps) : undefined;
  const endedAt = timestamps.length ? Math.max(...timestamps) : undefined;

  if (
    timestamps.length >= 2 &&
    startedAt !== undefined &&
    endedAt !== undefined &&
    endedAt > startedAt
  ) {
    return {
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      durationSource: "timestamps",
    };
  }

  const thinkingDuration = messages.reduce(
    (total, message) => total + safeCount(message.thinkingDurationMs),
    0,
  );
  if (thinkingDuration > 0) {
    return {
      startedAt,
      endedAt,
      durationMs: thinkingDuration,
      durationSource: "thinking",
    };
  }
  return { startedAt, endedAt };
}

function thinkingEntry(message: ChatMessage): ChatThinkingEntry | undefined {
  if (message.role !== "thinking" && !message.thinking?.trim()) return undefined;
  const text =
    message.thinking?.trim() ||
    (message.role === "thinking" ? message.text.trim() : "");
  if (!text) return undefined;
  const duration = safeCount(message.thinkingDurationMs);
  return {
    id: `thinking-${message.id}`,
    messageId: message.id,
    text,
    durationMs: duration || undefined,
    message,
  };
}

function hasAssistantContent(message: ChatMessage): boolean {
  return Boolean(message.text.trim() || message.images?.length);
}

function buildTurnTimeline(messages: readonly ChatMessage[]): ChatTurnTimelineItem[] {
  const timeline: ChatTurnTimelineItem[] = [];
  let pendingTools: ChatMessage[] = [];
  let pendingCategory: ToolCategory | undefined;
  const flushTools = () => {
    if (!pendingCategory || !pendingTools.length) return;
    const cluster = makeCluster(pendingCategory, pendingTools);
    timeline.push({ id: cluster.id, kind: "tools", cluster });
    pendingTools = [];
    pendingCategory = undefined;
  };

  for (const message of messages) {
    if (message.role === "user") continue;
    if (isToolMessage(message)) {
      const category = classifyToolMessage(message);
      if (pendingCategory && pendingCategory !== category) flushTools();
      pendingCategory = category;
      pendingTools.push(message);
      continue;
    }
    flushTools();
    const entry = thinkingEntry(message);
    if (entry) timeline.push({ id: entry.id, kind: "thinking", entry });
    if (message.role === "thinking") continue;
    if (message.role === "system") {
      timeline.push({ id: `system-${message.id}`, kind: "system", message });
    } else if (message.role === "assistant" && hasAssistantContent(message)) {
      timeline.push({
        id: `assistant-${message.id}`,
        kind: "assistant",
        message,
      });
    }
  }
  flushTools();
  return timeline;
}

function makeTurn(messages: ChatMessage[]): ChatTurn {
  const user = messages.find((message) => message.role === "user");
  const thinking: ChatThinkingEntry[] = [];
  const systemMessages: ChatMessage[] = [];
  const toolMessages: ChatMessage[] = [];
  const assistantMessages: ChatMessage[] = [];

  for (const message of messages) {
    const entry = thinkingEntry(message);
    if (entry) thinking.push(entry);

    if (message.role === "user" || message.role === "thinking") continue;
    if (message.role === "system") {
      systemMessages.push(message);
    } else if (isToolMessage(message)) {
      toolMessages.push(message);
    } else if (message.role === "assistant" && hasAssistantContent(message)) {
      assistantMessages.push(message);
    }
  }

  const userIndex = user ? messages.indexOf(user) : -1;
  const duration = durationForMessages(
    userIndex >= 0 ? messages.slice(userIndex) : messages,
  );
  return {
    id: `turn-${user?.id || messages[0]?.id || "empty"}`,
    user,
    messages,
    thinking,
    systemMessages,
    toolMessages,
    toolClusters: buildToolClusters(messages),
    timeline: buildTurnTimeline(messages),
    assistantMessages,
    finalAssistant: assistantMessages[assistantMessages.length - 1],
    stats: summarizeTools(toolMessages),
    ...duration,
  };
}

/**
 * Group a transcript into user-bounded turns. Leading system/activity messages
 * are retained with the first user turn; a transcript without a user still
 * produces one turn so no daemon data is dropped.
 */
export function buildChatTurns(messages: readonly ChatMessage[]): ChatTurn[] {
  if (!messages.length) return [];
  const turns: ChatTurn[] = [];
  let pending: ChatMessage[] = [];
  let hasUser = false;

  for (const message of messages) {
    if (message.role === "user" && hasUser) {
      turns.push(makeTurn(pending));
      pending = [];
      hasUser = false;
    }
    pending.push(message);
    if (message.role === "user") hasUser = true;
  }
  if (pending.length) turns.push(makeTurn(pending));
  return turns;
}

/** Format a trustworthy recorded duration without adding synthetic time. */
export function formatDuration(
  durationMs: number | null | undefined,
): string | undefined {
  if (
    durationMs == null ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return undefined;
  }
  if (durationMs < 1000) return "<1s";

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || !parts.length) parts.push(`${seconds}s`);
  return parts.join(" ");
}

export const formatTurnDuration = formatDuration;
export const formatDurationMs = formatDuration;

export function getToolClusterVisibility(
  density: ChatDensity,
  cluster: ToolCluster,
): ToolClusterVisibility {
  if (density === "detailed") return "all";
  if (
    cluster.stats.errorCount > 0 ||
    (density === "balanced" && IMPORTANT_CATEGORIES.has(cluster.category))
  ) {
    return "important";
  }
  return "summary";
}

/**
 * Recommend initial disclosure state while leaving explicit user expansion
 * state to the chat-density hook.
 */
export function getDefaultExpansionGuidance(
  turn: ChatTurn,
  options: ExpansionGuidanceOptions = {},
): DefaultExpansionGuidance {
  const density = options.density ?? "balanced";
  const isActive = options.isActive ?? false;
  const completedTurnsAfter = Math.max(
    0,
    Math.floor(options.completedTurnsAfter ?? 0),
  );
  const hasFailure = turn.stats.errorCount > 0;
  const isRecent = completedTurnsAfter < 3;

  const expandedToolClusterIds = turn.toolClusters
    .filter((cluster, index) => {
      if (density === "detailed" || cluster.stats.errorCount > 0) return true;
      if (isActive && index === turn.toolClusters.length - 1) return true;
      return (
        density === "balanced" && IMPORTANT_CATEGORIES.has(cluster.category)
      );
    })
    .map((cluster) => cluster.id);

  return {
    turnExpanded: isActive || hasFailure || isRecent,
    thinkingExpanded:
      density === "detailed" || (isActive && density === "balanced"),
    systemExpanded: density === "detailed",
    expandedToolClusterIds,
    reason: isActive
      ? "active"
      : hasFailure
        ? "failure"
        : isRecent
          ? "recent"
          : "older",
  };
}

export const getDefaultTurnExpansion = getDefaultExpansionGuidance;
