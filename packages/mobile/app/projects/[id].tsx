import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Link, router, useLocalSearchParams, useNavigation } from "expo-router";
import type { ChatSummary, Project } from "@cursor-remote/shared";
import { useConnection } from "../../lib/connection";
import { useComposerWatch } from "../../lib/composer-watch";
import { PulseDot } from "../../lib/pulse-dot";

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client } = useConnection();
  const {
    hostRunning,
    hostStatus,
    pendingApprovals,
    lastCompletedAt,
  } = useComposerWatch();
  const navigation = useNavigation();
  const [project, setProject] = useState<Project | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [completionClock, setCompletionClock] = useState(Date.now());

  useEffect(() => {
    if (!lastCompletedAt) return;
    const remaining = 15 * 60 * 1000 - (Date.now() - lastCompletedAt);
    if (remaining <= 0) {
      setCompletionClock(Date.now());
      return;
    }
    const timer = setTimeout(() => setCompletionClock(Date.now()), remaining + 50);
    return () => clearTimeout(timer);
  }, [lastCompletedAt]);
  const readyForReview = Boolean(
    lastCompletedAt &&
      completionClock - lastCompletedAt < 15 * 60 * 1000,
  );

  const refresh = useCallback(async () => {
    if (!client || !id) return;
    setLoading(true);
    setError(null);
    try {
      const [{ projects }, { chats: list }] = await Promise.all([
        client.projects(),
        client.chats(id),
      ]);
      setProject(projects.find((p) => p.id === id) || null);
      setChats(list);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [client, id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openInCursor = useCallback(async () => {
    if (!client || !id) return;
    setOpening(true);
    try {
      const r = await client.openProject(id);
      Alert.alert(
        "Open in Cursor",
        r.message ||
          (r.ok
            ? "Focused this project on the host."
            : "Could not focus the project window."),
      );
    } catch (err) {
      Alert.alert("Open in Cursor", (err as Error).message);
    } finally {
      setOpening(false);
    }
  }, [client, id]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: project?.name || "Project",
      headerRight: () =>
        id ? (
          <View style={styles.headerActions}>
            <Pressable
              hitSlop={8}
              style={styles.headerBtn}
              disabled={opening}
              onPress={openInCursor}
              accessibilityLabel="Focus this project on the host"
            >
              <Text
                style={[
                  styles.headerBtnTextMuted,
                  opening && styles.headerBtnBusy,
                ]}
              >
                {opening ? "Opening…" : "Open"}
              </Text>
            </Pressable>
            <Link href={`/diff/${id}`} asChild>
              <Pressable hitSlop={8} style={styles.headerBtn}>
                <Text style={styles.headerBtnText}>Diff</Text>
              </Pressable>
            </Link>
            <Link href={`/terminal/${id}`} asChild>
              <Pressable hitSlop={8} style={styles.headerBtn}>
                <Text style={styles.headerBtnText}>Term</Text>
              </Pressable>
            </Link>
          </View>
        ) : null,
    });
  }, [navigation, project?.name, id, opening, openInCursor]);

  const messageable = useMemo(
    () => chats.filter((c) => c.messageable !== false),
    [chats],
  );
  const viewOnly = useMemo(
    () => chats.filter((c) => c.messageable === false),
    [chats],
  );

  async function startNewChat() {
    if (!client || !id) return;
    setBusy(true);
    try {
      const before = new Set((await client.chats(id)).chats.map((c) => c.id));
      const r = await client.newChat(id);
      if (!r.ok) {
        Alert.alert(
          "New chat",
          "Could not create a chat in Cursor UI. Open Composer on the host, then retry.",
        );
        return;
      }
      let created: ChatSummary | undefined;
      for (let i = 0; i < 8; i++) {
        await new Promise((res) => setTimeout(res, 500));
        const { chats: list } = await client.chats(id);
        setChats(list);
        created = list.find((c) => !before.has(c.id));
        if (!created && list.length) {
          const sorted = [...list].sort(
            (a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0),
          );
          if (sorted[0] && !before.has(sorted[0].id)) created = sorted[0];
        }
        if (created) break;
      }
      if (created) {
        router.push(`/chats/${created.id}?projectId=${id}`);
      } else {
        Alert.alert(
          "New chat started",
          "Created in Cursor. Pull to refresh if it does not appear yet.",
        );
        await refresh();
      }
    } catch (err) {
      Alert.alert("New chat", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function renderChat(c: ChatSummary) {
    const canMessage = c.messageable !== false;
    return (
      <Link key={c.id} href={`/chats/${c.id}?projectId=${id}`} asChild>
        <Pressable
          style={({ pressed }) => [
            styles.card,
            !canMessage && styles.cardReadonly,
            pressed && styles.pressedSoft,
          ]}
        >
          <View style={styles.cardTop}>
            <Text
              style={[styles.cardTitle, !canMessage && styles.cardTitleMuted]}
              numberOfLines={2}
            >
              {c.name}
            </Text>
            <View
              style={[
                styles.badge,
                canMessage ? styles.badgeLive : styles.badgeReadonly,
              ]}
            >
              <Text
                style={[
                  styles.badgeText,
                  canMessage ? styles.badgeTextLive : styles.badgeTextReadonly,
                ]}
              >
                {c.isSubagent
                  ? "Subagent"
                  : canMessage
                    ? "Can message"
                    : "View only"}
              </Text>
            </View>
          </View>
          <Text style={styles.cardMeta}>
            {c.mode || "agent"}
            {c.subagentIds?.length
              ? ` · ${c.subagentIds.length} ${c.subagentIds.length === 1 ? "subagent" : "subagents"}`
              : ""}
            {!canMessage ? " · explore transcript" : ""}
            {c.lastUpdatedAt
              ? ` · ${new Date(c.lastUpdatedAt).toLocaleString()}`
              : ""}
          </Text>
        </Pressable>
      </Link>
    );
  }

  if (!client) {
    return (
      <View style={styles.center}>
        <Text>Not paired</Text>
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={refresh} />
      }
    >
      <Text style={styles.path}>{project?.path}</Text>
      <Text style={styles.hint}>
        Only parent agent chats accept messages. Explore / subagent transcripts
        are view-only (no Composer input in Cursor).
      </Text>

      {hostRunning ||
      pendingApprovals > 0 ||
      readyForReview ? (
        <View style={styles.runningRow}>
          {hostRunning || pendingApprovals > 0 ? <PulseDot /> : null}
          <Text style={styles.runningText} numberOfLines={1}>
            {pendingApprovals > 0
              ? `Needs approval · ${pendingApprovals} pending`
              : hostRunning
                ? `Working${hostStatus ? ` · ${hostStatus}` : ""}`
                : "Ready for review"}
          </Text>
        </View>
      ) : null}

      <Pressable
        style={({ pressed }) => [
          styles.actionBtnPrimary,
          busy && styles.actionBusy,
          pressed && styles.pressedSoft,
        ]}
        disabled={busy}
        onPress={startNewChat}
      >
        <Text style={styles.actionBtnPrimaryText}>
          {busy ? "Creating…" : "New chat"}
        </Text>
      </Pressable>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading && chats.length === 0 ? <ActivityIndicator /> : null}

      {messageable.length > 0 ? (
        <>
          <View style={styles.sectionRow}>
            <Text style={[styles.section, styles.sectionInRow]}>
              Can message
            </Text>
            {hostRunning || pendingApprovals > 0 ? <PulseDot /> : null}
          </View>
          {messageable.map(renderChat)}
        </>
      ) : null}

      {viewOnly.length > 0 ? (
        <>
          <Text style={styles.section}>View only</Text>
          {viewOnly.map(renderChat)}
        </>
      ) : null}

      {chats.length === 0 && !loading ? (
        <Text style={styles.empty}>No chats found for this project.</Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  container: { padding: 20, gap: 10, paddingBottom: 40 },
  path: { color: "#6f685c", fontSize: 13, lineHeight: 18 },
  hint: { color: "#8a8378", fontSize: 12, marginBottom: 4, lineHeight: 17 },
  actionBtnPrimary: {
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
    backgroundColor: "#1c1915",
    marginVertical: 4,
  },
  actionBusy: { opacity: 0.55 },
  actionBtnPrimaryText: { color: "#f7f4ee", fontWeight: "600", fontSize: 14 },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginRight: 4,
  },
  headerBtn: { paddingVertical: 4 },
  headerBtnText: { color: "#1c1915", fontWeight: "600", fontSize: 15 },
  headerBtnTextMuted: { color: "#6f685c", fontWeight: "600", fontSize: 15 },
  headerBtnBusy: { color: "#a39e93" },
  pressedSoft: { opacity: 0.7 },
  runningRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#f5e6d2",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  runningText: { flex: 1, color: "#8a5a20", fontSize: 12, fontWeight: "600" },
  sectionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
  },
  section: {
    marginTop: 10,
    fontSize: 12,
    fontWeight: "700",
    color: "#7a7368",
    textTransform: "uppercase",
  },
  sectionInRow: { marginTop: 0 },
  card: {
    backgroundColor: "#fffdf8",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#e5dfd2",
  },
  cardReadonly: {
    backgroundColor: "#f3f0e8",
    borderColor: "#e0dbd0",
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  cardTitle: { flex: 1, fontSize: 16, fontWeight: "600", color: "#1c1915" },
  cardTitleMuted: { color: "#6f685c", fontWeight: "500" },
  cardMeta: { marginTop: 6, color: "#6f685c", fontSize: 12 },
  badge: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  badgeLive: { backgroundColor: "#e5f0e2" },
  badgeReadonly: { backgroundColor: "#ebe4d6" },
  badgeText: { fontSize: 11, fontWeight: "700" },
  badgeTextLive: { color: "#2f5d3a" },
  badgeTextReadonly: { color: "#7a7368" },
  empty: { color: "#6f685c" },
  error: { color: "#9b2c1a" },
});
