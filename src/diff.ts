// Minimal line-level unified diff. We use the classic LCS dynamic-programming
// approach which is fine for the tree-sized inputs we operate on (a few
// hundred to a few thousand lines).

export interface DiffResult {
  /** unified-style hunks separated by newlines. empty string when identical. */
  text: string;
  /** number of +/- lines (excluding @@ and context). */
  changeLines: number;
}

interface Op {
  kind: "eq" | "add" | "del";
  line: string;
  /** 1-based line number in source side ('-' or context). */
  oldLine?: number;
  /** 1-based line number in target side ('+' or context). */
  newLine?: number;
}

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // For very long inputs we fall back to a coarse diff to avoid O(n*m) blowup.
  if (n * m > 4_000_000) {
    return coarseDiff(a, b);
  }
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: Uint32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0, j = 0;
  let oldLine = 1, newLine = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "eq", line: a[i], oldLine, newLine });
      i++; j++; oldLine++; newLine++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "del", line: a[i], oldLine });
      i++; oldLine++;
    } else {
      ops.push({ kind: "add", line: b[j], newLine });
      j++; newLine++;
    }
  }
  while (i < n) { ops.push({ kind: "del", line: a[i], oldLine }); i++; oldLine++; }
  while (j < m) { ops.push({ kind: "add", line: b[j], newLine }); j++; newLine++; }
  return ops;
}

function coarseDiff(a: string[], b: string[]): Op[] {
  // crude fallback: report whole-file replacement.
  const ops: Op[] = [];
  for (let i = 0; i < a.length; i++) ops.push({ kind: "del", line: a[i], oldLine: i + 1 });
  for (let j = 0; j < b.length; j++) ops.push({ kind: "add", line: b[j], newLine: j + 1 });
  return ops;
}

export function diffLines(before: string, after: string, contextSize = 2): DiffResult {
  if (before === after) return { text: "", changeLines: 0 };
  const a = before.length ? before.split("\n") : [];
  const b = after.length ? after.split("\n") : [];
  const ops = lcsOps(a, b);

  let changeLines = 0;
  for (const op of ops) if (op.kind !== "eq") changeLines++;
  if (changeLines === 0) return { text: "", changeLines: 0 };

  // Build hunks: contiguous runs of changes plus N lines of context on either
  // side. Adjacent runs with overlapping context are merged.
  interface Hunk {
    oldStart: number; oldLen: number;
    newStart: number; newLen: number;
    ops: Op[];
  }
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].kind === "eq") { i++; continue; }
    // find run end
    let j = i;
    while (j < ops.length && ops[j].kind !== "eq") j++;
    // back off context
    const startCtx = Math.max(0, i - contextSize);
    let endCtx = Math.min(ops.length, j + contextSize);
    // merge with previous hunk if context overlaps
    const prev = hunks[hunks.length - 1];
    let chunkOps: Op[];
    if (prev) {
      const prevEndOpIdx = ops.indexOf(prev.ops[prev.ops.length - 1]) + 1;
      if (prevEndOpIdx >= startCtx) {
        // extend prev
        chunkOps = prev.ops.concat(ops.slice(prevEndOpIdx, endCtx));
        prev.ops = chunkOps;
        const first = chunkOps[0];
        const last = chunkOps[chunkOps.length - 1];
        prev.oldStart = (first.oldLine ?? first.newLine ?? 1);
        prev.newStart = (first.newLine ?? first.oldLine ?? 1);
        let oldLen = 0, newLen = 0;
        for (const op of chunkOps) {
          if (op.kind === "eq") { oldLen++; newLen++; }
          else if (op.kind === "del") oldLen++;
          else newLen++;
        }
        prev.oldLen = oldLen;
        prev.newLen = newLen;
        i = endCtx;
        continue;
      }
    }
    chunkOps = ops.slice(startCtx, endCtx);
    const first = chunkOps[0];
    let oldStart = first.oldLine ?? first.newLine ?? 1;
    let newStart = first.newLine ?? first.oldLine ?? 1;
    let oldLen = 0, newLen = 0;
    for (const op of chunkOps) {
      if (op.kind === "eq") { oldLen++; newLen++; }
      else if (op.kind === "del") oldLen++;
      else newLen++;
    }
    hunks.push({ oldStart, oldLen, newStart, newLen, ops: chunkOps });
    i = endCtx;
  }

  const out: string[] = [];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLen} +${h.newStart},${h.newLen} @@`);
    for (const op of h.ops) {
      const sign = op.kind === "eq" ? " " : op.kind === "del" ? "-" : "+";
      out.push(`${sign}${op.line}`);
    }
  }
  return { text: out.join("\n"), changeLines };
}

/** Truncate a unified diff to its first `maxLines` body lines (excluding
 *  @@ headers). Returns the original if it already fits, plus a count of
 *  how many output lines were dropped.
 */
export function truncateDiff(diff: string, maxLines: number): { text: string; truncated: boolean; droppedLines: number } {
  if (!diff) return { text: "", truncated: false, droppedLines: 0 };
  const lines = diff.split("\n");
  let body = 0;
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("@@")) continue;
    body++;
    if (body > maxLines) { cut = i; break; }
  }
  if (cut === lines.length) return { text: diff, truncated: false, droppedLines: 0 };
  return {
    text: lines.slice(0, cut).join("\n"),
    truncated: true,
    droppedLines: lines.length - cut,
  };
}
