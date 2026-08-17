import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Animated,
  AppState,
  type AppStateStatus,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router, useRootNavigationState } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
/** Deep import — see notify.ts; barrel pulls Expo Go push auto-registration. */
import useLastNotificationResponse from "expo-notifications/build/useLastNotificationResponse";
import type {
  ChatDetail,
  ComposerHealth,
  ComposerServerMessage,
  Confirmation,
} from "@cursor-remote/shared";
import { useConnection } from "./connection";
import {
  getFocusedChat,
  getRememberedChat,
  hydrateRememberedChat,
} from "./focused-chat";
import {
  ensureNotificationPermission,
  notifyLocal,
  parseNotifyData,
} from "./notify";
import {
  logProtocolMetrics,
  recordChatSubscriptions,
  recordWsClose,
  recordWsOpen,
  recordWsReceived,
  recordWsSent,
} from "./protocol-metrics";

/** Tools finish and restart in bursts; wait this long before calling it "done". */
const FINISH_DEBOUNCE_MS = 3500;
const RECONNECT_MS = 4000;
const HANDLED_KEY = "cursor-remote:handled-notification";

function shortHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16);
}

export type WatchedChat = {
  chat: ChatDetail;
  revision: string;
  source: "ws" | "http";
};

type WatchValue = {
  /** Host agent is producing a status line right now. */
  hostRunning: boolean;
  hostStatus: string | null;
  hostLabels: string[];
  hostStartedAt: number | null;
  hostModel: string | null;
  lastCompletedAt: number | null;
  lastCompletedDurationMs: number | null;
  health: ComposerHealth | null;
  confirmations: Confirmation[];
  pendingApprovals: number;
  toast: (text: string) => void;
};

type ChatWatchValue = {
  chats: Record<string, WatchedChat>;
  errors: Record<string, string>;
  completions: Record<
    string,
    { durationMs: number; label?: string; at: number }
  >;
  subscribeChat: (chatId: string) => () => void;
  requestChatSnapshot: (chatId: string) => void;
};

const fallback: WatchValue = {
  hostRunning: false,
  hostStatus: null,
  hostLabels: [],
  hostStartedAt: null,
  hostModel: null,
  lastCompletedAt: null,
  lastCompletedDurationMs: null,
  health: null,
  confirmations: [],
  pendingApprovals: 0,
  toast: () => undefined,
};

const WatchContext = createContext<WatchValue>(fallback);
const ChatWatchContext = createContext<ChatWatchValue>({
  chats: {},
  errors: {},
  completions: {},
  subscribeChat: () => () => undefined,
  requestChatSnapshot: () => undefined,
});

export function useComposerWatch(): WatchValue {
  return useContext(WatchContext);
}

export function useChatWatch(): ChatWatchValue {
  return useContext(ChatWatchContext);
}

