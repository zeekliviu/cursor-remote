import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
  AttachmentMeta,
  ChatDetail,
  ChatSummary,
  ComposerHealth,
  DiffResponse,
  EffortLevel,
  ModelChoice,
  ModelParams,
  PairingInfo,
  Project,
} from "@cursor-remote/shared";

const LEGACY_KEY = "cursor-remote.connection";
const HOSTS_KEY = "cursor-remote.hosts.v1";

/** One paired daemon (Mac, Windows, …). */
export type HostProfile = {
  id: string;
  label: string;
  host: string;
  port: number;
  token: string;
  addedAt: number;
};

export type HostsState = {
  hosts: HostProfile[];
  activeId: string | null;
};

/** @deprecated use HostProfile — kept as alias for call sites */
export type Connection = Pick<HostProfile, "host" | "port" | "token"> & {
  id?: string;
  label?: string;
};

function connKey(host: string, port: number): string {
  return `${host.trim().toLowerCase()}:${port}`;
}

export function hostIdFor(host: string, port: number): string {
  return connKey(host, port);
}

export function defaultLabel(host: string, port: number): string {
  return port === 7843 ? host : `${host}:${port}`;
}

export async function loadHostsState(): Promise<HostsState> {
  const raw = await AsyncStorage.getItem(HOSTS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as HostsState;
      if (Array.isArray(parsed.hosts)) {
        return {
          hosts: parsed.hosts,
          activeId: parsed.activeId ?? parsed.hosts[0]?.id ?? null,
        };
      }
    } catch {
      // fall through to migrate
    }
  }

  // Migrate single-connection storage from earlier builds.
  const legacy = await AsyncStorage.getItem(LEGACY_KEY);
  if (legacy) {
    try {
      const c = JSON.parse(legacy) as Connection;
      if (c?.host && c?.token && c?.port) {
        const id = hostIdFor(c.host, c.port);
        const profile: HostProfile = {
          id,
          label: c.label || defaultLabel(c.host, c.port),
          host: c.host,
          port: c.port,
          token: c.token,
          addedAt: Date.now(),
        };
        const state: HostsState = { hosts: [profile], activeId: id };
        await saveHostsState(state);
        await AsyncStorage.removeItem(LEGACY_KEY);
        return state;
      }
    } catch {
      // ignore
    }
  }

  return { hosts: [], activeId: null };
}

export async function saveHostsState(state: HostsState): Promise<void> {
  await AsyncStorage.setItem(HOSTS_KEY, JSON.stringify(state));
}

export async function loadConnection(): Promise<Connection | null> {
  const state = await loadHostsState();
  const active =
    state.hosts.find((h) => h.id === state.activeId) || state.hosts[0] || null;
  return active;
}

export async function saveConnection(conn: Connection): Promise<void> {
  const state = await loadHostsState();
  const id = conn.id || hostIdFor(conn.host, conn.port);
  const existing = state.hosts.find((h) => h.id === id);
  const profile: HostProfile = {
    id,
    label: conn.label || existing?.label || defaultLabel(conn.host, conn.port),
    host: conn.host,
    port: conn.port,
    token: conn.token,
    addedAt: existing?.addedAt ?? Date.now(),
  };
  const others = state.hosts.filter((h) => h.id !== id);
  await saveHostsState({ hosts: [...others, profile], activeId: id });
}

export async function clearConnection(): Promise<void> {
  await saveHostsState({ hosts: [], activeId: null });
  await AsyncStorage.removeItem(LEGACY_KEY);
}

export function parsePairPayload(input: string): Connection | null {
  const trimmed = input.trim();
  try {
    if (trimmed.startsWith("cursor-remote://")) {
      const u = new URL(trimmed);
      const host = u.searchParams.get("host");
      const port = Number(u.searchParams.get("port") || "7843");
      const token = u.searchParams.get("token");
      if (!host || !token || host.includes("<") || host.includes("tailscale-magicdns")) {
        return null;
      }
      return { host, port, token, id: hostIdFor(host, port) };
    }
    // Also accept raw JSON from /pairing
    if (trimmed.startsWith("{")) {
      const j = JSON.parse(trimmed) as {
        qrPayload?: string;
        token?: string;
        port?: number;
        bindHost?: string;
      };
      if (j.qrPayload) return parsePairPayload(j.qrPayload);
    }
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      const u = new URL(trimmed);
      const token = u.searchParams.get("token") || "";
      if (!token) return null;
      const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
      return {
        host: u.hostname,
        port,
        token,
        id: hostIdFor(u.hostname, port),
      };
    }
    // host:port:token
    const parts = trimmed.split(":");
    if (parts.length >= 3) {
      const token = parts.slice(2).join(":");
      const host = parts[0];
      const port = Number(parts[1]);
      return { host, port, token, id: hostIdFor(host, port) };
    }
  } catch {
    return null;
  }
  return null;
}

export class ApiClient {
  constructor(private conn: Connection) {}

