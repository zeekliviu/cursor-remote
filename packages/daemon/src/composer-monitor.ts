import fs from "node:fs";
import type { WebSocket } from "ws";
import type {
  ChatDelta,
  ChatDetail,
  ComposerServerMessage,
  Confirmation,
} from "@cursor-remote/shared";
import type { CdpDriver } from "./cdp-driver.js";
import type { CursorStore } from "./cursor-store.js";

const RUNNING_FALLBACK_MS = 2500;
const IDLE_FALLBACK_MS = 15000;
const UNAVAILABLE_FALLBACK_MS = 5000;
const CHAT_DEBOUNCE_MS = 750;
const CHAT_FALLBACK_MS = 10000;

type ChatSubscription = {
  revision: string;
  chat: ChatDetail;
};

type Subscriber = {
  subscribed: boolean;
  chats: Map<string, ChatSubscription | null>;
};

function send(ws: WebSocket, message: ComposerServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function activityKey(activity: {
  status?: string;
  labels?: string[];
  currentChatId?: string;
  currentModel?: string;
  running?: boolean;
}): string {
  return `${activity.running ? 1 : 0}|${activity.status || ""}|${activity.currentModel || ""}|${activity.currentChatId || ""}|${(activity.labels || []).join("\u0001")}`;
}

function confirmationKey(items: Confirmation[]): string {
  return JSON.stringify(
    items.map((item) => [
      item.id,
      item.text,
      item.summary,
      item.command,
      item.kind,
      item.risk,
      item.resource,
      item.actions.map((action) => [
        action.id,
        action.label,
        action.intent,
        action.risk,
      ]),
    ]),
  );
}

function firstChangedMessage(previous: ChatDetail, next: ChatDetail): number {
  const common = Math.min(previous.messages.length, next.messages.length);
  for (let index = 0; index < common; index += 1) {
    const before = previous.messages[index];
    const after = next.messages[index];
    if (
      before.id !== after.id ||
      JSON.stringify(before) !== JSON.stringify(after)
    ) {
      return index;
    }
  }
  return common;
}

function chatMetadataChanged(previous: ChatDetail, next: ChatDetail): boolean {
  return (
    previous.projectId !== next.projectId ||
    previous.name !== next.name ||
    previous.createdAt !== next.createdAt ||
    previous.mode !== next.mode ||
    previous.model !== next.model ||
    previous.subagentType !== next.subagentType ||
    previous.status !== next.status ||
    previous.isArchived !== next.isArchived ||
    previous.messageable !== next.messageable ||
    previous.isSubagent !== next.isSubagent ||
    previous.parentChatId !== next.parentChatId ||
    JSON.stringify(previous.subagentIds || []) !==
      JSON.stringify(next.subagentIds || [])
  );
}

/**
 * One daemon-wide monitor fans changed-only Composer and chat state out to all
 * foreground clients. No client owns its own CDP polling interval.
 */
export class ComposerMonitor {
  private readonly subscribers = new Map<WebSocket, Subscriber>();
  private fallbackTimer: NodeJS.Timeout | null = null;
  private mutationTimer: NodeJS.Timeout | null = null;
  private chatTimer: NodeJS.Timeout | null = null;
  private chatFallbackTimer: NodeJS.Timeout | null = null;
  private sampling = false;
  private sampleAgain = false;
  private pendingTargets = new Set<WebSocket>();
  private running = false;
  private lastActivity = "\u0000";
  private lastConfirmations = "\u0000";
  private dbWatching = false;
  private cdpSamples = 0;
  private chatReads = 0;
  private lastSampleAt = 0;
  private observerActive = false;
  private cdpUnavailable = false;
  private lastFailureBroadcastAt = 0;
  private runStartedAt: number | null = null;
  private activeChatId: string | null = null;
  private workedFingerprintAtRunStart: string | undefined;
  private readonly onComposerMutation = (): void => {
    this.scheduleSample(100);
  };

  constructor(
    private readonly cdp: CdpDriver,
    private readonly store: CursorStore,
  ) {}

  attach(ws: WebSocket): void {
    this.subscribers.set(ws, { subscribed: false, chats: new Map() });
  }

  detach(ws: WebSocket): void {
    this.subscribers.delete(ws);
    this.syncDbWatching();
    if (!this.hasSubscribers()) void this.stopCdp();
  }

  async subscribe(ws: WebSocket, targetId?: string): Promise<void> {
    const subscriber = this.subscribers.get(ws);
    if (!subscriber) return;
    if (targetId) await this.cdp.selectWindow(targetId);
    subscriber.subscribed = true;
    this.syncDbWatching();
    const health = await this.cdp.health();
    this.cdpUnavailable = !health.cdpReachable || !health.selectorsOk;
    send(ws, { type: "status", health });
    this.start();
    await this.sample(ws);
  }

  async subscribeChat(
    ws: WebSocket,
    chatId: string,
    clientRevision?: string,
  ): Promise<void> {
    const subscriber = this.subscribers.get(ws);
    if (!subscriber) return;
    // Arm first so a commit racing the initial read is queued for a recheck.
    subscriber.chats.set(chatId, null);
    this.syncDbWatching();
    const snapshot = this.loadChatStable(chatId);
    if (!snapshot) {
      send(ws, {
        type: "chatError",
        chatId,
        message: `chat temporarily unavailable: ${chatId}`,
        at: Date.now(),
      });
      return;
    }
    subscriber.chats.set(chatId, snapshot);
    if (clientRevision !== snapshot.revision) {
      send(ws, {
        type: "chatSnapshot",
        chat: snapshot.chat,
        revision: snapshot.revision,
        at: Date.now(),
      });
    }
  }

  unsubscribeChat(ws: WebSocket, chatId: string): void {
    this.subscribers.get(ws)?.chats.delete(chatId);
    this.syncDbWatching();
  }

  wake(): void {
    this.scheduleSample(100);
    this.scheduleChatRefresh();
  }

  setActiveChat(chatId?: string | null): void {
    this.activeChatId = chatId || null;
  }

  async close(): Promise<void> {
    this.subscribers.clear();
    await this.stopCdp();
    if (this.chatTimer) clearTimeout(this.chatTimer);
    if (this.chatFallbackTimer) clearTimeout(this.chatFallbackTimer);
    this.chatTimer = null;
    this.chatFallbackTimer = null;
    this.stopDbWatching();
  }

  private hasSubscribers(): boolean {
    return Array.from(this.subscribers.values()).some(
      (subscriber) => subscriber.subscribed,
    );
  }

  private start(): void {
    if (!this.hasSubscribers()) return;
    if (!this.observerActive) {
      this.observerActive = true;
      void this.cdp
        .setComposerMutationHandler(this.onComposerMutation)
        .catch(() => {
          this.observerActive = false;
        });
    }
    this.scheduleFallback();
  }

  private async stopCdp(): Promise<void> {
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    if (this.mutationTimer) clearTimeout(this.mutationTimer);
    this.fallbackTimer = null;
    this.mutationTimer = null;
    this.observerActive = false;
    await this.cdp.setComposerMutationHandler(null);
    if (process.env.NODE_ENV !== "production") {
      console.debug("[protocol-metrics] daemon monitor stopped", {
        cdpSamples: this.cdpSamples,
        chatReads: this.chatReads,
      });
    }
  }

  private loadChatStable(chatId: string): ChatSubscription | null {
    let revision = this.store.getChatRevision(chatId);
    for (let attempt = 0; attempt < 3 && revision; attempt += 1) {
      const chat = this.store.getChat(chatId, revision);
      this.chatReads += 1;
      if (!chat) return null;
      const after = this.store.getChatRevision(chatId);
      if (after === revision) return { revision, chat };
      revision = after;
    }
    return null;
  }

  private scheduleSample(delay: number): void {
    if (!this.hasSubscribers() || this.mutationTimer) return;
    const throttleDelay = Math.max(
      delay,
      750 - (Date.now() - this.lastSampleAt),
    );
    this.mutationTimer = setTimeout(() => {
      this.mutationTimer = null;
      void this.sample();
    }, throttleDelay);
  }

  private scheduleFallback(): void {
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    if (!this.hasSubscribers()) return;
    this.fallbackTimer = setTimeout(
      () => {
        this.fallbackTimer = null;
        void this.sample();
      },
      this.cdpUnavailable
        ? UNAVAILABLE_FALLBACK_MS
        : this.running
          ? RUNNING_FALLBACK_MS
          : IDLE_FALLBACK_MS,
    );
  }

  private async sample(target?: WebSocket): Promise<void> {
    if (target) this.pendingTargets.add(target);
    if (this.sampling) {
      this.sampleAgain = true;
      return;
    }
    if (this.mutationTimer) {
      clearTimeout(this.mutationTimer);
      this.mutationTimer = null;
    }
    this.sampling = true;
    this.lastSampleAt = Date.now();
    const targets = new Set(this.pendingTargets);
    this.pendingTargets.clear();
    try {
      this.cdpSamples += 1;
      const { activity, confirmations } =
        await this.cdp.scrapeComposerState();
      this.lastFailureBroadcastAt = 0;
      if (this.observerActive) {
        await this.cdp.setComposerMutationHandler(this.onComposerMutation);
      }
      const recovered = this.cdpUnavailable;
      this.cdpUnavailable = false;
      if (activity.currentChatId) this.activeChatId = activity.currentChatId;
      const wasRunning = this.running;
      const nowRunning = Boolean(activity.running);
      const now = Date.now();
      if (!wasRunning && nowRunning) {
        this.runStartedAt = now;
        this.workedFingerprintAtRunStart =
          activity.lastCompletedFingerprint;
      }
      this.running = nowRunning;
      const nextActivityKey = activityKey(activity);
      const nextConfirmationKey = confirmationKey(confirmations);
      const activityChanged = nextActivityKey !== this.lastActivity;
      const confirmationsChanged =
        nextConfirmationKey !== this.lastConfirmations;
      this.lastActivity = nextActivityKey;
      this.lastConfirmations = nextConfirmationKey;

      for (const [ws, subscriber] of this.subscribers) {
        if (!subscriber.subscribed) continue;
        if (activityChanged || targets.has(ws)) {
          send(ws, {
            type: "activity",
            status: activity.status,
            labels: activity.labels,
            chatId: activity.currentChatId || this.activeChatId || undefined,
            currentModel: activity.currentModel,
            running: activity.running,
            startedAt: this.runStartedAt || undefined,
            at: now,
          });
        }
        if (confirmationsChanged || targets.has(ws)) {
          send(ws, { type: "confirmations", items: confirmations });
        }
      }
      if (wasRunning && !nowRunning) {
        const fallbackDuration = this.runStartedAt
          ? Math.max(0, now - this.runStartedAt)
          : 0;
        const hasFreshWorkedLabel =
          Boolean(activity.lastCompletedFingerprint) &&
          activity.lastCompletedFingerprint !==
            this.workedFingerprintAtRunStart;
        const durationMs =
          (hasFreshWorkedLabel
            ? activity.lastCompletedDurationMs
            : undefined) || fallbackDuration;
        if (durationMs > 0) {
          for (const [ws, subscriber] of this.subscribers) {
            if (!subscriber.subscribed) continue;
            const chatId =
              this.activeChatId &&
              subscriber.chats.has(this.activeChatId)
                ? this.activeChatId
                : undefined;
            send(ws, {
              type: "turnComplete",
              chatId,
              durationMs,
              label: hasFreshWorkedLabel
                ? activity.lastCompletedLabel
                : undefined,
              at: now,
            });
          }
        }
        this.runStartedAt = null;
        this.workedFingerprintAtRunStart = undefined;
      }
      if (recovered) {
        const health = await this.cdp.health();
        this.cdpUnavailable =
          !health.cdpReachable || !health.selectorsOk;
        for (const [ws, subscriber] of this.subscribers) {
          if (subscriber.subscribed) send(ws, { type: "status", health });
        }
      }
    } catch (error) {
      this.running = false;
      this.cdpUnavailable = true;
      const now = Date.now();
      if (
        targets.size > 0 ||
        now - this.lastFailureBroadcastAt >= 30000
      ) {
        this.lastFailureBroadcastAt = now;
        const health = await this.cdp.health();
        for (const [ws, subscriber] of this.subscribers) {
          if (!subscriber.subscribed) continue;
          send(ws, { type: "status", health });
          send(ws, { type: "error", message: (error as Error).message });
        }
      }
    } finally {
      this.sampling = false;
      this.scheduleFallback();
      if (this.sampleAgain) {
        this.sampleAgain = false;
        this.scheduleSample(0);
      }
    }
  }

  private syncDbWatching(): void {
    const shouldWatch = Array.from(this.subscribers.values()).some(
      (subscriber) => subscriber.chats.size > 0,
    );
    if (shouldWatch && !this.dbWatching) {
      this.dbWatching = true;
      for (const filePath of this.store.getChatWatchPaths()) {
        fs.watchFile(
          filePath,
          { interval: 1500, persistent: false },
          this.onDbChanged,
        );
      }
      this.scheduleChatFallback();
    } else if (!shouldWatch && this.dbWatching) {
      this.stopDbWatching();
    }
  }

  private stopDbWatching(): void {
    if (!this.dbWatching) return;
    for (const filePath of this.store.getChatWatchPaths()) {
      fs.unwatchFile(filePath, this.onDbChanged);
    }
    if (this.chatFallbackTimer) clearTimeout(this.chatFallbackTimer);
    this.chatFallbackTimer = null;
    this.dbWatching = false;
  }

  private scheduleChatFallback(): void {
    if (!this.dbWatching || this.chatFallbackTimer) return;
    this.chatFallbackTimer = setTimeout(() => {
      this.chatFallbackTimer = null;
      void this.refreshChats()
        .catch((error) => this.reportChatRefreshError(error))
        .finally(() => this.scheduleChatFallback());
    }, CHAT_FALLBACK_MS);
  }

  private readonly onDbChanged = (): void => {
    this.scheduleChatRefresh();
  };

  private scheduleChatRefresh(): void {
    if (!this.dbWatching || this.chatTimer) return;
    this.chatTimer = setTimeout(() => {
      this.chatTimer = null;
      void this.refreshChats().catch((error) =>
        this.reportChatRefreshError(error),
      );
    }, CHAT_DEBOUNCE_MS);
  }

  private reportChatRefreshError(error: unknown): void {
    const message = (error as Error).message || "chat refresh failed";
    for (const [ws, subscriber] of this.subscribers) {
      for (const chatId of subscriber.chats.keys()) {
        send(ws, { type: "chatError", chatId, message, at: Date.now() });
      }
    }
  }

  private async refreshChats(): Promise<void> {
    const chatIds = new Set<string>();
    for (const subscriber of this.subscribers.values()) {
      for (const chatId of subscriber.chats.keys()) chatIds.add(chatId);
    }
    for (const chatId of chatIds) {
      const snapshot = this.loadChatStable(chatId);
      if (!snapshot) continue;
      const interested = Array.from(this.subscribers.entries()).filter(
        ([, subscriber]) =>
          subscriber.chats.get(chatId)?.revision !== snapshot.revision,
      );
      if (!interested.length) continue;
      for (const [ws, subscriber] of interested) {
        const previous = subscriber.chats.get(chatId);
        if (!previous) {
          subscriber.chats.set(chatId, snapshot);
          send(ws, {
            type: "chatSnapshot",
            chat: snapshot.chat,
            revision: snapshot.revision,
            at: Date.now(),
          });
          continue;
        }
        if (chatMetadataChanged(previous.chat, snapshot.chat)) {
          subscriber.chats.set(chatId, snapshot);
          send(ws, {
            type: "chatSnapshot",
            chat: snapshot.chat,
            revision: snapshot.revision,
            at: Date.now(),
          });
          continue;
        }
        const fromIndex = firstChangedMessage(previous.chat, snapshot.chat);
        const delta: ChatDelta = {
          chatId,
          baseRevision: previous.revision,
          revision: snapshot.revision,
          fromIndex,
          messages: snapshot.chat.messages.slice(fromIndex),
          messageCount: snapshot.chat.messages.length,
          filesChangedCount: snapshot.chat.filesChangedCount,
          filesChanged: snapshot.chat.filesChanged,
          lastUpdatedAt: snapshot.chat.lastUpdatedAt,
        };
        subscriber.chats.set(chatId, snapshot);
        send(ws, { type: "chatDelta", ...delta, at: Date.now() });
      }
    }
  }
}
