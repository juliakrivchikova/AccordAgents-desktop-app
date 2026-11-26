import type { ChatProviderKind } from "./providers";

// Importing a thread the User ran in a CLI of her own (Claude Code, Codex,
// Antigravity's agy) on this computer as a chat whose main session goes on
// in that same CLI session (docs/design/cli-import/plan.md, decided by the
// User on 2026-11-26).

/** A thread found in a CLI's own store on this computer. */
export interface CliImportThread {
  kind: ChatProviderKind;
  /** The CLI's own id: what its resume takes. */
  sessionId: string;
  /** Its working folder, as the CLI recorded it. */
  folder: string;
  folderExists: boolean;
  /** The project its app lists it under, when that is not `folder` (a
   *  Claude Code session in one of the repository's worktrees). */
  project?: string;
  /** The project's name in its app, when the app names it (Codex). */
  projectName?: string;
  /** The thread it was started from, when its app shows it under that one
   *  (Claude's side sessions): that thread's `sessionId`. */
  parentSessionId?: string;
  title: string;
  updatedAt: string;
  /** The chat that already holds this thread: it is opened, never imported
   *  again. */
  conversationId?: string;
}

export interface CliImportListResult {
  threads: CliImportThread[];
  /** A CLI whose store could not be read here, and why. */
  unavailable: Array<{ kind: ChatProviderKind; reason: string }>;
}

export interface CliImportThreadRef {
  kind: ChatProviderKind;
  sessionId: string;
  /** The folder the chat works in, chosen for a thread whose own folder is
   *  gone (the CLI runs in an existing folder only). */
  folder?: string;
}

export interface CliImportRequest {
  threads: CliImportThreadRef[];
}

export interface CliImportResult {
  imported: Array<{ sessionId: string; conversationId: string }>;
  failed: Array<{ sessionId: string; reason: string }>;
}

/** Where an imported main session comes from (ChatParticipant.importOrigin):
 *  written once, by the computer, when the chat is made. */
export interface ChatParticipantImportOrigin {
  kind: ChatProviderKind;
  sessionId: string;
  /** The folder the thread was recorded in (it may be gone). */
  folder: string;
  title: string;
  importedAt: string;
}

/** The line at the top of an imported chat that says where its history comes
 *  from (ChatMessage.metadata.importNotice): shown on every device. */
export interface ChatImportNotice {
  kind: ChatProviderKind;
  importedAt: string;
  messageCount: number;
  firstAt?: string;
  lastAt?: string;
}
