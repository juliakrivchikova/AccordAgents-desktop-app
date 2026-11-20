import { memo, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, X } from "lucide-react";

import { SESSIONS_REMOVED_MEMBER_DETAIL, firstTextLine, type SessionsWorkStatus } from "../../../shared/mainSessionView";
import type { AppSettings, ChatImageInput, ChatMessage, ChatParticipant, ChatSkillMention, RepoFileMention } from "../../../shared/types";
import { MarkdownText } from "../content/markdown-text";
import { TimelineLoadMoreRow } from "../conversation/timeline-primitives";
import { IconButton } from "../primitives";
import { ChatComposer } from "./chat-composer";
import { ChatProviderMark, renderComposerMemberMark } from "./chat-member-mark";
import { ChatMessageItem } from "./chat-message-item";
import { ChatElapsed, ChatWorkStatusLabel } from "./chat-task-card";

type ChatMessageItemProps = ComponentProps<typeof ChatMessageItem>;

/** What a member panel's composer sends: to that member only. */
export interface ChatMemberSendRequest {
  content: string;
  repoFileMentions?: RepoFileMention[];
  imageAttachments?: ChatImageInput[];
  skillMentions?: ChatSkillMention[];
  targetParticipantIds: string[];
}

/** Who a member's session is of: a member, or one no longer in the chat. */
export interface ChatSessionMember {
  id: string;
  kind?: ChatParticipant["kind"];
  hostLabel?: string;
}

const NO_MENTIONS: ChatParticipant[] = [];
const FOCUS_HIGHLIGHT_MS = 1600;

/**
 * One member's whole session in the sessions view's right panel: its task
 * folded to one line, its replies, its questions and the main session's
 * answers, the User's messages to it, and a composer that writes to it only.
 * A member no longer in the chat is read-only: no composer, no Stop. Opened
 * from a task or a mention, it shows the message that was about.
 */
