import { memo, useMemo } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { ChatMessage } from "@cursor-remote/shared";
import {
  formatToolMessage,
  renderDiffLines,
} from "./format-tool";
import type { ChatDensity } from "./chat-density";
import type { ToolCategory } from "./chat-turns";

type Props = {
  clusterId: string;
  category: ToolCategory;
  messages: ChatMessage[];
  density: ChatDensity;
  initiallyExpanded?: boolean;
  onOpenTerminal?: () => void;
  onOpenSubagent?: (composerId: string) => void;
  onQuickPrompt?: (prompt: string) => void;
  isExpanded: (id: string, defaultExpanded?: boolean) => boolean;
  onToggleExpanded: (id: string, defaultExpanded?: boolean) => void;
};

const categoryTitles: Record<ToolCategory, [string, string]> = {
  Explore: ["Explored", "tools"],
  Edit: ["Edited", "files"],
  Terminal: ["Ran", "commands"],
  Web: ["Searched web", "sources"],
  MCP: ["Used MCP", "tools"],
  PlanTodos: ["Updated", "workflow"],
  Subagent: ["Delegated", "tasks"],
  Other: ["Used", "tools"],
};

function summaryFor(category: ToolCategory, messages: ChatMessage[]): string {
  const [verb, noun] = categoryTitles[category];
  const uniqueFiles = new Set<string>();
  let additions = 0;
  let deletions = 0;
  let failures = 0;
  for (const message of messages) {
    const formatted = formatToolMessage(message);
    if (formatted.detail && category === "Edit") uniqueFiles.add(formatted.detail);
    additions += formatted.additions || 0;
    deletions += formatted.deletions || 0;
    if (
      formatted.exitCode != null && formatted.exitCode !== 0 ||
      message.tool?.statusKind === "error" ||
      /error|failed/i.test(message.tool?.status || "")
    ) {
      failures += 1;
    }
  }
  const count = category === "Edit" && uniqueFiles.size
    ? uniqueFiles.size
    : messages.length;
  const countLabel = `${count} ${count === 1 ? noun.replace(/s$/, "") : noun}`;
  const stats =
    category === "Edit" && (additions || deletions)
      ? ` · +${additions} −${deletions}`
      : "";
  const failed = failures ? ` · ${failures} failed` : "";
  return `${verb} ${countLabel}${stats}${failed}`;
}

