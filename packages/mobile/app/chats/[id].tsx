import {
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
  FlatList,
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
  ChatDetail,
  ChatMessage,
} from "@cursor-remote/shared";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useConnection } from "../../lib/connection";
import {
  useChatWatch,
  useComposerWatch,
} from "../../lib/composer-watch";
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
import { useReducedMotion } from "../../lib/reduced-motion";
import { ApprovalSheet } from "../../lib/approval-sheet";
import {
  ImageViewer,
  type ImageViewerImage,
} from "../../lib/image-viewer";
import {
  buildChatTurns,
  getDefaultExpansionGuidance,
  type ChatTurn,
} from "../../lib/chat-turns";
import {
  CHAT_DENSITY_OPTIONS,
  useChatDensity,
  useChatExpansionState,
} from "../../lib/chat-density";
import { ToolCluster } from "../../lib/tool-cluster";
import { WorkSummaryRow } from "../../lib/work-summary-row";

const DRAFT_KEY = (chatId: string) => `cursor-remote:draft:${chatId}`;
/** How close to the bottom still counts as "following the conversation". */
const NEAR_BOTTOM_PX = 80;
const SLASH_COMMANDS = [
  { command: "/plan", label: "Plan first" },
  { command: "/review", label: "Review changes" },
  { command: "/fix", label: "Fix issue" },
  { command: "/test", label: "Run tests" },
];
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
  onOpen,
}: {
  images?: Array<{ path: string; name?: string; width?: number; height?: number }>;
  mediaUrl: (path: string) => string;
  onOpen?: (index: number) => void;
}) {
  if (!images?.length) return null;
  return (
    <ScrollView
      horizontal
      style={styles.msgImageRow}
      contentContainerStyle={styles.msgImageRowContent}
      showsHorizontalScrollIndicator={false}
    >
      {images.map((img, index) => (
        <Pressable
          key={img.path}
          onPress={() => onOpen?.(index)}
          accessibilityRole="imagebutton"
          accessibilityLabel={`Open ${img.name || "attachment"}`}
        >
          <Image
            source={{ uri: mediaUrl(img.path), cache: "force-cache" }}
            style={styles.msgImage}
            resizeMode="cover"
            accessibilityLabel={img.name || "Attachment"}
          />
        </Pressable>
      ))}
    </ScrollView>
  );
}

