/** Minimal line-oriented diff (no deps). Caps work for very large files. */

export type LineDiff = {
  additions: number;
  deletions: number;
  patch: string;
};

export function lineDiff(
  before: string,
  after: string,
  filePath = "file",
  maxPatchLines = 120,
): LineDiff {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > 4000 || b.length > 4000) {
    const additions = Math.max(0, b.length - a.length);
    const deletions = Math.max(0, a.length - b.length);
    return {
      additions: additions || (before === after ? 0 : b.length),
      deletions: deletions || (before === after ? 0 : a.length),
      patch: `--- a/${filePath}\n+++ b/${filePath}\n@@ large file @@\n(size ${a.length} → ${b.length} lines)`,
    };
  }

  const n = a.length;
  const m = b.length;
  // LCS lengths
  const dp: Uint16Array[] = Array.from(
    { length: n + 1 },
    () => new Uint16Array(m + 1),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? (dp[i + 1][j + 1] + 1) as number
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  type Op = { t: " " | "+" | "-"; line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: "-", line: a[i++] });
    } else {
      ops.push({ t: "+", line: b[j++] });
    }
  }
  while (i < n) ops.push({ t: "-", line: a[i++] });
  while (j < m) ops.push({ t: "+", line: b[j++] });

  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.t === "+") additions++;
    if (op.t === "-") deletions++;
  }

  // Build a compact unified-ish patch focusing near changes
  const lines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
  let emitted = 0;
  let contextBuf: string[] = [];
  const flushContext = (force = false) => {
    if (!contextBuf.length) return;
    const keep = force ? contextBuf : contextBuf.slice(-2);
    for (const l of keep) {
      if (emitted >= maxPatchLines) return;
      lines.push(l);
      emitted++;
    }
    contextBuf = [];
  };

  for (const op of ops) {
    if (emitted >= maxPatchLines) {
      lines.push("…");
      break;
    }
    if (op.t === " ") {
      contextBuf.push(` ${op.line}`);
      if (contextBuf.length > 4) contextBuf.shift();
      continue;
    }
    flushContext(true);
    lines.push(`${op.t}${op.line}`);
    emitted++;
  }

  return { additions, deletions, patch: lines.join("\n") };
}
