import type { Dirent } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseJsonRecord } from "../cliAgents/runs/records";
import { claudeProjectsDir, findClaudeTranscript } from "../memberSessionFiles";
import { claudeAppSessions, type ClaudeAppSession } from "./claudeAppSessions";
import { afterLeadingBlocks, fileLines, isoTime, leadingBlockName, oneLine } from "./text";
import type { CliImportHistory, CliImportHistoryEntry, CliThreadFound, CliThreadReader } from "./types";

// The list is only the sessions the Claude desktop app shows in its sidebar
// (the owner's decision, 2026-11-26; 157 of 808 sessions on disk here). Claude
// Code 2.1.329 keeps each as `<projects>/<folder>/<id>.jsonl`. A record with no
// title is named as /resume names a session: her title for it (the last
// `custom-title` line, else `<id>/custom-title.json`), the title it made
// (`ai-title`), the prompt she sent last (`last-prompt`), her first prompt.

const TAIL_BYTES = 64 * 1024;
/** Transcripts read at once (the Claude app keeps 163 sessions here,
 *  2026-11-26). */
const FILES_AT_ONCE = 32;
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

export class ClaudeThreads implements CliThreadReader {
  readonly kind = "claude-code" as const;

  constructor(private readonly env: () => NodeJS.ProcessEnv, private readonly appDataDir: string) {}

  async list(): Promise<CliThreadFound[]> {
    const sessions = await claudeAppSessions(this.appDataDir);
    const wanted = new Set(sessions.map((session) => session.cliSessionId));
    const transcripts = new Map<string, string[]>();
    for (const file of await sessionFiles(claudeProjectsDir(this.env()))) {
      const sessionId = path.basename(file, ".jsonl");
      if (wanted.has(sessionId)) transcripts.set(sessionId, [...(transcripts.get(sessionId) ?? []), file]);
    }
    const listed: Array<{ session: ClaudeAppSession; thread: CliThreadFound }> = [];
    for (let start = 0; start < sessions.length; start += FILES_AT_ONCE) {
      const found = await Promise.all(sessions.slice(start, start + FILES_AT_ONCE).map(async (session) => {
        const files = transcripts.get(session.cliSessionId);
        const thread = files ? await appThreadOf(session, files).catch(() => undefined) : undefined;
        return thread ? { session, thread } : undefined;
      }));
      listed.push(...found.filter((entry): entry is { session: ClaudeAppSession; thread: CliThreadFound } => Boolean(entry)));
    }
    const sessionIdOf = new Map(listed.map(({ session }) => [session.localId, session.cliSessionId]));
    const threads = new Map<string, CliThreadFound>();
    for (const { session, thread } of listed) {
      const parentSessionId = session.spawnedFrom ? sessionIdOf.get(session.spawnedFrom) : undefined;
      const linked = parentSessionId && parentSessionId !== thread.sessionId ? { ...thread, parentSessionId } : thread;
      const known = threads.get(thread.sessionId);
      if (!known || known.updatedAt < linked.updatedAt) threads.set(thread.sessionId, linked);
    }
    return [...threads.values()];
  }

