import { memo, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

function formatDuration(ms?: number | null): string | null {
  if (!ms || ms < 1000) return null;
  const total = Math.max(1, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export type WorkSummaryRowProps = {
  active?: boolean;
  status?: string | null;
  startedAt?: number | null;
  durationMs?: number | null;
  toolCount: number;
  fileCount?: number;
  additions?: number;
  deletions?: number;
  expanded: boolean;
  onToggle: () => void;
  onOpenChanges?: () => void;
};

export const WorkSummaryRow = memo(function WorkSummaryRow({
  active,
  status,
  startedAt,
  durationMs,
  toolCount,
  fileCount = 0,
  additions = 0,
  deletions = 0,
  expanded,
  onToggle,
  onOpenChanges,
}: WorkSummaryRowProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active || !startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, startedAt]);

  const elapsed = useMemo(
    () =>
      formatDuration(
        active && startedAt ? Math.max(0, now - startedAt) : durationMs,
      ),
    [active, durationMs, now, startedAt],
  );
  const title = active
    ? status || "Working…"
    : elapsed
      ? `Worked for ${elapsed}`
      : "Completed";
  const details = [
    toolCount ? `${toolCount} ${toolCount === 1 ? "tool" : "tools"}` : null,
    fileCount ? `${fileCount} ${fileCount === 1 ? "file" : "files"}` : null,
  ].filter(Boolean);

  return (
    <View style={[styles.row, active && styles.rowActive]}>
      <Pressable
        style={styles.main}
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${title}${details.length ? `, ${details.join(", ")}` : ""}`}
        hitSlop={6}
      >
        <View style={[styles.dot, active && styles.dotActive]} />
        <View style={styles.copy}>
          <Text style={styles.title}>
            {expanded ? "⌄" : "›"} {title}
          </Text>
          {details.length ? (
            <Text style={styles.meta}>{details.join(" · ")}</Text>
          ) : null}
        </View>
      </Pressable>
      {fileCount > 0 && onOpenChanges ? (
        <Pressable
          onPress={onOpenChanges}
          style={styles.changes}
          accessibilityRole="button"
          accessibilityLabel={`Review ${fileCount} changed files`}
          hitSlop={6}
        >
          <Text style={styles.changesText}>
            +{additions} −{deletions}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 10,
    backgroundColor: "#efebe2",
    marginVertical: 5,
    paddingLeft: 10,
  },
  rowActive: { backgroundColor: "#eee7d8" },
  main: {
    minHeight: 44,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: "#8f877a",
  },
  dotActive: { backgroundColor: "#b8863b" },
  copy: { flex: 1, paddingVertical: 6 },
  title: { color: "#312d27", fontSize: 12, fontWeight: "700" },
  meta: { color: "#777064", fontSize: 11, marginTop: 2 },
  changes: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: "#d8d0c2",
  },
  changesText: { color: "#47674d", fontSize: 11, fontWeight: "700" },
});
