import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Linking,
} from "react-native";
import { useFocusEffect, useLocalSearchParams, useNavigation, router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Markdown from "react-native-markdown-display";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import type {
  AttachmentMeta,
  ChatChangedFile,
  ChatDetail,
  ChatMessage,
  ComposerHealth,
  Confirmation,
} from "@cursor-remote/shared";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useConnection } from "../../lib/connection";
import { useComposerWatch } from "../../lib/composer-watch";
import {
  ModelPickerSheet,
  shortModelLabel,
} from "../../lib/model-picker-sheet";
import {
  clearFocusedChat,
  isFocusedChat,
  rememberChat,
  setFocusedChat,
} from "../../lib/focused-chat";
import {
  buildChatBlocks,
} from "../../lib/chat-blocks";
import {
  formatToolGroupPreview,
  formatToolMessage,
  renderDiffLines,
} from "../../lib/format-tool";

const DRAFT_KEY = (chatId: string) => `cursor-remote:draft:${chatId}`;
/** How close to the bottom still counts as "following the conversation". */
const NEAR_BOTTOM_PX = 80;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cursor / agent transcripts sometimes contain markdown links whose "URL" is a
 * bare composer/chat id (e.g. `[subagent](uuid)`). Open those in-app; never
 * hand bare ids to Android Linking.
 */
function openSafeMarkdownUrl(
  url: string,
  opts?: { projectId?: string },
): boolean {
  const trimmed = (url || "").trim();
  if (!trimmed) return false;
  if (UUID_RE.test(trimmed)) {
    const q = opts?.projectId
      ? `?projectId=${encodeURIComponent(opts.projectId)}`
      : "";
    router.push(`/chats/${trimmed}${q}`);
    return false;
  }
  if (
    /^(https?:|mailto:|tel:|cursor-remote:)/i.test(trimmed) ||
    trimmed.startsWith("/")
  ) {
    void Linking.openURL(trimmed).catch(() => undefined);
    return false;
  }
  return false;
}

type LocalAttach = {
  uri: string;
  name: string;
  mime: string;
  preview?: string;
};

function MessageImages({
  images,
  mediaUrl,
}: {
  images?: Array<{ path: string; name?: string; width?: number; height?: number }>;
  mediaUrl: (path: string) => string;
}) {
  if (!images?.length) return null;
  return (
    <ScrollView
      horizontal
      style={styles.msgImageRow}
      contentContainerStyle={styles.msgImageRowContent}
      showsHorizontalScrollIndicator={false}
    >
      {images.map((img) => (
        <Image
          key={img.path}
          source={{ uri: mediaUrl(img.path) }}
          style={styles.msgImage}
          resizeMode="cover"
          accessibilityLabel={img.name || "Attachment"}
        />
      ))}
    </ScrollView>
  );
}

function TypewriterText({
  text,
  active,
  onLinkPress,
}: {
  text: string;
  active: boolean;
  onLinkPress?: (url: string) => boolean;
}) {
  const [shown, setShown] = useState(active ? "" : text);
  useEffect(() => {
    if (!active) {
      setShown(text);
      return;
    }
    setShown("");
    let i = 0;
    const step = Math.max(1, Math.floor(text.length / 80));
    const id = setInterval(() => {
      i = Math.min(text.length, i + step);
      setShown(text.slice(0, i));
      if (i >= text.length) clearInterval(id);
    }, 16);
    return () => clearInterval(id);
  }, [text, active]);
  return (
    <Markdown style={markdownStyles} onLinkPress={onLinkPress}>
      {shown || " "}
    </Markdown>
  );
}

/**
 * Pulsing activity label — used in the nav subtitle next to the message count.
 */
function LiveStatusLine({
  status,
  compact,
}: {
  status: string | null;
  compact?: boolean;
}) {
  const pulse = useRef(new Animated.Value(1)).current;
  const running = Boolean(status);

  useEffect(() => {
    if (!running) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.4,
          duration: 760,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 760,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      pulse.setValue(1);
    };
  }, [pulse, running]);

  if (!status) return null;

  return (
    <Animated.View
      style={[styles.statusLine, compact && styles.statusLineCompact, { opacity: pulse }]}
    >
      <View style={[styles.statusDot, compact && styles.statusDotCompact]} />
      <Text style={[styles.statusText, compact && styles.statusTextCompact]}>
        {status}
      </Text>
    </Animated.View>
  );
}

