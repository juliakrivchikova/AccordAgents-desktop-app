import { useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, X } from "lucide-react";

import { firstTextLine, memberRunningSince, type SessionsWorkStatus } from "../../../shared/mainSessionView";
import type { AppSettings, ChatImageInput, ChatMessage, ChatParticipant, ChatSkillMention, RepoFileMention } from "../../../shared/types";
import { MarkdownText } from "../content/markdown-text";
import { chatParticipantDisplayName } from "../conversation/conversation-display";
import { TimelineLoadMoreRow } from "../conversation/timeline-primitives";
import { IconButton } from "../primitives";
import { ChatComposer } from "./chat-composer";
import { renderComposerMemberMark } from "./chat-member-mark";
import { chatRoleLabel, participantProviderLabel } from "./chat-mention-directory";
import { ChatMessageItem } from "./chat-message-item";
import { ChatElapsed, ChatWorkStatusLabel } from "./chat-task-card";
import { ProviderIcon } from "./provider-icon";

type ChatMessageItemProps = ComponentProps<typeof ChatMessageItem>;

/** What a member panel's composer sends: to that member only. */
export interface ChatMemberSendRequest {
  content: string;
  repoFileMentions?: RepoFileMention[];
  imageAttachments?: ChatImageInput[];
  skillMentions?: ChatSkillMention[];
  targetParticipantIds: string[];
}

/**
 * One member's whole session in the sessions view's right panel: its task
 * folded to one line, its replies, its questions and the main session's
 * answers, the User's messages to it, and a composer that writes to it only.
 */
export function ChatMemberSessionPanel(props: {
  participant: ChatParticipant;
  mainSessionId: string;
  status: SessionsWorkStatus;
  runIds: readonly string[];
  messages: readonly ChatMessage[];
  allMessages: readonly ChatMessage[];
  messageProps: (message: ChatMessage) => ChatMessageItemProps;
  participants: ChatParticipant[];
  settings: AppSettings;
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
  const { participant } = props;
  const name = chatParticipantDisplayName(participant);
  const provider = [participantProviderLabel(participant.kind, participant.hostLabel), participant.model].filter(Boolean).join(" · ");
  const since = props.status === "running" ? memberRunningSince(participant.id, props.allMessages) : undefined;
  const bodyRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);
  const last = props.messages[props.messages.length - 1];
  useLayoutEffect(() => {
    stuckRef.current = true;
  }, [participant.id]);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body && stuckRef.current) {
      body.scrollTop = body.scrollHeight;
    }
  }, [participant.id, props.messages.length, last?.content.length, last?.status]);

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
    const sent = await props.onSend({ content, repoFileMentions, imageAttachments, skillMentions, targetParticipantIds: [participant.id] });
    if (sent) {
      props.onDraftChange("");
      stuckRef.current = true;
    }
    return sent;
  }

  return (
    <section className="chat-thread-panel chat-member-session-panel" aria-label={`${name} session`} data-testid="chat-member-session-panel" data-participant-id={participant.id}>
      <header className="thread-panel-head chat-thread-head chat-member-session-head" data-titlebar>
        <div>
          <IconButton icon={ArrowLeft} label="Back to members" tooltip="Back to members" data-testid="chat-member-session-back" onClick={props.onBack} />
          <ProviderIcon className="chat-provider-icon" kind={participant.kind} label={participantProviderLabel(participant.kind, participant.hostLabel)} />
          <span className="chat-member-session-title">
            <h2>{name}</h2>
            <span className="chat-member-session-provider">{provider}</span>
          </span>
          <ChatWorkStatusLabel status={props.status} />
          {since && <ChatElapsed className="chat-members-row-elapsed" since={since} />}
        </div>
        <div className="thread-panel-actions">
          {props.onStopRuns && props.runIds.length > 0 && (
            <IconButton tone="danger" icon={X} label={`Stop ${name}`} tooltip={`Stop ${name}`} data-testid="chat-member-session-stop" onClick={() => props.onStopRuns?.(props.runIds)} />
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
          const task = taskFor(message, participant.id);
          if (task) {
            return <ChatMemberTaskFold key={message.id} message={message} prompt={task.prompt} fromMain={task.requester === props.mainSessionId} requesterHandle={task.requesterHandle} />;
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
      <ChatComposer
        className="chat-thread-composer chat-member-composer"
        participants={props.participants}
        savedPrompts={props.settings.chatSavedPrompts}
        conversationId={props.conversationId}
        dictationSession={`${props.conversationId}:member:${participant.id}`}
        repoPath={props.repoPath}
        draft={props.draft}
        onDraftChange={props.onDraftChange}
        onSend={send}
        isRunning={props.busy}
        placeholder={`Message ${name}...`}
        testId="chat-member-composer"
        renderParticipantAvatar={renderComposerMemberMark}
        participantRoleLabel={(item) => chatRoleLabel(props.settings.chatRoleConfigs, item)}
      />
    </section>
  );
}

/** The task a request message gives this member, unless the member asked it. */
function taskFor(message: ChatMessage, participantId: string): { prompt: string; requester: string; requesterHandle: string } | undefined {
  const batch = message.metadata?.participantRequest;
  if (!batch || batch.requesterParticipantId === participantId) return undefined;
  const item = batch.items.find((candidate) => candidate.targetParticipantId === participantId);
  return item ? { prompt: item.prompt, requester: batch.requesterParticipantId, requesterHandle: batch.requesterHandle } : undefined;
}

/** The task the member was given, folded to one line; opens to the whole. */
export function ChatMemberTaskFold(props: { message: ChatMessage; prompt: string; fromMain: boolean; requesterHandle: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const label = props.fromMain ? "Task from the main session" : `Task from @${props.requesterHandle.replace(/^@/, "")}`;
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
}
