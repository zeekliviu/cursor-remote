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
  isArchived?: boolean;
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
  };
  /** Assistant reasoning / "Thought for Ns" body */
  thinking?: string;
  thinkingDurationMs?: number;
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
};

export type Confirmation = {
  id: string;
  text: string;
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
  | { type: "attach"; projectId: string; cols?: number; rows?: number }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" };

export type TerminalServerMessage =
  | { type: "ready"; projectId: string; cwd: string }
  | { type: "data"; data: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string }
  | { type: "pong" };

export type ComposerClientMessage =
  | { type: "subscribe"; targetId?: string }
  | { type: "send"; text: string; submit?: boolean }
  | { type: "selectChat"; chatName?: string; chatId?: string }
  | { type: "selectModel"; modelLabel: string }
  | { type: "confirm"; confirmationId: string; actionId: string }
  | { type: "ping" };

export type ComposerServerMessage =
  | { type: "status"; health: ComposerHealth }
  | { type: "event"; kind: string; text?: string; at: number }
  | { type: "confirmations"; items: Confirmation[] }
  | { type: "error"; message: string }
  | { type: "pong" };

export const DEFAULT_DAEMON_PORT = 7843;
export const DEFAULT_CDP_PORT = 9222;
