/**
 * What an "Allow for this chat" answer on a member's permission card covers,
 * scoped the way Claude Code scopes its own "Yes, and don't ask again" (2.1.329):
 *
 * - Bash: the command's prefix, one for each command of a compound command
 *   (`Bash(mkdir:*)`; "Yes, and don't ask again for mkdir and date commands").
 * - WebFetch: the domain (`WebFetch(domain:example.com)`).
 * - File edits (Edit, Write, NotebookEdit): the folder: the member's working
 *   folder for a file in it, else the file's own folder.
 * - Any other tool (WebSearch, an MCP tool): the tool itself, as the CLI's
 *   rule for it is.
 *
 * The scope is worked out once, when the card is raised, kept on its request
 * (`ChatToolPermissionRequest.chatScope`), shown on the card's option and
 * saved with the rule (`ChatAppToolApprovalPolicy.targetToolScope`), so the
 * User approves exactly what she reads. A request of a scoped tool the app
 * cannot read (a command substitution, a here-document) gets no "for this
 * chat" option: it is asked each time.
 */

export type ChatToolPermissionScope =
  | { kind: "commands"; prefixes: string[] }
  | { kind: "domain"; domain: string }
  | { kind: "folder"; path: string };

export const CHAT_TOOL_PERMISSION_EDIT_TOOLS: readonly string[] = ["Edit", "Write", "NotebookEdit", "MultiEdit"];

const MAX_COMMAND_PREFIXES = 5;
const MAX_COMMAND_PREFIX_LENGTH = 160;
/** Constructs whose command is decided only when they run, and characters
 *  the shell reads otherwise than this parser would (a whitespace other than
 *  a space or a tab is part of a word to the shell; control characters). */
const OPAQUE_COMMAND = /`|\$\(|<\(|>\(|[^\S \t]|[\u0000-\u0008\u000e-\u001f\u007f]/u;
/** Commands that run another command or a script: their prefix is the whole
 *  command, never the bare program (`Bash(sudo:*)` would allow anything). */
const COMMAND_RUNNERS = new Set([
  "sudo", "doas", "su", "env", "exec", "eval", "command", "builtin", "nohup", "time", "timeout", "nice", "xargs", "watch",
  "bash", "sh", "zsh", "fish", "dash", "ksh", "python", "python3", "node", "deno", "bun", "ruby", "perl", "php", "osascript",
  "ssh", "find", "awk", "sed"
]);
/** Programs whose first argument names what they do (`git commit`). */
const SUBCOMMAND_PROGRAMS = new Set([
  "git", "npm", "pnpm", "yarn", "npx", "cargo", "go", "docker", "kubectl", "gh", "brew", "pip", "pip3", "uv", "poetry",
  "make", "dotnet", "terraform", "aws", "gcloud", "swift", "xcodebuild", "rustup", "gradle", "mvn", "helm", "launchctl"
]);
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn"]);

/** Whether this tool's "for this chat" answer is scoped (Bash, WebFetch,
 *  file edits); another tool's covers the tool. */
export function chatToolPermissionIsScoped(toolName: string): boolean {
  return toolName === "Bash" || toolName === "WebFetch" || CHAT_TOOL_PERMISSION_EDIT_TOOLS.includes(toolName);
}

/** What "for this chat" would cover for this request; undefined when the
 *  tool is scoped and this request cannot be (it is asked each time), or
 *  when the tool is not scoped (its answer covers the tool). */
export function chatToolPermissionScope(
  toolName: string,
  toolInput: unknown,
  workingDirectory?: string
): ChatToolPermissionScope | undefined {
  const input = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? toolInput as Record<string, unknown> : {};
  if (toolName === "Bash") {
    const prefixes = typeof input.command === "string" ? commandPrefixes(input.command) : undefined;
    return prefixes ? { kind: "commands", prefixes } : undefined;
  }
  if (toolName === "WebFetch") {
    const domain = typeof input.url === "string" ? urlDomain(input.url) : undefined;
    return domain ? { kind: "domain", domain } : undefined;
  }
  if (CHAT_TOOL_PERMISSION_EDIT_TOOLS.includes(toolName)) {
    const file = editedFile(input);
    if (!file) return undefined;
    const home = workingDirectory ? normalizedAbsolute(workingDirectory) : undefined;
    const folder = home && within(file, home) ? home : parentFolder(file);
    return folder ? { kind: "folder", path: folder } : undefined;
  }
  return undefined;
}

/** Whether the rules saved for a member cover this request (each command of
 *  a compound command by one of their prefixes, the URL's domain, the file's
 *  folder). A command that writes a file through a redirection is asked
 *  again: a command prefix never covers writing a file. */
export function chatToolPermissionCoveredByScopes(
  toolName: string,
  toolInput: unknown,
  scopes: ChatToolPermissionScope[]
): boolean {
  if (scopes.length === 0) return false;
  const input = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? toolInput as Record<string, unknown> : {};
  if (toolName === "Bash") {
    const prefixes = scopes.flatMap((scope) => scope.kind === "commands" ? scope.prefixes : []);
    const segments = typeof input.command === "string" ? commandSegments(input.command) : undefined;
    if (!segments || segments.length === 0 || prefixes.length === 0) return false;
    return segments.every((segment) => {
      if (segment.writes) return false;
      const text = withoutAssignments(segment.words).join(" ");
      return text.length > 0 && prefixes.some((prefix) => text === prefix || text.startsWith(`${prefix} `));
    });
  }
  if (toolName === "WebFetch") {
    const domain = typeof input.url === "string" ? urlDomain(input.url) : undefined;
    return Boolean(domain) && scopes.some((scope) => scope.kind === "domain" && scope.domain === domain);
  }
  if (CHAT_TOOL_PERMISSION_EDIT_TOOLS.includes(toolName)) {
    const file = editedFile(input);
    return Boolean(file) && scopes.some((scope) => scope.kind === "folder" && within(file!, scope.path));
  }
  return false;
}

/** The card's "for this chat" option, in Claude Code's words. */
export function chatToolPermissionScopeOptionLabel(scope: ChatToolPermissionScope): string {
  if (scope.kind === "commands") {
    return `Yes, and don't ask again for ${listed(scope.prefixes)} commands in this chat`;
  }
  if (scope.kind === "domain") {
    return `Yes, and don't ask again for ${scope.domain} in this chat`;
  }
  return `Yes, and don't ask again for edits in ${scope.path} in this chat`;
}

