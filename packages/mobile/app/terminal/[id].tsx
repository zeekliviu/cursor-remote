import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  ScrollView,
} from "react-native";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConnection } from "../../lib/connection";
import { stripAnsi } from "../../lib/strip-ansi";
import {
  recordWsClose,
  recordWsOpen,
  recordWsReceived,
  recordWsSent,
} from "../../lib/protocol-metrics";

const terminalSessionIds = new Map<string, string>();

export default function TerminalScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client } = useConnection();
  const [isFocused, setIsFocused] = useState(false);
  const insets = useSafeAreaInsets();
  const [output, setOutput] = useState("Connecting…\n");
  const [line, setLine] = useState("");
  const [ready, setReady] = useState(false);
  const [cwd, setCwd] = useState<string | null>(null);
  const [kbHeight, setKbHeight] = useState(0);
  const [appActive, setAppActive] = useState(
    AppState.currentState === "active",
  );
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, []),
  );

  useEffect(() => {
    const showEvt =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvt =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvt, (e) =>
      setKbHeight(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      setAppActive(state === "active");
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!client || !id || !isFocused || !appActive) return;
    const ws = new WebSocket(client.wsUrl("/terminal"));
    wsRef.current = ws;
    ws.onopen = () => {
      if (wsRef.current !== ws) {
        ws.close();
        return;
      }
      recordWsOpen(false);
      const raw = JSON.stringify({
        type: "attach",
        projectId: id,
        sessionId: terminalSessionIds.get(id),
        cols: 80,
        rows: 24,
      });
      ws.send(raw);
      recordWsSent(raw);
    };
    ws.onmessage = (ev) => {
      if (wsRef.current !== ws) return;
      recordWsReceived(String(ev.data));
      try {
        const msg = JSON.parse(String(ev.data)) as {
          type: string;
          data?: string;
          cwd?: string;
          message?: string;
          code?: number | null;
          sessionId?: string;
        };
        if (msg.type === "ready") {
          if (msg.sessionId) terminalSessionIds.set(id, msg.sessionId);
          setReady(true);
          setCwd(msg.cwd || null);
          setOutput((o) => `${o}ready @ ${msg.cwd}\n`);
        } else if (msg.type === "data") {
          const clean = stripAnsi(msg.data || "");
          if (clean) setOutput((o) => o + clean);
        } else if (msg.type === "error") {
          setOutput((o) => `${o}\nerror: ${msg.message}\n`);
        } else if (msg.type === "exit") {
          terminalSessionIds.delete(id);
          setReady(false);
          setOutput((o) => `${o}\n[exit ${msg.code}]\n`);
        }
      } catch {
        // ignore
      }
      requestAnimationFrame(() =>
        scrollRef.current?.scrollToEnd({ animated: false }),
      );
    };
    ws.onerror = () => {
      if (wsRef.current === ws) {
        setOutput((o) => `${o}\nwebsocket error\n`);
      }
    };
    ws.onclose = () => {
      recordWsClose();
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      setReady(false);
    };
    return () => {
      wsRef.current = null;
      ws.close();
    };
  }, [appActive, client, id, isFocused]);

  function sendLine() {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const raw = JSON.stringify({ type: "input", data: `${line}\n` });
    ws.send(raw);
    recordWsSent(raw);
    setLine("");
  }

  if (!client) {
    return (
      <View style={styles.center}>
        <Text>Not paired</Text>
      </View>
    );
  }

  const bottomPad =
    kbHeight > 0 ? 8 : Math.max(insets.bottom, Platform.OS === "android" ? 28 : 12) + 8;
  const bottomLift =
    Platform.OS === "android" && kbHeight > 0 ? kbHeight + 22 : 0;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}
    >
      {cwd ? (
        <View style={styles.cwdBar}>
          <Text style={styles.cwdLabel} numberOfLines={1}>
            cwd · {cwd}
          </Text>
        </View>
      ) : null}
      <ScrollView
        ref={scrollRef}
        style={styles.out}
        contentContainerStyle={{ padding: 12 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.mono}>{output}</Text>
      </ScrollView>
      <View
        style={[
          styles.row,
          { paddingBottom: bottomPad, marginBottom: bottomLift },
        ]}
      >
        <TextInput
          style={styles.input}
          value={line}
          onChangeText={setLine}
          autoCapitalize="none"
          autoCorrect={false}
          editable={ready}
          placeholder={ready ? "command" : "waiting for shell…"}
          onSubmitEditing={sendLine}
        />
        <Pressable style={styles.send} onPress={sendLine} disabled={!ready}>
          <Text style={styles.sendText}>Run</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: "#161411" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  cwdBar: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#1e1a15",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#3a342c",
  },
  cwdLabel: {
    color: "#a89f90",
    fontSize: 11,
    fontFamily: "Menlo",
  },
  out: { flex: 1 },
  mono: {
    fontFamily: "Menlo",
    fontSize: 12,
    color: "#e8e0d0",
    lineHeight: 16,
  },
  row: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 10,
    paddingTop: 10,
    backgroundColor: "#221e18",
  },
  input: {
    flex: 1,
    backgroundColor: "#2b261f",
    color: "#f7f4ee",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: "Menlo",
  },
  send: {
    backgroundColor: "#d9c7a5",
    borderRadius: 10,
    paddingHorizontal: 14,
    justifyContent: "center",
  },
  sendText: { color: "#1c1915", fontWeight: "700" },
});
