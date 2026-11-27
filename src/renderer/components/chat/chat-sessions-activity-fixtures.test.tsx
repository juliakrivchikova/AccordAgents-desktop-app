// Shared by the sessions view's reply tests (chat-sessions-activity.test.tsx,
// chat-live-steps.test.tsx): a sessions timeline row rendered with its
// member's progress, and what its steps look like.
import { act, create, type ReactTestInstance } from "react-test-renderer";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatAgentActivityEvent, ChatMessage, Conversation } from "../../../shared/types";
import { ChatMessageItem } from "./chat-message-item";
import { ChatSessionsPresentationContext } from "./chat-member-mark";
import type { ChatParticipantRosterStatus } from "./chat-roster-status";
import { ChatSessionsTimelineRow } from "./chat-sessions-timeline-row";
import { useChatSessionsView, type ChatSessionsView } from "./use-chat-sessions-view";
import { DREW, GERA, MAIN, PARTICIPANTS, TAYLOR, disclosure } from "./chat-sessions-fixtures.test";

export const noop = (): void => undefined;
export const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
export const hasClass = (name: string) => (node: ReactTestInstance): boolean =>
  typeof node.type === "string" && typeof node.props.className === "string" && node.props.className.split(/\s+/).includes(name);

/** The main session on Codex: its steps are a row each (a Claude Code
 *  member's are folded, below). */
export const CODEX_MAIN = PARTICIPANTS.map((item) => item.id === MAIN.id ? { ...item, kind: "codex-cli" as const } : item);

export const STATUSES = new Map<string, ChatParticipantRosterStatus>([[DREW.id, "running"], [GERA.id, "idle"], [TAYLOR.id, "pending"]]);

export function sessionsOf(conversation: Conversation): ChatSessionsView {
  let result: ChatSessionsView | undefined;
  function Harness(): null {
    result = useChatSessionsView({
      conversation,
      view: "sessions",
      participants: conversation.metadata.participants as typeof PARTICIPANTS,
      participantStatusById: STATUSES
    });
    return null;
  }
  const renderer = create(<Harness />);
  renderer.unmount();
  return result!;
}

export function itemProps(message: ChatMessage, extra: Partial<Parameters<typeof ChatMessageItem>[0]> = {}): Parameters<typeof ChatMessageItem>[0] {
  return {
    activityDisclosure: disclosure(),
    message,
    conversationId: "chat-sessions",
    participants: CODEX_MAIN,
    participantStatusById: STATUSES,
    busy: false,
    onOpenThread: noop,
    onApproveMentions: noop,
    onRejectMentions: noop,
    onRespondToChoice: noop,
    onToggleReaction: noop,
    ...extra
  };
}

export function renderSessionsRow(message: ChatMessage, sessions: ChatSessionsView, extra: Partial<Parameters<typeof ChatMessageItem>[0]> = {}): ReactTestInstance {
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
        <ChatSessionsPresentationContext.Provider value>
          <ChatSessionsTimelineRow itemProps={itemProps(message, extra)} context={{ sessions, onOpenMember: noop, onOpenTask: noop }} />
        </ChatSessionsPresentationContext.Provider>
      </TooltipProvider>
    );
  });
  return renderer!.root;
}

export const activity = (id: string, kind: ChatAgentActivityEvent["kind"], label: string, afterContentLength: number, detail?: string): ChatAgentActivityEvent =>
  ({ id, sequence: Number(id.replace(/\D/g, "")) || 1, kind, label, createdAt: new Date().toISOString(), afterContentLength, ...(detail ? { detail } : {}) });

/** A turn as T3 Code's work log shows it: thinking, a search, a command, a read, an edit, another tool. */
export function workEvents(): ChatAgentActivityEvent[] {
  return [
    activity("a1", "tool", "Thinking", 0, "I need the current exchange rate, so I'll run a standard web search."),
    activity("a2", "web", "Using web search", 0, "EUR to USD exchange rate today"),
    activity("a3", "command", "Running command", 0, "npm test -- --grep login\nsecond line"),
    activity("a4", "tool", "Reading file", 0, "src/login.ts"),
    activity("a5", "file-edit", "Updating files", 0, "src/login.css"),
    activity("a6", "tool", "Using mcp__accord_agents__app_chat_get_context", 0)
  ];
}

/** The live line of a running reply: its kind, its words, whether it shimmers and is open. */
export const liveLineOf = (root: ReactTestInstance): string[] => root.findAll((node) => typeof node.type === "string" && node.props["data-testid"] === "chat-live-step")
  .map((node) => [node.props["data-activity-kind"], textOf(node), node.props.className.includes("is-current") ? "current" : "", node.props["aria-expanded"] ? "open" : "folded"])[0] ?? [];
export const pressLiveLine = (root: ReactTestInstance): void => {
  const line = root.find((node) => node.type === "button" && node.props["data-testid"] === "chat-live-step");
  act(() => line.props.onClick());
};

export const rowsOf = (root: ReactTestInstance): string[][] => root.findAll((node) => typeof node.type === "string" && node.props["data-testid"] === "chat-sessions-activity-row")
  .map((node) => [node.props["data-activity-kind"], textOf(node), node.props.className.includes("is-current") ? "current" : ""]);

export const WORK_ROWS = [
  ["thinking", "I need the current exchange rate, so I'll run a standard web search."],
  ["web", "EUR to USD exchange rate today"],
  ["shell", "npm test -- --grep login"],
  ["read", "src/login.ts"],
  ["edit", "src/login.css"],
  ["tool", "Using mcp__accord_agents__app_chat_get_context"]
];

/** A long turn: `count` steps, each a command. */
export function manySteps(count: number): ChatAgentActivityEvent[] {
  return Array.from({ length: count }, (_, index) => activity(`s${index + 1}`, "command", "Running command", 0, `step ${index + 1}`));
}