  async readHistory(sessionId: string): Promise<CliImportHistory> {
    const file = await findClaudeTranscript(claudeProjectsDir(this.env()), sessionId);
    const thread = file ? await claudeThreadOf(file).catch(() => undefined) : undefined;
    if (!file || !thread) throw new Error("Claude Code has no such session on this computer");
    const entries: CliImportHistoryEntry[] = [];
    let model: string | undefined;
    let reasoningEffort: string | undefined;
    // The last reply since she last wrote: it ended that turn.
    let lastReply: { index: number; uuid: unknown } | undefined;
    const endTurn = (): void => {
      if (lastReply && typeof lastReply.uuid === "string") entries[lastReply.index]!.cut = lastReply.uuid;
      lastReply = undefined;
    };
    for await (const line of fileLines(file)) {
      const userLine = line.includes("\"type\":\"user\"") && !line.includes("\"type\":\"tool_result\"");
      const replyLine = line.includes("\"type\":\"assistant\"") && line.includes("\"type\":\"text\"");
      if (!userLine && !replyLine) continue;
      const entry = parseJsonRecord(line);
      const at = typeof entry?.timestamp === "string" ? isoTime(Date.parse(entry.timestamp)) : undefined;
      if (!entry || !at || entry.isSidechain === true) continue;
      if (entry.type === "user") {
        const message = claudeUserMessage(entry);
        if (!message) continue;
        endTurn();
        entries.push({ role: "user", text: message.text, at, ...(message.imageCount ? { imageCount: message.imageCount } : {}) });
      } else if (entry.type === "assistant") {
        const message = entry.message && typeof entry.message === "object" ? entry.message as Record<string, unknown> : undefined;
        const text = textOfBlocks(message?.content);
        if (!text) continue;
        if (typeof message?.model === "string" && message.model !== "<synthetic>") model = message.model;
        if (typeof entry.perTurnEffort === "string") reasoningEffort = entry.perTurnEffort;
        entries.push({ role: "assistant", text, at });
        lastReply = { index: entries.length - 1, uuid: entry.uuid };
      }
    }
    endTurn();
    return {
      kind: "claude-code",
      sessionId: thread.sessionId,
      folder: thread.folder,
      title: thread.title,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      entries
    };
  }
}

async function sessionFiles(projectsDir: string): Promise<string[]> {
  let folders: Dirent[];
  try {
    folders = await readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    throw new Error((error as NodeJS.ErrnoException).code === "ENOENT"
      ? "Claude Code keeps no sessions on this computer"
      : "Claude Code's sessions could not be read");
  }
  const files: string[] = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const entries = await readdir(path.join(projectsDir, folder.name), { withFileTypes: true }).catch(() => [] as Dirent[]);
    for (const entry of entries) {
      if (entry.isFile() && SESSION_FILE.test(entry.name)) files.push(path.join(projectsDir, folder.name, entry.name));
    }
  }
  return files;
}

/** A session the Claude app lists, in the folder its transcript records. A
 *  session the app moved to another folder is there twice (a hard link):
 *  the newest is the one resume and readHistory find. */
async function appThreadOf(session: ClaudeAppSession, files: readonly string[]): Promise<CliThreadFound | undefined> {
  const found = await Promise.all(files.map(async (file) => ({ file, info: await stat(file) })));
  const newest = found.reduce((best, next) => (next.info.mtimeMs > best.info.mtimeMs ? next : best));
  // Where the app runs it now: a session it moved keeps its first folder in
  // the transcript.
  const folder = session.cwd ?? (await sessionHead(newest.file, false)).cwd;
  const title = oneLine(session.title) || (await claudeThreadOf(newest.file))?.title;
  if (!folder || !title) return undefined;
  return {
    kind: "claude-code",
    sessionId: session.cliSessionId,
    folder,
    ...(session.originCwd && session.originCwd !== folder ? { project: session.originCwd } : {}),
    title,
    updatedAt: isoTime(session.lastActivityAt) ?? newest.info.mtime.toISOString()
  };
}

/** A session as Claude Code's /resume list names it; undefined for one it
 *  leaves out (nothing she wrote, nothing named) or that names no folder. */
async function claudeThreadOf(file: string): Promise<CliThreadFound | undefined> {
  const sessionId = path.basename(file, ".jsonl");
  const info = await stat(file);
  const tail = await tailLines(file, info.size);
  const named = [
    lastField(tail, "customTitle", "custom-title") ?? await sidecarTitle(file, sessionId),
    lastField(tail, "aiTitle", "ai-title"),
    lastField(tail, "lastPrompt", "last-prompt")
  ].map((title) => oneLine(title)).find(Boolean);
  const head = await sessionHead(file, !named);
  const title = named ?? oneLine(head.firstPrompt);
  if (!title || !head.cwd) return undefined;
  return {
    kind: "claude-code",
    sessionId,
    folder: head.cwd,
    title,
    updatedAt: info.mtime.toISOString()
  };
}

/** The last 64 KiB of a session as lines (the first may begin mid-line, so it
 *  is dropped). */
