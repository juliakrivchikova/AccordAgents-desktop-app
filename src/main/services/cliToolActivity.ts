// What a member's tool call says in its activity row: its CLI's own words for
// that call, not the app's ("Using Bash" told the User nothing, 2026-11-22).
//
// Claude Code 2.1.330 (verified in a real interactive session and in the
// CLI's own code): while a shell command, a read or a search runs, its line
// is "Running <description in its -ing form, or the command cut to 50
// characters>", "Reading <file>", "Searching for <pattern>", "Finding
// <pattern>"; an edit, a new file, a fetch, a web search and a subagent are
// rows of their own, "Update(<file>)", "Write(<file>)", "Fetch(<url>)", "Web
// Search("<query>")", "Agent(<description>)"; one MCP call is "<server> -
// <tool> (MCP)" (its live line, "Calling <server>…", names the server only, so
// one row per call takes the name the CLI gives the call). Paths are relative
// to the session's folder, as the CLI shows them; newlines read as spaces.

import path from "node:path";
import type { ChatAgentActivityKind } from "../../shared/types";
import { claudeRunningTitle } from "./claudeRunningTitle";

/** Where Claude Code cuts a command, a pattern or a URL in its line (its
 *  `Yx`): 49 characters and "…". */
export const CLI_ACTIVITY_SUMMARY_MAX_CHARS = 50;
/** A row is one line: what is kept of a label, at most. */
export const CLI_ACTIVITY_LABEL_MAX_CHARS = 200;
/** The whole invocation a row opens to (a command, an MCP call's arguments),
 *  at most: a heredoc that writes a file must not grow every reply. */
export const CLI_ACTIVITY_DETAIL_MAX_CHARS = 1_800;

export interface CliToolActivity {
  label: string;
  kind: ChatAgentActivityKind;
  detail?: string;
}

export interface ClaudeToolActivityContext {
  /** The session's folder (the CLI's `system/init` cwd). */
  cwd?: string;
  /** MCP servers by the name their tools carry (`claude_ai_Context7`), as
   *  the CLI named them in `system/init` (`claude.ai Context7`). */
  mcpServerNames?: ReadonlyMap<string, string>;
}

/** Text on one line: newlines and runs of spaces read as one space. */
export function cliOneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** How wide a character is on Claude Code's screen: a control character
 *  (a newline, a tab) takes no column. */
function cliColumns(char: string): number {
  return /[\u0000-\u001f\u007f-\u009f]/.test(char) ? 0 : 1;
}

/** Text cut the way Claude Code cuts it, then put on one line: at most `max`
 *  columns, the last of them "…", where a newline takes no column (so
 *  "sleep 3\necho line-2\n…" keeps more characters than a one-line command). */
export function cliTruncate(value: string, max: number): string {
  let kept = "";
  let columns = 0;
  let cut = false;
  for (const char of value) {
    const width = cliColumns(char);
    if (columns + width > max - 1) {
      // One more column fits only if nothing follows it.
      cut = true;
      break;
    }
    kept += char;
    columns += width;
  }
  if (!cut) return cliOneLine(value);
  const rest = value.slice(kept.length);
  let restColumns = 0;
  for (const char of rest) {
    restColumns += cliColumns(char);
    if (columns + restColumns > max) return `${cliOneLine(kept)}…`;
  }
  return cliOneLine(value);
}

/** A label as a row keeps it: one line, CLI_ACTIVITY_LABEL_MAX_CHARS at most. */
export function cliActivityLabel(value: string): string {
  return cliTruncate(cliOneLine(value), CLI_ACTIVITY_LABEL_MAX_CHARS);
}

/** An invocation as a row keeps it, with how much was left out. */
export function cliActivityDetail(value: string | undefined): string | undefined {
  const normalized = value?.trimEnd();
  if (!normalized) return undefined;
  if (normalized.length <= CLI_ACTIVITY_DETAIL_MAX_CHARS) return normalized;
  let keep = CLI_ACTIVITY_DETAIL_MAX_CHARS;
  let marker = `… [+${normalized.length - keep} chars omitted]`;
  while (keep + marker.length > CLI_ACTIVITY_DETAIL_MAX_CHARS) {
    keep = Math.max(0, CLI_ACTIVITY_DETAIL_MAX_CHARS - marker.length);
    marker = `… [+${normalized.length - keep} chars omitted]`;
  }
  return `${normalized.slice(0, keep)}${marker}`;
}

/** A path as Claude Code's transcript shows it: relative to the session's
 *  folder when inside it, else as given. */
export function cliDisplayPath(filePath: string, cwd: string | undefined): string {
  if (!cwd || !path.isAbsolute(filePath)) return filePath;
  const relative = path.relative(cwd, filePath);
  const outside = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  return relative && !outside ? relative : filePath;
}

/** The server and tool of an MCP tool's name (`mcp__<server>__<tool>`). */
export function mcpToolParts(name: string): { server: string; tool: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? { server: match[1], tool: match[2] } : undefined;
}

