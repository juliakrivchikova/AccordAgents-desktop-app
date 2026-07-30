export type NativeGoalCommandParseResult =
  | { kind: "none" }
  | { kind: "valid"; contentWithoutCommand: string }
  | { kind: "invalid"; error: string };

const GOAL_COMMAND = "/goal";
const TARGET_MENTION_RE = /@([A-Za-z0-9][A-Za-z0-9_-]{0,31})/g;

export function parseNativeGoalCommand(content: string): NativeGoalCommandParseResult {
  const tokens = nativeGoalTokenOffsets(content);
  if (tokens.length === 0) {
    return { kind: "none" };
  }
  if (tokens.length > 1) {
    return { kind: "invalid", error: "Use /goal only once in a message." };
  }

  const start = tokens[0];
  const end = start + GOAL_COMMAND.length;
  const prefix = content.slice(0, start);
  const suffix = content.slice(end);
  const leading = prefix.replace(TARGET_MENTION_RE, "").trim() === "";
  const trailing = suffix.trim() === "";
  if (!leading && !trailing) {
    return { kind: "invalid", error: "Put /goal at the beginning or end of the message." };
  }

  const contentWithoutCommand = removeGoalToken(content, start, end, leading);
  if (!contentWithoutCommand.replace(TARGET_MENTION_RE, "").trim()) {
    return { kind: "invalid", error: "Add a goal after /goal or before a trailing /goal." };
  }
  return { kind: "valid", contentWithoutCommand };
}

function nativeGoalTokenOffsets(content: string): number[] {
  const codeMask = markdownCodeMask(content);
  const offsets: number[] = [];
  let offset = content.indexOf(GOAL_COMMAND);
  while (offset >= 0) {
    const previous = offset === 0 ? "" : content[offset - 1];
    const next = content[offset + GOAL_COMMAND.length] ?? "";
    if (
      !codeMask[offset] &&
      (previous === "" || /\s/.test(previous)) &&
      (next === "" || /\s/.test(next))
    ) {
      offsets.push(offset);
    }
    offset = content.indexOf(GOAL_COMMAND, offset + GOAL_COMMAND.length);
  }
  return offsets;
}

function removeGoalToken(content: string, start: number, end: number, leading: boolean): string {
  let prefix = content.slice(0, start);
  let suffix = content.slice(end);
  if (leading && /^[ \t]/.test(suffix)) {
    suffix = suffix.slice(1);
  } else if (!leading && /[ \t]$/.test(prefix)) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}${suffix}`.trim();
}

function markdownCodeMask(content: string): boolean[] {
  const mask = Array.from({ length: content.length }, () => false);
  let offset = 0;
  let fence: { marker: "`" | "~"; length: number } | undefined;
  for (const lineWithEnding of content.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!lineWithEnding) {
      continue;
    }
    const line = lineWithEnding.endsWith("\n") ? lineWithEnding.slice(0, -1) : lineWithEnding;
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      mark(mask, offset, offset + lineWithEnding.length);
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.marker &&
        fenceMatch[1].length >= fence.length
      ) {
        fence = undefined;
      }
      offset += lineWithEnding.length;
      continue;
    }
    if (fenceMatch) {
      fence = {
        marker: fenceMatch[1][0] as "`" | "~",
        length: fenceMatch[1].length
      };
      mark(mask, offset, offset + lineWithEnding.length);
      offset += lineWithEnding.length;
      continue;
    }
    markInlineCode(mask, line, offset);
    offset += lineWithEnding.length;
  }
  return mask;
}

function markInlineCode(mask: boolean[], line: string, lineOffset: number): void {
  let index = 0;
  while (index < line.length) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }
    let runLength = 1;
    while (line[index + runLength] === "`") {
      runLength += 1;
    }
    const delimiter = "`".repeat(runLength);
    const end = line.indexOf(delimiter, index + runLength);
    const codeEnd = end >= 0 ? end + runLength : line.length;
    mark(mask, lineOffset + index, lineOffset + codeEnd);
    index = codeEnd;
  }
}

function mark(mask: boolean[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    mask[index] = true;
  }
}
