import type { ChatMessage } from "@cursor-remote/shared";

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
};

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
    case "edit_file_v2": {
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
    case "read_file_v2": {
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
    case "run_terminal_command_v2": {
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
    case "grep": {
      const pattern = str(params?.pattern);
      const path = str(params?.path || params?.glob || ".");
      return {
        ...base,
        title: `Searched code`,
        detail: `/${pattern}/ in ${path}`,
      };
    }
    case "glob_file_search": {
      return {
        ...base,
        title: "Found files",
        detail: str(params?.globPattern || params?.targetDirectory),
      };
    }
    case "web_search": {
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
    case "web_fetch": {
      return {
        ...base,
        title: "Fetched page",
        detail: str(params?.url),
      };
    }
    case "todo_write": {
      return {
        ...base,
        title: "Updated todos",
        detail: params?.merge ? "merged into existing list" : "replaced list",
        result: "ok",
      };
    }
    case "delete_file": {
      return {
        ...base,
        title: "Deleted file",
        detail: str(params?.path || params?.relativeWorkspacePath),
      };
    }
    case "create_plan": {
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
    case "await": {
      return {
        ...base,
        title: "Waited",
        detail: str(params?.block_until_ms ? `${params.block_until_ms}ms` : params?.pattern),
      };
    }
    default: {
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
