import type { ChatProviderKind, CliImportThread } from "../../../shared/types";

/** One question or answer of a thread, as its CLI recorded it. */
export interface CliImportHistoryEntry {
  role: "user" | "assistant";
  /** The message's text parts joined; pictures are not copied. */
  text: string;
  /** ISO time. */
  at: string;
  /** Pictures the message had (shown as "Image" later). */
  imageCount?: number;
  /** For an assistant reply that ended a turn: the CLI's own point, as Fork
   *  to new chat records it (ChatMessageSessionCut.at: Claude Code, that
   *  assistant message's `uuid`; Codex, the turn's id). */
  cut?: string;
}

/** A thread's history, read once to be imported. */
export interface CliImportHistory {
  kind: ChatProviderKind;
  sessionId: string;
  folder: string;
  title: string;
  model?: string;
  reasoningEffort?: string;
  entries: CliImportHistoryEntry[];
}

/** A thread as its CLI's reader finds it: whether its folder is still there
 *  and whether a chat holds it are said by the list. */
export type CliThreadFound = Omit<CliImportThread, "folderExists" | "conversationId">;

/** Reads one CLI's own store. Its errors are short sentences the User reads
 *  (a store that is not there, one that could not be read). */
export interface CliThreadReader {
  readonly kind: ChatProviderKind;
  /** The threads its vendor's own app lists. */
  list(): Promise<CliThreadFound[]>;
  readHistory(sessionId: string): Promise<CliImportHistory>;
}

/** What the import is given by the app. */
export interface CliImportDependencies {
  /** The Codex that members run (its app-server lists its threads). */
  codexExecutable: () => Promise<string>;
  /** For the bundled sqlite3 on Windows (Antigravity's list is a database). */
  sqliteExecutable: string;
  /** The environment members run in: it names where Claude Code and Codex
   *  keep their data (CLAUDE_CONFIG_DIR, CODEX_HOME). */
  env?: () => NodeJS.ProcessEnv;
  /** Where Antigravity keeps its data (`~/.gemini`). */
  homeDir?: string;
  /** Electron's `app.getPath("appData")`: the Claude app's session records
   *  are under it. */
  appDataDir?: string;
}
