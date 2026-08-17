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
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ChatChangedFile, ChatDetail } from "@cursor-remote/shared";
import { useConnection } from "../../../lib/connection";
import { renderDiffLines } from "../../../lib/format-tool";

type BooleanByPath = Record<string, boolean>;
type PatchByPath = Record<string, ChatChangedFile>;
type ErrorByPath = Record<string, string>;

function fileStats(file: ChatChangedFile): string | null {
  if (file.additions == null && file.deletions == null) return null;
  return `+${file.additions ?? 0}  −${file.deletions ?? 0}`;
}

export default function ChatChangesScreen() {
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  const chatId = Array.isArray(id) ? id[0] : id;
  const { client } = useConnection();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  const [chat, setChat] = useState<ChatDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<BooleanByPath>({});
  const [patches, setPatches] = useState<PatchByPath>({});
  const [patchLoading, setPatchLoading] = useState<BooleanByPath>({});
  const [patchErrors, setPatchErrors] = useState<ErrorByPath>({});

  const loadSequenceRef = useRef(0);
  const patchGenerationRef = useRef(0);
  const patchSequenceRef = useRef(0);
  const patchRequestsRef = useRef<Record<string, number>>({});

  const loadChat = useCallback(async () => {
    if (!client || !chatId) return;
    const sequence = ++loadSequenceRef.current;
    setLoading(true);
    setError(null);
    try {
      const detail = await client.chat(chatId);
      if (loadSequenceRef.current !== sequence) return;
      patchGenerationRef.current += 1;
      patchRequestsRef.current = {};
      setChat(detail);
      setExpanded({});
      setPatches({});
      setPatchLoading({});
      setPatchErrors({});
    } catch (loadError) {
      if (loadSequenceRef.current !== sequence) return;
      setError((loadError as Error).message || "Could not load changes.");
    } finally {
      if (loadSequenceRef.current === sequence) setLoading(false);
    }
  }, [chatId, client]);

  useEffect(() => {
    if (!client || !chatId) return;
    void loadChat();
    return () => {
      loadSequenceRef.current += 1;
      patchGenerationRef.current += 1;
      patchRequestsRef.current = {};
    };
  }, [chatId, client, loadChat]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: chat?.name ? `Changes · ${chat.name}` : "Changes",
      headerBackTitle: "Chat",
    });
  }, [chat?.name, navigation]);

  const files = chat?.filesChanged ?? [];
  const totals = useMemo(
    () =>
      files.reduce(
        (sum, file) => ({
          additions: sum.additions + (file.additions ?? 0),
          deletions: sum.deletions + (file.deletions ?? 0),
          hasStats:
            sum.hasStats ||
            file.additions != null ||
            file.deletions != null,
        }),
        { additions: 0, deletions: 0, hasStats: false },
      ),
    [files],
  );

  const loadPatch = useCallback(
    async (file: ChatChangedFile, retry = false) => {
      if (!client || !chatId) return;
      const path = file.path;

      if (expanded[path] && !retry) {
        setExpanded((current) => ({ ...current, [path]: false }));
        return;
      }

      setExpanded((current) => ({ ...current, [path]: true }));
      if (patches[path] || patchRequestsRef.current[path]) return;

      const generation = patchGenerationRef.current;
      const sequence = ++patchSequenceRef.current;
      patchRequestsRef.current[path] = sequence;
      setPatchLoading((current) => ({ ...current, [path]: true }));
      setPatchErrors((current) => {
        if (!current[path]) return current;
        const next = { ...current };
        delete next[path];
        return next;
      });

      try {
        const patch = await client.changedFile(chatId, path);
        if (
          patchGenerationRef.current !== generation ||
          patchRequestsRef.current[path] !== sequence
        ) {
          return;
        }
        setPatches((current) => ({ ...current, [path]: patch }));
      } catch (patchError) {
        if (
          patchGenerationRef.current !== generation ||
          patchRequestsRef.current[path] !== sequence
        ) {
          return;
        }
        setPatchErrors((current) => ({
          ...current,
          [path]:
            (patchError as Error).message || "Could not load this patch.",
        }));
      } finally {
        if (
          patchGenerationRef.current === generation &&
          patchRequestsRef.current[path] === sequence
        ) {
          delete patchRequestsRef.current[path];
          setPatchLoading((current) => ({ ...current, [path]: false }));
        }
      }
    },
    [chatId, client, expanded, patches],
  );

  if (!client) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>Not paired</Text>
        <Text style={styles.emptyBody}>
          Connect to a host to review chat changes.
        </Text>
      </View>
    );
  }

  if (!chat && loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#6f685c" />
        <Text style={styles.loadingText}>Loading latest changes…</Text>
      </View>
    );
  }

  if (!chat) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>Changes unavailable</Text>
        <Text style={styles.emptyBody}>
          {error || (chatId ? "Could not load this chat." : "Missing chat id.")}
        </Text>
        {chatId ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading chat changes"
            onPress={() => void loadChat()}
            style={({ pressed }) => [
              styles.retryButton,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.retryButtonText}>Try again</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.container,
        { paddingBottom: Math.max(insets.bottom, 12) + 28 },
      ]}
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={() => void loadChat()} />
      }
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.summaryCard}>
        <Text style={styles.eyebrow}>Latest assistant turn</Text>
        <Text style={styles.summaryTitle}>
          {chat.filesChangedCount ?? files.length}{" "}
          {(chat.filesChangedCount ?? files.length) === 1 ? "file" : "files"}{" "}
          changed
        </Text>
        {totals.hasStats ? (
          <Text style={styles.summaryStats}>
            <Text style={styles.additions}>+{totals.additions}</Text>
            {"  "}
            <Text style={styles.deletions}>−{totals.deletions}</Text>
          </Text>
        ) : null}
        <Text style={styles.summaryHint}>
          Patches load only when you open a file.
        </Text>
      </View>

      {error ? (
        <View style={styles.inlineError}>
          <Text style={styles.inlineErrorText}>{error}</Text>
        </View>
      ) : null}

      {files.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No files changed</Text>
          <Text style={styles.emptyBody}>
            The latest assistant turn does not include file edits.
          </Text>
        </View>
      ) : (
        files.map((file) => {
          const isOpen = Boolean(expanded[file.path]);
          const loadedPatch = patches[file.path];
          const lines = renderDiffLines(loadedPatch?.patch);
          const stats = fileStats(loadedPatch || file);
          const isLoadingPatch = Boolean(patchLoading[file.path]);
          const patchError = patchErrors[file.path];
          const status = file.isNew ? "A" : "M";

          return (
            <View key={file.path} style={styles.fileCard}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${isOpen ? "Collapse" : "Review"} ${
                  file.isNew ? "added" : "modified"
                } file ${file.path}`}
                accessibilityState={{
                  expanded: isOpen,
                  busy: isLoadingPatch,
                }}
                onPress={() => void loadPatch(file)}
                style={({ pressed }) => [
                  styles.fileHeader,
                  pressed && styles.pressed,
                ]}
              >
                <View
                  style={[
                    styles.statusBadge,
                    file.isNew && styles.statusBadgeAdded,
                  ]}
                >
                  <Text
                    style={[
                      styles.statusBadgeText,
                      file.isNew && styles.statusBadgeTextAdded,
                    ]}
                  >
                    {status}
                  </Text>
                </View>
                <View style={styles.fileIdentity}>
                  <Text style={styles.filePath} numberOfLines={3}>
                    {file.path.replace(/\\/g, "/")}
                  </Text>
                  {stats ? (
                    <Text style={styles.fileStats}>
                      <Text style={styles.additions}>
                        +{(loadedPatch || file).additions ?? 0}
                      </Text>
                      {"  "}
                      <Text style={styles.deletions}>
                        −{(loadedPatch || file).deletions ?? 0}
                      </Text>
                    </Text>
                  ) : null}
                </View>
                {isLoadingPatch ? (
                  <ActivityIndicator size="small" color="#6f685c" />
                ) : (
                  <Text style={styles.chevron}>{isOpen ? "⌃" : "⌄"}</Text>
                )}
              </Pressable>

              {isOpen ? (
                <View style={styles.patchRegion}>
                  {isLoadingPatch ? (
                    <View style={styles.patchMessage}>
                      <ActivityIndicator size="small" color="#8a8378" />
                      <Text style={styles.patchMessageText}>Loading patch…</Text>
                    </View>
                  ) : patchError ? (
                    <View style={styles.patchError}>
                      <Text style={styles.patchErrorText}>{patchError}</Text>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Retry loading patch for ${file.path}`}
                        onPress={() => void loadPatch(file, true)}
                        style={({ pressed }) => [
                          styles.patchRetry,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text style={styles.patchRetryText}>Retry</Text>
                      </Pressable>
                    </View>
                  ) : loadedPatch && lines.length === 0 ? (
                    <Text style={styles.noPatch}>
                      No textual patch is available for this file.
                    </Text>
                  ) : loadedPatch ? (
                    <View style={styles.diffBox}>
                      <ScrollView
                        horizontal
                        bounces={false}
                        showsHorizontalScrollIndicator
                        contentContainerStyle={styles.diffContent}
                      >
                        <View>
                          {lines.map((line, index) => (
                            <Text
                              key={`${file.path}-${index}`}
                              selectable
                              style={[
                                styles.diffLine,
                                line.kind === "add" && styles.diffLineAdd,
                                line.kind === "del" && styles.diffLineDel,
                                line.kind === "meta" && styles.diffLineMeta,
                              ]}
                            >
                              {line.t || " "}
                            </Text>
                          ))}
                        </View>
                      </ScrollView>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f4ee" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
    gap: 10,
    backgroundColor: "#f7f4ee",
  },
  container: { padding: 16, gap: 12 },
  loadingText: { color: "#6f685c", fontSize: 13 },
  summaryCard: {
    backgroundColor: "#fffdf8",
    borderWidth: 1,
    borderColor: "#e5dfd2",
    borderRadius: 16,
    padding: 16,
    gap: 5,
  },
  eyebrow: {
    color: "#7a7368",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  summaryTitle: { color: "#1c1915", fontSize: 20, fontWeight: "700" },
  summaryStats: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 13,
    marginTop: 2,
  },
  summaryHint: { color: "#7a7368", fontSize: 12, marginTop: 3 },
  additions: { color: "#2f5d3a", fontWeight: "700" },
  deletions: { color: "#9b2c1a", fontWeight: "700" },
  inlineError: {
    backgroundColor: "#f5e6d2",
    borderWidth: 1,
    borderColor: "#e0c9a0",
    borderRadius: 12,
    padding: 12,
  },
  inlineErrorText: { color: "#8a4030", fontSize: 13 },
  emptyCard: {
    alignItems: "center",
    backgroundColor: "#fffdf8",
    borderWidth: 1,
    borderColor: "#e5dfd2",
    borderRadius: 16,
    padding: 24,
    gap: 6,
  },
  emptyTitle: { color: "#1c1915", fontSize: 17, fontWeight: "700" },
  emptyBody: {
    color: "#6f685c",
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
  retryButton: {
    marginTop: 6,
    borderRadius: 10,
    backgroundColor: "#1c1915",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  retryButtonText: { color: "#f7f4ee", fontSize: 13, fontWeight: "700" },
  fileCard: {
    backgroundColor: "#fffdf8",
    borderWidth: 1,
    borderColor: "#e5dfd2",
    borderRadius: 14,
    overflow: "hidden",
  },
  fileHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingHorizontal: 12,
    paddingVertical: 13,
  },
  statusBadge: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f4e4df",
  },
  statusBadgeAdded: { backgroundColor: "#e8efe6" },
  statusBadgeText: {
    color: "#9b2c1a",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 12,
    fontWeight: "700",
  },
  statusBadgeTextAdded: { color: "#2f5d3a" },
  fileIdentity: { flex: 1, minWidth: 0, gap: 4 },
  filePath: {
    color: "#1c1915",
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
  },
  fileStats: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 11,
  },
  chevron: { color: "#6f685c", fontSize: 20, width: 20, textAlign: "center" },
  patchRegion: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e5dfd2",
  },
  patchMessage: {
    minHeight: 70,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 16,
  },
  patchMessageText: { color: "#7a7368", fontSize: 12 },
  patchError: { padding: 14, gap: 10, alignItems: "flex-start" },
  patchErrorText: { color: "#9b2c1a", fontSize: 13, lineHeight: 18 },
  patchRetry: {
    backgroundColor: "#ebe4d6",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  patchRetryText: { color: "#1c1915", fontSize: 12, fontWeight: "700" },
  noPatch: {
    color: "#6f685c",
    fontSize: 13,
    fontStyle: "italic",
    padding: 14,
  },
  diffBox: { backgroundColor: "#1c1915" },
  diffContent: { padding: 10 },
  diffLine: {
    color: "#d7d0c4",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 11,
    lineHeight: 16,
  },
  diffLineAdd: { color: "#8fdb9a" },
  diffLineDel: { color: "#f0a8a0" },
  diffLineMeta: { color: "#8a8378" },
  pressed: { opacity: 0.68 },
});
