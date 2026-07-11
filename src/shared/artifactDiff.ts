// Line-based unified diff between two artifact versions. Dependency-free so it
// can run in both the main process (service/tool responses) and the renderer.

const DEFAULT_CONTEXT_LINES = 3;
// LCS is O(a*b); above this product fall back to a whole-document replacement
// hunk instead of burning CPU on pathological inputs.
const MAX_LCS_CELLS = 4_000_000;

interface DiffOp {
  kind: "same" | "del" | "add";
  line: string;
}

export function unifiedLineDiff(
  before: string,
  after: string,
  options: { context?: number; fromLabel?: string; toLabel?: string } = {}
): string {
  const context = Math.max(0, options.context ?? DEFAULT_CONTEXT_LINES);
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const header = [
    `--- ${options.fromLabel ?? "before"}`,
    `+++ ${options.toLabel ?? "after"}`
  ];
  if (before === after) {
    return [...header, "(no changes)"].join("\n");
  }
  const ops = diffOps(beforeLines, afterLines);
  const hunks = buildHunks(ops, context);
  return [...header, ...hunks].join("\n");
}

function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  return text.replace(/\r\n/g, "\n").split("\n");
}

function diffOps(before: string[], after: string[]): DiffOp[] {
  // Trim common prefix/suffix first; it keeps the DP table small for the
  // common "edit one section of a large document" case.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const midBefore = before.slice(start, endBefore);
  const midAfter = after.slice(start, endAfter);
  const middle = (midBefore.length + 1) * (midAfter.length + 1) > MAX_LCS_CELLS
    ? [
        ...midBefore.map((line): DiffOp => ({ kind: "del", line })),
        ...midAfter.map((line): DiffOp => ({ kind: "add", line }))
      ]
    : lcsOps(midBefore, midAfter);
  return [
    ...before.slice(0, start).map((line): DiffOp => ({ kind: "same", line })),
    ...middle,
    ...before.slice(endBefore).map((line): DiffOp => ({ kind: "same", line }))
  ];
}

function lcsOps(before: string[], after: string[]): DiffOp[] {
  const rows = before.length + 1;
  const cols = after.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = before[i] === after[j]
        ? table[(i + 1) * cols + j + 1] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ kind: "same", line: before[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      ops.push({ kind: "del", line: before[i] });
      i += 1;
    } else {
      ops.push({ kind: "add", line: after[j] });
      j += 1;
    }
  }
  while (i < before.length) {
    ops.push({ kind: "del", line: before[i] });
    i += 1;
  }
  while (j < after.length) {
    ops.push({ kind: "add", line: after[j] });
    j += 1;
  }
  return ops;
}

function buildHunks(ops: DiffOp[], context: number): string[] {
  const changed = ops.map((op) => op.kind !== "same");
  const include = new Array<boolean>(ops.length).fill(false);
  for (let index = 0; index < ops.length; index += 1) {
    if (!changed[index]) {
      continue;
    }
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length - 1, index + context);
    for (let mark = from; mark <= to; mark += 1) {
      include[mark] = true;
    }
  }
  const lines: string[] = [];
  let index = 0;
  let beforeLine = 1;
  let afterLine = 1;
  while (index < ops.length) {
    if (!include[index]) {
      if (ops[index].kind !== "add") {
        beforeLine += 1;
      }
      if (ops[index].kind !== "del") {
        afterLine += 1;
      }
      index += 1;
      continue;
    }
    const hunkStart = index;
    let end = index;
    while (end < ops.length && include[end]) {
      end += 1;
    }
    const hunkOps = ops.slice(hunkStart, end);
    const beforeCount = hunkOps.filter((op) => op.kind !== "add").length;
    const afterCount = hunkOps.filter((op) => op.kind !== "del").length;
    lines.push(`@@ -${beforeCount === 0 ? beforeLine - 1 : beforeLine},${beforeCount} +${afterCount === 0 ? afterLine - 1 : afterLine},${afterCount} @@`);
    for (const op of hunkOps) {
      if (op.kind === "same") {
        lines.push(` ${op.line}`);
        beforeLine += 1;
        afterLine += 1;
      } else if (op.kind === "del") {
        lines.push(`-${op.line}`);
        beforeLine += 1;
      } else {
        lines.push(`+${op.line}`);
        afterLine += 1;
      }
    }
    index = end;
  }
  return lines;
}