export function ChatMemberSessionPanel(props: {
  member: ChatSessionMember;
  /** Its task's title and the line under it (provider, model, role). */
  title: string;
  detail: string;
  readOnly: boolean;
  focus?: { messageId: string; nonce: number };
  mainSessionId: string;
  status: SessionsWorkStatus;
  runningSince?: string;
  runIds: readonly string[];
  messages: readonly ChatMessage[];
  messageProps: (message: ChatMessage) => ChatMessageItemProps;
  appSettings: AppSettings;
  /** Its settings control (a gear opening its model, effort, mode, rights,
   *  where it runs, remove). */
  settings?: ReactNode;
  /** Its model chip in the composer (opens the same settings). */
  chip?: ReactNode;
  conversationId: string;
  repoPath?: string;
  draft: string;
  busy: boolean;
  hasOlderMessages: boolean;
  olderMessagesLoading: boolean;
  onLoadOlderMessages: () => void;
  onDraftChange: (value: string) => void;
  onSend: (request: ChatMemberSendRequest) => Promise<boolean>;
  onStopRuns?: (runIds: readonly string[]) => void;
  onBack: () => void;
  onClose: () => void;
}): JSX.Element {
  const { member } = props;
  const since = props.status === "running" ? props.runningSince : undefined;
  const bodyRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);
  const focusedNonceRef = useRef<number | undefined>();
  const last = props.messages[props.messages.length - 1];
  useLayoutEffect(() => {
    stuckRef.current = true;
  }, [member.id]);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const focus = props.focus;
    if (body && focus && focusedNonceRef.current !== focus.nonce) {
      const target = body.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(focus.messageId)}"]`);
      if (target) {
        focusedNonceRef.current = focus.nonce;
        stuckRef.current = false;
        target.scrollIntoView?.({ block: "center" });
        target.classList.add("message-focused");
        window.setTimeout(() => target.classList.remove("message-focused"), FOCUS_HIGHLIGHT_MS);
        return;
      }
    }
    if (body && stuckRef.current) {
      body.scrollTop = body.scrollHeight;
    }
  }, [member.id, props.focus?.nonce, props.messages.length, last?.content.length, last?.status]);

  async function send(
    repoFileMentions: RepoFileMention[] = [],
    imageAttachments: ChatImageInput[] = [],
    skillMentions: ChatSkillMention[] = [],
    contentOverride?: string
  ): Promise<boolean> {
    const content = (contentOverride ?? props.draft).trim();
    if (!content && imageAttachments.length === 0 && skillMentions.length === 0) {
      return false;
    }
    const sent = await props.onSend({ content, repoFileMentions, imageAttachments, skillMentions, targetParticipantIds: [member.id] });
    if (sent) {
      props.onDraftChange("");
      stuckRef.current = true;
    }
    return sent;
  }

  return (
    <section className="chat-thread-panel chat-member-session-panel" aria-label={`${props.title} session`} data-testid="chat-member-session-panel" data-participant-id={member.id} data-read-only={props.readOnly || undefined}>
      <header className="thread-panel-head chat-thread-head chat-member-session-head" data-titlebar>
        <div>
          <IconButton icon={ArrowLeft} label="Back to members" tooltip="Back to members" data-testid="chat-member-session-back" onClick={props.onBack} />
          {member.kind && <ChatProviderMark member={{ kind: member.kind, hostLabel: member.hostLabel }} />}
          <span className="chat-member-session-title">
            <h2>{props.title}</h2>
            {props.detail && <span className="chat-member-session-provider">{props.detail}</span>}
          </span>
          {props.status !== "idle" && <ChatWorkStatusLabel status={props.status} />}
          {since && <ChatElapsed className="chat-members-row-elapsed" since={since} />}
        </div>
        <div className="thread-panel-actions">
          {props.settings}
          {!props.readOnly && props.onStopRuns && props.runIds.length > 0 && (
            <IconButton tone="danger" icon={X} label={`Stop ${props.title}`} tooltip="Stop" data-testid="chat-member-session-stop" onClick={() => props.onStopRuns?.(props.runIds)} />
          )}
          <IconButton icon={X} label="Close member" tooltip="Close" onClick={props.onClose} />
        </div>
      </header>
      <div
        className="chat-thread-body chat-member-session-body"
        ref={bodyRef}
        onScroll={(event) => {
          const body = event.currentTarget;
          stuckRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 96;
        }}
      >
        {props.hasOlderMessages && (
          <TimelineLoadMoreRow loading={props.olderMessagesLoading} disabled={props.olderMessagesLoading} onClick={props.onLoadOlderMessages} />
        )}
        {props.messages.length === 0 && <p className="chat-members-empty">Nothing in this session yet.</p>}
        {props.messages.map((message) => {
          const task = taskFor(message, member.id);
          if (task) {
            return <ChatMemberTaskFold key={message.id} message={message} prompt={task.prompt} fromMain={task.requester === props.mainSessionId} />;
          }
          const itemProps = props.messageProps(message);
          return (
            <ChatMessageItem
              key={message.id}
              {...itemProps}
              presentation="sessions"
              authorLabel={message.role === "participant" && message.participantId === props.mainSessionId ? "Main session" : undefined}
              onOpenThread={undefined}
            />
          );
        })}
      </div>
      {props.readOnly ? (
        <p className="chat-member-session-gone" data-testid="chat-member-session-gone">{SESSIONS_REMOVED_MEMBER_DETAIL}. Its session stays here to read.</p>
      ) : (
        <ChatComposer
          className="chat-thread-composer chat-member-composer"
          participants={NO_MENTIONS}
          savedPrompts={props.appSettings.chatSavedPrompts}
          conversationId={props.conversationId}
          dictationSession={`${props.conversationId}:member:${member.id}`}
          repoPath={props.repoPath}
          draft={props.draft}
          onDraftChange={props.onDraftChange}
          onSend={send}
          isRunning={props.busy}
          placeholder={`Message ${props.title}...`}
          footerChip={props.chip}
          testId="chat-member-composer"
          renderParticipantAvatar={renderComposerMemberMark}
          participantRoleLabel={() => ""}
        />
      )}
    </section>
  );
}

/** The task a request message gives this member, unless the member asked it. */
function taskFor(message: ChatMessage, participantId: string): { prompt: string; requester: string } | undefined {
  const batch = message.metadata?.participantRequest;
  if (!batch || batch.requesterParticipantId === participantId) return undefined;
  const item = batch.items.find((candidate) => candidate.targetParticipantId === participantId);
  return item ? { prompt: item.prompt, requester: batch.requesterParticipantId } : undefined;
}

/** The task the member was given, folded to one line; opens to the whole. */
export const ChatMemberTaskFold = memo(function ChatMemberTaskFold(props: { message: ChatMessage; prompt: string; fromMain: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const label = props.fromMain ? "Task from the main session" : "Task from another member";
  const preview = useMemo(() => firstTextLine(props.prompt), [props.prompt]);
  return (
    <div className={`chat-member-task ${open ? "is-open" : ""}`} data-message-id={props.message.id} data-testid="chat-member-task">
      <button type="button" className="chat-member-task-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        <span className="chat-member-task-label">{label}</span>
        {!open && <span className="chat-member-task-preview">{preview}</span>}
      </button>
      {open && (
        <div className="chat-member-task-body">
          <MarkdownText content={props.prompt} />
        </div>
      )}
    </div>
  );
});
