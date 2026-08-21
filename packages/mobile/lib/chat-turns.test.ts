import assert from "node:assert/strict";
import test from "node:test";

import type { ChatMessage } from "@cursor-remote/shared";

import {
  buildChatTurns,
  buildToolClusters,
  classifyToolName,
  formatDuration,
  getDefaultExpansionGuidance,
  getToolClusterVisibility,
  parseMessageTimestamp,
} from "./chat-turns";
import {
  approvalActionIntent,
  orderApprovalActions,
} from "./approval-semantics";

function message(
  id: string,
  role: ChatMessage["role"],
  text: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return { id, role, text, ...overrides };
}

function tool(
  id: string,
  name: string,
  overrides: Partial<NonNullable<ChatMessage["tool"]>> = {},
): ChatMessage {
  return message(id, "tool", "[tool call]", {
    hasTools: true,
    tool: { name, ...overrides },
  });
}

test("buildChatTurns uses user boundaries and separates turn content", () => {
  const messages: ChatMessage[] = [
    message("system", "system", "Harness ready", {
      createdAt: "2026-08-17T08:59:59.000Z",
    }),
    message("user-1", "user", "Implement it", {
      createdAt: "2026-08-17T09:00:00.000Z",
    }),
    message("thinking-1", "thinking", "Thought · 2s", {
      thinking: "Inspect the existing model",
      thinkingDurationMs: 2_000,
      createdAt: "2026-08-17T09:00:01.000Z",
    }),
    tool("read", "read_file_v2"),
    tool("edit", "edit_file_v2", {
      params: JSON.stringify({ relativeWorkspacePath: "src/a.ts" }),
      additions: 4,
      deletions: 1,
    }),
    message("assistant-interim", "assistant", "I found the issue.", {
      thinking: "Check the edge case too",
      thinkingDurationMs: 500,
      createdAt: "2026-08-17T09:00:04.000Z",
    }),
    message("assistant-final", "assistant", "Implemented and tested.", {
      createdAt: "2026-08-17T09:00:08.000Z",
    }),
    message("user-2", "user", "Thanks", {
      createdAt: "2026-08-17T09:01:00.000Z",
    }),
    message("assistant-2", "assistant", "You're welcome.", {
      createdAt: "2026-08-17T09:01:01.000Z",
    }),
  ];

  const turns = buildChatTurns(messages);
  assert.equal(turns.length, 2);

  const first = turns[0];
  assert.ok(first);
  assert.equal(first.user?.id, "user-1");
  assert.deepEqual(first.systemMessages.map((item) => item.id), ["system"]);
  assert.deepEqual(first.thinking.map((item) => item.text), [
    "Inspect the existing model",
    "Check the edge case too",
  ]);
  assert.deepEqual(first.toolMessages.map((item) => item.id), ["read", "edit"]);
  assert.deepEqual(first.assistantMessages.map((item) => item.id), [
    "assistant-interim",
    "assistant-final",
  ]);
  assert.equal(first.finalAssistant?.id, "assistant-final");
  assert.deepEqual(first.toolClusters.map((cluster) => cluster.category), [
    "Explore",
    "Edit",
  ]);
  assert.equal(first.durationMs, 8_000);
  assert.equal(first.durationSource, "timestamps");
  assert.equal(first.startedAt, Date.parse("2026-08-17T09:00:00.000Z"));

  assert.equal(turns[1]?.user?.id, "user-2");
  assert.equal(turns[1]?.finalAssistant?.id, "assistant-2");
});

test("assistant tool bubbles stay out of final assistant content", () => {
  const toolBubble = message("assistant-tool", "assistant", "[tool call]", {
    hasTools: true,
    tool: { name: "grep" },
  });
  const [turn] = buildChatTurns([
    message("user", "user", "Search"),
    toolBubble,
    message("answer", "assistant", "Found it"),
  ]);

  assert.ok(turn);
  assert.deepEqual(turn.toolMessages.map((item) => item.id), ["assistant-tool"]);
  assert.deepEqual(turn.assistantMessages.map((item) => item.id), ["answer"]);
  assert.equal(turn.finalAssistant?.id, "answer");
});