export function ComposerWatchProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { client } = useConnection();
  const insets = useSafeAreaInsets();
  const navState = useRootNavigationState();
  const lastResponse = useLastNotificationResponse();

  const [hostStatus, setHostStatus] = useState<string | null>(null);
  const [hostLabels, setHostLabels] = useState<string[]>([]);
  const [hostStartedAt, setHostStartedAt] = useState<number | null>(null);
  const [hostModel, setHostModel] = useState<string | null>(null);
  const [lastCompletedAt, setLastCompletedAt] = useState<number | null>(null);
  const [lastCompletedDurationMs, setLastCompletedDurationMs] = useState<
    number | null
  >(null);
  const [health, setHealth] = useState<ComposerHealth | null>(null);
  const [confirmations, setConfirmations] = useState<Confirmation[]>([]);
  const [chats, setChats] = useState<Record<string, WatchedChat>>({});
  const [chatErrors, setChatErrors] = useState<Record<string, string>>({});
  const [completions, setCompletions] = useState<
    Record<string, { durationMs: number; label?: string; at: number }>
  >({});
  const [appState, setAppState] = useState<AppStateStatus>(
    AppState.currentState || "active",
  );
  const [toastText, setToastText] = useState<string | null>(null);

  const fade = useRef(new Animated.Value(0)).current;
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const finishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sawRunRef = useRef(false);
  const seenConfirmRef = useRef<Set<string>>(new Set());
  const appStateRef = useRef<AppStateStatus>(appState);
  const wsRef = useRef<WebSocket | null>(null);
  const watchedChatsRef = useRef<Map<string, number>>(new Map());
  const chatsRef = useRef<Record<string, WatchedChat>>({});
  const syncGenerationRef = useRef(0);
  const fallbackRequestRef = useRef(0);
  const chatBootstrapTimersRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  const supportsChatDeltasRef = useRef<boolean | null>(null);
  const socketHealthyRef = useRef(false);

  const toast = useCallback(
    (text: string) => {
      setToastText(text);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      Animated.timing(fade, {
        toValue: 1,
        duration: 160,
        useNativeDriver: true,
      }).start();
      toastTimer.current = setTimeout(() => {
        Animated.timing(fade, {
          toValue: 0,
          duration: 260,
          useNativeDriver: true,
        }).start(() => setToastText(null));
      }, 1900);
    },
    [fade],
  );

  const announceFinished = useCallback(async () => {
    const focusedNow = getFocusedChat();
    if (focusedNow && appStateRef.current === "active") {
      toast("Agent finished");
      return;
    }
    const ref = getRememberedChat() || (await hydrateRememberedChat());
    await notifyLocal(
      "Agent finished",
      ref?.name
        ? `${ref.name} is done on the host.`
        : "The host agent stopped working.",
      { kind: "finished", chatId: ref?.id, projectId: ref?.projectId },
    );
  }, [toast]);

  const observeActivity = useCallback(
    (
      status?: string | null,
      model?: string | null,
      running?: boolean | null,
      labels?: string[] | null,
      startedAt?: number | null,
    ) => {
      const trimmed = status?.trim() || null;
      // Prefer explicit running flag from daemon (Stop-button aware). Fall back
      // to status text for older daemons.
      const next =
        running === false
          ? null
          : running === true
            ? trimmed || "Working…"
            : trimmed;
      setHostStatus(next);
      setHostLabels(labels || []);
      if (next) {
        setHostStartedAt((current) => startedAt || current || Date.now());
      } else {
        setHostStartedAt(null);
      }
      if (model) setHostModel(model);

      if (next) {
        sawRunRef.current = true;
        runningRef.current = true;
        if (finishTimer.current) {
          clearTimeout(finishTimer.current);
          finishTimer.current = null;
        }
        return;
      }
      if (!runningRef.current || finishTimer.current) return;
      finishTimer.current = setTimeout(() => {
        finishTimer.current = null;
        runningRef.current = false;
        if (!sawRunRef.current) return;
        sawRunRef.current = false;
        void announceFinished();
      }, FINISH_DEBOUNCE_MS);
    },
    [announceFinished],
  );

  const observeUnavailable = useCallback(() => {
    if (finishTimer.current) {
      clearTimeout(finishTimer.current);
      finishTimer.current = null;
    }
    runningRef.current = false;
    sawRunRef.current = false;
    setHostStatus(null);
    setHostLabels([]);
    setHostStartedAt(null);
  }, []);

  const observeConfirmations = useCallback((items: Confirmation[]) => {
    setConfirmations((previous) => {
      const previousKey = JSON.stringify(previous);
      const nextKey = JSON.stringify(items);
      return previousKey === nextKey ? previous : items;
    });
    const seen = seenConfirmRef.current;
    for (const id of Array.from(seen)) {
      if (!items.some((i) => i.id === id)) seen.delete(id);
    }
    const fresh = items.filter((i) => !seen.has(i.id));
    if (!fresh.length) return;
    for (const i of fresh) seen.add(i.id);

    const focusedNow = getFocusedChat();
    // The chat screen already renders the approval card — stay quiet there.
    if (appStateRef.current === "active" && focusedNow) return;
    const ref = focusedNow || getRememberedChat();
    void notifyLocal(
      "Cursor needs approval",
      fresh[0]?.text || "The agent is waiting on you.",
      { kind: "approval", chatId: ref?.id, projectId: ref?.projectId },
    );
  }, []);

  useEffect(() => {
    syncGenerationRef.current += 1;
    fallbackRequestRef.current += 1;
    supportsChatDeltasRef.current = null;
    socketHealthyRef.current = false;
    for (const timer of chatBootstrapTimersRef.current.values()) {
      clearTimeout(timer);
    }
    chatBootstrapTimersRef.current.clear();
    chatsRef.current = {};
    setChats({});
    setChatErrors({});
    setHealth(null);
    setConfirmations([]);
    setHostStatus(null);
    setHostLabels([]);
    setHostStartedAt(null);
    setHostModel(null);
    setLastCompletedAt(null);
    setLastCompletedDurationMs(null);
    setCompletions({});
    if (!client) return;
    void ensureNotificationPermission();
    void hydrateRememberedChat();
  }, [client]);

  const fallbackSnapshot = useCallback(async (generation: number) => {
    if (!client) return;
    const requestId = ++fallbackRequestRef.current;
    const chatIds = Array.from(watchedChatsRef.current.keys());
    const [activity, conf, nextHealth, chatResults] = await Promise.all([
      client.composerActivity().catch(() => null),
      client.confirmations().catch(() => null),
      client.composerHealth().catch(() => null),
      Promise.all(
        chatIds.map(async (chatId) => ({
          chatId,
          chat: await client.chat(chatId).catch(() => null),
        })),
      ),
    ]);
    if (
      generation !== syncGenerationRef.current ||
      requestId !== fallbackRequestRef.current ||
      appStateRef.current !== "active"
    ) {
      return;
    }
    if (activity) {
      observeActivity(
        activity.status,
        activity.currentModel,
        activity.running,
        activity.labels,
      );
    }
    if (conf) observeConfirmations(conf.items as Confirmation[]);
    if (nextHealth) setHealth(nextHealth);
    const loaded = chatResults.filter(
      (
        result,
      ): result is {
        chatId: string;
        chat: ChatDetail & { revision?: string };
      } =>
        Boolean(result.chat) && watchedChatsRef.current.has(result.chatId),
    );
    if (loaded.length) {
      setChatErrors((previous) => {
        let changed = false;
        const next = { ...previous };
        for (const { chatId } of loaded) {
          if (!watchedChatsRef.current.has(chatId)) continue;
          if (!next[chatId]) continue;
          delete next[chatId];
          changed = true;
        }
        return changed ? next : previous;
      });
      setChats((previous) => {
        const next = { ...previous };
        let changed = false;
        for (const { chatId, chat } of loaded) {
          if (!watchedChatsRef.current.has(chatId)) continue;
          const last = chat.messages[chat.messages.length - 1];
          const revision =
            chat.revision ||
            `http:${chat.lastUpdatedAt || 0}:${chat.messages.length}:${shortHash(
              JSON.stringify(last || null),
            )}`;
          if (
            previous[chatId]?.source === "ws" &&
            socketHealthyRef.current &&
            supportsChatDeltasRef.current === true
          ) {
            continue;
          }
          if (previous[chatId]?.revision === revision) continue;
          changed = true;
          const { revision: _revision, ...detail } = chat;
          next[chatId] = {
            chat: detail,
            revision,
            source: "http",
          };
        }
        if (!changed) return previous;
        chatsRef.current = next;
        return next;
      });
    }
  }, [client, observeActivity, observeConfirmations]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      appStateRef.current = next;
      setAppState(next);
      if (next !== "active") {
        syncGenerationRef.current += 1;
        fallbackRequestRef.current += 1;
        for (const timer of chatBootstrapTimersRef.current.values()) {
          clearTimeout(timer);
        }
        chatBootstrapTimersRef.current.clear();
        logProtocolMetrics(`app-${next}`);
      }
    });
    return () => {
      sub.remove();
    };
  }, []);

  const sendSocket = useCallback((message: object) => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const raw = JSON.stringify(message);
    try {
      socket.send(raw);
      recordWsSent(raw);
      return true;
    } catch {
      return false;
    }
  }, []);

  const clearChatBootstrap = useCallback((chatId: string) => {
    const timer = chatBootstrapTimersRef.current.get(chatId);
    if (timer) clearTimeout(timer);
    chatBootstrapTimersRef.current.delete(chatId);
  }, []);

  const applyHttpChat = useCallback(
    (chatId: string, chat: ChatDetail & { revision?: string }) => {
      if (!watchedChatsRef.current.has(chatId)) return;
      clearChatBootstrap(chatId);
      const last = chat.messages[chat.messages.length - 1];
      const revision =
        chat.revision ||
        `http:${chat.lastUpdatedAt || 0}:${chat.messages.length}:${shortHash(
          JSON.stringify(last || null),
        )}`;
      const { revision: _revision, ...detail } = chat;
      setChatErrors((previous) => {
        if (!previous[chatId]) return previous;
        const next = { ...previous };
        delete next[chatId];
        return next;
      });
      setChats((previous) => {
        if (
          previous[chatId]?.source === "ws" &&
          socketHealthyRef.current &&
          supportsChatDeltasRef.current === true
        ) {
          return previous;
        }
        if (previous[chatId]?.revision === revision) return previous;
        const next = {
          ...previous,
          [chatId]: { chat: detail, revision, source: "http" as const },
        };
        chatsRef.current = next;
        return next;
      });
    },
    [clearChatBootstrap],
  );

  const scheduleLegacyChatPoll = useCallback(
    (chatId: string, initialDelay = 1800) => {
      if (!client || chatBootstrapTimersRef.current.has(chatId)) return;
      const generation = syncGenerationRef.current;
      const schedule = (delay: number) => {
        const timer = setTimeout(() => {
          chatBootstrapTimersRef.current.delete(chatId);
          void client
            .chat(chatId)
            .then((chat) => {
              if (
                generation !== syncGenerationRef.current ||
                !watchedChatsRef.current.has(chatId)
              ) {
                return;
              }
              applyHttpChat(chatId, chat);
            })
            .catch((loadError) => {
              if (
                generation !== syncGenerationRef.current ||
                !watchedChatsRef.current.has(chatId) ||
                chatsRef.current[chatId]
              ) {
                return;
              }
              setChatErrors((previous) => ({
                ...previous,
                [chatId]:
                  (loadError as Error).message || "Could not load this chat.",
              }));
            })
            .finally(() => {
              if (
                generation === syncGenerationRef.current &&
                appStateRef.current === "active" &&
                watchedChatsRef.current.has(chatId) &&
                supportsChatDeltasRef.current !== true
              ) {
                schedule(2500);
              }
            });
        }, delay);
        chatBootstrapTimersRef.current.set(chatId, timer);
      };
      schedule(initialDelay);
    },
    [applyHttpChat, client],
  );

  const requestChatSnapshot = useCallback(
    (chatId: string) => {
      if (!watchedChatsRef.current.has(chatId)) return;
      sendSocket({ type: "subscribeChat", chatId });
    },
    [sendSocket],
  );

  const subscribeChat = useCallback(
    (chatId: string) => {
      const count = watchedChatsRef.current.get(chatId) || 0;
      watchedChatsRef.current.set(chatId, count + 1);
      recordChatSubscriptions(watchedChatsRef.current.size);
      if (count === 0) {
        const revision = chatsRef.current[chatId]?.revision;
        sendSocket({ type: "subscribeChat", chatId, revision });
        if (client) scheduleLegacyChatPoll(chatId);
      }
      return () => {
        const nextCount = (watchedChatsRef.current.get(chatId) || 1) - 1;
        if (nextCount > 0) {
          watchedChatsRef.current.set(chatId, nextCount);
          return;
        }
        watchedChatsRef.current.delete(chatId);
        clearChatBootstrap(chatId);
        recordChatSubscriptions(watchedChatsRef.current.size);
        sendSocket({ type: "unsubscribeChat", chatId });
        if (chatsRef.current[chatId]) {
          const next = { ...chatsRef.current };
          delete next[chatId];
          chatsRef.current = next;
        }
        setChats((previous) => {
          if (watchedChatsRef.current.has(chatId)) return previous;
          if (!previous[chatId]) return previous;
          const next = { ...previous };
          delete next[chatId];
          return next;
        });
        setChatErrors((previous) => {
          if (!previous[chatId]) return previous;
          const next = { ...previous };
          delete next[chatId];
          return next;
        });
        setCompletions((previous) => {
          if (!previous[chatId]) return previous;
          const next = { ...previous };
          delete next[chatId];
          return next;
        });
      };
    },
    [clearChatBootstrap, client, scheduleLegacyChatPoll, sendSocket],
  );

  // One foreground-only socket is the source of truth. Closing it in the
  // background prevents radio wakeups and reconnect loops while JS is suspended.
  useEffect(() => {
    if (!client || appState !== "active") {
      wsRef.current = null;
      socketHealthyRef.current = false;
      return;
    }
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let attempt = 0;
    let hasOpened = false;

    const schedule = () => {
      if (closed || retry || appStateRef.current !== "active") return;
      // Back off when the daemon is unreachable so we don't spin on a dead host.
      const delay = Math.min(RECONNECT_MS * 2 ** Math.min(attempt, 3), 30000);
      attempt += 1;
      void fallbackSnapshot(syncGenerationRef.current);
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (closed) return;
      supportsChatDeltasRef.current = null;
      let socket: WebSocket;
      try {
        socket = new WebSocket(client.wsUrl("/composer"));
      } catch {
        schedule();
        return;
      }
      wsRef.current = socket;
      socket.onopen = () => {
        if (closed || wsRef.current !== socket) {
          socket.close();
          return;
        }
        socketHealthyRef.current = true;
        recordWsOpen(hasOpened);
        hasOpened = true;
        attempt = 0;
        sendSocket({ type: "subscribe" });
        for (const chatId of watchedChatsRef.current.keys()) {
          sendSocket({
            type: "subscribeChat",
            chatId,
            revision: chatsRef.current[chatId]?.revision,
          });
          scheduleLegacyChatPoll(chatId);
        }
      };
      socket.onmessage = (ev) => {
        if (closed || wsRef.current !== socket) return;
        const raw = String(ev.data);
        recordWsReceived(raw);
        let msg: ComposerServerMessage;
        try {
          msg = JSON.parse(raw) as ComposerServerMessage;
        } catch {
          return;
        }
        if (msg.type === "capabilities") {
          supportsChatDeltasRef.current = msg.chatDeltas;
          if (msg.chatDeltas) {
            for (const timer of chatBootstrapTimersRef.current.values()) {
              clearTimeout(timer);
            }
            chatBootstrapTimersRef.current.clear();
          }
        } else if (msg.type === "status") {
          setHealth(msg.health);
          if (!msg.health.cdpReachable || !msg.health.selectorsOk) {
            observeUnavailable();
            observeConfirmations([]);
          }
        } else if (msg.type === "activity") {
          observeActivity(
            msg.status,
            msg.currentModel,
            msg.running,
            msg.labels,
            msg.startedAt,
          );
        } else if (msg.type === "confirmations") {
          observeConfirmations(msg.items);
        } else if (msg.type === "turnComplete") {
          setLastCompletedAt(msg.at);
          setLastCompletedDurationMs(msg.durationMs);
          const chatId = msg.chatId;
          if (typeof chatId === "string") {
            setCompletions((previous) => ({
              ...previous,
              [chatId]: {
                durationMs: msg.durationMs,
                label: msg.label,
                at: msg.at,
              },
            }));
          }
        } else if (msg.type === "chatSnapshot") {
          if (!watchedChatsRef.current.has(msg.chat.id)) return;
          clearChatBootstrap(msg.chat.id);
          setChatErrors((previous) => {
            if (!previous[msg.chat.id]) return previous;
            const next = { ...previous };
            delete next[msg.chat.id];
            return next;
          });
          setChats((previous) => {
            const next = {
              ...previous,
              [msg.chat.id]: {
                chat: msg.chat,
                revision: msg.revision,
                source: "ws" as const,
              },
            };
            chatsRef.current = next;
            return next;
          });
        } else if (msg.type === "chatDelta") {
          if (!watchedChatsRef.current.has(msg.chatId)) return;
          clearChatBootstrap(msg.chatId);
          setChatErrors((previous) => {
            if (!previous[msg.chatId]) return previous;
            const next = { ...previous };
            delete next[msg.chatId];
            return next;
          });
          const current = chatsRef.current[msg.chatId];
          if (!current || current.revision !== msg.baseRevision) {
            requestChatSnapshot(msg.chatId);
            return;
          }
          const messages = [
            ...current.chat.messages.slice(0, msg.fromIndex),
            ...msg.messages,
          ].slice(0, msg.messageCount);
          const nextItem: WatchedChat = {
            revision: msg.revision,
            source: "ws",
            chat: {
              ...current.chat,
              messages,
              lastUpdatedAt: msg.lastUpdatedAt ?? current.chat.lastUpdatedAt,
              filesChangedCount: msg.filesChangedCount,
              filesChanged: msg.filesChanged,
            },
          };
          setChats((previous) => {
            const next = { ...previous, [msg.chatId]: nextItem };
            chatsRef.current = next;
            return next;
          });
        } else if (msg.type === "chatError") {
          if (!watchedChatsRef.current.has(msg.chatId)) return;
          setChatErrors((previous) => ({
            ...previous,
            [msg.chatId]: msg.message,
          }));
        }
      };
      socket.onerror = () => undefined;
      socket.onclose = () => {
        recordWsClose();
        if (wsRef.current !== socket) return;
        socketHealthyRef.current = false;
        wsRef.current = null;
        if (!closed) schedule();
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      const socket = wsRef.current;
      wsRef.current = null;
      socketHealthyRef.current = false;
      try {
        socket?.close();
      } catch {
        // already closed
      }
    };
  }, [
    appState,
    client,
    clearChatBootstrap,
    fallbackSnapshot,
    observeActivity,
    observeConfirmations,
    observeUnavailable,
    requestChatSnapshot,
    scheduleLegacyChatPoll,
    sendSocket,
  ]);

  useEffect(
    () => () => {
      if (finishTimer.current) clearTimeout(finishTimer.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  // Deep link from a tapped notification, including cold start.
  useEffect(() => {
    if (!lastResponse || !navState?.key) return;
    const identifier = lastResponse.notification.request.identifier;
    let cancelled = false;
    (async () => {
      const handled = await AsyncStorage.getItem(HANDLED_KEY).catch(() => null);
      if (cancelled || handled === identifier) return;
      await AsyncStorage.setItem(HANDLED_KEY, identifier).catch(
        () => undefined,
      );
      const data = parseNotifyData(
        lastResponse.notification.request.content.data,
      );
      if (!data?.chatId || cancelled) return;
      const query = data.projectId
        ? `?projectId=${encodeURIComponent(data.projectId)}`
        : "";
      router.push(`/chats/${data.chatId}${query}`);
    })();
    return () => {
      cancelled = true;
    };
  }, [lastResponse, navState?.key]);

  const value = useMemo<WatchValue>(
    () => ({
      hostRunning: Boolean(hostStatus),
      hostStatus,
      hostLabels,
      hostStartedAt,
      hostModel,
      lastCompletedAt,
      lastCompletedDurationMs,
      health,
      confirmations,
      pendingApprovals: confirmations.length,
      toast,
    }),
    [
      confirmations,
      health,
      hostLabels,
      hostModel,
      hostStartedAt,
      hostStatus,
      lastCompletedAt,
      lastCompletedDurationMs,
      toast,
    ],
  );
  const chatValue = useMemo<ChatWatchValue>(
    () => ({
      chats,
      errors: chatErrors,
      completions,
      subscribeChat,
      requestChatSnapshot,
    }),
    [chatErrors, chats, completions, requestChatSnapshot, subscribeChat],
  );

  return (
    <WatchContext.Provider value={value}>
      <ChatWatchContext.Provider value={chatValue}>
        {children}
        {toastText ? (
          <Animated.View
            pointerEvents="none"
            style={[styles.toastWrap, { top: insets.top + 10, opacity: fade }]}
          >
            <View style={styles.toast}>
              <Text style={styles.toastText}>{toastText}</Text>
            </View>
          </Animated.View>
        ) : null}
      </ChatWatchContext.Provider>
    </WatchContext.Provider>
  );
}

const styles = StyleSheet.create({
  toastWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  toast: {
    backgroundColor: "#1c1915",
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  toastText: {
    color: "#f7f4ee",
    fontSize: 13,
    fontWeight: "700",
  },
});
