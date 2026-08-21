export type Project = {
  id: string;
  name: string;
  path: string;
  uri?: string;
};

export type ChatSummary = {
  id: string;
  projectId: string;
  name: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  mode?: string;
  /** Resolved model id/label when known (e.g. from modelConfig). */
  model?: string;
  /** Subagent kind: explore, generalPurpose, shell, … */
  subagentType?: string;
  /** Composer status: running, completed, … */
  status?: string;
  isArchived?: boolean;
  parentChatId?: string;
  subagentIds?: string[];
  isSubagent?: boolean;
  /**
   * False for subagent / explore transcripts (no Composer input in Cursor).
   * True for parent agent chats and normal composers you can message.
   */
  messageable?: boolean;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool" | "thinking";
  text: string;
  createdAt?: string;
  hasTools?: boolean;
  tool?: {
    name: string;
    status?: string;
    params?: string;
    resultPreview?: string;
    /** Unified-ish patch for edit tools */
    diffPatch?: string;
    additions?: number;
    deletions?: number;
    exitCode?: number;
    output?: string;
    durationMs?: number;
    startedAt?: number;
    finishedAt?: number;
    statusKind?: "pending" | "running" | "completed" | "error" | "cancelled";
    /** Linked child composer for task/subagent tools. */
    subagentComposerId?: string;
  };
  /** Assistant reasoning / "Thought for Ns" body */
  thinking?: string;
  thinkingDurationMs?: number;
  /** Attached / referenced images for this bubble (host absolute paths). */
  images?: ChatImage[];
};

/** Image attached to a chat bubble (Composer paste, phone upload, or agent read). */
export type ChatImage = {
  /** Absolute path on the daemon host */
  path: string;
  name?: string;
  width?: number;
  height?: number;
  mime?: string;
};

export type ChatChangedFile = {
  path: string;
  isNew?: boolean;
  additions?: number;
  deletions?: number;
  /** Short patch preview; full via /chats/:id/changed-file */
  patch?: string;
};

export type ChatDetail = ChatSummary & {
  messages: ChatMessage[];
  filesChangedCount?: number;
  filesChanged?: ChatChangedFile[];
};

export type DiffFile = {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
};

export type DiffResponse = {
  projectId: string;
  branch?: string;
  files: DiffFile[];
  patch: string;
};

export type CursorWindow = {
  targetId: string;
  title: string;
  url?: string;
  type: string;
};

export type ComposerBindResult = {
  window: CursorWindow;
  chatSelected?: boolean;
  matchedBy?: "targetId" | "project" | "agentsPanel" | "fallback";
  repoSelected?: boolean;
};

export type ComposerHealth = {
  cdpReachable: boolean;
  cdpUrl: string;
  windowCount: number;
  selectorsOk: boolean;
  selectorPack: string;
  cursorVersionHint?: string;
  issues: string[];
  fixHint?: string;
};

export type ModelChoice = {
  id: string;
  label: string;
  /** @deprecated use params sections */
  supportsEffort?: boolean;
  /** @deprecated use params sections */
  supportsFast?: boolean;
};

export type ModelParamOption = {
  id: string;
  label: string;
  /** For toggles: current on/off. For choices: whether this option is selected. */
  selected: boolean;
};

export type ModelParamSection = {
  id: string;
  title: string;
  kind: "choice" | "toggle";
  options: ModelParamOption[];
};

export type ModelParams = {
  modelLabel: string;
  baseModel?: string;
  sections: ModelParamSection[];
};

export type ModelConfigApply = {
  modelLabel: string;
  /** Map of section title → selected choice label (Effort → High, Context → 1M) */
  choices?: Record<string, string>;
  /** Map of toggle label → desired on/off (Fast → true, Thinking → false) */
  toggles?: Record<string, boolean>;
};

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type AttachmentMeta = {
  id: string;
  name: string;
  mime: string;
  path: string;
  size: number;
};


export type ConfirmationAction = {
  id: string;
  label: string;
  risk: "low" | "medium" | "high";
  intent?: "deny" | "allowOnce" | "allowAlways" | "other";
};

export type ConfirmationKind =
  | "shell"
  | "network"
  | "delete"
  | "externalFile"
  | "mcp"
  | "browser"
  | "generic";

export type Confirmation = {
  id: string;
  /** Short title, e.g. "Run command" */
  text: string;
  /** Human-readable summary when available */
  summary?: string;
  /** Shell / tool command to approve */
  command?: string;
  kind?: ConfirmationKind;
  risk?: "low" | "medium" | "high";
  /** Domain, path, MCP operation, or other protected resource. */
  resource?: string;
  actions: ConfirmationAction[];
};

export type PairingInfo = {
  token: string;
  port: number;
  bindHost: string;
  qrPayload: string;
  hint: string;
};

export type TerminalClientMessage =
  | {
      type: "attach";
      projectId: string;
      sessionId?: string;
      cols?: number;
      rows?: number;
    }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" };

export type TerminalServerMessage =
  | { type: "ready"; projectId: string; cwd: string; sessionId: string }
  | { type: "data"; data: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string }
  | { type: "pong" };

export type ComposerClientMessage =
  | { type: "subscribe"; targetId?: string }
  | { type: "subscribeChat"; chatId: string; revision?: string }
  | { type: "unsubscribeChat"; chatId: string }
  | { type: "send"; text: string; submit?: boolean; force?: boolean }
  | { type: "selectChat"; chatName?: string; chatId?: string }
  | { type: "selectModel"; modelLabel: string }
  | { type: "confirm"; confirmationId: string; actionId: string }
  | { type: "ping" };

export type ChatDelta = {
  chatId: string;
  /** Revision the client must currently hold before applying this delta. */
  baseRevision: string;
  revision: string;
  /** Replace the local message tail beginning at this index. */
  fromIndex: number;
  messages: ChatMessage[];
  messageCount: number;
  filesChangedCount?: number;
  filesChanged?: ChatChangedFile[];
  lastUpdatedAt?: number;
};

export type ComposerServerMessage =
  | {
      type: "capabilities";
      chatDeltas: boolean;
      typedApprovals?: boolean;
      turnComplete?: boolean;
    }
  | { type: "status"; health: ComposerHealth }
  | { type: "event"; kind: string; text?: string; at: number }
  | { type: "confirmations"; items: Confirmation[] }
  /** Host agent status line; `status` is undefined when the agent is idle. */
  | {
      type: "activity";
      status?: string;
      labels?: string[];
      chatId?: string;
      currentModel?: string;
      running?: boolean;
      startedAt?: number;
      at: number;
    }
  | {
      type: "turnComplete";
      chatId?: string;
      durationMs: number;
      label?: string;
      at: number;
    }
  | { type: "chatSnapshot"; chat: ChatDetail; revision: string; at: number }
  | ({ type: "chatDelta"; at: number } & ChatDelta)
  | { type: "chatError"; chatId: string; message: string; at: number }
  | { type: "error"; message: string }
  | { type: "pong" };

export const DEFAULT_DAEMON_PORT = 7843;
export const DEFAULT_CDP_PORT = 9222;
