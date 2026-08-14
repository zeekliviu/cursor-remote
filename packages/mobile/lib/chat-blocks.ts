import type { ChatMessage } from "@cursor-remote/shared";

export type ChatBlock =
  | { kind: "message"; message: ChatMessage }
  | { kind: "tools"; id: string; count: number; messages: ChatMessage[] }
  | { kind: "thinking"; id: string; message: ChatMessage };

function isToolMessage(m: ChatMessage): boolean {
  if (m.role === "tool") return true;
  if (m.hasTools && (!m.text || m.text === "[tool call]" || Boolean(m.tool)))
    return true;
  if (m.text === "[tool call]") return true;
  return false;
}

function isThinkingMessage(m: ChatMessage): boolean {
  if (m.role === "thinking") return true;
  return Boolean(m.thinking && !m.text && !m.hasTools);
}

export function buildChatBlocks(messages: ChatMessage[]): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  let toolBuf: ChatMessage[] = [];

  const flushTools = () => {
    if (!toolBuf.length) return;
    blocks.push({
      kind: "tools",
      id: `tools-${toolBuf[0].id}`,
      count: toolBuf.length,
      messages: toolBuf,
    });
    toolBuf = [];
  };

  for (const m of messages) {
    if (isThinkingMessage(m)) {
      flushTools();
      blocks.push({ kind: "thinking", id: m.id, message: m });
      continue;
    }
    if (isToolMessage(m)) toolBuf.push(m);
    else {
      flushTools();
      blocks.push({ kind: "message", message: m });
    }
  }
  flushTools();
  return blocks;
}

export function toolSummaryLine(m: ChatMessage): string {
  if (m.tool?.name) {
    const st = m.tool.status ? ` · ${m.tool.status}` : "";
    return `${m.tool.name}${st}`;
  }
  return m.text || "action";
}