  get connection(): Connection {
    return this.conn;
  }

  baseUrl(): string {
    return `http://${this.conn.host}:${this.conn.port}`;
  }

  wsUrl(path: string): string {
    return `ws://${this.conn.host}:${this.conn.port}${path}?token=${encodeURIComponent(this.conn.token)}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl()}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.conn.token}`,
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        (body as { error?: string }).error || `HTTP ${res.status}`,
      );
    }
    return body as T;
  }

  healthz() {
    return fetch(`${this.baseUrl()}/healthz`).then((r) => r.json());
  }

  pairing() {
    return this.request<PairingInfo & { qrDataUrl?: string }>("/pairing");
  }

  projects() {
    return this.request<{ projects: Project[] }>("/projects");
  }

  chats(projectId: string) {
    return this.request<{ chats: ChatSummary[] }>(
      `/projects/${encodeURIComponent(projectId)}/chats`,
    );
  }

  chat(chatId: string) {
    return this.request<ChatDetail>(`/chats/${encodeURIComponent(chatId)}`);
  }

  changedFile(chatId: string, filePath: string) {
    return this.request<import("@cursor-remote/shared").ChatChangedFile>(
      `/chats/${encodeURIComponent(chatId)}/changed-file?path=${encodeURIComponent(filePath)}`,
    );
  }

  /** Authenticated URL for Image components (token in query — RN Image has no headers). */
  mediaUrl(filePath: string): string {
    return `${this.baseUrl()}/media?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(this.conn.token)}`;
  }

  diff(projectId: string) {
    return this.request<DiffResponse>(
      `/projects/${encodeURIComponent(projectId)}/diff`,
    );
  }

  composerHealth() {
    return this.request<ComposerHealth>("/composer/health");
  }

  composerActivity() {
    return this.request<{
      status?: string;
      labels: string[];
      currentModel?: string;
      running?: boolean;
    }>("/composer/activity");
  }

  selectComposer(body: {
    targetId?: string;
    chatId?: string;
    chatName?: string;
    projectId?: string;
    projectPath?: string;
    projectName?: string;
  }) {
    return this.request<{
      window: unknown;
      chatSelected?: boolean;
      repoSelected?: boolean;
      matchedBy?: string;
    }>("/composer/select", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  newChat(projectId?: string) {
    return this.request<{
      ok: boolean;
      method: string;
      window?: unknown;
    }>("/composer/new-chat", {
      method: "POST",
      body: JSON.stringify({ projectId }),
    });
  }

  stopComposer() {
    return this.request<{ ok: boolean }>("/composer/stop", {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  openProject(projectId: string) {
    return this.request<{
      ok: boolean;
      message: string;
      window?: unknown;
      matchedBy?: string;
    }>(`/projects/${encodeURIComponent(projectId)}/open`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  sendComposer(
    text: string,
    submit = true,
    attachmentPaths: string[] = [],
    opts?: { projectId?: string; chatName?: string; chatId?: string },
  ) {
    return this.request<{ ok: boolean }>("/composer/send", {
      method: "POST",
      body: JSON.stringify({
        text,
        submit,
        attachmentPaths,
        projectId: opts?.projectId,
        chatName: opts?.chatName,
        chatId: opts?.chatId,
      }),
    });
  }

  models() {
    return this.request<{
      source: string;
      current?: string;
      models: ModelChoice[];
      params?: ModelParams | null;
      efforts?: EffortLevel[];
      fastMode?: boolean;
      error?: string;
    }>("/composer/models");
  }

  modelParams(modelLabel?: string) {
    const q = modelLabel
      ? `?model=${encodeURIComponent(modelLabel)}`
      : "";
    return this.request<ModelParams & { source?: string; error?: string }>(
      `/composer/model-params${q}`,
    );
  }

  selectModel(
    modelLabel: string,
    effort?: EffortLevel,
    fastMode?: boolean,
    config?: {
      choices?: Record<string, string>;
      toggles?: Record<string, boolean>;
    },
  ) {
    return this.request<{ ok: boolean }>("/composer/model", {
      method: "POST",
      body: JSON.stringify({
        modelLabel,
        effort,
        fastMode,
        choices: config?.choices,
        toggles: config?.toggles,
      }),
    });
  }

  uploadBase64(name: string, mime: string, base64: string) {
    return this.request<{ attachment: AttachmentMeta }>("/composer/upload", {
      method: "POST",
      body: JSON.stringify({ name, mime, base64 }),
    });
  }

  confirmations() {
    return this.request<{
      items: Array<{
        id: string;
        text: string;
        summary?: string;
        command?: string;
        actions: Array<{
          id: string;
          label: string;
          risk: "low" | "medium" | "high";
        }>;
      }>;
    }>("/composer/confirmations");
  }

  actConfirmation(confirmationId: string, actionId: string) {
    return this.request<{ ok: boolean }>("/composer/confirmations", {
      method: "POST",
      body: JSON.stringify({ confirmationId, actionId }),
    });
  }
}
