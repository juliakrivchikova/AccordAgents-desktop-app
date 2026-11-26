import { ensureLoginShellEnvPrimed } from "../command";
import { withCodexAppServerOneOff, type CodexAppServerOneOff } from "../cliAgents/codex/appServerOneOff";
import { asRecord } from "../cliAgents/runs/records";
import { afterLeadingBlocks, isoTime, oneLine } from "./text";
import type { CliImportHistory, CliImportHistoryEntry, CliThreadFound, CliThreadReader } from "./types";

// Codex 0.170 lists and reads its threads through its own app-server
// (`thread/list`, `thread/read`, `thread/turns/list`, `thread/items/list`),
// never its databases. `thread/list` with no source filter gives the
// interactive threads (the terminal, the VS Code extension, Codex Desktop);
// it also repairs what its database says from the threads' files, which
// takes 10-15 s for 945 threads here (2026-11-26) and drops 402 threads whose
// files are gone, so it is not asked to skip that.

/** Every source kind Codex 0.170 has (ThreadSourceKind): an empty filter
 *  means the interactive ones. */
const ALL_SOURCE_KINDS = [
  "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"
] as const;
const PAGE_SIZE = 100;
const CODEX_THREADS_TIMEOUT_MS = 120_000;

type CodexRequest = CodexAppServerOneOff["request"];

export class CodexThreads implements CliThreadReader {
  readonly kind = "codex-cli" as const;

  constructor(private readonly deps: { codexExecutable: () => Promise<string>; env: () => NodeJS.ProcessEnv }) {}

  list(includeAutomated: boolean): Promise<CliThreadFound[]> {
    return this.withServer("thread list", async (request) => {
      const interactive = await listThreads(request, {});
      if (!includeAutomated) return interactive.map((thread) => threadFound(thread, false));
      // Automated is what Codex's own filter leaves out, whatever kinds it adds.
      const interactiveIds = new Set(interactive.map((thread) => thread.id));
      const all = await listThreads(request, { sourceKinds: ALL_SOURCE_KINDS });
      return all.map((thread) => threadFound(thread, !interactiveIds.has(thread.id)));
    });
  }

  readHistory(sessionId: string): Promise<CliImportHistory> {
    return this.withServer("thread history", async (request) => {
      const thread = asRecord(asRecord(await request("thread/read", { threadId: sessionId, includeTurns: false }))?.thread);
      if (!thread) throw new Error("Codex has no such thread on this computer");
      const entries = await codexHistoryEntries(request, sessionId, typeof thread.updatedAt === "number" ? thread.updatedAt * 1000 : Date.now());
      return {
        kind: "codex-cli",
        sessionId,
        folder: typeof thread.cwd === "string" ? thread.cwd : "",
        title: codexTitle(thread),
        ...(typeof thread.model === "string" && thread.model ? { model: thread.model } : {}),
        ...(typeof thread.reasoningEffort === "string" && thread.reasoningEffort ? { reasoningEffort: thread.reasoningEffort } : {}),
        entries
      };
    });
  }

  private async withServer<T>(purpose: string, job: (request: CodexRequest) => Promise<T>): Promise<T> {
    let executable: string;
    try {
      executable = await this.deps.codexExecutable();
    } catch {
      throw new Error("Codex is not installed on this computer");
    }
    await ensureLoginShellEnvPrimed();
    return withCodexAppServerOneOff(
      { executable, env: this.deps.env(), purpose, timeoutMs: CODEX_THREADS_TIMEOUT_MS },
      ({ request }) => job(request)
    );
  }
}

/** Her messages and its replies, oldest first, each turn's last reply at the
 *  turn's id (one still running ends no turn). */