/** The name an MCP server's tools carry: what is not a letter, a digit, "_"
 *  or "-" in its configured name becomes "_" (`claude.ai Context7` →
 *  `claude_ai_Context7`). */
export function mcpServerToolPrefix(serverName: string): string {
  return serverName.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function stringInput(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function jsonDetail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object" && Object.keys(value as Record<string, unknown>).length === 0) return undefined;
  try {
    return cliActivityDetail(JSON.stringify(value, null, 2));
  } catch {
    return undefined;
  }
}

/** A Claude Code tool call's row, in the CLI's words for it. */
export function claudeToolActivity(
  name: string,
  input: Record<string, unknown> | undefined,
  context: ClaudeToolActivityContext = {}
): CliToolActivity {
  const text = (key: string) => stringInput(input, key);
  const file = (key: string) => {
    const value = text(key);
    return value ? cliDisplayPath(value, context.cwd) : undefined;
  };
  const cut = (value: string) => cliTruncate(value, CLI_ACTIVITY_SUMMARY_MAX_CHARS);
  const row = (label: string, kind: ChatAgentActivityKind, detail?: string): CliToolActivity => ({
    label: cliActivityLabel(label),
    kind,
    ...(detail ? { detail } : {})
  });
  switch (name) {
    case "Bash":
    case "PowerShell": {
      const command = text("command");
      const description = text("description");
      const detail = cliActivityDetail(command);
      if (description) return row(claudeRunningTitle(cliOneLine(description)) ?? cliOneLine(description), "command", detail);
      return command ? row(`Running ${cut(command)}`, "command", detail) : row("Running command", "command");
    }
    case "Read": {
      const target = file("file_path");
      return row(target ? `Reading ${target}` : "Reading file", "tool");
    }
    case "Grep": {
      const pattern = text("pattern");
      return row(pattern ? `Searching for ${cut(pattern)}` : "Searching", "tool");
    }
    case "Glob": {
      const pattern = text("pattern");
      return row(pattern ? `Finding ${cut(pattern)}` : "Finding files", "tool");
    }
    case "Edit":
    case "MultiEdit": {
      const target = file("file_path");
      return row(target ? `Update(${target})` : "Update", "file-edit");
    }
    case "Write": {
      const target = file("file_path");
      return row(target ? `Write(${target})` : "Write", "file-edit");
    }
    case "NotebookEdit": {
      const target = file("notebook_path");
      return row(target ? `Edit Notebook(${target})` : "Edit Notebook", "file-edit");
    }
    case "WebFetch": {
      const url = text("url");
      return row(url ? `Fetch(${url})` : "Fetch", "web");
    }
    case "WebSearch": {
      const query = text("query");
      return row(query ? `Web Search("${cliOneLine(query)}")` : "Web Search", "web");
    }
    case "Task":
    case "Agent": {
      const description = text("description");
      return row(description ? `Agent(${cliOneLine(description)})` : "Agent", "tool", cliActivityDetail(text("prompt")));
    }
    default: {
      const mcp = mcpToolParts(name);
      if (mcp) {
        const server = context.mcpServerNames?.get(mcp.server) ?? mcp.server;
        return row(`${server} - ${mcp.tool} (MCP)`, "tool", jsonDetail(input));
      }
      return row(name, "tool", jsonDetail(input));
    }
  }
}

// Codex 0.155.1's TUI (verified in a real interactive session): a shell
// command is "Ran <command>" once it ran (with its shell wrapper taken off);
// reading, listing and searching commands are "Read <file>", "List <path>",
// "Search <query>" under "Explored"; an edit is "Edited <file> (+1 -1)",
// "Added <file> (+1 -0)", "Deleted <file>"; a web search "Searching the web",
// then "Searched the web for <query>"; an MCP call "Calling
// <server>.<tool>(<arguments>)", then "Called …". A command still running, an
// edit not applied yet and a step the User declined have no line of their own
// there; their rows say "Running …", "Editing …", "Declined …", never that the
// step happened.

/** How a Codex item ended: Codex's own status ("completed", "failed",
 *  "declined"), or none while it runs. */
export type CodexItemStatus = string | undefined;

function codexDeclined(status: CodexItemStatus): boolean {
  return status === "declined";
}

/** The command as Codex's TUI shows it: a `bash -lc '…'` wrapper taken off. */
export function codexDisplayCommand(command: string): string {
  const match = /^(?:\S*\/)?(?:bash|zsh|sh)\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command.trim());
  if (!match) return command.trim();
  return match[1] === "'" ? match[2].replace(/'\\''/g, "'") : match[2].replace(/\\(["\\$`])/g, "$1");
}

export interface CodexCommandAction {
  type?: string;
  command?: string;
  name?: string;
  path?: string | null;
  query?: string | null;
}

/** One exploring action's line: "Read a.ts", "List src", "Search foo in src". */
function codexExploreLine(action: CodexCommandAction): string | undefined {
  switch (action.type) {
    case "read":
      return action.name || action.path ? `Read ${action.name || action.path}` : undefined;
    case "listFiles":
      return `List ${action.path || codexDisplayCommand(action.command ?? "")}`.trimEnd();
    case "search":
      if (action.query) return action.path ? `Search ${action.query} in ${action.path}` : `Search ${action.query}`;
      return `Search ${codexDisplayCommand(action.command ?? "")}`.trimEnd();
    default:
      return undefined;
  }
}

/** A Codex command's row: its exploring lines when all it does is read, list
 *  or search; else "Running …" while it runs and "Ran …" once it ran (a
 *  failing command ran too); one the User declined is "Declined …". */
export function codexCommandActivity(
  command: string | undefined,
  actions: readonly CodexCommandAction[] | undefined,
  finished: boolean,
  status?: CodexItemStatus
): CliToolActivity {
  const detail = cliActivityDetail(command);
  const explore = actions && actions.length > 0 ? actions.map(codexExploreLine) : [];
  const declined = codexDeclined(status);
  if (explore.length > 0 && explore.every((line): line is string => Boolean(line))) {
    const lines = explore.join(", ");
    return { label: cliActivityLabel(declined ? `Declined ${lines}` : lines), kind: "tool", ...(detail ? { detail } : {}) };
  }
  const verb = declined ? "Declined" : finished ? "Ran" : "Running";
  if (!command?.trim()) return { label: `${verb} command`, kind: "command" };
  return { label: cliActivityLabel(`${verb} ${codexDisplayCommand(command)}`), kind: "command", ...(detail ? { detail } : {}) };
}

/** A Codex MCP call's row: "Calling server.tool({…})", then "Called …". */
export function codexMcpActivity(server: string | undefined, tool: string | undefined, args: unknown, finished: boolean): CliToolActivity {
  const name = [server, tool].filter(Boolean).join(".") || "tool";
  let compact = "";
  try {
    compact = args === undefined || args === null ? "" : JSON.stringify(args);
  } catch {
    compact = "";
  }
  const detail = jsonDetail(args);
  return {
    label: cliActivityLabel(`${finished ? "Called" : "Calling"} ${name}(${compact})`),
    kind: "tool",
    ...(detail ? { detail } : {})
  };
}

/** A Codex web search's row. */
export function codexWebSearchActivity(query: string | undefined, finished: boolean): CliToolActivity {
  const shown = query?.trim() ? cliOneLine(query) : undefined;
  return {
    label: cliActivityLabel(finished && shown ? `Searched the web for ${shown}` : "Searching the web"),
    kind: "web",
    ...(shown ? { detail: shown } : {})
  };
}

export interface CodexFileChange {
  path?: string;
  kind?: string;
  diff?: string;
}

function diffCounts(diff: string | undefined, kind: string | undefined): { added: number; removed: number } | undefined {
  if (!diff) return undefined;
  const lines = diff.replace(/\n$/, "").split("\n");
  // A new file may come as its content rather than a diff: every line is added.
  if (kind === "add" && !diff.includes("@@") && !lines.every((line) => line.startsWith("+"))) {
    return { added: lines.length, removed: 0 };
  }
  let added = 0;
  let removed = 0;
  // Header lines ("--- a/x", "+++ b/x") only come before the first hunk.
  let inHunks = !diff.includes("@@");
  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunks = true;
      continue;
    }
    if (!inHunks) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/** A Codex edit's row once applied: "Edited a.ts (+1 -1)", "Added d.txt
 *  (+1 -0)", "Deleted old.ts", "Edited 3 files (+9 -2)"; before that (still
 *  proposed, or it failed to apply) "Editing …", and "Declined …" when the
 *  User declined it. */
export function codexFileChangeActivity(
  changes: readonly CodexFileChange[],
  cwd: string | undefined,
  detail: string | undefined,
  applied = true,
  status?: CodexItemStatus
): CliToolActivity {
  const files = changes.filter((change) => change.path);
  const counts = files.filter((change) => change.kind !== "delete").map((change) => diffCounts(change.diff, change.kind));
  let total: { added: number; removed: number } | undefined = { added: 0, removed: 0 };
  for (const count of counts) {
    total = count && total ? { added: total.added + count.added, removed: total.removed + count.removed } : undefined;
  }
  const suffix = total ? ` (+${total.added} -${total.removed})` : "";
  const done = applied && status !== "failed" && !codexDeclined(status);
  const verb = (kind: string | undefined) => codexDeclined(status)
    ? "Declined"
    : kind === "add"
      ? (done ? "Added" : "Adding")
      : kind === "delete" ? (done ? "Deleted" : "Deleting") : (done ? "Edited" : "Editing");
  let label: string;
  if (files.length === 1) {
    const only = files[0];
    label = `${verb(only.kind)} ${cliDisplayPath(only.path ?? "", cwd)}${only.kind === "delete" ? "" : suffix}`;
  } else {
    label = files.length > 1 ? `${verb("update")} ${files.length} files${suffix}` : `${verb("update")} files`;
  }
  return { label: cliActivityLabel(label), kind: "file-edit", ...(detail ? { detail } : {}) };
}