test("classifyToolName supports stored and current tool spellings", () => {
  const cases = [
    ["read_file_v2", "Explore"],
    ["RipgrepRawSearch", "Explore"],
    ["edit_file_v2", "Edit"],
    ["ApplyPatch", "Edit"],
    ["run_terminal_command_v2", "Terminal"],
    ["AwaitShell", "Terminal"],
    ["web_search", "Web"],
    ["WebFetch", "Web"],
    ["mcp-github-create-issue", "MCP"],
    ["CallMcpTool", "MCP"],
    ["todo_write", "PlanTodos"],
    ["UpdateCurrentStep", "PlanTodos"],
    ["Subagent", "Subagent"],
    ["task_v2", "Subagent"],
    ["Task", "Subagent"],
    ["unknown_action", "Other"],
  ] as const;

  for (const [name, expected] of cases) {
    assert.equal(classifyToolName(name), expected, name);
  }
});

test("clusters remain ordered and non-tool activity is a barrier", () => {
  const clusters = buildToolClusters([
    tool("read-a", "read_file_v2"),
    tool("grep", "grep"),
    message("thought", "thinking", "Thinking"),
    tool("read-b", "read_file_v2"),
    tool("terminal", "run_terminal_command_v2"),
  ]);

  assert.deepEqual(
    clusters.map((cluster) => [
      cluster.category,
      cluster.messages.map((item) => item.id),
    ]),
    [
      ["Explore", ["read-a", "grep"]],
      ["Explore", ["read-b"]],
      ["Terminal", ["terminal"]],
    ],
  );
});

test("turn timeline preserves assistant and tool chronology", () => {
  const [turn] = buildChatTurns([
    message("u1", "user", "Work"),
    tool("read", "ReadFile"),
    message("a-progress", "assistant", "I found the entry point."),
    tool("edit", "ApplyPatch"),
    message("a-final", "assistant", "Done."),
  ]);
  assert.deepEqual(
    turn.timeline.map((item) =>
      item.kind === "tools" ? `tools:${item.cluster.category}` : item.id,
    ),
    [
      "tools:Explore",
      "assistant-a-progress",
      "tools:Edit",
      "assistant-a-final",
    ],
  );
});

test("turn and cluster stats count failures and unique edited files", () => {
  const [turn] = buildChatTurns([
    message("user", "user", "Change files"),
    tool("edit-a", "edit_file_v2", {
      params: JSON.stringify({ relativeWorkspacePath: "src\\a.ts" }),
      additions: 5,
      deletions: 2,
    }),
    tool("patch", "ApplyPatch", {
      params: JSON.stringify({
        patch:
          "*** Update File: src/a.ts\n*** Add File: src/b.ts\n+export {}",
      }),
      additions: 1,
    }),
    tool("failed-command", "run_terminal_command_v2", {
      status: "error",
      exitCode: 1,
    }),
    message("answer", "assistant", "The command failed"),
  ]);

  assert.ok(turn);
  assert.deepEqual(turn.stats, {
    toolCount: 3,
    errorCount: 1,
    fileCount: 2,
    files: ["src/a.ts", "src/b.ts"],
    additions: 6,
    deletions: 2,
  });
  assert.equal(turn.toolClusters[0]?.stats.fileCount, 2);
  assert.equal(turn.toolClusters[1]?.stats.errorCount, 1);
});

test("duration falls back to summed thinking time when timestamps are unusable", () => {
  const [turn] = buildChatTurns([
    message("user", "user", "Think", { createdAt: "not-a-date" }),
    message("thinking-a", "thinking", "Thinking", {
      thinkingDurationMs: 1_250,
    }),
    message("answer", "assistant", "Done", {
      thinking: "One more check",
      thinkingDurationMs: 2_000,
    }),
  ]);

  assert.ok(turn);
  assert.equal(turn.durationMs, 3_250);
  assert.equal(turn.durationSource, "thinking");
  assert.equal(turn.startedAt, undefined);

  const [unknown] = buildChatTurns([
    message("user-unknown", "user", "No timing"),
    message("answer-unknown", "assistant", "Done"),
  ]);
  assert.equal(unknown?.durationMs, undefined);
  assert.equal(unknown?.durationSource, undefined);
});