async function codexHistoryEntries(request: CodexRequest, threadId: string, updatedAtMs: number): Promise<CliImportHistoryEntry[]> {
  // Old threads record no time for their items, and some none for when a
  // turn started: the turn's end stands in.
  const turns = new Map<string, { atMs?: number; ended: boolean }>();
  for await (const turn of pages(request, "thread/turns/list", { threadId, sortDirection: "asc", itemsView: "notLoaded" })) {
    if (typeof turn.id !== "string") continue;
    const atSeconds = numberOr(turn.completedAt) ?? numberOr(turn.startedAt);
    turns.set(turn.id, { ...(atSeconds !== undefined ? { atMs: atSeconds * 1000 } : {}), ended: turn.status !== "inProgress" });
  }
  const entries: CliImportHistoryEntry[] = [];
  const lastReplyOfTurn = new Map<string, number>();
  for await (const record of pages(request, "thread/items/list", { threadId, sortDirection: "asc" })) {
    const item = asRecord(record.item);
    const turnId = typeof record.turnId === "string" ? record.turnId : undefined;
    const at = isoTime(numberOr(record.completedAtMs) ?? numberOr(record.startedAtMs) ?? (turnId ? turns.get(turnId)?.atMs : undefined) ?? updatedAtMs)!;
    if (item?.type === "userMessage") {
      const content = Array.isArray(item.content) ? item.content.map(asRecord).filter((part): part is Record<string, unknown> => Boolean(part)) : [];
      const text = content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => codexPromptText(part.text as string)).filter(Boolean).join("\n\n");
      const imageCount = content.filter((part) => part.type === "image" || part.type === "localImage").length;
      if (text || imageCount) entries.push({ role: "user", text, at, ...(imageCount ? { imageCount } : {}) });
    } else if (item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
      entries.push({ role: "assistant", text: item.text.trim(), at });
      if (turnId) lastReplyOfTurn.set(turnId, entries.length - 1);
    }
  }
  for (const [turnId, index] of lastReplyOfTurn) {
    if (turns.get(turnId)?.ended) entries[index]!.cut = turnId;
  }
  return entries;
}

async function listThreads(request: CodexRequest, filter: { sourceKinds?: readonly string[] }): Promise<Record<string, unknown>[]> {
  const threads: Record<string, unknown>[] = [];
  for await (const thread of pages(request, "thread/list", { archived: false, ...filter })) {
    if (typeof thread.id === "string") threads.push(thread);
  }
  return threads;
}

/** Every record of a paged app-server list, following its `nextCursor`. */
async function* pages(request: CodexRequest, method: string, params: Record<string, unknown>): AsyncGenerator<Record<string, unknown>> {
  let cursor: string | null = null;
  do {
    const page = asRecord(await request(method, { ...params, cursor, limit: PAGE_SIZE }));
    for (const record of Array.isArray(page?.data) ? page.data : []) {
      const value = asRecord(record);
      if (value) yield value;
    }
    cursor = typeof page?.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
  } while (cursor);
}

function threadFound(thread: Record<string, unknown>, automated: boolean): CliThreadFound {
  return {
    kind: "codex-cli",
    // Thread.id is what resume takes; Thread.sessionId is shared by a tree.
    sessionId: thread.id as string,
    folder: typeof thread.cwd === "string" ? thread.cwd : "",
    title: codexTitle(thread),
    updatedAt: isoTime(typeof thread.updatedAt === "number" ? thread.updatedAt * 1000 : undefined) ?? new Date(0).toISOString(),
    automated
  };
}

/** Its name, else its preview (usually her first message), as Codex lists it. */
function codexTitle(thread: Record<string, unknown>): string {
  return oneLine(typeof thread.name === "string" && thread.name.trim() ? thread.name : typeof thread.preview === "string" ? thread.preview : "");
}

/** What the IDE extension and Codex Desktop send before her request; Codex
 *  shows only what follows it. */
const IDE_REQUEST_MARKER = "## My request for Codex:";

/**
 * Her words in a text part, as Codex 0.170 shows them (measured on a third of
 * the threads here, 2026-11-26): her request after the IDE's context, her
 * answer to its question; otherwise what follows the blocks Codex put before
 * it (`<in-app-browser-context>`), and nothing for one that is only such a
 * block (`<environment_context>`, from older Codex).
 */
function codexPromptText(text: string): string {
  const marker = text.indexOf(IDE_REQUEST_MARKER);
  if (marker >= 0) return text.slice(marker + IDE_REQUEST_MARKER.length).trim();
  const reply = /^\s*<send_user_message_question_reply>([\s\S]*)<\/send_user_message_question_reply>\s*$/.exec(text);
  if (reply) return reply[1]!.trim();
  return afterLeadingBlocks(text);
}

function numberOr(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
