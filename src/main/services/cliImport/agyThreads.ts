import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCommand } from "../command";
import { parseJsonRecord } from "../cliAgents/runs/records";
import { geminiTranscriptPathForConversation, geminiUserSettingsPath } from "../geminiExec";
import { fileLines, isoTime, oneLine } from "./text";
import type { CliImportHistory, CliImportHistoryEntry, CliThreadFound, CliThreadReader } from "./types";

// Antigravity's agy 1.5.18 keeps its conversations in its own folder (beside
// its settings.json): one SQLite file each in `conversations/`, a summary row
// each in `conversation_summaries.db` (a row can outlive its conversation:
// 198 rows for 98 files here, 2026-11-26), and a readable transcript of each
// in `brain/<id>/.system_generated/logs/` (`transcript.jsonl` cuts long
// messages short, `transcript_full.jsonl` keeps them whole). Its rows carry
// no title (only a preview) and nothing that tells a `--print` run from one
// she typed in.

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SQLITE_TIMEOUT_MS = 10_000;

interface AgySummary {
  conversation_id: string;
  title: string;
  preview: string;
  last_modified_time: string;
  workspace_uris: string;
}

export class AgyThreads implements CliThreadReader {
  readonly kind = "gemini-cli" as const;

  constructor(private readonly deps: { sqliteExecutable: string; homeDir: string }) {}

  async list(): Promise<CliThreadFound[]> {
    return (await this.conversations()).map(threadFound);
  }

  async readHistory(sessionId: string): Promise<CliImportHistory> {
    const summary = CONVERSATION_ID.test(sessionId)
      ? (await this.conversations()).find((row) => row.conversation_id === sessionId)
      : undefined;
    if (!summary) throw new Error("Antigravity has no such conversation on this computer");
    const transcript = path.join(path.dirname(geminiTranscriptPathForConversation(this.deps.homeDir, sessionId)), "transcript_full.jsonl");
    // A conversation agy wrote no transcript for (2 of 98 here) still goes on.
    const { entries, model } = await isFile(transcript) ? await agyTranscript(transcript) : { entries: [], model: undefined };
    const thread = threadFound(summary);
    return { kind: "gemini-cli", sessionId, folder: thread.folder, title: thread.title, ...(model ? { model } : {}), entries };
  }

  /** Its summary rows whose conversation is still on disk, as agy's own
   *  database holds them (read only). */
  private async conversations(): Promise<AgySummary[]> {
    const folder = path.dirname(geminiUserSettingsPath(this.deps.homeDir));
    const database = path.join(folder, "conversation_summaries.db");
    if (!await isFile(database)) throw new Error("Antigravity keeps no conversations on this computer");
    // agy keeps it in WAL mode and deletes the WAL when it closes; read only,
    // SQLite cannot open it without one ("unable to open database file"), and
    // with none there is nothing outside the file to miss.
    const source = await isFile(`${database}-wal`) ? ["-readonly", database] : [`${pathToFileURL(database).href}?mode=ro&immutable=1`];
    let rows: AgySummary[];
    try {
      const { stdout } = await runCommand(this.deps.sqliteExecutable, [
        "-batch", "-bail", "-json", "-cmd", ".timeout 5000", ...source,
        "select conversation_id, title, preview, last_modified_time, workspace_uris from conversation_summaries"
      ], { timeoutMs: SQLITE_TIMEOUT_MS });
      // No rows print nothing.
      rows = stdout.trim() ? JSON.parse(stdout) as AgySummary[] : [];
    } catch {
      throw new Error("Antigravity's conversations could not be read");
    }
    const kept = await Promise.all(rows.map(async (row) =>
      CONVERSATION_ID.test(row.conversation_id) && await isFile(path.join(folder, "conversations", `${row.conversation_id}.db`))));
    return rows.filter((_, index) => kept[index]);
  }
}

/** Her inputs and its responses, as agy recorded them. */
async function agyTranscript(file: string): Promise<{ entries: CliImportHistoryEntry[]; model?: string }> {
  const entries: CliImportHistoryEntry[] = [];
  let model: string | undefined;
  try {
    for await (const line of fileLines(file)) {
      const isUser = line.includes("\"type\":\"USER_INPUT\"");
      if (!isUser && !line.includes("\"type\":\"PLANNER_RESPONSE\"")) continue;
      const step = parseJsonRecord(line);
      const at = typeof step?.created_at === "string" ? isoTime(Date.parse(step.created_at)) : undefined;
      if (!step || !at) continue;
      if (step.type === "PLANNER_RESPONSE" && typeof step.model === "string" && step.model) model = step.model;
      // A response that only calls tools has no content.
      const content = typeof step.content === "string" ? step.content : "";
      const text = (isUser ? agyUserRequest(content) : content).trim();
      if (text) entries.push({ role: isUser ? "user" : "assistant", text, at });
    }
  } catch {
    throw new Error("Antigravity's transcript of this conversation could not be read");
  }
  return { entries, ...(model ? { model } : {}) };
}

/** Her words in an input as agy hands it to the model: inside
 *  `<USER_REQUEST>`, before its `<ADDITIONAL_METADATA>` (the time), `<PLAN>`
 *  and `<USER_SETTINGS_CHANGE>` (all 152 inputs here, 2026-11-26). */
function agyUserRequest(content: string): string {
  return /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content)?.[1] ?? content;
}

function threadFound(row: AgySummary): CliThreadFound {
  return {
    kind: "gemini-cli",
    sessionId: row.conversation_id,
    folder: firstWorkspaceFolder(row.workspace_uris),
    title: oneLine(row.title || row.preview),
    // "2026-01-29 12:47:19.545897+00:00"
    updatedAt: isoTime(Date.parse(row.last_modified_time.replace(" ", "T"))) ?? new Date(0).toISOString(),
    automated: false
  };
}

/** The folder of its first workspace (`file://` URIs in a JSON array). */
function firstWorkspaceFolder(uris: string): string {
  try {
    const first = (JSON.parse(uris) as unknown[]).find((uri): uri is string => typeof uri === "string" && uri.startsWith("file:"));
    return first ? fileURLToPath(first) : "";
  } catch {
    return "";
  }
}

async function isFile(file: string): Promise<boolean> {
  return (await stat(file).catch(() => undefined))?.isFile() === true;
}
