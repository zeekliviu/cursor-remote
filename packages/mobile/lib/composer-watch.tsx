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

/** Tools finish and restart in bursts; wait this long before calling it "done". */
const FINISH_DEBOUNCE_MS = 3500;
const POLL_MS = 3000;
const RECONNECT_MS = 4000;
const HANDLED_KEY = "cursor-remote:handled-notification";

type WatchValue = {
  /** Host agent is producing a status line right now. */
  hostRunning: boolean;
  hostStatus: string | null;
  hostModel: string | null;
  pendingApprovals: number;
  toast: (text: string) => void;
};

const fallback: WatchValue = {
  hostRunning: false,
  hostStatus: null,
  hostModel: null,
  pendingApprovals: 0,
  toast: () => undefined,
};

const WatchContext = createContext<WatchValue>(fallback);

export function useComposerWatch(): WatchValue {
  return useContext(WatchContext);
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
  const [hostModel, setHostModel] = useState<string | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [toastText, setToastText] = useState<string | null>(null);

  const fade = useRef(new Animated.Value(0)).current;
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const finishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sawRunRef = useRef(false);
  const seenConfirmRef = useRef<Set<string>>(new Set());
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

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

  const observeConfirmations = useCallback((items: Confirmation[]) => {
    setPendingApprovals(items.length);
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
    if (!client) return;
    void ensureNotificationPermission();
    void hydrateRememberedChat();
  }, [client]);

  const poll = useCallback(async () => {
    if (!client) return;
    const [activity, conf] = await Promise.all([
      client.composerActivity().catch(() => null),
      client.confirmations().catch(() => null),
    ]);
    if (activity) {
      observeActivity(
        activity.status,
        activity.currentModel,
        activity.running,
      );
    }
    if (conf) observeConfirmations(conf.items as Confirmation[]);
  }, [client, observeActivity, observeConfirmations]);

  // HTTP poll is the backup path (and the only one that runs right after resume).
  useEffect(() => {
    if (!client) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      if (timer) return;
      void poll();
      timer = setInterval(() => void poll(), POLL_MS);
    };
    if (AppState.currentState === "active") start();
    const sub = AppState.addEventListener("change", (next) => {
      appStateRef.current = next;
      if (next === "active") start();
      else stop();
    });
    return () => {
      sub.remove();
      stop();
    };
  }, [client, poll]);

  // Composer WS gives sub-second transitions while the app is foregrounded.
  useEffect(() => {
    if (!client) return;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let attempt = 0;

    const schedule = () => {
      if (closed || retry) return;
      // Back off when the daemon is unreachable so we don't spin on a dead host.
      const delay = Math.min(RECONNECT_MS * 2 ** Math.min(attempt, 3), 30000);
      attempt += 1;
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (closed) return;
      let socket: WebSocket;
      try {
        socket = new WebSocket(client.wsUrl("/composer"));
      } catch {
        schedule();
        return;
      }
      ws = socket;
      socket.onopen = () => {
        attempt = 0;
        try {
          socket.send(JSON.stringify({ type: "subscribe" }));
        } catch {
          // socket died between open and send
        }
      };
      socket.onmessage = (ev) => {
        let msg: ComposerServerMessage;
        try {
          msg = JSON.parse(String(ev.data)) as ComposerServerMessage;
        } catch {
          return;
        }
        if (msg.type === "activity") {
          observeActivity(msg.status, msg.currentModel, msg.running);
        } else if (msg.type === "confirmations") {
          observeConfirmations(msg.items);
        }
      };
      socket.onerror = () => undefined;
      socket.onclose = () => {
        if (ws === socket) ws = null;
        schedule();
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      try {
        ws?.close();
      } catch {
        // already closed
      }
    };
  }, [client, observeActivity, observeConfirmations]);

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
      hostModel,
      pendingApprovals,
      toast,
    }),
    [hostStatus, hostModel, pendingApprovals, toast],
  );

  return (
    <WatchContext.Provider value={value}>
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
