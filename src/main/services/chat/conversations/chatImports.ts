import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DEFAULT_CHAT_VIEW, MAIN_SESSION_HANDLE, MAIN_SESSION_ROLE_ID, isMainSessionParticipant } from "../../../../shared/mainSession";
import { cliProviderMetadata } from "../../../../shared/cliReadiness";
import { normalizeChatReasoningEffort } from "../../../../shared/reasoningEffort";
import type {
  ChatImportNotice, ChatMessage, ChatParticipant, ChatParticipantSession, ChatProviderKind, Conversation
} from "../../../../shared/types";
import { chatSessions, upsertSession } from "../members/identity";
import { rebuildLastMessagesByParticipant } from "../store/lastMessages";
import { chatCreateLogPayload, createChatMessage } from "../store/messages";
import { chatIntro } from "../store/titles";
import { setPromptContextPointerForScope } from "../turns/promptContextRecords";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** One message of a CLI thread as its reader gives it (CliImportService). */
export interface ImportedThreadEntry {
  role: "user" | "assistant";
  text: string;
  at: string;
  imageCount?: number;
  /** The CLI's own point at a reply that ended a turn (Claude Code's message
   *  uuid, Codex's turn id): Fork to new chat cuts its copy there. */
  cut?: string;
}

/** A CLI thread read for import. */
export interface ImportedThread {
  kind: ChatProviderKind;
  sessionId: string;
  /** The folder the thread was recorded in. */
  folder: string;
  title: string;
  model?: string;
  reasoningEffort?: string;
  entries: ImportedThreadEntry[];
}

/** What a picture of the thread leaves in the history: its bytes are only in
 *  the CLI's transcript, which its session keeps. */
const IMAGE_PLACEHOLDER = "Image";

/**
 * Chats imported from a CLI thread of the User's own (docs/design/cli-import/
 * plan.md, the User, 2026-11-26): a chat in the thread's folder whose main
 * session goes on in that same CLI session (its first turn resumes it, see
 * MemberSessions.sessionForParticipant), with the thread's questions and
 * answers as its history. Made on the computer, which holds the CLI's store.
 */
export class ChatImports {
  constructor(
    private readonly chat: Pick<ChatModules, "creation" | "host" | "memberSessions" | "store">,
    private readonly deps: Pick<ChatDependencies, "debugLogs">
  ) {}