async function tailLines(file: string, size: number): Promise<string[]> {
  const handle = await open(file, "r");
  try {
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8", 0, bytesRead).split("\n");
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    await handle.close();
  }
}

/** A string field of the last line that has it (of that `type`, when one is
 *  named). */
function lastField(lines: readonly string[], field: string, type?: string): string | undefined {
  const marker = type ? `"type":"${type}"` : `"${field}":"`;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.includes(marker)) continue;
    const value = parseJsonRecord(line)?.[field];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** Her title as Claude Code keeps it beside the session, for one whose last
 *  `custom-title` line is further back than the tail. */
async function sidecarTitle(file: string, sessionId: string): Promise<string | undefined> {
  try {
    const value = parseJsonRecord(await readFile(path.join(path.dirname(file), sessionId, "custom-title.json"), "utf8"))?.customTitle;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Where a session ran, what ran it and (when asked) her first prompt, read a
 *  line at a time until found: its first line can be a queued prompt of
 *  800 KB (102 of 1004 sessions here), so a fixed head can miss them. */
async function sessionHead(file: string, needPrompt: boolean): Promise<{ cwd?: string; firstPrompt?: string }> {
  const head: { cwd?: string; firstPrompt?: string } = {};
  for await (const line of fileLines(file)) {
    const cwdLine = !head.cwd && line.includes("\"cwd\":\"");
    const promptLine = needPrompt && !head.firstPrompt && line.includes("\"type\":\"user\"") && !line.includes("\"type\":\"tool_result\"");
    const entry = cwdLine || promptLine ? parseJsonRecord(line) : undefined;
    if (entry && cwdLine && typeof entry.cwd === "string") {
      head.cwd = entry.cwd;
    }
    if (entry && promptLine && entry.isSidechain !== true) head.firstPrompt = claudeUserMessage(entry)?.text || undefined;
    if (head.cwd && (!needPrompt || head.firstPrompt)) break;
  }
  return head;
}

/** A message she sent, as Claude Code shows it; undefined for what the CLI
 *  wrote in her name (tool results, skill bodies, compaction summaries,
 *  reminders, task notices). */
function claudeUserMessage(entry: Record<string, unknown>): { text: string; imageCount: number } | undefined {
  if (entry.type !== "user" || entry.isMeta === true || entry.isCompactSummary === true) return undefined;
  const content = entry.message && typeof entry.message === "object" ? (entry.message as Record<string, unknown>).content : undefined;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content as unknown[] : [];
  const typed = blocks.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object");
  if (typed.some((block) => block.type === "tool_result")) return undefined;
  const texts = typed
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => claudePromptText(block.text as string))
    .filter((text): text is string => Boolean(text));
  const imageCount = typed.filter((block) => block.type === "image").length;
  return texts.length || imageCount ? { text: texts.join("\n\n"), imageCount } : undefined;
}

/**
 * Her words in a text block, as Claude Code 2.1.329 and Claude desktop write
 * them (measured on 1004 sessions here, 2026-11-26): a slash command as
 * "/name args", a `!` command as "! command", a paste with what she wrote
 * after it; otherwise what follows the blocks the apps put before her words
 * (`<system-reminder>`, `<artifact-view-context>`, …). Undefined when nothing
 * is left (a task notice, a command's output) and for "[Request interrupted
 * by user]".
 */
function claudePromptText(text: string): string | undefined {
  const opening = leadingBlockName(text);
  if (opening === "command-name" || opening === "command-message") {
    const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    if (name) return args ? `${name} ${args}` : name;
  }
  if (opening === "bash-input") {
    const command = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(text)?.[1]?.trim();
    return command ? `! ${command}` : undefined;
  }
  if (opening === "pasted_content") {
    return text.replace(/<\/?pasted_content(?:\s[^>]*)?>/g, "").trim() || undefined;
  }
  const rest = afterLeadingBlocks(text);
  return rest && !/^\[Request interrupted by user[^\]]*\]/.test(rest) ? rest : undefined;
}

function textOfBlocks(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => Boolean(block) && typeof block === "object" && (block as Record<string, unknown>).type === "text" && typeof (block as Record<string, unknown>).text === "string")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
}
