import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { DiffResponse, Project } from "@cursor-remote/shared";
import { useConnection } from "../../lib/connection";

export default function DiffScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client } = useConnection();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!client || !id) return;
    setLoading(true);
    setError(null);
    try {
      const [{ projects }, d] = await Promise.all([
        client.projects(),
        client.diff(id),
      ]);
      setProject(projects.find((p) => p.id === id) || null);
      setDiff(d);
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
      title: project ? `Diff · ${project.name}` : "Diff",
    });
  }, [navigation, project]);

  if (!client) {
    return (
      <View style={styles.center}>
        <Text>Not paired</Text>
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={[
        styles.container,
        { paddingBottom: Math.max(insets.bottom, 12) + 28 },
      ]}
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={refresh} />
      }
    >
      {project?.path ? (
        <Text style={styles.cwd}>repo · {project.path}</Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!diff && loading ? <ActivityIndicator /> : null}
      {diff ? (
        <>
          <Text style={styles.meta}>
            branch {diff.branch || "?"} · {diff.files.length} files
          </Text>
          {diff.files.map((f) => (
            <View key={f.path} style={styles.row}>
              <Text style={styles.status}>{f.status}</Text>
              <Text style={styles.path}>{f.path}</Text>
            </View>
          ))}
          {diff.patch ? (
            <Text style={styles.patch}>{diff.patch}</Text>
          ) : (
            <Text style={styles.meta}>No textual patch (untracked only?).</Text>
          )}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  container: { padding: 16, gap: 8 },
  cwd: { color: "#8a8378", fontSize: 12, marginBottom: 2 },
  meta: { color: "#6f685c", marginBottom: 6 },
  row: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  status: {
    width: 28,
    color: "#9b2c1a",
    fontFamily: "Menlo",
    fontSize: 12,
  },
  path: { flex: 1, color: "#1c1915", fontSize: 13 },
  patch: {
    marginTop: 8,
    fontFamily: "Menlo",
    fontSize: 11,
    color: "#2a261f",
    lineHeight: 15,
  },
  error: { color: "#9b2c1a" },
});