  /**
   * An imported main session's first session record (MemberSessions.
   * sessionForParticipant, when it has none yet) takes the thread's CLI
   * session: its turns resume that session, and the first one tells it it is
   * now the chat's main session (importIntroPending, ParticipantTurn).
   */
  startFromImportOrigin(conversation: Conversation, participant: ChatParticipant, session: ChatParticipantSession): void {
    const origin = participant.importOrigin;
    if (!origin || origin.kind !== participant.kind || !isMainSessionParticipant(conversation.metadata, participant.id)) {
      return;
    }
    session.sessionId = origin.sessionId;
    session.importIntroPending = true;
    void this.deps.debugLogs.write("chat.session.import-start", { conversationId: conversation.id, participantId: participant.id, kind: origin.kind });
    void this.chat.store.withChatMutation(conversation, async () => {
      if (chatSessions(conversation).some((item) => item.participantId === participant.id)) return;
      upsertSession(conversation, session);
      this.chat.store.queueSnapshot(conversation);
    }).catch((error) => {
      void this.deps.debugLogs.write("chat.session.persist-failed", {
        conversationId: conversation.id,
        participantId: participant.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  /** The session an imported main session that has not run yet takes with
   *  it when it moves (MemberMoves): the thread's own, not told yet. */
  async importedSessionToMove(conversation: Conversation, participant: ChatParticipant): Promise<ChatParticipantSession | undefined> {
    const origin = participant.importOrigin;
    if (!origin || origin.kind !== participant.kind || !isMainSessionParticipant(conversation.metadata, participant.id)) {
      return undefined;
    }
    const session = await this.chat.memberSessions.newSessionForParticipant(participant);
    return { ...session, sessionId: origin.sessionId, importIntroPending: true };
  }

  /** `folder`: where the chat works when the thread's own folder is gone. */
  async createImportedConversation(thread: ImportedThread, folder?: string): Promise<Conversation> {
    if (this.chat.host.machineRuntime) {
      throw new Error("A chat is imported on the User's computer.");
    }
    const repoPath = (folder?.trim() || thread.folder).trim();
    if (!repoPath || !existsSync(repoPath)) {
      throw new Error("Choose a folder for this thread: the one it ran in is gone.");
    }
    const [created] = await this.chat.creation.ensureMainSessionParticipant([], thread.kind, {
      repoPath,
      newChatDefaults: true,
      requested: {
        handle: MAIN_SESSION_HANDLE,
        roleConfigId: MAIN_SESSION_ROLE_ID,
        kind: thread.kind,
        ...(thread.model ? { model: thread.model } : {}),
        ...(normalizeChatReasoningEffort(thread.reasoningEffort, thread.kind) ? { reasoningEffort: normalizeChatReasoningEffort(thread.reasoningEffort, thread.kind) } : {})
      }
    });
    if (!created) {
      throw new Error("Could not make the imported chat.");
    }
    const importedAt = new Date().toISOString();
    const mainSession: ChatParticipant = {
      ...created,
      importOrigin: { kind: thread.kind, sessionId: thread.sessionId, folder: thread.folder, title: thread.title, importedAt }
    };
    const history = importedHistory(thread, mainSession);
    const notice: ChatImportNotice = {
      kind: thread.kind,
      importedAt,
      messageCount: history.length,
      ...(history[0] ? { firstAt: history[0].createdAt } : {}),
      ...(history.length ? { lastAt: history[history.length - 1]!.createdAt } : {})
    };
    // Dated before the oldest imported message: every device orders the
    // timeline by time (the phone too), and this line opens it.
    const openingAt = history[0] ? new Date(Date.parse(history[0].createdAt) - 1).toISOString() : importedAt;
    const intro = { ...createChatMessage("system", chatIntro([mainSession]), undefined, { threadId: "system" }), createdAt: openingAt };
    const noticeMessage: ChatMessage = {
      ...createChatMessage("system", importNoticeText(notice), undefined, { importNotice: notice }),
      createdAt: openingAt
    };
    const messages = [intro, noticeMessage, ...history];
    const conversation: Conversation = {
      id: randomUUID(),
      title: thread.title.trim() || `${cliProviderMetadata(thread.kind).label} thread`,
      kind: "chat",
      createdAt: importedAt,
      // Listed where the thread's last turn was, as the CLI's resume list
      // orders it, not all at the import.
      updatedAt: notice.lastAt ?? importedAt,
      repoPath,
      messages,
      findings: [],
      metadata: {
        participants: [mainSession],
        participantSessions: [],
        warnings: [],
        running: false,
        mainSessionParticipantId: mainSession.id,
        chatView: DEFAULT_CHAT_VIEW
      }
    };
    // The session already holds the history: its first turn is not given it
    // again as chat context (a long thread would not even fit agy's argv).
    const last = messages[messages.length - 1]!;
    const pointers = {};
    setPromptContextPointerForScope(pointers, mainSession.id, { type: "timeline" }, {
      messageId: last.id,
      sequence: messages.length - 1,
      createdAt: last.createdAt
    });
    conversation.metadata = { ...conversation.metadata, promptContextPointers: pointers };
    rebuildLastMessagesByParticipant(conversation);
    const logPayload = { ...chatCreateLogPayload(conversation), importedKind: thread.kind, importedMessages: history.length };
    await this.deps.debugLogs.write("chat.import.save-started", logPayload).catch(() => undefined);
    await this.chat.store.saveImportedConversation(conversation);
    await this.deps.debugLogs.write("chat.import.saved", logPayload).catch(() => undefined);
    return conversation;
  }
}

/** The thread's questions and answers as chat messages: the User's are hers,
 *  with no addressee (a historical message asks no turn of anyone); the
 *  answers are the main session's, and one that ended a turn carries the
 *  CLI's point there. */
function importedHistory(thread: ImportedThread, mainSession: ChatParticipant): ChatMessage[] {
  const cuts = thread.kind === "claude-code" || thread.kind === "codex-cli";
  const messages: ChatMessage[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const entry of thread.entries) {
    const pictures = entry.imageCount && entry.imageCount > 0 ? Array.from({ length: entry.imageCount }, () => IMAGE_PLACEHOLDER).join("\n") : "";
    const content = [entry.text.trim(), pictures].filter(Boolean).join("\n\n");
    if (!content) continue;
    // Strictly after the message before: an older Codex thread gives a turn's
    // question and answer one time, and devices order a timeline by time.
    const parsed = Date.parse(entry.at);
    const time = Math.max(Number.isFinite(parsed) ? parsed : Date.now(), previous + 1);
    previous = time;
    const at = new Date(time).toISOString();
    if (entry.role === "user") {
      messages.push({ id: randomUUID(), role: "user", content, createdAt: at, status: "done" });
      continue;
    }
    messages.push({
      id: randomUUID(),
      role: "participant",
      participantId: mainSession.id,
      participantLabel: `@${mainSession.handle}`,
      content,
      createdAt: at,
      status: "done",
      ...(cuts && entry.cut ? { metadata: { sessionCut: { sessionId: thread.sessionId, at: entry.cut } } } : {})
    });
  }
  return messages;
}

/** The import line's words, the same on every device (its fields say it too). */
export function importNoticeText(notice: ChatImportNotice): string {
  const label = cliProviderMetadata(notice.kind).label;
  const day = (iso: string | undefined): string | undefined => iso
    ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
    : undefined;
  const span = notice.firstAt && notice.lastAt ? `, ${day(notice.firstAt)} to ${day(notice.lastAt)}` : "";
  const count = `${notice.messageCount} message${notice.messageCount === 1 ? "" : "s"}`;
  return `Imported from ${label} on ${day(notice.importedAt)}: ${count}${span}. Tool steps and pictures stay in the session and are not shown here. Your next message continues the same session.`;
}