/** Fade + lift used for approval cards so they never pop in abruptly. */
function SoftEnter({
  children,
  style,
}: {
  children: ReactNode;
  style?: object;
}) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [anim]);
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: anim,
          transform: [
            {
              translateY: anim.interpolate({
                inputRange: [0, 1],
                outputRange: [10, 0],
              }),
            },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

export default function ChatScreen() {
  const { id, projectId } = useLocalSearchParams<{
    id: string;
    projectId?: string;
  }>();
  const { client } = useConnection();
  const { toast } = useComposerWatch();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const lastLenRef = useRef(0);
  const streamingIdRef = useRef<string | null>(null);
  const nearBottomRef = useRef(true);
  const projectIdParam = typeof projectId === "string" ? projectId : undefined;

  const onMarkdownLink = useCallback(
    (url: string) => openSafeMarkdownUrl(url, { projectId: projectIdParam }),
    [projectIdParam],
  );

  const mediaUrlFor = useCallback(
    (filePath: string) => (client ? client.mediaUrl(filePath) : ""),
    [client],
  );

  const [chat, setChat] = useState<ChatDetail | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState("");
  const [confirmations, setConfirmations] = useState<Confirmation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<ComposerHealth | null>(null);
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>(
    {},
  );
  const [expandedThinking, setExpandedThinking] = useState<
    Record<string, boolean>
  >({});
  const [expandedToolDetail, setExpandedToolDetail] = useState<
    Record<string, boolean>
  >({});
  const [expandedChanged, setExpandedChanged] = useState(false);
  const [changedPatches, setChangedPatches] = useState<
    Record<string, ChatChangedFile>
  >({});
  const [loadingChanged, setLoadingChanged] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  const [hostModelLabel, setHostModelLabel] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [kbHeight, setKbHeight] = useState(0);
  const [attaches, setAttaches] = useState<LocalAttach[]>([]);
  const [streamingIds, setStreamingIds] = useState<Record<string, boolean>>({});
  const [bindHint, setBindHint] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);

  const blocks = useMemo(
    () => (chat ? buildChatBlocks(chat.messages) : []),
    [chat],
  );
  const cdpOk = Boolean(health?.cdpReachable);
  const agentRunning = Boolean(agentStatus) || busy;
  const messageable = chat?.messageable !== false;
  const showFilesChanged = Boolean(chat?.filesChanged?.length);

  const canSend =
    cdpOk &&
    messageable &&
    !agentRunning &&
    (draft.trim().length > 0 || attaches.length > 0);
  const showJumpPill = !atBottom && (newCount > 0 || agentRunning);

  const scrollBottom = useCallback(() => {
    requestAnimationFrame(() =>
      scrollRef.current?.scrollToEnd({ animated: true }),
    );
  }, []);

  /** Auto-scroll only while the user is actually following the tail. */
  const followBottom = useCallback(() => {
    if (!nearBottomRef.current) return;
    scrollBottom();
  }, [scrollBottom]);

  const jumpToLatest = useCallback(() => {
    nearBottomRef.current = true;
    setAtBottom(true);
    setNewCount(0);
    scrollBottom();
  }, [scrollBottom]);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const distance =
        contentSize.height - contentOffset.y - layoutMeasurement.height;
      const near = distance < NEAR_BOTTOM_PX;
      nearBottomRef.current = near;
      setAtBottom((prev) => (prev === near ? prev : near));
      if (near) setNewCount((c) => (c === 0 ? c : 0));
    },
    [],
  );

  const applyChatUpdate = useCallback((detail: ChatDetail) => {
    // Counted outside the updater so a re-invoked updater can't double-count.
    const grew = detail.messages.length - lastLenRef.current;
    if (grew > 0 && lastLenRef.current > 0 && !nearBottomRef.current) {
      setNewCount((c) => c + grew);
    }
    setChat((prev) => {
      const prevLen = prev?.messages.length ?? 0;
      const nextLen = detail.messages.length;
      if (nextLen > prevLen) {
        const newest = detail.messages[detail.messages.length - 1];
        if (newest?.role === "assistant" && newest.text) {
          streamingIdRef.current = newest.id;
          setStreamingIds((s) => ({ ...s, [newest.id]: true }));
          setTimeout(() => {
            setStreamingIds((s) => {
              const n = { ...s };
              delete n[newest.id];
              return n;
            });
          }, Math.min(4000, newest.text.length * 8));
        }
        setTimeout(followBottom, 50);
      } else if (prev && nextLen === prevLen && nextLen > 0) {
        const a = prev.messages[prevLen - 1];
        const b = detail.messages[nextLen - 1];
        if (
          a &&
          b &&
          a.id === b.id &&
          b.role === "assistant" &&
          (b.text?.length || 0) > (a.text?.length || 0)
        ) {
          streamingIdRef.current = b.id;
          setStreamingIds((s) => ({ ...s, [b.id]: true }));
          setTimeout(followBottom, 30);
        }
      }
      lastLenRef.current = nextLen;
      return detail;
    });
  }, [followBottom]);

  const refresh = useCallback(async (quiet = false) => {
    if (!client || !id) return;
    if (!quiet) setError(null);
    try {
      const [detail, h, activity, conf] = await Promise.all([
        client.chat(id),
        client.composerHealth().catch(() => null),
        client.composerActivity().catch(() => null),
        client.confirmations().catch(() => ({ items: [] as Confirmation[] })),
      ]);
      applyChatUpdate(detail);
      setHealth(h);
      setAgentStatus(
        activity?.running === false
          ? null
          : activity?.status ||
              (activity?.running ? "Working…" : null),
      );
      if (activity?.currentModel) {
        setHostModelLabel(activity.currentModel);
      }
      setConfirmations(conf.items as Confirmation[]);
    } catch (err) {
      if (!quiet) setError((err as Error).message);
    }
  }, [applyChatUpdate, client, id]);

  useEffect(() => {
    refresh(false);
  }, [refresh]);

  useEffect(() => {
    if (!client || !projectId) {
      setProjectName(null);
      return;
    }
    let cancelled = false;
    client
      .projects()
      .then(({ projects }) => {
        if (cancelled) return;
        const p = projects.find((x) => x.id === projectId);
        setProjectName(p?.name || null);
      })
      .catch(() => {
        if (!cancelled) setProjectName(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client, projectId]);

  // The header carries identity + live agent status next to the message count.
  const headerSubtitle = useMemo(() => {
    const parts = [
      projectName,
      messageable ? null : "view only",
      chat?.messages.length ? `${chat.messages.length} msg` : null,
    ].filter(Boolean);
    return parts.length ? parts.join(" · ") : null;
  }, [projectName, messageable, chat?.messages.length]);

  const headerStatus = agentStatus || (busy ? live || "Working…" : null);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {chat?.name || "Chat"}
          </Text>
          {headerSubtitle ? (
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {headerSubtitle}
            </Text>
          ) : null}
          {headerStatus ? (
            <LiveStatusLine status={headerStatus} compact />
          ) : null}
        </View>
      ),
    });
  }, [navigation, headerSubtitle, headerStatus, chat?.name]);

  // Let the background watcher know this chat is on screen (no notification needed).
  useFocusEffect(
    useCallback(() => {
      if (!id) return;
      setFocusedChat({ id, projectId: projectIdParam });
      return () => clearFocusedChat(id);
    }, [id, projectIdParam]),
  );

  useEffect(() => {
    if (!id || !chat?.name) return;
    const ref = { id, projectId: projectIdParam, name: chat.name };
    if (isFocusedChat(id)) setFocusedChat(ref);
    else rememberChat(ref);
  }, [id, projectIdParam, chat?.name]);

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
    if (!id) return;
    let cancelled = false;
    AsyncStorage.getItem(DRAFT_KEY(id))
      .then((saved) => {
        if (!cancelled && saved) setDraft(saved);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const t = setTimeout(() => {
      AsyncStorage.setItem(DRAFT_KEY(id), draft).catch(() => undefined);
    }, 200);
    return () => clearTimeout(t);
  }, [id, draft]);

  // Realtime poll while chat is open
  useEffect(() => {
    if (!client || !id) return;
    const t = setInterval(() => {
      refresh(true);
    }, 1200);
    return () => clearInterval(t);
  }, [client, id, refresh]);

  useEffect(() => {
    if (!client || !chat?.name) return;
    let cancelled = false;
    client
      .selectComposer({
        chatId: typeof id === "string" ? id : undefined,
        chatName: chat.name,
        projectId: typeof projectId === "string" ? projectId : undefined,
      })
      .then((r) => {
        if (cancelled) return;
        const title =
          r.window &&
          typeof r.window === "object" &&
          "title" in r.window &&
          typeof (r.window as { title?: string }).title === "string"
            ? (r.window as { title: string }).title
            : null;
        const parts = [
          r.matchedBy === "agentsPanel"
            ? "selected in Agents panel"
            : r.matchedBy === "project"
              ? "bound to project window"
              : r.matchedBy === "fallback"
                ? "Agents panel bind failed — open Agents sidebar"
                : null,
          r.matchedBy === "agentsPanel" && r.chatSelected === false
            ? "chat not found under repo"
            : null,
          title && r.matchedBy !== "fallback"
            ? `· ${title.slice(0, 48)}`
            : null,
        ].filter(Boolean);
        setBindHint(parts.length ? parts.join(" ") : null);
      })
      .catch((err) => {
        if (!cancelled) setBindHint((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [client, chat?.name, projectId, id]);

  async function pickPhoto() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Photos", "Permission required");
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.55,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    setAttaches((prev) => [
      ...prev,
      {
        uri: a.uri,
        name: a.fileName || `photo-${Date.now()}.jpg`,
        mime: a.mimeType || "image/jpeg",
        preview: a.uri,
      },
    ]);
  }

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Camera", "Permission required");
      return;
    }
    const res = await ImagePicker.launchCameraAsync({
      quality: 0.55,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    setAttaches((prev) => [
      ...prev,
      {
        uri: a.uri,
        name: a.fileName || `camera-${Date.now()}.jpg`,
        mime: a.mimeType || "image/jpeg",
        preview: a.uri,
      },
    ]);
  }

  async function pickDoc() {
    const res = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: true,
    });
    if (res.canceled) return;
    setAttaches((prev) => [
      ...prev,
      ...res.assets.map((a) => ({
        uri: a.uri,
        name: a.name,
        mime: a.mimeType || "application/octet-stream",
      })),
    ]);
  }

  function openAttachMenu() {
    Alert.alert("Attach", "Add to your next message", [
      { text: "Photo library", onPress: () => void pickPhoto() },
      { text: "Take photo", onPress: () => void takePhoto() },
      { text: "Files", onPress: () => void pickDoc() },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  function copyOrQuote(m: ChatMessage) {
    const text = (m.text || "").trim();
    if (!text) return;
    void Haptics.selectionAsync().catch(() => undefined);
    Alert.alert(
      m.role === "user" ? "Your message" : "Assistant message",
      text.length > 140 ? `${text.slice(0, 140)}…` : text,
      [
        {
          text: "Copy",
          onPress: () => {
            Clipboard.setStringAsync(text)
              .then(() => toast("Copied"))
              .catch(() => undefined);
          },
        },
        {
          text: "Quote in reply",
          onPress: () => {
            const quoted = text
              .split("\n")
              .slice(0, 12)
              .map((line) => `> ${line}`)
              .join("\n");
            setDraft((d) =>
              d.trim() ? `${quoted}\n\n${d}` : `${quoted}\n\n`,
            );
          },
        },
        { text: "Cancel", style: "cancel" },
      ],
    );
  }

  async function stopAgent() {
    if (!client) return;
    try {
      setLive("Stopping…");
      await client.stopComposer();
      setLive("Stop sent");
      await refresh(true);
    } catch (err) {
      Alert.alert("Stop", (err as Error).message);
    }
  }

  async function uploadAll(): Promise<AttachmentMeta[]> {
    if (!client) return [];
    const out: AttachmentMeta[] = [];
    for (const a of attaches) {
      const b64 = await FileSystem.readAsStringAsync(a.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (!b64) throw new Error(`Could not read ${a.name}`);
      const { attachment } = await client.uploadBase64(a.name, a.mime, b64);
      out.push(attachment);
    }
    return out;
  }

  async function send() {
    if (!client) return;
    if (!messageable) {
      Alert.alert(
        "View only",
        "This transcript has no Composer input. Open a parent agent chat to send.",
      );
      return;
    }
    if (!draft.trim() && attaches.length === 0) return;
    if (!cdpOk) {
      Alert.alert(
        "CDP down",
        health?.fixHint ||
          "Quit Cursor, run ./scripts/launch-cursor-debug.sh on the Mac, then retry.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let uploaded: AttachmentMeta[] = [];
      if (attaches.length) {
        setLive("Uploading…");
        uploaded = await uploadAll();
      }
      const text =
        draft.trim() ||
        (uploaded.length ? "See attached file(s) from phone." : "");
      setLive("Sending to Cursor…");
      await client.sendComposer(
        text,
        true,
        uploaded.map((u) => u.path),
        {
          projectId: typeof projectId === "string" ? projectId : undefined,
          chatName: chat?.name,
          chatId: typeof id === "string" ? id : undefined,
        },
      );
      setLive("Sent");
      setDraft("");
      setAttaches([]);
      if (id) AsyncStorage.removeItem(DRAFT_KEY(id)).catch(() => undefined);
      await refresh(true);
      const conf = await client.confirmations().catch(() => ({ items: [] }));
      setConfirmations(conf.items as Confirmation[]);
      scrollBottom();
    } catch (err) {
      const msg = (err as Error).message || "send failed";
      setError(msg);
      Alert.alert("Send failed", msg);
    } finally {
      setBusy(false);
    }
  }

  if (!client) {
    return (
      <View style={styles.center}>
        <Text>Not paired</Text>
      </View>
    );
  }

  if (!chat) {
    return (
      <View style={styles.center}>
        {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator />}
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 108 : 0}
    >
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.container}
        onContentSizeChange={followBottom}
        onScroll={onScroll}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
      >
        {!messageable ? (
          <View style={styles.readonlyBanner}>
            <Text style={styles.readonlyTitle}>View only</Text>
            <Text style={styles.readonlyBody}>
              This is a subagent / explore transcript. Cursor has no Composer
              input here — open a parent agent chat to send messages.
            </Text>
          </View>
        ) : null}
        {!cdpOk ? (
          <View style={styles.warn}>
            <Text style={styles.warnTitle}>CDP down — Send is blocked</Text>
            <Text style={styles.warnBody}>
              {health?.fixHint ||
                "On the Mac: quit Cursor, then run ./scripts/launch-cursor-debug.sh"}
            </Text>
          </View>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {live ? <Text style={styles.live}>{live}</Text> : null}
        {bindHint ? <Text style={styles.bindHint}>{bindHint}</Text> : null}
        {blocks.map((block) => {
          if (block.kind === "thinking") {
            const m = block.message;
            const open = !!expandedThinking[block.id];
            return (
              <View key={block.id} style={styles.thinkingGroup}>
                <Pressable
                  onPress={() =>
                    setExpandedThinking((s) => ({
                      ...s,
                      [block.id]: !open,
                    }))
                  }
                  style={styles.thinkingHeader}
                >
                  <Text style={styles.thinkingHeaderText}>
                    {open ? "▼" : "▶"} {m.text || "Thinking…"}
                  </Text>
                </Pressable>
                {open && m.thinking ? (
                  <Text style={styles.thinkingBody} selectable>
                    {m.thinking}
                  </Text>
                ) : null}
              </View>
            );
          }
          if (block.kind === "tools") {
            const open = !!expandedTools[block.id];
            return (
              <View key={block.id} style={styles.toolGroup}>
                <Pressable
                  onPress={() =>
                    setExpandedTools((s) => ({
                      ...s,
                      [block.id]: !open,
                    }))
                  }
                  style={styles.toolHeader}
                >
                  <Text style={styles.toolHeaderText}>
                    {open ? "▼" : "▶"} {block.count} action
                    {block.count === 1 ? "" : "s"}
                  </Text>
                </Pressable>
                {open ? (
                  block.messages.map((m) => {
                    const fmt = formatToolMessage(m);
                    const detailOpen = !!expandedToolDetail[m.id];
                    const hasExtra = Boolean(
                      fmt.diffPatch || fmt.output || fmt.exitCode != null,
                    );
                    return (
                      <Pressable
                        key={m.id}
                        style={styles.toolDetail}
                        onPress={() =>
                          hasExtra &&
                          setExpandedToolDetail((s) => ({
                            ...s,
                            [m.id]: !detailOpen,
                          }))
                        }
                      >
                        <Text style={styles.toolName}>
                          {fmt.title}
                          {fmt.status ? (
                            <Text style={styles.toolStatus}> · {fmt.status}</Text>
                          ) : null}
                        </Text>
                        {fmt.detail ? (
                          <Text style={styles.toolDetailText} selectable>
                            {fmt.detail}
                          </Text>
                        ) : null}
                        {fmt.result ? (
                          <Text style={styles.toolResult} selectable>
                            → {fmt.result}
                          </Text>
                        ) : null}
                        {(fmt.additions != null || fmt.deletions != null) &&
                        !fmt.result?.includes("+") ? (
                          <Text style={styles.diffStats}>
                            <Text style={styles.diffAdd}>
                              +{fmt.additions ?? 0}
                            </Text>{" "}
                            <Text style={styles.diffDel}>
                              −{fmt.deletions ?? 0}
                            </Text>
                          </Text>
                        ) : null}
                        {detailOpen && fmt.diffPatch ? (
                          <View style={styles.diffBox}>
                            {renderDiffLines(fmt.diffPatch).map((line, i) => (
                              <Text
                                key={`${m.id}-d-${i}`}
                                style={[
                                  styles.diffLine,
                                  line.kind === "add" && styles.diffLineAdd,
                                  line.kind === "del" && styles.diffLineDel,
                                  line.kind === "meta" && styles.diffLineMeta,
                                ]}
                                selectable
                              >
                                {line.t}
                              </Text>
                            ))}
                          </View>
                        ) : null}
                        {detailOpen && fmt.output ? (
                          <Text style={styles.termOut} selectable>
                            {fmt.exitCode != null
                              ? `$ exit ${fmt.exitCode}\n`
                              : ""}
                            {fmt.output}
                          </Text>
                        ) : null}
                        {hasExtra && !detailOpen ? (
                          <Text style={styles.tapHint}>Tap for details</Text>
                        ) : null}
                      </Pressable>
                    );
                  })
                ) : (
                  <Text style={styles.toolPreview} numberOfLines={2}>
                    {formatToolGroupPreview(block.messages)}
                  </Text>
                )}
              </View>
            );
          }
          const m = block.message;
          const animate = !!streamingIds[m.id];
          if (m.role === "system") {
            return (
              <View key={m.id} style={styles.systemBubble}>
                <Text style={styles.systemText}>{m.text}</Text>
              </View>
            );
          }
          return (
            <Pressable
              key={m.id}
              onLongPress={() => copyOrQuote(m)}
              delayLongPress={280}
              style={({ pressed }) => [
                styles.bubble,
                m.role === "user" ? styles.user : styles.assistant,
                pressed && styles.bubblePressed,
              ]}
            >
              <Text style={styles.role}>{m.role}</Text>
              <MessageImages images={m.images} mediaUrl={mediaUrlFor} />
              {m.role === "assistant" ? (
                m.text ? (
                  <TypewriterText
                    text={m.text}
                    active={animate}
                    onLinkPress={onMarkdownLink}
                  />
                ) : null
              ) : m.role === "user" ? (
                m.text ? (
                  <Markdown
                    style={markdownStyles}
                    onLinkPress={onMarkdownLink}
                  >
                    {m.text}
                  </Markdown>
                ) : null
              ) : (
                <Text style={styles.bubbleText}>{m.text}</Text>
              )}
            </Pressable>
          );
        })}
        {(showFilesChanged && (chat.filesChanged?.length || 0) > 0) ? (
          <View style={styles.filesChanged}>
            <Pressable
              onPress={() => setExpandedChanged((v) => !v)}
              style={styles.filesChangedHeader}
            >
              <Text style={styles.filesChangedTitle}>
                {expandedChanged ? "▼" : "▶"}{" "}
                {chat.filesChangedCount || chat.filesChanged?.length || 0}{" "}
                Files Changed
              </Text>
            </Pressable>
            {expandedChanged
              ? (chat.filesChanged || []).map((f) => {
                  const loaded = changedPatches[f.path];
                  const open = !!loaded;
                  return (
                    <View key={f.path} style={styles.changedRow}>
                      <Pressable
                        onPress={async () => {
                          if (open) {
                            setChangedPatches((s) => {
                              const n = { ...s };
                              delete n[f.path];
                              return n;
                            });
                            return;
                          }
                          if (!client || !id) return;
                          setLoadingChanged(f.path);
                          try {
                            const full = await client.changedFile(id, f.path);
                            setChangedPatches((s) => ({
                              ...s,
                              [f.path]: full,
                            }));
                          } catch (err) {
                            Alert.alert("Diff", (err as Error).message);
                          } finally {
                            setLoadingChanged(null);
                          }
                        }}
                      >
                        <Text style={styles.changedPath} numberOfLines={2}>
                          {f.isNew ? "A " : "M "}
                          {f.path.replace(/^.*\/(?=[^/]+\/[^/]+$)/, "")}
                        </Text>
                        {loadingChanged === f.path ? (
                          <ActivityIndicator size="small" />
                        ) : null}
                      </Pressable>
                      {open && loaded?.patch ? (
                        <View style={styles.diffBox}>
                          {(loaded.additions != null ||
                            loaded.deletions != null) && (
                            <Text style={styles.diffStats}>
                              <Text style={styles.diffAdd}>
                                +{loaded.additions ?? 0}
                              </Text>{" "}
                              <Text style={styles.diffDel}>
                                −{loaded.deletions ?? 0}
                              </Text>
                            </Text>
                          )}
                          {renderDiffLines(loaded.patch).map((line, i) => (
                            <Text
                              key={`${f.path}-${i}`}
                              style={[
                                styles.diffLine,
                                line.kind === "add" && styles.diffLineAdd,
                                line.kind === "del" && styles.diffLineDel,
                                line.kind === "meta" && styles.diffLineMeta,
                              ]}
                              selectable
                            >
                              {line.t}
                            </Text>
                          ))}
                        </View>
                      ) : null}
                    </View>
                  );
                })
              : null}
          </View>
        ) : null}
        <View onLayout={followBottom} style={{ height: 1 }} />
      </ScrollView>

      <View
        style={[
          styles.composer,
          {
            // Keyboard.endCoordinates.height is the real OS keyboard size.
            // With android softwareKeyboardLayoutMode=pan we lift by that height
            // (+ small gap) so the composer sits just above the keys.
            paddingBottom:
              kbHeight > 0
                ? 8
                : Math.max(insets.bottom, 12) + 8,
            marginBottom:
              Platform.OS === "android" && kbHeight > 0 ? kbHeight + 22 : 0,
          },
        ]}
      >
        {showJumpPill ? (
          <Pressable
            onPress={jumpToLatest}
            style={({ pressed }) => [
              styles.jumpPill,
              pressed && styles.pressedSoft,
            ]}
            accessibilityLabel="Scroll to latest message"
          >
            <Text style={styles.jumpPillText}>
              {newCount > 0
                ? `↓ ${newCount} new`
                : "↓ Jump to latest"}
            </Text>
          </Pressable>
        ) : null}
        {confirmations.length > 0 ? (
          <View style={styles.confirmStack}>
            {confirmations
              .filter((c) => {
                const t = (c.text || "")
                  .replace(/[↵⏎]/g, "")
                  .replace(/\s+/g, " ")
                  .trim();
                // Drop scrapes that are only button labels (legacy daemon / nested parents).
                if (
                  /^(skip|run|allow|cancel|reject|deny|yes|no)(\s+(skip|run|allow|cancel|reject|deny|yes|no))*$/i.test(
                    t,
                  )
                ) {
                  return false;
                }
                return t.length >= 4;
              })
              .map((c) => {
              const runLike = c.actions.filter((a) =>
                /^(run|allow|accept|approve|continue|confirm|yes)$/i.test(
                  a.label,
                ),
              );
              const cancelLike = c.actions.filter((a) =>
                /^(cancel|skip|reject|deny|no)$/i.test(a.label),
              );
              const other = c.actions.filter(
                (a) =>
                  !runLike.some((x) => x.id === a.id) &&
                  !cancelLike.some((x) => x.id === a.id),
              );
              const ordered = [...runLike, ...other, ...cancelLike];
              return (
                <SoftEnter key={c.id} style={styles.confirm}>
                  <Text style={styles.confirmBadge}>Needs approval</Text>
                  <Text style={styles.confirmTitle}>
                    {c.text
                      .replace(/[↵⏎]/g, "")
                      .replace(
                        /\s+(Skip|Run|Allow|Cancel|Reject|Deny)(\s+(Skip|Run|Allow|Cancel|Reject|Deny))*\s*$/i,
                        "",
                      )
                      .trim()}
                  </Text>
                  {c.summary ? (
                    <Text style={styles.confirmSummary} selectable>
                      {c.summary}
                    </Text>
                  ) : null}
                  {c.command ? (
                    <View style={styles.confirmCommandBox}>
                      <Text style={styles.confirmCommandLabel}>Command</Text>
                      <Text style={styles.confirmCommand} selectable>
                        {c.command}
                      </Text>
                    </View>
                  ) : null}
                  <View style={styles.confirmActions}>
                    {ordered.map((a) => {
                      const isRun =
                        /^(run|allow|accept|approve|continue|confirm|yes)$/i.test(
                          a.label,
                        );
                      const isCancel = /^(cancel|skip|reject|deny|no)$/i.test(
                        a.label,
                      );
                      return (
                        <Pressable
                          key={a.id}
                          style={({ pressed }) => [
                            styles.confirmBtn,
                            isRun && styles.confirmBtnRun,
                            isCancel && styles.confirmBtnCancel,
                            a.risk === "high" &&
                              isRun &&
                              styles.confirmBtnHigh,
                            pressed && styles.pressedSoft,
                          ]}
                          onPress={async () => {
                            void Haptics.selectionAsync().catch(
                              () => undefined,
                            );
                            try {
                              await client.actConfirmation(c.id, a.id);
                              setConfirmations([]);
                              refresh(true);
                            } catch (err) {
                              Alert.alert("Approval", (err as Error).message);
                            }
                          }}
                        >
                          <Text
                            style={[
                              styles.confirmBtnText,
                              (isRun || isCancel) && styles.confirmBtnTextOn,
                            ]}
                          >
                            {a.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </SoftEnter>
              );
            })}
          </View>
        ) : null}
        {!messageable ? (
          <Text style={styles.composerReadonlyHint}>
            View only · no Composer input on this chat
          </Text>
        ) : (
          <>
        {attaches.length ? (
          <ScrollView horizontal style={styles.attachRow}>
            {attaches.map((a, i) => (
              <Pressable
                key={`${a.uri}-${i}`}
                style={styles.attachChip}
                onPress={() =>
                  setAttaches((prev) => prev.filter((_, j) => j !== i))
                }
              >
                {a.preview ? (
                  <Image source={{ uri: a.preview }} style={styles.thumb} />
                ) : null}
                <Text style={styles.attachName} numberOfLines={1}>
                  {a.name} ✕
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        <View style={styles.inputRow}>
          <Pressable
            style={({ pressed }) => [
              styles.attachBtn,
              pressed && styles.attachBtnPressed,
            ]}
            onPress={openAttachMenu}
            hitSlop={6}
            accessibilityLabel="Attach file"
          >
            <Text style={styles.attachBtnIcon}>＋</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.modelChip,
              pressed && styles.pressedSoft,
            ]}
            onPress={() => setModelOpen(true)}
            accessibilityLabel="Change model"
          >
            <Text style={styles.modelChipText} numberOfLines={1}>
              {shortModelLabel(hostModelLabel)}
            </Text>
          </Pressable>
          <TextInput
            style={[styles.input, styles.multiline, styles.inputGrow]}
            placeholder={cdpOk ? "Message…" : "CDP down — cannot send"}
            multiline
            value={draft}
            onChangeText={setDraft}
            editable={cdpOk && !agentRunning}
          />
          <Pressable
            style={({ pressed }) => [
              styles.actionOrb,
              agentRunning && styles.actionOrbStop,
              !agentRunning && !canSend && styles.actionOrbDisabled,
              pressed && styles.actionOrbPressed,
            ]}
            disabled={!cdpOk || (!agentRunning && !canSend)}
            onPress={() => {
              void Haptics.impactAsync(
                agentRunning
                  ? Haptics.ImpactFeedbackStyle.Medium
                  : Haptics.ImpactFeedbackStyle.Light,
              ).catch(() => undefined);
              if (agentRunning) void stopAgent();
              else void send();
            }}
            accessibilityLabel={agentRunning ? "Stop agent" : "Send message"}
          >
            <Text
              style={[
                styles.actionOrbIcon,
                agentRunning && styles.actionOrbIconStop,
                !agentRunning && !canSend && styles.actionOrbIconDisabled,
              ]}
            >
              {agentRunning ? "■" : "✈"}
            </Text>
          </Pressable>
        </View>
          </>
        )}
      </View>

      <ModelPickerSheet
        open={modelOpen}
        hostModelLabel={hostModelLabel}
        cdpOk={cdpOk}
        onClose={() => setModelOpen(false)}
        onApplied={(label) => {
          // Show it straight away; the activity poll confirms within a tick.
          setHostModelLabel(label);
          setModelOpen(false);
        }}
      />
    </KeyboardAvoidingView>
  );
}

const markdownStyles = StyleSheet.create({
  body: { color: "#1c1915", fontSize: 15, lineHeight: 22 },
  paragraph: { marginTop: 0, marginBottom: 8 },
  strong: { fontWeight: "700" },
  em: { fontStyle: "italic" },
  heading1: { fontSize: 20, fontWeight: "700", marginBottom: 6 },
  heading2: { fontSize: 18, fontWeight: "700", marginBottom: 6 },
  heading3: { fontSize: 16, fontWeight: "700", marginBottom: 4 },
  code_inline: {
    backgroundColor: "#ebe4d6",
    borderRadius: 4,
    paddingHorizontal: 4,
    fontFamily: "Menlo",
    fontSize: 13,
  },
  fence: {
    backgroundColor: "#ebe4d6",
    borderRadius: 8,
    padding: 10,
    fontFamily: "Menlo",
    fontSize: 12,
  },
  link: { color: "#2f5d3a" },
});

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerTitleWrap: {
    alignItems: Platform.OS === "ios" ? "center" : "flex-start",
    maxWidth: 320,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#1c1915",
  },
  headerSubtitle: {
    fontSize: 12,
    color: "#6f685c",
    marginTop: 1,
  },
  statusLine: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 5,
    marginTop: 2,
    maxWidth: 320,
  },
  statusLineCompact: {},
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#b8863b",
    marginTop: 4,
  },
  statusDotCompact: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    marginTop: 4,
  },
  statusText: {
    flex: 1,
    color: "#6b5b3e",
    fontSize: 12,
    fontStyle: "italic",
    fontWeight: "600",
  },
  statusTextCompact: {
    fontSize: 11,
    lineHeight: 14,
  },
  container: { padding: 16, gap: 10, paddingBottom: 24 },
  meta: { color: "#6f685c", marginBottom: 6 },
  bubble: {
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: "#e5dfd2",
  },
  bubblePressed: { opacity: 0.72 },
  msgImageRow: { marginBottom: 8, maxHeight: 168 },
  msgImageRowContent: { gap: 8, paddingVertical: 2 },
  msgImage: {
    width: 148,
    height: 148,
    borderRadius: 10,
    backgroundColor: "#ebe4d6",
  },
  user: { backgroundColor: "#ebe4d6" },
  assistant: { backgroundColor: "#fffdf8" },
  jumpPill: {
    alignSelf: "center",
    backgroundColor: "#f5e6d2",
    borderWidth: 1,
    borderColor: "#e0c9a0",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  jumpPillText: { color: "#8a5a20", fontSize: 13, fontWeight: "700" },
  pressedSoft: { opacity: 0.7 },
  role: {
    fontSize: 11,
    fontWeight: "700",
    color: "#7a7368",
    textTransform: "uppercase",
    marginBottom: 4,
  },
  bubbleText: { color: "#1c1915", lineHeight: 20 },
  toolGroup: {
    backgroundColor: "#e8e2d6",
    borderRadius: 12,
    overflow: "hidden",
    paddingBottom: 8,
  },
  thinkingGroup: {
    backgroundColor: "transparent",
    paddingVertical: 4,
    marginBottom: 4,
  },
  thinkingHeader: { paddingVertical: 2 },
  thinkingHeaderText: {
    color: "#7a7368",
    fontSize: 13,
    fontStyle: "italic",
    fontWeight: "600",
  },
  thinkingBody: {
    marginTop: 6,
    marginLeft: 4,
    color: "#5c564c",
    fontSize: 13,
    lineHeight: 18,
    fontStyle: "italic",
  },
  toolHeader: { paddingHorizontal: 12, paddingVertical: 10 },
  toolHeaderText: { color: "#5c564c", fontWeight: "700", fontSize: 13 },
  toolPreview: {
    paddingHorizontal: 12,
    color: "#7a7368",
    fontSize: 12,
    marginBottom: 4,
  },
  toolDetail: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#d5cfc2",
    gap: 4,
  },
  toolName: { color: "#1c1915", fontWeight: "700", fontSize: 13 },
  toolStatus: { color: "#7a7368", fontWeight: "600" },
  toolDetailText: {
    fontSize: 12,
    color: "#5c564c",
    lineHeight: 17,
  },
  toolResult: {
    fontSize: 12,
    color: "#2f5d3a",
    lineHeight: 17,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  composer: {
    borderTopWidth: 1,
    borderTopColor: "#e5dfd2",
    paddingHorizontal: 12,
    paddingTop: 10,
    gap: 8,
    backgroundColor: "#f3f0e8",
  },
  input: {
    backgroundColor: "#fffdf8",
    borderWidth: 1,
    borderColor: "#e5dfd2",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  multiline: { minHeight: 44, maxHeight: 120, textAlignVertical: "top" },
  inputRow: { flexDirection: "row", gap: 8, alignItems: "flex-end" },
  inputGrow: { flex: 1, minWidth: 0 },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  chip: {
    backgroundColor: "#1c1915",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
  },
  chipText: { color: "#f7f4ee", fontWeight: "600", fontSize: 13 },
  modelChip: {
    maxWidth: 88,
    height: 42,
    paddingHorizontal: 10,
    borderRadius: 21,
    backgroundColor: "#fffdf8",
    borderWidth: 1,
    borderColor: "#e5dfd2",
    alignItems: "center",
    justifyContent: "center",
  },
  modelChipText: {
    color: "#1c1915",
    fontWeight: "700",
    fontSize: 12,
  },
  attachBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#ebe4d6",
    alignItems: "center",
    justifyContent: "center",
  },
  attachBtnPressed: { backgroundColor: "#ded6c6" },
  attachBtnIcon: {
    color: "#1c1915",
    fontSize: 22,
    fontWeight: "500",
    marginTop: -1,
  },
  stopBtn: {
    backgroundColor: "#8a4030",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  stopBtnText: { color: "#f7f4ee", fontWeight: "700", fontSize: 13 },
  actionOrb: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#1c1915",
    alignItems: "center",
    justifyContent: "center",
  },
  actionOrbStop: {
    backgroundColor: "#8a4030",
  },
  actionOrbDisabled: {
    backgroundColor: "#d5cfc2",
  },
  actionOrbPressed: {
    opacity: 0.75,
    transform: [{ scale: 0.94 }],
  },
  actionOrbIcon: {
    color: "#f7f4ee",
    fontSize: 18,
    fontWeight: "700",
    marginTop: -1,
  },
  actionOrbIconStop: {
    fontSize: 14,
  },
  actionOrbIconDisabled: {
    color: "#9a9488",
  },
  bindHint: {
    color: "#8a8378",
    fontSize: 12,
    marginBottom: 4,
  },
  attachRow: { maxHeight: 64 },
  attachChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#ebe4d6",
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginRight: 8,
    maxWidth: 160,
  },
  thumb: { width: 28, height: 28, borderRadius: 6 },
  attachName: { color: "#1c1915", fontSize: 12, flexShrink: 1 },
  confirmStack: { gap: 8, marginBottom: 8 },
  confirm: {
    backgroundColor: "#f5e6d2",
    borderRadius: 12,
    padding: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: "#e0c9a0",
  },
  confirmBadge: {
    alignSelf: "flex-start",
    fontSize: 11,
    fontWeight: "700",
    color: "#8a5a20",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  confirmTitle: {
    color: "#1c1915",
    fontWeight: "700",
    fontSize: 15,
  },
  confirmSummary: {
    color: "#5c564c",
    fontSize: 13,
    lineHeight: 18,
  },
  confirmCommandBox: {
    backgroundColor: "#1c1915",
    borderRadius: 10,
    padding: 10,
    gap: 4,
  },
  confirmCommandLabel: {
    color: "#a39e93",
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  confirmCommand: {
    color: "#f7f4ee",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 13,
    lineHeight: 18,
  },
  confirmActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 2,
  },
  confirmBtn: {
    backgroundColor: "#ebe4d6",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },
  confirmBtnRun: { backgroundColor: "#2f5d3a" },
  confirmBtnCancel: { backgroundColor: "#5c564c" },
  confirmBtnHigh: { backgroundColor: "#8a4030" },
  confirmBtnText: { color: "#1c1915", fontWeight: "700", fontSize: 14 },
  confirmBtnTextOn: { color: "#f7f4ee" },
  live: { color: "#2f5d3a", fontSize: 12 },
  error: { color: "#9b2c1a" },
  warn: {
    backgroundColor: "#f5e6d2",
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  warnTitle: { fontWeight: "700", color: "#1c1915" },
  warnBody: { color: "#5c564c", fontSize: 13, lineHeight: 18 },
  readonlyBanner: {
    backgroundColor: "#ebe4d6",
    borderRadius: 12,
    padding: 12,
    gap: 4,
    borderWidth: 1,
    borderColor: "#d5cfc2",
  },
  readonlyTitle: { color: "#5c564c", fontWeight: "700", fontSize: 14 },
  readonlyBody: { color: "#6f685c", fontSize: 13, lineHeight: 18 },
  composerReadonlyHint: {
    color: "#7a7368",
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
    paddingVertical: 4,
  },
  systemBubble: {
    backgroundColor: "#ece8df",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 8,
  },
  systemText: { color: "#5c564c", fontSize: 12, fontStyle: "italic" },
  diffStats: { marginTop: 4, fontFamily: "Menlo", fontSize: 12 },
  diffAdd: { color: "#2f5d3a", fontWeight: "700" },
  diffDel: { color: "#9b2c1a", fontWeight: "700" },
  diffBox: {
    marginTop: 8,
    backgroundColor: "#1c1915",
    borderRadius: 8,
    padding: 8,
  },
  diffLine: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 11,
    color: "#d7d0c4",
    lineHeight: 15,
  },
  diffLineAdd: { color: "#8fdb9a" },
  diffLineDel: { color: "#f0a8a0" },
  diffLineMeta: { color: "#8a8378" },
  termOut: {
    marginTop: 8,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 11,
    color: "#2f5d3a",
    backgroundColor: "#e8efe6",
    padding: 8,
    borderRadius: 8,
    overflow: "hidden",
  },
  tapHint: { marginTop: 4, color: "#9a9286", fontSize: 11 },
  filesChanged: {
    backgroundColor: "#e8e2d6",
    borderRadius: 12,
    padding: 10,
    marginTop: 8,
    marginBottom: 8,
  },
  filesChangedHeader: { paddingVertical: 4 },
  filesChangedTitle: { color: "#1c1915", fontWeight: "700", fontSize: 14 },
  changedRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#d5cfc2",
    paddingVertical: 8,
  },
  changedPath: { color: "#1c1915", fontSize: 13, fontWeight: "600" },
});