const ToolRow = memo(function ToolRow({
  message,
  onOpenTerminal,
  onOpenSubagent,
  onQuickPrompt,
  open,
  onToggle,
}: {
  message: ChatMessage;
  onOpenTerminal?: () => void;
  onOpenSubagent?: (composerId: string) => void;
  onQuickPrompt?: (prompt: string) => void;
  open: boolean;
  onToggle: () => void;
}) {
  const formatted = useMemo(() => formatToolMessage(message), [message]);
  const subagentId =
    formatted.subagentComposerId || message.tool?.subagentComposerId;
  const hasDetails = Boolean(
    formatted.detail ||
      formatted.result ||
      formatted.diffPatch ||
      formatted.output ||
      subagentId,
  );
  const failed =
    (formatted.exitCode != null && formatted.exitCode !== 0) ||
    message.tool?.statusKind === "error" ||
    /error|failed/i.test(message.tool?.status || "");

  return (
    <View style={[styles.toolRow, failed && styles.toolRowFailed]}>
      <Pressable
        onPress={() => {
          if (subagentId && onOpenSubagent) {
            onOpenSubagent(subagentId);
            return;
          }
          if (hasDetails) onToggle();
        }}
        style={styles.toolMain}
        accessibilityRole={hasDetails || subagentId ? "button" : undefined}
        accessibilityState={hasDetails ? { expanded: open } : undefined}
        accessibilityLabel={
          subagentId
            ? `Open subagent ${formatted.title}`
            : formatted.title
        }
      >
        <View style={styles.toolTextCol}>
          <Text style={[styles.toolTitle, failed && styles.failedText]}>
            {hasDetails && !subagentId ? (open ? "⌄ " : "› ") : ""}
            {subagentId ? "↗ " : ""}
            {formatted.title}
          </Text>
          {!open && formatted.detail ? (
            <Text style={styles.toolSubtitle} numberOfLines={2}>
              {formatted.detail}
            </Text>
          ) : null}
        </View>
        {formatted.status ? (
          <Text style={styles.status}>{formatted.status}</Text>
        ) : formatted.exitCode != null ? (
          <Text style={[styles.status, failed && styles.failedText]}>
            exit {formatted.exitCode}
          </Text>
        ) : null}
      </Pressable>
      {open ? (
        <View style={styles.details}>
          {formatted.detail ? (
            <Text selectable style={styles.detail}>
              {formatted.detail}
            </Text>
          ) : null}
          {formatted.result ? (
            <Text selectable style={styles.result}>
              {formatted.result}
            </Text>
          ) : null}
          {formatted.diffPatch ? (
            <View style={styles.codeBox}>
              {renderDiffLines(formatted.diffPatch).map((line, index) => (
                <Text
                  selectable
                  key={`${message.id}-${index}`}
                  style={[
                    styles.code,
                    line.kind === "add" && styles.add,
                    line.kind === "del" && styles.del,
                    line.kind === "meta" && styles.meta,
                  ]}
                >
                  {line.t}
                </Text>
              ))}
            </View>
          ) : null}
          {formatted.output ? (
            <Text selectable style={styles.output}>
              {formatted.output}
            </Text>
          ) : null}
          {subagentId && onOpenSubagent ? (
            <Pressable
              onPress={() => onOpenSubagent(subagentId)}
              style={styles.openTerminal}
              accessibilityRole="button"
            >
              <Text style={styles.openTerminalText}>Open subagent chat</Text>
            </Pressable>
          ) : null}
          {/terminal|shell|command/i.test(message.tool?.name || "") &&
          onOpenTerminal ? (
            <Pressable
              onPress={onOpenTerminal}
              style={styles.openTerminal}
              accessibilityRole="button"
            >
              <Text style={styles.openTerminalText}>Open terminal</Text>
            </Pressable>
          ) : null}
          {/create_plan|CreatePlan/i.test(message.tool?.name || "") &&
          onQuickPrompt ? (
            <Pressable
              onPress={() => onQuickPrompt("Build this plan.")}
              style={styles.openTerminal}
              accessibilityRole="button"
            >
              <Text style={styles.openTerminalText}>Build this plan</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

export const ToolCluster = memo(function ToolCluster({
  clusterId,
  category,
  messages,
  density,
  initiallyExpanded,
  onOpenTerminal,
  onOpenSubagent,
  onQuickPrompt,
  isExpanded,
  onToggleExpanded,
}: Props) {
  const hasFailure = messages.some(
    (message) =>
      message.tool?.statusKind === "error" ||
      (message.tool?.exitCode != null && message.tool.exitCode !== 0) ||
      /error|failed/i.test(message.tool?.status || ""),
  );
  const defaultExpanded = Boolean(
    initiallyExpanded ||
      density === "detailed" ||
      hasFailure ||
      category === "Subagent",
  );
  const expanded = isExpanded(clusterId, defaultExpanded);
  const showRows = expanded;

  return (
    <View style={styles.cluster}>
      <Pressable
        onPress={() => onToggleExpanded(clusterId, defaultExpanded)}
        style={styles.clusterHeader}
        accessibilityRole="button"
        accessibilityState={{ expanded: showRows }}
      >
        <Text style={styles.clusterTitle}>
          {showRows ? "⌄" : "›"} {summaryFor(category, messages)}
        </Text>
      </Pressable>
      {showRows
        ? messages.map((message) => (
            <ToolRow
              key={message.id}
              message={message}
              onOpenTerminal={onOpenTerminal}
              onOpenSubagent={onOpenSubagent}
              onQuickPrompt={onQuickPrompt}
              open={isExpanded(`tool-detail-${message.id}`, false)}
              onToggle={() =>
                onToggleExpanded(`tool-detail-${message.id}`, false)
              }
            />
          ))
        : null}
    </View>
  );
});

const styles = StyleSheet.create({
  cluster: {
    marginVertical: 4,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: "#f1ede5",
  },
  clusterHeader: {
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: 11,
  },
  clusterTitle: { color: "#4c463e", fontSize: 12, fontWeight: "700" },
  toolRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#ddd5c8",
  },
  toolRowFailed: { backgroundColor: "#f8ebe8" },
  toolMain: {
    minHeight: 40,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  toolTitle: { color: "#312d27", fontSize: 12, fontWeight: "600" },
  toolTextCol: { flex: 1, gap: 2 },
  toolSubtitle: { color: "#81786b", fontSize: 11 },
  failedText: { color: "#94483f" },
  status: { color: "#81786b", fontSize: 10 },
  details: { paddingHorizontal: 12, paddingBottom: 10, gap: 5 },
  detail: { color: "#655e54", fontSize: 11, fontFamily: "Menlo" },
  result: { color: "#746c60", fontSize: 11 },
  codeBox: {
    backgroundColor: "#27231e",
    borderRadius: 7,
    padding: 8,
  },
  code: { color: "#d8d0c4", fontFamily: "Menlo", fontSize: 10, lineHeight: 14 },
  add: { color: "#9bc5a2" },
  del: { color: "#e0a29a" },
  meta: { color: "#aa9f91" },
  output: {
    backgroundColor: "#252b25",
    color: "#d2e3d2",
    borderRadius: 7,
    padding: 8,
    fontFamily: "Menlo",
    fontSize: 10,
    maxHeight: 260,
  },
  openTerminal: {
    minHeight: 40,
    justifyContent: "center",
    alignSelf: "flex-start",
  },
  openTerminalText: { color: "#3d6748", fontSize: 12, fontWeight: "700" },
});