function TypewriterText({
  text,
  onLinkPress,
}: {
  text: string;
  onLinkPress?: (url: string) => boolean;
}) {
  return (
    <Markdown style={markdownStyles} onLinkPress={onLinkPress}>
      {text || " "}
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
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (!running || reducedMotion) {
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
  }, [pulse, reducedMotion, running]);

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

export default function ChatScreen() {
  const { id, projectId } = useLocalSearchParams<{
    id: string;
    projectId?: string;
  }>();
  const { client } = useConnection();
  const {
    toast,
    health,
    confirmations,
    hostStatus: agentStatus,
    hostLabels,
    hostStartedAt,
    hostModel: hostModelLabel,
  } = useComposerWatch();
  const {
    chats: watchedChats,
    errors: chatErrors,
    completions,
    subscribeChat,
    requestChatSnapshot,
  } = useChatWatch();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<FlatList<ChatTurn>>(null);
  const lastLenRef = useRef(0);
  const nearBottomRef = useRef(true);
  const projectIdParam = typeof projectId === "string" ? projectId : undefined;
  const hostId = client
    ? client.connection.id ||
      `${client.connection.host}:${client.connection.port}`
    : null;
  const { density, setDensity } = useChatDensity(hostId);
  const turnExpansion = useChatExpansionState(hostId, id);

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
  const [interrupting, setInterrupting] = useState(false);
  const [live, setLive] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const [kbHeight, setKbHeight] = useState(0);
  const [attaches, setAttaches] = useState<LocalAttach[]>([]);
  const [bindHint, setBindHint] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const [imageViewer, setImageViewer] = useState<{
    images: ImageViewerImage[];
    index: number;
  } | null>(null);
  const openMessageImages = useCallback(
    (
      images: Array<{ path: string; name?: string }>,
      index: number,
    ) => {
      setImageViewer({
        index,
        images: images.map((image) => ({
          uri: mediaUrlFor(image.path),
          name: image.name,
          accessibilityLabel: image.name || "Chat attachment",
        })),
      });
    },
    [mediaUrlFor],
  );

  useEffect(() => {
    if (!confirmations.length) setApprovalsOpen(false);
  }, [confirmations.length]);

  const turns = useMemo(() => {
    const built = chat ? buildChatTurns(chat.messages) : [];
    const completion = completions[id];
    if (!completion || !built.length) return built;
    return built.map((turn, index) =>
      index === built.length - 1
        ? {
            ...turn,
            durationMs: completion.durationMs,
          }
        : turn,
    );
  }, [chat, completions, id]);
  const cdpOk = Boolean(health?.cdpReachable && health?.selectorsOk);
  const hostAgentRunning = Boolean(agentStatus);
  const agentRunning = hostAgentRunning || busy;
  const messageable = chat?.messageable !== false;

  const canSend =
    cdpOk &&
    messageable &&
    !busy &&
    !interrupting &&
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
          setTimeout(followBottom, 30);
        }
      }
      lastLenRef.current = nextLen;
      return detail;
    });
  }, [followBottom]);

  useEffect(() => {
    if (!id) return;
    const watched = watchedChats[id];
    if (chatErrors[id]) {
      setError(chatErrors[id]);
    } else if (watched) {
      applyChatUpdate(watched.chat);
      setError(null);
    }
  }, [applyChatUpdate, chatErrors, id, watchedChats]);

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
  const openDensityMenu = useCallback(() => {
    Alert.alert(
      "Conversation density",
      "Choose how much agent activity appears inline.",
      [
        ...CHAT_DENSITY_OPTIONS.map((option) => ({
          text: `${option.label}${density === option.value ? " ✓" : ""}`,
          onPress: () => setDensity(option.value),
        })),
        { text: "Cancel", style: "cancel" as const },
      ],
    );
  }, [density, setDensity]);

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
      headerRight: () => (
        <Pressable
          onPress={openDensityMenu}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Conversation density: ${density}`}
        >
          <Text style={styles.densityButton}>{density.slice(0, 1).toUpperCase()}</Text>
        </Pressable>
      ),
    });
  }, [
    navigation,
    headerSubtitle,
    headerStatus,
    chat?.name,
    density,
    openDensityMenu,
  ]);

  // Let the background watcher know this chat is on screen (no notification needed).
  useFocusEffect(
    useCallback(() => {
      if (!id) return;
      setFocusedChat({ id, projectId: projectIdParam });
      const unsubscribe = subscribeChat(id);
      return () => {
        unsubscribe();
        clearFocusedChat(id);
        lastLenRef.current = 0;
        setChat(null);
      };
    }, [id, projectIdParam, subscribeChat]),
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
    }, 500);
    return () => clearTimeout(t);
  }, [id, draft]);

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

  useEffect(() => {
    if (!bindHint || /failed|not found|error/i.test(bindHint)) return;
    const timer = setTimeout(() => setBindHint(null), 3500);
    return () => clearTimeout(timer);
  }, [bindHint]);

  useEffect(() => {
    if (!/^(Sent|Queued in Cursor|Stop sent)$/.test(live)) return;
    const timer = setTimeout(() => setLive(""), 2200);
    return () => clearTimeout(timer);
  }, [live]);

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
      requestChatSnapshot(id);
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
      setLive(hostAgentRunning ? "Queued in Cursor" : "Sent");
      setDraft("");
      setAttaches([]);
      if (id) AsyncStorage.removeItem(DRAFT_KEY(id)).catch(() => undefined);
      requestChatSnapshot(id);
      scrollBottom();
    } catch (err) {
      const msg = (err as Error).message || "send failed";
      setError(msg);
      Alert.alert("Send failed", msg);
    } finally {
      setBusy(false);
    }
  }

  async function interruptAndSend() {
    if (!client || !hostAgentRunning || !canSend || interrupting || busy) return;
    setInterrupting(true);
    try {
      setLive("Interrupting…");
      const stopped = await client.stopComposer();
      if (!stopped.ok) throw new Error("Cursor did not accept the stop request.");
      let stillRunning = true;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const activity = await client.composerActivity().catch(() => null);
        if (
          activity &&
          (activity.running === false ||
            (activity.running == null && !activity.status))
        ) {
          stillRunning = false;
          break;
        }
      }
      if (stillRunning) {
        throw new Error("Cursor is still stopping. Try again in a moment.");
      }
      setInterrupting(false);
      await send();
    } catch (err) {
      Alert.alert("Interrupt & send", (err as Error).message);
    } finally {
      setInterrupting(false);
    }
  }

  const renderTurn = useCallback(
    (turn: ChatTurn, index: number) => {
      if (!chat) return null;
      const isLatest = index === turns.length - 1;
      const isActive = isLatest && hostAgentRunning;
      const guidance = getDefaultExpansionGuidance(turn, {
        density,
        isActive,
        completedTurnsAfter: Math.max(0, turns.length - index - 1),
      });
      const expanded = turnExpansion.isExpanded(
        turn.id,
        guidance.turnExpanded,
      );
      const latestFiles =
        isLatest && chat.filesChanged?.length ? chat.filesChanged : [];
      const fileCount = latestFiles.length || turn.stats.fileCount;
      const additions = latestFiles.length
        ? latestFiles.reduce((sum, file) => sum + (file.additions || 0), 0)
        : turn.stats.additions;
      const deletions = latestFiles.length
        ? latestFiles.reduce((sum, file) => sum + (file.deletions || 0), 0)
        : turn.stats.deletions;
      return (
        <View style={styles.turn}>
          {turn.user ? (
            <Pressable
              onLongPress={() => copyOrQuote(turn.user!)}
              delayLongPress={280}
              style={({ pressed }) => [
                styles.userBubble,
                pressed && styles.bubblePressed,
              ]}
            >
              <MessageImages
                images={turn.user.images}
                mediaUrl={mediaUrlFor}
                onOpen={(imageIndex) =>
                  openMessageImages(turn.user?.images || [], imageIndex)
                }
              />
              {turn.user.text ? (
                <Markdown
                  style={markdownStyles}
                  onLinkPress={onMarkdownLink}
                >
                  {turn.user.text}
                </Markdown>
              ) : null}
            </Pressable>
          ) : null}

          {(turn.toolMessages.length > 0 ||
            turn.thinking.length > 0 ||
            isActive) ? (
            <WorkSummaryRow
              active={isActive}
              status={isActive ? agentStatus || hostLabels[0] : null}
              startedAt={isActive ? hostStartedAt : null}
              durationMs={turn.durationMs}
              toolCount={turn.stats.toolCount}
              fileCount={fileCount}
              additions={additions}
              deletions={deletions}
              expanded={expanded}
              onToggle={() =>
                turnExpansion.toggleExpanded(turn.id, guidance.turnExpanded)
              }
              onOpenChanges={
                latestFiles.length
                  ? () => router.push(`/chats/${id}/changes`)
                  : undefined
              }
            />
          ) : null}

          <View style={styles.turnWork}>
            {turn.timeline.map((item) => {
              if (item.kind === "assistant") {
                const message = item.message;
                if (
                  density === "compact" &&
                  turn.finalAssistant?.id !== message.id
                ) {
                  return null;
                }
                return (
                  <Pressable
                    key={item.id}
                    onLongPress={() => copyOrQuote(message)}
                    delayLongPress={280}
                    style={({ pressed }) => [
                      styles.assistantMessage,
                      pressed && styles.bubblePressed,
                    ]}
                  >
                    <MessageImages
                      images={message.images}
                      mediaUrl={mediaUrlFor}
                      onOpen={(imageIndex) =>
                        openMessageImages(message.images || [], imageIndex)
                      }
                    />
                    {message.text ? (
                      <TypewriterText
                        text={message.text}
                        onLinkPress={onMarkdownLink}
                      />
                    ) : null}
                  </Pressable>
                );
              }

              if (item.kind === "thinking") {
                if (!expanded) return null;
                const entry = item.entry;
                const thinkingOpen = turnExpansion.isExpanded(
                  entry.id,
                  guidance.thinkingExpanded,
                );
                return (
                  <View key={item.id} style={styles.thinkingCompact}>
                    <Pressable
                      onPress={() =>
                        turnExpansion.toggleExpanded(
                          entry.id,
                          guidance.thinkingExpanded,
                        )
                      }
                      style={styles.thinkingCompactHeader}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: thinkingOpen }}
                    >
                      <Text style={styles.thinkingCompactTitle}>
                        {thinkingOpen ? "⌄" : "›"}{" "}
                        {entry.durationMs
                          ? `Thought for ${Math.max(
                              1,
                              Math.round(entry.durationMs / 1000),
                            )}s`
                          : "Thinking"}
                      </Text>
                    </Pressable>
                    {thinkingOpen ? (
                      <Text selectable style={styles.thinkingCompactBody}>
                        {entry.text}
                      </Text>
                    ) : null}
                  </View>
                );
              }

              if (item.kind === "tools") {
                if (!expanded) return null;
                const cluster = item.cluster;
                return (
                  <ToolCluster
                    key={item.id}
                    clusterId={cluster.id}
                    category={cluster.category}
                    messages={cluster.messages}
                    density={density}
                    initiallyExpanded={guidance.expandedToolClusterIds.includes(
                      cluster.id,
                    )}
                    isExpanded={turnExpansion.isExpanded}
                    onToggleExpanded={turnExpansion.toggleExpanded}
                    onOpenTerminal={() =>
                      router.push(
                        `/terminal/${projectIdParam || chat.projectId}`,
                      )
                    }
                    onQuickPrompt={(prompt) => setDraft(prompt)}
                  />
                );
              }

              const important = /task finished|background task|subagent/i.test(
                item.message.text,
              );
              if (!expanded && !important) return null;
              if (density !== "detailed" && !important) return null;
              return (
                <View key={item.id} style={styles.systemRow}>
                  <Text style={styles.systemText}>{item.message.text}</Text>
                </View>
              );
            })}
          </View>
        </View>
      );
    },
    [
      agentStatus,
      chat,
      density,
      hostAgentRunning,
      hostLabels,
      hostStartedAt,
      id,
      mediaUrlFor,
      onMarkdownLink,
      openMessageImages,
      projectIdParam,
      turnExpansion,
      turns.length,
    ],
  );

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
      <FlatList
        ref={scrollRef}
        data={turns}
        keyExtractor={(turn) => turn.id}
        renderItem={({ item, index }) => renderTurn(item, index)}
        contentContainerStyle={styles.container}
        onContentSizeChange={followBottom}
        onScroll={onScroll}
        scrollEventThrottle={32}
        removeClippedSubviews={Platform.OS === "android"}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        windowSize={7}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            {!messageable ? (
              <View style={styles.readonlyBanner}>
                <Text style={styles.readonlyTitle}>View only</Text>
                <Text style={styles.readonlyBody}>
                  This is a subagent / explore transcript. Cursor has no
                  Composer input here — open a parent agent chat to send
                  messages.
                </Text>
                {chat.parentChatId ? (
                  <Pressable
                    onPress={() =>
                      router.push(
                        `/chats/${chat.parentChatId}?projectId=${projectIdParam || chat.projectId}`,
                      )
                    }
                    accessibilityRole="button"
                  >
                    <Text style={styles.readonlyLink}>Open parent chat ›</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {!cdpOk ? (
              <View style={styles.warn}>
                <Text style={styles.warnTitle}>
                  CDP down — Send is blocked
                </Text>
                <Text style={styles.warnBody}>
                  {health?.fixHint ||
                    "On the Mac: quit Cursor, then run ./scripts/launch-cursor-debug.sh"}
                </Text>
              </View>
            ) : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {live ? <Text style={styles.live}>{live}</Text> : null}
            {bindHint ? <Text style={styles.bindHint}>{bindHint}</Text> : null}
          </View>
        }
        ListFooterComponent={
          <View onLayout={followBottom} style={{ height: 1 }} />
        }
      />

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
          <Pressable
            style={({ pressed }) => [
              styles.approvalDock,
              pressed && styles.pressedSoft,
            ]}
            onPress={() => setApprovalsOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={`${confirmations.length} approval ${confirmations.length === 1 ? "request" : "requests"}`}
          >
            <View style={styles.approvalDockCopy}>
              <Text style={styles.approvalDockBadge}>Needs approval</Text>
              <Text style={styles.approvalDockTitle} numberOfLines={1}>
                {confirmations[0]?.text || "Agent is waiting for you"}
              </Text>
            </View>
            <Text style={styles.approvalDockAction}>
              {confirmations.length > 1 ? `${confirmations.length} · ` : ""}
              Review ›
            </Text>
          </Pressable>
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

        {draft.startsWith("/") && !draft.includes(" ") ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.slashRow}
          >
            {SLASH_COMMANDS.filter(({ command }) =>
              command.startsWith(draft.toLowerCase()),
            ).map(({ command, label }) => (
              <Pressable
                key={command}
                style={styles.slashChip}
                onPress={() => setDraft(`${command} `)}
                accessibilityRole="button"
              >
                <Text style={styles.slashCommand}>{command}</Text>
                <Text style={styles.slashLabel}>{label}</Text>
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
            onLongPress={() =>
              Alert.alert("Active model", hostModelLabel || "Auto")
            }
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
            editable={cdpOk && !busy && !interrupting}
          />
          {hostAgentRunning ? (
            <Pressable
              style={({ pressed }) => [
                styles.actionOrb,
                styles.actionOrbStop,
                pressed && styles.actionOrbPressed,
              ]}
              onPress={() => {
                void Haptics.impactAsync(
                  Haptics.ImpactFeedbackStyle.Medium,
                ).catch(() => undefined);
                void stopAgent();
              }}
              disabled={interrupting}
              accessibilityLabel="Stop agent"
              accessibilityState={{ disabled: interrupting, busy: interrupting }}
            >
              <Text style={[styles.actionOrbIcon, styles.actionOrbIconStop]}>
                ■
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            style={({ pressed }) => [
              styles.actionOrb,
              !canSend && styles.actionOrbDisabled,
              pressed && styles.actionOrbPressed,
            ]}
            disabled={!canSend}
            onPress={() => {
              void Haptics.impactAsync(
                Haptics.ImpactFeedbackStyle.Light,
              ).catch(() => undefined);
              void send();
            }}
            onLongPress={() => {
              if (!hostAgentRunning || !canSend) return;
              Alert.alert(
                "Send while agent is working",
                "Queue this follow-up in Cursor, or interrupt the current step first?",
                [
                  { text: "Cancel", style: "cancel" },
                  { text: "Queue", onPress: () => void send() },
                  {
                    text: "Interrupt & send",
                    style: "destructive",
                    onPress: () => void interruptAndSend(),
                  },
                ],
              );
            }}
            accessibilityLabel={
              hostAgentRunning ? "Queue message" : "Send message"
            }
          >
            <Text
              style={[
                styles.actionOrbIcon,
                !canSend && styles.actionOrbIconDisabled,
              ]}
            >
              {hostAgentRunning ? "↥" : "✈"}
            </Text>
          </Pressable>
        </View>
          </>
        )}
      </View>

      <ImageViewer
        visible={Boolean(imageViewer)}
        images={imageViewer?.images || []}
        initialIndex={imageViewer?.index || 0}
        onClose={() => setImageViewer(null)}
      />

      <ApprovalSheet
        open={approvalsOpen}
        confirmations={confirmations}
        onClose={() => setApprovalsOpen(false)}
        onAction={async (confirmationId, actionId) => {
          const result = await client.actConfirmation(
            confirmationId,
            actionId,
          );
          if (!result.ok) throw new Error("Cursor did not accept this action.");
          return result;
        }}
      />

      <ModelPickerSheet
        open={modelOpen}
        hostModelLabel={hostModelLabel}
        cdpOk={cdpOk}
        onClose={() => setModelOpen(false)}
        onApplied={() => setModelOpen(false)}
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
  listHeader: { gap: 8 },
  densityButton: {
    color: "#5f584e",
    fontSize: 12,
    fontWeight: "800",
    width: 32,
    height: 32,
    lineHeight: 32,
    textAlign: "center",
    borderRadius: 16,
    backgroundColor: "#ebe4d6",
    overflow: "hidden",
  },
  turn: { gap: 5, marginBottom: 12 },
  turnWork: { gap: 3 },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "92%",
    borderRadius: 15,
    borderBottomRightRadius: 5,
    backgroundColor: "#ebe4d6",
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  assistantMessage: {
    alignSelf: "stretch",
    paddingHorizontal: 2,
    paddingVertical: 5,
  },
  thinkingCompact: {
    borderLeftWidth: 2,
    borderLeftColor: "#d8d0c2",
    paddingLeft: 9,
    marginVertical: 2,
  },
  thinkingCompactHeader: { minHeight: 36, justifyContent: "center" },
  thinkingCompactTitle: {
    color: "#736b60",
    fontSize: 12,
    fontStyle: "italic",
    fontWeight: "700",
  },
  thinkingCompactBody: {
    color: "#5f584f",
    fontSize: 12,
    lineHeight: 18,
    paddingBottom: 8,
  },
  systemRow: {
    backgroundColor: "#efebe3",
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
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
    maxWidth: 112,
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
  slashRow: { gap: 7, paddingRight: 8 },
  slashChip: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#ebe4d6",
    borderRadius: 10,
    paddingHorizontal: 10,
  },
  slashCommand: { color: "#2f5d3a", fontSize: 12, fontWeight: "800" },
  slashLabel: { color: "#6f685c", fontSize: 11 },
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
  approvalDock: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#f5e6d2",
    borderWidth: 1,
    borderColor: "#e0c9a0",
    borderRadius: 12,
    paddingHorizontal: 12,
  },
  approvalDockCopy: { flex: 1, paddingVertical: 8 },
  approvalDockBadge: {
    color: "#8a5a20",
    fontSize: 10,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  approvalDockTitle: {
    color: "#302a23",
    fontSize: 12,
    fontWeight: "700",
    marginTop: 2,
  },
  approvalDockAction: { color: "#7d4e18", fontSize: 12, fontWeight: "800" },
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
  readonlyLink: {
    color: "#2f5d3a",
    fontSize: 13,
    fontWeight: "700",
    paddingVertical: 6,
  },
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
