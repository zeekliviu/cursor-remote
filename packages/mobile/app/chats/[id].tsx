import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Markdown from "react-native-markdown-display";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import type {
  AttachmentMeta,
  ChatChangedFile,
  ChatDetail,
  ChatMessage,
  ComposerHealth,
  Confirmation,
  ModelChoice,
  ModelParamSection,
  ModelParams,
} from "@cursor-remote/shared";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useConnection } from "../../lib/connection";
import {
  buildChatBlocks,
} from "../../lib/chat-blocks";
import {
  formatToolGroupPreview,
  formatToolMessage,
  renderDiffLines,
} from "../../lib/format-tool";

const UI_BUILD = "ui-0814m";
const DRAFT_KEY = (chatId: string) => `cursor-remote:draft:${chatId}`;

type LocalAttach = {
  uri: string;
  name: string;
  mime: string;
  preview?: string;
};

function TypewriterText({
  text,
  active,
}: {
  text: string;
  active: boolean;
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
  return <Markdown style={markdownStyles}>{shown || " "}</Markdown>;
}

export default function ChatScreen() {
  const { id, projectId } = useLocalSearchParams<{
    id: string;
    projectId?: string;
  }>();
  const { client } = useConnection();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const lastLenRef = useRef(0);
  const streamingIdRef = useRef<string | null>(null);

  const [chat, setChat] = useState<ChatDetail | null>(null);
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
  const lastHostModelRef = useRef<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [modelParams, setModelParams] = useState<ModelParams | null>(null);
  const [paramsLoading, setParamsLoading] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<ModelChoice | null>(null);
  const [paramChoices, setParamChoices] = useState<Record<string, string>>({});
  const [paramToggles, setParamToggles] = useState<Record<string, boolean>>({});
  const [kbHeight, setKbHeight] = useState(0);
  const [attaches, setAttaches] = useState<LocalAttach[]>([]);
  const [streamingIds, setStreamingIds] = useState<Record<string, boolean>>({});

  const blocks = useMemo(
    () => (chat ? buildChatBlocks(chat.messages) : []),
    [chat],
  );
  const cdpOk = Boolean(health?.cdpReachable);

  const scrollBottom = useCallback(() => {
    requestAnimationFrame(() =>
      scrollRef.current?.scrollToEnd({ animated: true }),
    );
  }, []);

  const applyChatUpdate = useCallback((detail: ChatDetail) => {
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
        setTimeout(scrollBottom, 50);
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
          setTimeout(scrollBottom, 30);
        }
      }
      lastLenRef.current = nextLen;
      return detail;
    });
  }, [scrollBottom]);

  const refresh = useCallback(async (quiet = false) => {
    if (!client || !id) return;
    if (!quiet) setError(null);
    try {
      const [detail, h, activity] = await Promise.all([
        client.chat(id),
        client.composerHealth().catch(() => null),
        client.composerActivity().catch(() => null),
      ]);
      applyChatUpdate(detail);
      setHealth(h);
      setAgentStatus(activity?.status || null);
      if (activity?.currentModel) {
        setHostModelLabel(activity.currentModel);
      }
    } catch (err) {
      if (!quiet) setError((err as Error).message);
    }
  }, [applyChatUpdate, client, id]);

  useEffect(() => {
    refresh(false);
  }, [refresh]);

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
    client.selectComposer({ chatName: chat.name }).catch(() => undefined);
  }, [client, chat?.name]);

  const applyParamsState = useCallback((params: ModelParams | null) => {
    setModelParams(params);
    const choices: Record<string, string> = {};
    const toggles: Record<string, boolean> = {};
    for (const section of params?.sections || []) {
      if (section.kind === "choice") {
        const sel = section.options.find((o) => o.selected);
        if (sel) choices[section.title] = sel.label;
      } else {
        for (const o of section.options) {
          toggles[o.label] = o.selected;
        }
      }
    }
    setParamChoices(choices);
    setParamToggles(toggles);
  }, []);

  const loadParamsForModel = useCallback(
    async (label: string) => {
      if (!client) return;
      setParamsLoading(true);
      try {
        const p = await client.modelParams(label);
        applyParamsState({
          modelLabel: p.modelLabel || label,
          baseModel: p.baseModel,
          sections: p.sections || [],
        });
      } catch (err) {
        setModelsError((err as Error).message);
        applyParamsState({ modelLabel: label, sections: [] });
      } finally {
        setParamsLoading(false);
      }
    },
    [applyParamsState, client],
  );

  const loadModelsFromCdp = useCallback(async () => {
    if (!client) return;
    setModelsLoading(true);
    setModelsError(null);
    try {
      const r = await client.models();
      if (!r.models?.length) {
        setModels([]);
        setModelsError(r.error || "No models from CDP scrape");
        return;
      }
      setModels(r.models);
      let chosen =
        (r.current &&
          r.models.find(
            (m) =>
              m.label === r.current ||
              r.current?.toLowerCase().includes(m.label.toLowerCase()) ||
              m.label.toLowerCase().includes((r.current || "").toLowerCase()),
          )) ||
        null;
      if (!chosen) chosen = r.models[0];
      setSelectedModel(chosen);
      if (r.params?.sections) {
        applyParamsState(r.params);
      } else if (chosen) {
        await loadParamsForModel(chosen.label);
      }
    } catch (err) {
      setModels([]);
      setModelsError((err as Error).message);
    } finally {
      setModelsLoading(false);
    }
  }, [applyParamsState, client, loadParamsForModel]);

  // Sync Expo model label when host Cursor picker changes
  useEffect(() => {
    if (!hostModelLabel) return;
    if (lastHostModelRef.current === hostModelLabel) return;
    lastHostModelRef.current = hostModelLabel;
    const label = hostModelLabel;
    setSelectedModel((prev) => {
      if (prev && prev.label === label) return prev;
      const match = models.find(
        (m) =>
          m.label === label ||
          label.toLowerCase().includes(m.label.toLowerCase()) ||
          m.label.toLowerCase().includes(label.toLowerCase()),
      );
      return (
        match || {
          id: label.toLowerCase().replace(/\s+/g, "-"),
          label,
        }
      );
    });
    if (modelOpen) {
      loadParamsForModel(label).catch(() => undefined);
    }
  }, [hostModelLabel, loadParamsForModel, modelOpen, models]);

  async function applyModelToCursor() {
    if (!client || !selectedModel) return;
    if (!cdpOk) {
      Alert.alert("CDP down", "Cannot apply model without Cursor CDP.");
      return;
    }
    try {
      const { ok } = await client.selectModel(
        selectedModel.label,
        undefined,
        undefined,
        { choices: paramChoices, toggles: paramToggles },
      );
      if (!ok) {
        Alert.alert(
          "Model",
          `Could not apply "${selectedModel.label}" in Cursor UI — retune selectors.`,
        );
      }
    } catch (err) {
      Alert.alert("Model", (err as Error).message);
    }
  }

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
        onContentSizeChange={scrollBottom}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>{chat.name}</Text>
        <Text style={styles.meta}>
          {chat.mode} · {chat.messages.length} messages
          {projectId ? ` · ${projectId.slice(0, 8)}` : ""} · {UI_BUILD}
          {cdpOk ? " · live" : ""}
        </Text>
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
        {agentStatus ? (
          <Text style={styles.agentStatus}>{agentStatus}</Text>
        ) : null}
        {confirmations.map((c) => (
          <View key={c.id} style={styles.confirm}>
            <Text style={styles.confirmText}>{c.text}</Text>
            <View style={styles.row}>
              {c.actions.map((a) => (
                <Pressable
                  key={a.id}
                  style={styles.chip}
                  onPress={async () => {
                    await client.actConfirmation(c.id, a.id);
                    setConfirmations([]);
                    refresh(true);
                  }}
                >
                  <Text style={styles.chipText}>{a.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ))}
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
            <View
              key={m.id}
              style={[
                styles.bubble,
                m.role === "user" ? styles.user : styles.assistant,
              ]}
            >
              <Text style={styles.role}>{m.role}</Text>
              {m.role === "assistant" ? (
                <TypewriterText text={m.text || " "} active={animate} />
              ) : m.role === "user" ? (
                <Markdown style={markdownStyles}>{m.text || " "}</Markdown>
              ) : (
                <Text style={styles.bubbleText}>{m.text}</Text>
              )}
            </View>
          );
        })}
        {(chat.filesChanged?.length || 0) > 0 ? (
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
        <View onLayout={scrollBottom} style={{ height: 1 }} />
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
        <View style={styles.row}>
          <Pressable
            style={styles.modelBtn}
            onPress={() => {
              setModelOpen(true);
              loadModelsFromCdp();
            }}
          >
            <Text style={styles.modelBtnText} numberOfLines={1}>
              {selectedModel
                ? [
                    selectedModel.label,
                    ...Object.entries(paramChoices).map(
                      ([, v]) => v,
                    ),
                    ...Object.entries(paramToggles)
                      .filter(([, on]) => on)
                      .map(([k]) => k),
                  ]
                    .filter(Boolean)
                    .slice(0, 3)
                    .join(" · ")
                : "Model (CDP)"}
            </Text>
          </Pressable>
          <Pressable style={styles.iconBtn} onPress={pickPhoto}>
            <Text style={styles.iconBtnText}>Photo</Text>
          </Pressable>
          <Pressable style={styles.iconBtn} onPress={pickDoc}>
            <Text style={styles.iconBtnText}>File</Text>
          </Pressable>
        </View>

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
          <TextInput
            style={[styles.input, styles.multiline, { flex: 1 }]}
            placeholder={cdpOk ? "Message…" : "CDP down — cannot send"}
            multiline
            value={draft}
            onChangeText={setDraft}
            editable={cdpOk && !busy}
          />
          <Pressable
            style={[styles.send, (!cdpOk || busy) && { opacity: 0.45 }]}
            disabled={busy || !cdpOk}
            onPress={send}
          >
            <Text style={styles.sendText}>{busy ? "…" : "Send"}</Text>
          </Pressable>
        </View>
      </View>

      <Modal visible={modelOpen} animationType="slide" transparent>
        <View style={styles.modalBackdrop}>
          <View
            style={[
              styles.modalSheet,
              { paddingBottom: Math.max(insets.bottom, 20), maxHeight: "88%" },
            ]}
          >
            <Text style={styles.modalTitle}>Model (live CDP)</Text>
            {hostModelLabel ? (
              <Text style={styles.hostSync}>Host: {hostModelLabel}</Text>
            ) : null}
            {modelsLoading ? (
              <ActivityIndicator style={{ marginVertical: 16 }} />
            ) : null}
            {modelsError ? (
              <Text style={styles.error}>{modelsError}</Text>
            ) : null}

            <Text style={[styles.modalTitle, { marginTop: 4 }]}>
              {selectedModel?.label || "Select a model"}
            </Text>
            {paramsLoading ? (
              <ActivityIndicator style={{ marginVertical: 8 }} />
            ) : null}
            {(modelParams?.sections || []).map(
              (section: ModelParamSection) => (
                <View key={section.id} style={{ marginTop: 10 }}>
                  <Text style={styles.sectionLabel}>{section.title}</Text>
                  {section.kind === "toggle" ? (
                    <View style={{ gap: 8 }}>
                      {section.options.map((opt) => {
                        const on = !!paramToggles[opt.label];
                        return (
                          <View key={opt.id} style={styles.toggleRow}>
                            <Text style={styles.modalItemText}>{opt.label}</Text>
                            <Switch
                              value={on}
                              onValueChange={(v) =>
                                setParamToggles((s) => ({
                                  ...s,
                                  [opt.label]: v,
                                }))
                              }
                              trackColor={{ false: "#d5cfc2", true: "#2f5d3a" }}
                              thumbColor="#f7f4ee"
                            />
                          </View>
                        );
                      })}
                    </View>
                  ) : (
                    <View style={styles.rowWrap}>
                      {section.options.map((opt) => {
                        const on = paramChoices[section.title] === opt.label;
                        return (
                          <Pressable
                            key={opt.id}
                            style={[styles.effortChip, on && styles.modalItemOn]}
                            onPress={() =>
                              setParamChoices((s) => ({
                                ...s,
                                [section.title]: opt.label,
                              }))
                            }
                          >
                            <Text style={styles.modalItemText}>{opt.label}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  )}
                </View>
              ),
            )}
            {!paramsLoading &&
            selectedModel &&
            !/^auto$/i.test(selectedModel.label) &&
            !(modelParams?.sections || []).length ? (
              <Text style={[styles.meta, { marginTop: 8 }]}>
                No extra options for this model in Cursor UI.
              </Text>
            ) : null}

            <Text style={[styles.modalTitle, { marginTop: 14 }]}>
              All models
            </Text>
            <ScrollView style={{ maxHeight: 180 }}>
              {models.map((m) => (
                <Pressable
                  key={m.id}
                  style={[
                    styles.modalItem,
                    selectedModel?.id === m.id && styles.modalItemOn,
                  ]}
                  onPress={async () => {
                    setSelectedModel(m);
                    await loadParamsForModel(m.label);
                  }}
                >
                  <Text style={styles.modalItemText}>{m.label}</Text>
                </Pressable>
              ))}
            </ScrollView>

            <Pressable
              style={{ paddingVertical: 10, alignItems: "center" }}
              onPress={() => loadModelsFromCdp()}
            >
              <Text style={{ color: "#2f5d3a", fontWeight: "600" }}>
                Rescrape menu
              </Text>
            </Pressable>
            <Pressable
              style={[styles.send, { marginTop: 8 }]}
              onPress={async () => {
                setModelOpen(false);
                await applyModelToCursor();
              }}
              disabled={!selectedModel}
            >
              <Text style={styles.sendText}>Apply in Cursor</Text>
            </Pressable>
            <Pressable
              style={{ paddingVertical: 12, alignItems: "center" }}
              onPress={() => setModelOpen(false)}
            >
              <Text style={{ color: "#6f685c", fontWeight: "600" }}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
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
  container: { padding: 16, gap: 10, paddingBottom: 24 },
  title: { fontSize: 22, fontWeight: "700", color: "#1c1915" },
  meta: { color: "#6f685c", marginBottom: 6 },
  bubble: {
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: "#e5dfd2",
  },
  user: { backgroundColor: "#ebe4d6" },
  assistant: { backgroundColor: "#fffdf8" },
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
  agentStatus: {
    color: "#6b5b3e",
    fontSize: 13,
    fontStyle: "italic",
    marginBottom: 8,
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
  send: {
    backgroundColor: "#1c1915",
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  sendText: { color: "#f7f4ee", fontWeight: "700" },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  rowWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    backgroundColor: "#1c1915",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
  },
  chipText: { color: "#f7f4ee", fontWeight: "600", fontSize: 13 },
  modelBtn: {
    flex: 1,
    backgroundColor: "#fffdf8",
    borderWidth: 1,
    borderColor: "#e5dfd2",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  modelBtnText: { color: "#1c1915", fontWeight: "600" },
  iconBtn: {
    backgroundColor: "#ebe4d6",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  iconBtnText: { color: "#1c1915", fontWeight: "600", fontSize: 13 },
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
  confirm: {
    backgroundColor: "#f5e6d2",
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  confirmText: { color: "#1c1915" },
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
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: "#f7f4ee",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 16,
  },
  modalTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#7a7368",
    textTransform: "uppercase",
    marginBottom: 8,
  },
  modalItem: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    marginBottom: 4,
  },
  modalItemOn: { backgroundColor: "#ebe4d6" },
  modalItemText: { color: "#1c1915", fontWeight: "600" },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "#7a7368",
    textTransform: "uppercase",
    marginBottom: 6,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#fffdf8",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "#e5dfd2",
  },
  hostSync: { color: "#6f685c", fontSize: 12, marginBottom: 8 },
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
  effortChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "#fffdf8",
    borderWidth: 1,
    borderColor: "#e5dfd2",
  },
});