/** What a saved rule covers, for the chat's system line ("Allowed @x to run
 *  mkdir commands for this chat."). */
export function chatToolPermissionScopeSummary(scope: ChatToolPermissionScope): string {
  if (scope.kind === "commands") return `run ${listed(scope.prefixes)} commands`;
  if (scope.kind === "domain") return `fetch from ${scope.domain}`;
  return `edit files in ${scope.path}`;
}

/** A scope as stored, or undefined when it is not one. */
export function normalizeChatToolPermissionScope(value: unknown): ChatToolPermissionScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === "commands" && Array.isArray(record.prefixes)) {
    const prefixes = record.prefixes
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0 && item.length <= MAX_COMMAND_PREFIX_LENGTH)
      .slice(0, MAX_COMMAND_PREFIXES);
    return prefixes.length > 0 && prefixes.length === record.prefixes.length ? { kind: "commands", prefixes } : undefined;
  }
  if (record.kind === "domain" && typeof record.domain === "string" && /^[a-z0-9.-]{1,253}$/.test(record.domain)) {
    return { kind: "domain", domain: record.domain };
  }
  if (record.kind === "folder" && typeof record.path === "string") {
    const path = normalizedAbsolute(record.path);
    return path && path === record.path ? { kind: "folder", path } : undefined;
  }
  return undefined;
}

