import type { ChatAgentActivityEvent } from "./types";

/**
 * Claude Code's way of showing steps (the User, 2026-11-25: "Claude Code shows
 * this differently"; verified in 2.1.330, a real interactive session and the
 * CLI's own code): reads, searches, listings, shell commands and MCP calls in
 * a row are one line. While they run it says the step it is at; once they ran,
 * how many of each ("Read 1 file, ran 2 shell commands"). An edit, a new file,
 * a fetch, a web search and a subagent stay lines of their own, and so does
 * anything the member says between them.
 */
type StepEvent = Pick<ChatAgentActivityEvent, "kind" | "label" | "detail">;

type FoldedStep =
  | { kind: "read"; path?: string }
  | { kind: "search" | "list" | "shell" | "silent" }
  | { kind: "mcp"; server: string };

/** Consecutive steps as they are drawn: folded into one line, or on their own. */
export type ClaudeStepBlock<T> = { fold: true; events: T[] } | { fold: false; event: T };

// The CLI's own lists: a command made only of these reads, searches or lists.
const SEARCH_COMMANDS = new Set(["find", "grep", "rg", "ag", "ack", "locate", "which", "whereis"]);
const READ_COMMANDS = new Set(["cat", "head", "tail", "less", "more", "wc", "stat", "file", "strings", "jq", "awk", "cut", "sort", "uniq", "tr"]);
const LIST_COMMANDS = new Set(["ls", "tree", "du"]);
const NEUTRAL_COMMANDS = new Set(["echo", "printf", "true", "false", ":"]);
/** A redirection that writes somewhere (not to /dev/null). */
const WRITES = />(?!\s*(?:&|\/dev\/null))/;

/** A command without what stands in its quotes, read once from start to end
 *  (a pattern for it took hours on an unclosed quote with many backslashes;
 *  a long command is kept cut, so its quote is often not closed). */
function withoutQuoted(command: string): string {
  let kept = "";
  let quote = "";
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (char === "\\" && quote !== "'") index += 1;
    else if (quote) quote = char === quote ? "" : quote;
    else if (char === "\"" || char === "'") quote = char;
    else kept += char;
  }
  return kept;
}

function shellStep(command: string | undefined): FoldedStep {
  const shell: FoldedStep = { kind: "shell" };
  if (!command || WRITES.test(withoutQuoted(command))) return shell;
  let found: FoldedStep | undefined;
  for (const part of command.split(/&&|\|\||[;|\n]/)) {
    const [name = "", ...args] = part.trim().split(/\s+/);
    if (!name || NEUTRAL_COMMANDS.has(name)) continue;
    const writes = name === "sort" ? args.some((arg) => /^(?:-[a-zA-Z]*o|--output)/.test(arg)) : name === "find" && args.some((arg) => /^-(?:delete|exec|ok|fprint)/.test(arg));
    if (writes || (name === "cat" && command.includes("<<"))) return shell;
    if (LIST_COMMANDS.has(name)) found = { kind: "list" };
    else if (SEARCH_COMMANDS.has(name)) found = found?.kind === "list" ? found : { kind: "search" };
    else if (READ_COMMANDS.has(name)) found ??= { kind: "read" };
    else return shell;
  }
  return found ?? shell;
}

/** Each step is read once: the same steps are folded again on every update
 *  of a reply being written. */
const foldedSteps = new WeakMap<StepEvent, StepEvent & { step: FoldedStep | undefined }>();

function foldedStep(event: StepEvent): FoldedStep | undefined {
  const known = foldedSteps.get(event);
  if (known && known.kind === event.kind && known.label === event.label && known.detail === event.detail) return known.step;
  const step = readFoldedStep(event);
  foldedSteps.set(event, { kind: event.kind, label: event.label, detail: event.detail, step });
  return step;
}

function readFoldedStep(event: StepEvent): FoldedStep | undefined {
  const label = event.label.replace(/\s+/g, " ").trim();
  if (event.kind === "command") return shellStep(event.detail);
  if (/^(?:thinking|reasoning)\b/i.test(label)) return { kind: "silent" };
  if (event.kind !== "tool") return undefined;
  const mcp = /^(.+?) - \S+ \(MCP\)$/.exec(label);
  if (mcp) return { kind: "mcp", server: mcp[1]! };
  const read = /^Reading (.+)$/.exec(label);
  // "Reading file": a step kept from before its label named the file.
  if (read) return { kind: "read", path: read[1] === "file" ? event.detail : read[1] };
  if (/^(?:Searching(?: for .+)?|Finding .+)$/.test(label)) return { kind: "search" };
  if (label === "ToolSearch") return { kind: "silent" };
  return undefined;
}

export function claudeStepBlocks<T extends StepEvent>(events: readonly T[]): ClaudeStepBlock<T>[] {
  const blocks: ClaudeStepBlock<T>[] = [];
  for (const event of events) {
    const last = blocks[blocks.length - 1];
    if (!foldedStep(event)) blocks.push({ fold: false, event });
    else if (last?.fold) last.events.push(event);
    else blocks.push({ fold: true, events: [event] });
  }
  return blocks;
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What folded steps say once they ran, in Claude Code's words and order;
 *  "" when they are nothing it counts (looking for a tool, thinking). */
export function claudeStepSummary(events: readonly StepEvent[]): string {
  const tally = { search: 0, list: 0, shell: 0, reads: 0, mcp: 0 };
  const paths = new Set<string>();
  const servers = new Set<string>();
  for (const event of events) {
    const step = foldedStep(event);
    if (!step) continue;
    if (step.kind === "read") {
      tally.reads += 1;
      if (step.path) paths.add(step.path);
    } else if (step.kind === "mcp") {
      tally.mcp += 1;
      servers.add(step.server);
    } else if (step.kind !== "silent") tally[step.kind] += 1;
  }
  // As the CLI counts them: the files its Read tool named, else the reads.
  const files = paths.size > 0 ? paths.size : tally.reads;
  const parts = [
    tally.search > 0 && `searched for ${counted(tally.search, "pattern", "patterns")}`,
    files > 0 && `read ${counted(files, "file", "files")}`,
    tally.list > 0 && `listed ${counted(tally.list, "directory", "directories")}`,
    tally.mcp > 0 && `called ${[...servers].join(", ")}${tally.mcp > 1 ? ` ${tally.mcp} times` : ""}`,
    tally.shell > 0 && `ran ${counted(tally.shell, "shell command", "shell commands")}`
  ].filter((part): part is string => Boolean(part));
  const text = parts.join(", ");
  return text ? text[0]!.toUpperCase() + text.slice(1) : "";
}