test("timestamp and duration formatters handle edge cases", () => {
  assert.equal(parseMessageTimestamp("1723885200"), 1_723_885_200_000);
  assert.equal(
    parseMessageTimestamp("2026-08-17T09:00:00.000Z"),
    Date.parse("2026-08-17T09:00:00.000Z"),
  );
  assert.equal(parseMessageTimestamp("bad"), undefined);

  assert.equal(formatDuration(undefined), undefined);
  assert.equal(formatDuration(Number.NaN), undefined);
  assert.equal(formatDuration(-1), undefined);
  assert.equal(formatDuration(500), "<1s");
  assert.equal(formatDuration(3_000), "3s");
  assert.equal(formatDuration(192_000), "3m 12s");
  assert.equal(formatDuration(3_661_000), "1h 1m 1s");
});

test("default guidance keeps recent, active, and failed activity inspectable", () => {
  const [ordinary] = buildChatTurns([
    message("user", "user", "Read"),
    tool("read", "read_file_v2"),
    message("answer", "assistant", "Done"),
  ]);
  assert.ok(ordinary);

  const olderCompact = getDefaultExpansionGuidance(ordinary, {
    density: "compact",
    completedTurnsAfter: 3,
  });
  assert.equal(olderCompact.turnExpanded, false);
  assert.deepEqual(olderCompact.expandedToolClusterIds, []);
  assert.equal(olderCompact.reason, "older");

  const activeBalanced = getDefaultExpansionGuidance(ordinary, {
    density: "balanced",
    isActive: true,
  });
  assert.equal(activeBalanced.turnExpanded, true);
  assert.equal(activeBalanced.thinkingExpanded, true);
  assert.deepEqual(activeBalanced.expandedToolClusterIds, ["tools-read"]);

  const [failed] = buildChatTurns([
    message("failed-user", "user", "Run"),
    tool("failed", "run_terminal_command_v2", { exitCode: 2 }),
  ]);
  assert.ok(failed);
  const failedCompact = getDefaultExpansionGuidance(failed, {
    density: "compact",
    completedTurnsAfter: 20,
  });
  assert.equal(failedCompact.turnExpanded, true);
  assert.equal(failedCompact.reason, "failure");
  assert.deepEqual(failedCompact.expandedToolClusterIds, ["tools-failed"]);

  assert.equal(
    getToolClusterVisibility("compact", failed.toolClusters[0]!),
    "important",
  );
  assert.equal(
    getToolClusterVisibility("balanced", ordinary.toolClusters[0]!),
    "summary",
  );
  assert.equal(
    getToolClusterVisibility("detailed", ordinary.toolClusters[0]!),
    "all",
  );
});

test("approval semantics distinguish one-time and persistent actions", () => {
  assert.equal(
    approvalActionIntent({ label: "Run" }),
    "allowOnce",
  );
  assert.equal(
    approvalActionIntent({ label: "Always Run" }),
    "allowAlways",
  );
  assert.equal(
    approvalActionIntent({ label: "Don't Ask Again" }),
    "allowAlways",
  );
  assert.equal(approvalActionIntent({ label: "Skip" }), "deny");
});

test("approval actions keep persistent permissions visually separated", () => {
  const ordered = orderApprovalActions([
    { id: "always", label: "Always Run", risk: "high" as const },
    { id: "run", label: "Run", risk: "medium" as const },
    { id: "skip", label: "Skip", risk: "low" as const },
  ]);
  assert.deepEqual(
    ordered.map((action) => action.id),
    ["skip", "run", "always"],
  );
});
