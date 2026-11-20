// A chat with a main session, for the sessions view's tests: the User asks the
// main session, it gives two members tasks, one of them asks it a question and
// is answered, the User writes to that member in its panel, and a third member
// asks the User a choice that is still open.
import type {
  ChatMessage,
  ChatParticipant,
  ChatParticipantRequestBatch,
  ChatParticipantRequestItem,
  Conversation
} from "../../../shared/types";
import type { ChatActivityDisclosureState } from "./use-chat-activity-disclosure";

export const at = (minute: number): string => `2026-11-20T10:${String(minute).padStart(2, "0")}:00.000Z`;

export const member = (id: string, handle: string, roleConfigId = "generic-participant", kind: ChatParticipant["kind"] = "claude-code"): ChatParticipant =>
  ({ id, handle, roleConfigId, kind }) as ChatParticipant;

export const MAIN = member("p-main", "main", "main-session");
export const DREW = member("p-drew", "drew", "generic-participant", "codex-cli");
export const GERA = member("p-gera", "gera");
export const TAYLOR = member("p-taylor", "taylor", "generic-participant", "gemini-cli");
export const PARTICIPANTS = [MAIN, DREW, GERA, TAYLOR];

export function requestItem(target: ChatParticipant, status: ChatParticipantRequestItem["status"], minute: number, extra: Partial<ChatParticipantRequestItem> = {}): ChatParticipantRequestItem {
  return {
    targetParticipantId: target.id,
    targetHandle: target.handle,
    prompt: `Task for ${target.handle}: fix the ${target.handle} part\nwith every detail`,
    status,
    createdAt: at(minute),
    updatedAt: at(minute),
    ...extra
  };
}

export function requestBatch(id: string, requester: ChatParticipant, items: ChatParticipantRequestItem[], extra: Partial<ChatParticipantRequestBatch> = {}): ChatParticipantRequestBatch {
  return {
    id,
    requesterParticipantId: requester.id,
    requesterHandle: requester.handle,
    source: "mcp",
    resumeRequester: true,
    status: "running",
    depth: 1,
    createdAt: items[0]!.createdAt,
    updatedAt: items[0]!.createdAt,
    items,
    ...extra
  };
}

export function chatMessage(id: string, role: ChatMessage["role"], minute: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, content: id, createdAt: at(minute), status: "done", ...extra } as ChatMessage;
}

export function sessionsMessages(): ChatMessage[] {
  return [
    chatMessage("intro", "system", 0, { content: "Chat started." }),
    chatMessage("ask", "user", 1, { content: "Fix the login bug", metadata: { askedParticipantIds: [MAIN.id] } }),
    chatMessage("main-1", "participant", 2, { participantId: MAIN.id, participantLabel: "main", content: "On it, giving the parts to two members." }),
    chatMessage("tasks", "participant", 3, {
      participantId: MAIN.id,
      participantLabel: "main",
      content: "@drew Task\n@gera Task",
      metadata: { participantRequest: requestBatch("b1", MAIN, [requestItem(DREW, "running", 3), requestItem(GERA, "answered", 3, { replyMessageId: "gera-reply" })]) }
    }),
    chatMessage("drew-question", "participant", 4, {
      participantId: DREW.id,
      participantLabel: "drew",
      content: "@main Which config?",
      metadata: { participantRequest: requestBatch("b2", DREW, [requestItem(MAIN, "answered", 4, { prompt: "Which config?", replyMessageId: "main-answer" })]) }
    }),
    chatMessage("main-answer", "participant", 5, { participantId: MAIN.id, participantLabel: "main", content: "Use the staging config." }),
    chatMessage("gera-reply", "participant", 6, { participantId: GERA.id, participantLabel: "gera", content: "Done: the token refresh is fixed\n\nDetails follow." }),
    chatMessage("to-drew", "user", 7, { content: "Also check logout", metadata: { askedParticipantIds: [DREW.id] } }),
    chatMessage("drew-running", "participant", 8, { participantId: DREW.id, participantLabel: "drew", status: "pending", content: "", metadata: { runId: "run-drew" } }),
    chatMessage("taylor-choice", "participant", 9, {
      participantId: TAYLOR.id,
      participantLabel: "taylor",
      content: "Which database should I use?",
      metadata: {
        pendingChoice: {
          id: "choice-1",
          title: "Database",
          question: "Which database?",
          options: [{ id: "pg", label: "Postgres" }, { id: "sqlite", label: "SQLite" }],
          status: "pending"
        }
      }
    })
  ];
}

export function sessionsConversation(overrides: Partial<Conversation["metadata"]> = {}, messages = sessionsMessages()): Conversation {
  return {
    id: "chat-sessions",
    title: "Login bug",
    kind: "chat",
    createdAt: at(0),
    updatedAt: at(9),
    messages,
    findings: [],
    metadata: {
      participants: PARTICIPANTS,
      mainSessionParticipantId: MAIN.id,
      activeRunIds: ["run-drew"],
      running: true,
      ...overrides
    }
  } as Conversation;
}

export function disclosure(): ChatActivityDisclosureState {
  const none = new Set<string>();
  const noop = (): void => undefined;
  return {
    expandedProcessingTranscriptMessageIds: none,
    expandedActivityIds: none,
    fullyExpandedDetailIds: none,
    revealedDetailIds: none,
    toggleProcessingTranscript: noop,
    toggleActivity: noop,
    toggleDetailLength: noop,
    toggleDetailReveal: noop
  };
}
