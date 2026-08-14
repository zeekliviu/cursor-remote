import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Link, useLocalSearchParams, useNavigation } from "expo-router";
import type { ChatSummary, Project } from "@cursor-remote/shared";
import { useConnection } from "../../lib/connection";

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client } = useConnection();
  const navigation = useNavigation();
  const [project, setProject] = useState<Project | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  useLayoutEffect(() => {
    navigation.setOptions({
      title: project?.name || "Project",
      headerRight: () =>
        id ? (
          <View style={styles.headerActions}>
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
  }, [navigation, project?.name, id]);

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
        Diff and Terminal (header) run in this project folder.
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Text style={styles.section}>IDE chats</Text>
      {loading && chats.length === 0 ? <ActivityIndicator /> : null}
      {chats.map((c) => (
        <Link key={c.id} href={`/chats/${c.id}?projectId=${id}`} asChild>
          <Pressable style={styles.card}>
            <Text style={styles.cardTitle}>{c.name}</Text>
            <Text style={styles.cardMeta}>
              {c.mode || "agent"}
              {c.lastUpdatedAt
                ? ` · ${new Date(c.lastUpdatedAt).toLocaleString()}`
                : ""}
            </Text>
          </Pressable>
        </Link>
      ))}
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
  hint: { color: "#8a8378", fontSize: 12, marginBottom: 4 },
  headerActions: { flexDirection: "row", gap: 14, marginRight: 4 },
  headerBtn: { paddingVertical: 4 },
  headerBtnText: { color: "#1c1915", fontWeight: "600", fontSize: 15 },
  section: {
    marginTop: 10,
    fontSize: 12,
    fontWeight: "700",
    color: "#7a7368",
    textTransform: "uppercase",
  },
  card: {
    backgroundColor: "#fffdf8",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#e5dfd2",
  },
  cardTitle: { fontSize: 16, fontWeight: "600", color: "#1c1915" },
  cardMeta: { marginTop: 4, color: "#6f685c", fontSize: 12 },
  empty: { color: "#6f685c" },
  error: { color: "#9b2c1a" },
});
