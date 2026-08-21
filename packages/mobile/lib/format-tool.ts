import type { ChatMessage } from "@cursor-remote/shared";

export type ToolCategory =
  | "explore"
  | "edit"
  | "terminal"
  | "web"
  | "mcp"
  | "plan"
  | "subagent"
  | "other";

export function classifyToolMessage(message: ChatMessage): ToolCategory {
  const name = (message.tool?.name || "").toLowerCase();
  if (
    /read|grep|ripgrep|glob|search_file|list_dir|searchconversation|fetchresource/.test(
      name,
    )
  ) {
    return "explore";
  }
  if (/web|fetch|browser|navigate|screenshot/.test(name)) return "web";
  if (/edit|write|patch|delete|create_file|strreplace/.test(name)) return "edit";
  if (/terminal|shell|command|awaitshell/.test(name)) return "terminal";
  if (/subagent|best.of.n|bugbot|security.review|^task(_v\d+)?$/i.test(name)) {
    return "subagent";
  }
  if (/todo|plan|mode|question/.test(name)) return "plan";
  if (/mcp/.test(name)) return "mcp";
  return "other";
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

function parseParams(raw?: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseResult(raw?: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function str(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export type FormattedTool = {
  title: string;
  detail?: string;
  result?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  exitCode?: number;
  diffPatch?: string;
  output?: string;
  /** Child composer id for task/subagent tools — openable in-app. */
  subagentComposerId?: string;
};

function prettySubagentType(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || /^unspecified$/i.test(trimmed)) return undefined;
  if (trimmed === "generalPurpose" || trimmed === "general-purpose") {
    return "general purpose";
  }
  return trimmed.replace(/[_-]+/g, " ");
}

function prettyModel(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^default$/i.test(trimmed)) return "Auto";
  return trimmed;
}

function taskSubagentId(
  params: Record<string, unknown> | null,
  result: unknown,
  message: ChatMessage,
): string | undefined {
  if (message.tool?.subagentComposerId) return message.tool.subagentComposerId;
  const fromParams =
    params?.subagentComposerId ?? params?.agentId ?? params?.composerId;
  if (typeof fromParams === "string" && fromParams.trim()) {
    return fromParams.trim();
  }
  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    const id = obj.agentId ?? obj.composerId ?? obj.subagentComposerId;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return undefined;
}

function formatTaskTool(
  m: ChatMessage,
  params: Record<string, unknown> | null,
  result: unknown,
  base: Omit<FormattedTool, "title" | "detail" | "result" | "subagentComposerId">,
): FormattedTool {
  const description = str(params?.description || params?.name || params?.title);
  const typeLabel =
    prettySubagentType(str(params?.subagentTypeName || params?.subagentType)) ||
    prettySubagentType(str(params?.name));
  const modelLabel = prettyModel(str(params?.model || params?.modelName));
  const subagentComposerId = taskSubagentId(params, result, m);
  const running =
    m.tool?.statusKind === "running" ||
    m.tool?.statusKind === "pending" ||
    /running|pending/i.test(m.tool?.status || "");
  const bits = [typeLabel, modelLabel].filter(Boolean);
  return {
    ...base,
    title: description || (running ? "Subagent running" : "Subagent"),
    detail: bits.length ? bits.join(" · ") : undefined,
    result: subagentComposerId
      ? running
        ? "Open live transcript"
        : "Open transcript"
      : undefined,
    subagentComposerId,
  };
}

/** Turn a tool bubble into a short human-readable summary. */
export function formatToolMessage(m: ChatMessage): FormattedTool {
  const name = m.tool?.name || "action";
  const status = m.tool?.status;
  const params = parseParams(m.tool?.params);
  const result = parseResult(m.tool?.resultPreview);
  const base = {
    status,
    additions: m.tool?.additions,
    deletions: m.tool?.deletions,
    exitCode: m.tool?.exitCode,
    diffPatch: m.tool?.diffPatch,
    output: m.tool?.output,
  };

  switch (name) {
    case "edit_file_v2":
    case "edit_file":
    case "StrReplace":
    case "ApplyPatch":
    case "Write": {
      const path = str(params?.relativeWorkspacePath || params?.path);
      const plus = m.tool?.additions;
      const minus = m.tool?.deletions;
      const stats =
        plus != null || minus != null
          ? `+${plus ?? 0} −${minus ?? 0}`
          : status === "error"
            ? "Edit failed"
            : "File updated";
      return {
        ...base,
        title: `Edited ${basename(path) || "file"}`,
        detail: path || undefined,
        result: stats,
      };
    }
    case "read_file_v2":
    case "read_file":
    case "ReadFile": {
      const path = str(params?.targetFile || params?.effectiveUri || params?.path);
      const offset = params?.offset;
      const limit = params?.limit;
      const range =
        offset != null || limit != null
          ? `lines ${offset ?? "?"}+${limit ?? "?"}`
          : undefined;
      const total =
        result && typeof result === "object" && "totalLinesInFile" in (result as object)
          ? `${(result as { totalLinesInFile: number }).totalLinesInFile} lines`
          : undefined;
      return {
        ...base,
        title: `Read ${basename(path) || "file"}`,
        detail: [path, range].filter(Boolean).join(" · ") || undefined,
        result: total,
      };
    }
    case "run_terminal_command_v2":
    case "run_terminal_command":
    case "Shell": {
      const cmd = str(params?.command);
      const desc = str(params?.commandDescription);
      const out = (
        m.tool?.output ||
        (result && typeof result === "object" && "output" in (result as object)
          ? str((result as { output: unknown }).output)
          : str(result))
      ).trim();
      const code =
        m.tool?.exitCode ??
        (result && typeof result === "object" && "exitCode" in (result as object)
          ? Number((result as { exitCode: unknown }).exitCode)
          : undefined);
      const outShort =
        out.length > 400 ? `${out.slice(0, 400).trim()}…` : out || undefined;
      const exitBit = code != null && !Number.isNaN(code) ? `exit ${code}` : undefined;
      return {
        ...base,
        title: desc || "Ran terminal",
        detail: cmd || undefined,
        result: [exitBit, outShort].filter(Boolean).join(" · ") || undefined,
        exitCode: code,
        output: out || undefined,
      };
    }
    case "ripgrep_raw_search":
    case "grep":
    case "rg": {
      const pattern = str(params?.pattern);
      const path = str(params?.path || params?.glob || ".");
      return {
        ...base,
        title: `Searched code`,
        detail: `/${pattern}/ in ${path}`,
      };
    }
    case "glob_file_search":
    case "Glob": {
      return {
        ...base,
        title: "Found files",
        detail: str(params?.globPattern || params?.targetDirectory),
      };
    }
    case "web_search":
    case "WebSearch": {
      return {
        ...base,
        title: "Web search",
        detail: str(params?.searchTerm || params?.search_term),
        result:
          result && typeof result === "object" && "references" in (result as object)
            ? `${((result as { references: unknown[] }).references || []).length} results`
            : undefined,
      };
    }
    case "web_fetch":
    case "WebFetch": {
      return {
        ...base,
        title: "Fetched page",
        detail: str(params?.url),
      };
    }
    case "todo_write":
    case "TodoWrite": {
      const todos = Array.isArray(params?.todos)
        ? (params.todos as Array<{ status?: string }>)
        : [];
      const done = todos.filter((todo) => todo.status === "completed").length;
      const active = todos.filter((todo) => todo.status === "in_progress").length;
      return {
        ...base,
        title: "Updated todos",
        detail: todos.length
          ? `${done}/${todos.length} complete${active ? " · active task" : ""}`
          : params?.merge
            ? "merged into existing list"
            : "replaced list",
        result: todos.length ? undefined : "ok",
      };
    }
    case "delete_file":
    case "Delete": {
      return {
        ...base,
        title: "Deleted file",
        detail: str(params?.path || params?.relativeWorkspacePath),
      };
    }
    case "create_plan":
    case "CreatePlan": {
      return {
        ...base,
        title: "Created plan",
        detail: str(params?.name || params?.overview)?.slice(0, 120),
      };
    }
    case "switch_mode": {
      return {
        ...base,
        title: "Switched mode",
        detail: str(params?.target_mode_id || params?.mode),
      };
    }
    case "Subagent":
    case "task_v2":
    case "task":
    case "Task": {
      return formatTaskTool(m, params, result, base);
    }
    case "AskQuestion": {
      const questions = Array.isArray(params?.questions)
        ? (params.questions as unknown[])
        : [];
      return {
        ...base,
        title: "Asked for input",
        detail: questions.length
          ? `${questions.length} ${questions.length === 1 ? "question" : "questions"}`
          : undefined,
      };
    }
    case "await": {
      return {
        ...base,
        title: "Waited",
        detail: str(params?.block_until_ms ? `${params.block_until_ms}ms` : params?.pattern),
      };
    }
    default: {
      if (/^task(_v\d+)?$/i.test(name) || /subagent/i.test(name)) {
        return formatTaskTool(m, params, result, base);
      }
      if (name.startsWith("mcp-") || name.includes("mcp")) {
        return {
          ...base,
          title: `MCP · ${name.replace(/^mcp-/, "")}`,
          detail: params
            ? Object.entries(params)
                .slice(0, 4)
                .map(([k, v]) => `${k}: ${str(v).slice(0, 60)}`)
                .join(" · ")
            : undefined,
        };
      }
      const keys = params ? Object.keys(params).slice(0, 3) : [];
      return {
        ...base,
        title: name.replace(/_/g, " "),
        detail: keys
          .map((k) => `${k}: ${str(params?.[k]).slice(0, 80)}`)
          .join(" · ") || m.text,
      };
    }
  }
}

export function formatToolGroupPreview(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const f = formatToolMessage(m);
      if (f.additions != null || f.deletions != null) {
        return `${f.title} (+${f.additions ?? 0}/−${f.deletions ?? 0})`;
      }
      if (f.exitCode != null) return `${f.title} · exit ${f.exitCode}`;
      return f.title;
    })
    .slice(0, 4)
    .join(" · ");
}

export function renderDiffLines(patch?: string): Array<{ t: string; kind: "add" | "del" | "meta" | "ctx" }> {
  if (!patch) return [];
  return patch.split("\n").map((line) => {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("…")) {
      return { t: line, kind: "meta" as const };
    }
    if (line.startsWith("+")) return { t: line, kind: "add" as const };
    if (line.startsWith("-")) return { t: line, kind: "del" as const };
    return { t: line, kind: "ctx" as const };
  });
}