export function chatToolPermissionScopesEqual(left: ChatToolPermissionScope | undefined, right: ChatToolPermissionScope | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

// --- commands ------------------------------------------------------------------

interface CommandSegment {
  words: string[];
  /** Writes a file through an output redirection (`> file`, `>> file`). */
  writes: boolean;
}

/** The prefixes Claude Code's "don't ask again" would cover for a command:
 *  the program (with its subcommand for `git commit`, `npm run test`), the
 *  whole command for one that runs another command (`sudo`, `bash -c`, an
 *  interpreter). Undefined when the command cannot be read this way. */
export function commandPrefixes(command: string): string[] | undefined {
  const segments = commandSegments(command);
  if (!segments || segments.length === 0) return undefined;
  const prefixes: string[] = [];
  for (const segment of segments) {
    const prefix = segmentPrefix(segment.words);
    if (!prefix) return undefined;
    if (!prefixes.includes(prefix)) prefixes.push(prefix);
  }
  return prefixes.length <= MAX_COMMAND_PREFIXES ? prefixes : undefined;
}

function segmentPrefix(words: string[]): string | undefined {
  const rest = withoutAssignments(words);
  const [program, ...args] = rest;
  if (!program || program.includes("$") || program === "{" || program === "}" || program === "!") return undefined;
  const name = program.slice(program.lastIndexOf("/") + 1);
  let prefix: string[];
  if (COMMAND_RUNNERS.has(name)) {
    prefix = rest;
  } else if (SUBCOMMAND_PROGRAMS.has(name) && args[0] && !args[0].startsWith("-")) {
    prefix = [program, args[0]];
    if (SCRIPT_RUNNERS.has(name) && args[0] === "run" && args[1] && !args[1].startsWith("-")) prefix.push(args[1]);
  } else {
    prefix = [program];
  }
  const text = prefix.join(" ");
  return text.length <= MAX_COMMAND_PREFIX_LENGTH ? text : undefined;
}

function withoutAssignments(words: string[]): string[] {
  let start = 0;
  while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start]!)) start++;
  return words.slice(start);
}

/** A shell command split into its commands (at `&&`, `||`, `;`, `|`, `&`),
 *  each as its words with quotes removed and redirections left out. */
function commandSegments(command: string): CommandSegment[] | undefined {
  if (OPAQUE_COMMAND.test(command)) return undefined;
  const segments: CommandSegment[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | "\"" | undefined;
  let writes = false;
  let redirect: "out" | "in" | undefined;
  let broken = false;
  const endWord = (): void => {
    if (!inWord) return;
    if (redirect) {
      if (redirect === "out" && word !== "/dev/null") writes = true;
      redirect = undefined;
    } else {
      words.push(word);
    }
    word = "";
    inWord = false;
  };
  const endSegment = (): void => {
    endWord();
    if (redirect) broken = true;
    if (words.length > 0) segments.push({ words, writes });
    else if (writes) broken = true;
    words = [];
    writes = false;
  };
  for (let index = 0; index < command.length && !broken; index++) {
    const char = command[index]!;
    const next = command[index + 1];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === "\"" && next !== undefined) word += command[++index];
      else word += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      inWord = true;
      continue;
    }
    if (char === "\\") {
      if (next !== undefined) {
        word += command[++index];
        inWord = true;
      }
      continue;
    }
    if (char === " " || char === "\t") {
      endWord();
      continue;
    }
    if (char === "(" || char === ")") return undefined;
    if (char === "&" && next === ">") {
      endWord();
      index += command[index + 2] === ">" ? 2 : 1;
      redirect = "out";
      continue;
    }
    if (char === ";" || char === "|" || char === "&") {
      if ((char === "&" || char === "|") && next === char) index++;
      else if (char === "|" && next === "&") index++;
      endSegment();
      continue;
    }
    if (char === ">" || char === "<") {
      // A stream number before it (`2>`) belongs to the redirection.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else {
        endWord();
      }
      if (char === "<" && next === "<") return undefined;
      if (char === ">" && (next === ">" || next === "|")) index++;
      if (command[index + 1] === "&") {
        // `>&2`, `2>&1`: one stream into another, no file.
        index++;
        while (/[\d-]/.test(command[index + 1] ?? "")) index++;
        continue;
      }
      redirect = char === ">" ? "out" : "in";
      continue;
    }
    word += char;
    inWord = true;
  }
  if (quote || broken) return undefined;
  endSegment();
  return broken ? undefined : segments;
}

function listed(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// --- domains and folders --------------------------------------------------------

function urlDomain(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
    return host && !host.includes("*") ? host : undefined;
  } catch {
    return undefined;
  }
}

function editedFile(input: Record<string, unknown>): string | undefined {
  const raw = input.file_path ?? input.notebook_path ?? input.path;
  return typeof raw === "string" ? normalizedAbsolute(raw) : undefined;
}

/** An absolute POSIX path with `.` and `..` resolved; undefined for a
 *  relative one or one that climbs above the root. */
function normalizedAbsolute(path: string): string | undefined {
  if (!path.startsWith("/")) return undefined;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function parentFolder(file: string): string | undefined {
  const index = file.lastIndexOf("/");
  return index > 0 ? file.slice(0, index) : undefined;
}

function within(file: string, folder: string): boolean {
  return folder === "/" ? file.startsWith("/") && file !== "/" : file === folder || file.startsWith(`${folder}/`);
}
