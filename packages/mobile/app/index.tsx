import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Link, router } from "expo-router";
import type { ComposerHealth, Project } from "@cursor-remote/shared";
import { useConnection } from "../lib/connection";
import { useComposerWatch } from "../lib/composer-watch";
import { PulseDot } from "../lib/pulse-dot";
import type { HostProfile } from "../lib/api";

export default function HomeScreen() {
  const {
    client,
    connection,
    hosts,
    ready,
    switchHost,
    renameHost,
    removeHost,
    disconnect,
  } = useConnection();
  const { hostRunning, hostStatus, pendingApprovals } = useComposerWatch();
  const [projects, setProjects] = useState<Project[]>([]);
  const [health, setHealth] = useState<ComposerHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const refresh = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const [{ projects: list }, h] = await Promise.all([
        client.projects(),
        client.composerHealth().catch(() => null),
      ]);
      setProjects(list);
      setHealth(h);
    } catch (err) {
      setError((err as Error).message);
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (client) refresh();
    else {
      setProjects([]);
      setHealth(null);
    }
  }, [client, refresh]);

  function confirmRemove(h: HostProfile) {
    Alert.alert(
      "Remove host?",
      `Forget ${h.label} (${h.host}:${h.port})? Other saved hosts stay.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => removeHost(h.id),
        },
      ],
    );
  }

  if (!ready) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!hosts.length || !connection || !client) {
    return (
      <View style={styles.container}>
        <Text style={styles.brand}>Cursor Remote</Text>
        <Text style={styles.sub}>
          Pair with a daemon on Mac or Windows (same Wi‑Fi / VPN / Tailscale).
          You can save several hosts and switch between them.
        </Text>
        <Pressable style={styles.primary} onPress={() => router.push("/pair")}>
          <Text style={styles.primaryText}>Add host</Text>
        </Pressable>
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
      <Text style={styles.section}>Hosts</Text>
      {hosts
        .slice()
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((h) => {
          const active = h.id === connection.id;
          return (
            <View
              key={h.id}
              style={[styles.hostCard, active && styles.hostCardActive]}
            >
              {renamingId === h.id ? (
                <View style={styles.renameRow}>
                  <TextInput
                    style={styles.renameInput}
                    value={renameDraft}
                    onChangeText={setRenameDraft}
                    autoFocus
                    placeholder="MacBook, PC birou…"
                  />
                  <Pressable
                    onPress={async () => {
                      await renameHost(h.id, renameDraft);
                      setRenamingId(null);
                    }}
                  >
                    <Text style={styles.linkAction}>Save</Text>
                  </Pressable>
                  <Pressable onPress={() => setRenamingId(null)}>
                    <Text style={styles.mutedAction}>Cancel</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  onPress={() => {
                    if (!active) switchHost(h.id);
                  }}
                  onLongPress={() => {
                    setRenamingId(h.id);
                    setRenameDraft(h.label);
                  }}
                >
                  <Text style={styles.hostLabel}>
                    {h.label}
                    {active ? " · active" : ""}
                  </Text>
                  <Text style={styles.hostMeta}>
                    {h.host}:{h.port}
                  </Text>
                </Pressable>
              )}
              <View style={styles.hostActions}>
                {!active ? (
                  <Pressable onPress={() => switchHost(h.id)}>
                    <Text style={styles.linkAction}>Switch</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={() => {
                    setRenamingId(h.id);
                    setRenameDraft(h.label);
                  }}
                >
                  <Text style={styles.mutedAction}>Rename</Text>
                </Pressable>
                <Pressable onPress={() => confirmRemove(h)}>
                  <Text style={styles.dangerAction}>Remove</Text>
                </Pressable>
              </View>
            </View>
          );
        })}

      <Pressable style={styles.addHost} onPress={() => router.push("/pair")}>
        <Text style={styles.addHostText}>+ Add another host</Text>
      </Pressable>

      <Text style={styles.meta}>
        Active · {connection.label} · {connection.host}:{connection.port}
      </Text>
      {health ? (
        <View
          style={[
            styles.banner,
            health.cdpReachable && health.selectorsOk
              ? styles.bannerOk
              : styles.bannerWarn,
          ]}
        >
          <Text style={styles.bannerText}>
            CDP {health.cdpReachable ? "up" : "down"} · selectors{" "}
            {health.selectorsOk ? "ok" : "need tune"} · windows{" "}
            {health.windowCount}
          </Text>
          {health.issues[0] ? (
            <Text style={styles.bannerIssue}>{health.issues[0]}</Text>
          ) : null}
          {!health.cdpReachable && health.fixHint ? (
            <Text style={styles.bannerIssue}>{health.fixHint}</Text>
          ) : null}
        </View>
      ) : null}
      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.error}>{error}</Text>
          {error.toLowerCase().includes("unauthorized") ? (
            <Text style={styles.errorHint}>
              Token mismatch for this host. Remove it and pair again from
              http://{connection.host}:7843.
            </Text>
          ) : null}
        </View>
      ) : null}
      {hostRunning || pendingApprovals > 0 ? (
        <View style={styles.hostBusy}>
          <PulseDot />
          <Text style={styles.hostBusyText} numberOfLines={1}>
            {pendingApprovals > 0
              ? `${pendingApprovals} waiting for approval`
              : `Agent running${hostStatus ? ` · ${hostStatus}` : ""}`}
          </Text>
        </View>
      ) : null}
      <Text style={styles.section}>Projects</Text>
      {projects.map((p) => (
        <Link key={p.id} href={`/projects/${p.id}`} asChild>
          <Pressable
            style={({ pressed }) => [styles.card, pressed && styles.pressedSoft]}
          >
            <Text style={styles.cardTitle}>{p.name}</Text>
            <Text style={styles.cardPath} numberOfLines={2}>
              {p.path}
            </Text>
          </Pressable>
        </Link>
      ))}
      {!loading && projects.length === 0 && !error ? (
        <Text style={styles.empty}>No projects on this host.</Text>
      ) : null}
      <Pressable
        style={styles.secondary}
        onPress={() => {
          Alert.alert(
            "Remove all hosts?",
            "Clears every saved Mac/Windows pairing on this phone.",
            [
              { text: "Cancel", style: "cancel" },
              {
                text: "Clear all",
                style: "destructive",
                onPress: async () => {
                  await disconnect();
                  router.replace("/");
                },
              },
            ],
          );
        }}
      >
        <Text style={styles.secondaryText}>Clear all hosts</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  container: { padding: 20, gap: 12, paddingBottom: 40 },
  brand: {
    fontSize: 34,
    fontWeight: "700",
    color: "#1c1915",
    fontFamily: "Georgia",
  },
  sub: { color: "#5c564c", fontSize: 16, lineHeight: 22, marginBottom: 8 },
  meta: { color: "#7a7368", fontSize: 13 },
  section: {
    marginTop: 8,
    fontSize: 13,
    fontWeight: "700",
    color: "#7a7368",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  hostCard: {
    backgroundColor: "#fffdf8",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#e5dfd2",
    gap: 8,
  },
  hostCardActive: {
    borderColor: "#1c1915",
    backgroundColor: "#f3eee3",
  },
  hostLabel: { fontSize: 17, fontWeight: "600", color: "#1c1915" },
  hostMeta: { marginTop: 2, color: "#6f685c", fontSize: 13 },
  hostActions: { flexDirection: "row", gap: 16, marginTop: 4 },
  linkAction: { color: "#1c1915", fontWeight: "700", fontSize: 13 },
  mutedAction: { color: "#7a7368", fontWeight: "600", fontSize: 13 },
  dangerAction: { color: "#8a4030", fontWeight: "600", fontSize: 13 },
  renameRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  renameInput: {
    flex: 1,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e5dfd2",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
  },
  addHost: {
    borderWidth: 1,
    borderColor: "#d4cdc0",
    borderStyle: "dashed",
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  addHostText: { color: "#1c1915", fontWeight: "600" },
  card: {
    backgroundColor: "#fffdf8",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#e5dfd2",
  },
  cardTitle: { fontSize: 17, fontWeight: "600", color: "#1c1915" },
  cardPath: { marginTop: 4, color: "#6f685c", fontSize: 13 },
  pressedSoft: { opacity: 0.7 },
  hostBusy: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#f5e6d2",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  hostBusyText: { flex: 1, color: "#8a5a20", fontSize: 12, fontWeight: "600" },
  empty: { color: "#6f685c" },
  primary: {
    backgroundColor: "#1c1915",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  primaryText: { color: "#f7f4ee", fontWeight: "600", fontSize: 16 },
  secondary: {
    marginTop: 16,
    paddingVertical: 12,
    alignItems: "center",
  },
  secondaryText: { color: "#8a4030", fontWeight: "600" },
  banner: { borderRadius: 12, padding: 12 },
  bannerOk: { backgroundColor: "#e5f0e2" },
  bannerWarn: { backgroundColor: "#f5e6d2" },
  bannerText: { color: "#1c1915", fontWeight: "600" },
  bannerIssue: { marginTop: 4, color: "#5c564c", fontSize: 12 },
  error: { color: "#9b2c1a", fontWeight: "600" },
  errorBox: { gap: 4 },
  errorHint: { color: "#5c564c", fontSize: 13, lineHeight: 18 },
});
