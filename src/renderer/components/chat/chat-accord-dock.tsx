import { useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import type { AccordLaunchCard } from "../../../shared/accordLaunchCard";
import {
  accordProgressNoteHead, accordProgressStages, accordProgressStatus, type AccordProgress, type AccordStage, type AccordStepState
} from "../../../shared/accordProgress";
import type { ChatParticipant } from "../../../shared/types";
import type { DockedAccord } from "./use-accord-progress";
import { ArtifactsContext } from "../artifacts/artifacts-context";
import { Avatar, avatarForParticipant } from "../avatar/avatar";
import { IconButton } from "../primitives";
import { AccordMergeIcon } from "./accord-merge-icon";
import {
  accordDockClosed, accordDockFolded, accordDockVersion, setAccordDockChoice, subscribeAccordDock
} from "./accord-dock-store";
import { avatarForChatParticipant } from "./chat-avatars";

// The chat's newest Accord, pinned above the composer (the User, 2026-11-08):
// where it stands, with every member's draft and signature, the current
// version's note and Open for the whole document. It stays until the User
// closes it or a new Accord starts; its head folds it into one line. Both are
// this device's own choice (accord-dock-store.ts).

/** Closed and folded, for the Accord the dock shows: a newer Accord in the
 *  chat opens again, unfolded. */
function useDockChoice(launchId: string) {
  useSyncExternalStore(subscribeAccordDock, accordDockVersion);
  return {
    closed: accordDockClosed(launchId),
    folded: accordDockFolded(launchId),
    close: () => setAccordDockChoice("closed", launchId, true),
    setFolded: (folded: boolean) => setAccordDockChoice("folded", launchId, folded)
  };
}

function StageMark(props: { state: AccordStepState }): JSX.Element {
  return (
    <span className={`chat-accord-progress-mark is-${props.state}`} aria-hidden="true">
      {props.state === "done" && <Check size={12} strokeWidth={3} />}
    </span>
  );
}

function memberAvatar(handle: string, participants?: ChatParticipant[]) {
  const label = `@${handle}`;
  const participant = participants?.find((item) => item.handle.toLowerCase() === handle.toLowerCase());
  return participant ? avatarForChatParticipant(participant, label) : avatarForParticipant(label);
}

function Stage(props: { stage: AccordStage; participants?: ChatParticipant[] }): JSX.Element {
  const { stage } = props;
  return (
    <li className={`chat-accord-progress-stage is-${stage.state}`}>
      <StageMark state={stage.state} />
      <span className="chat-accord-progress-stage-text">
        <span className="chat-accord-progress-label">{stage.label}</span>
        {stage.detail && <span className="chat-accord-progress-detail">{stage.detail}</span>}
        {stage.members.length > 0 && (
          <span className="chat-accord-progress-members">
            {stage.members.map((member) => (
              <span
                key={member.handle}
                className={`chat-accord-progress-member${member.given ? " is-given" : member.waiting ? " is-waiting" : ""}`}
              >
                <span aria-hidden="true" className="chat-accord-progress-avatar-slot">
                  <Avatar className="chat-accord-progress-avatar" spec={memberAvatar(member.handle, props.participants)} tooltip={null} />
                </span>
                <span>@{member.handle}</span>
                {member.given && <Check className="chat-accord-progress-member-check" size={12} strokeWidth={3} aria-label="done" />}
              </span>
            ))}
          </span>
        )}
      </span>
    </li>
  );
}

export function ChatAccordDock(props: {
  conversationId: string;
  launchId: string;
  card: AccordLaunchCard;
  progress: AccordProgress;
  participants?: ChatParticipant[];
}): JSX.Element | null {
  const { progress, card } = props;
  const artifacts = useContext(ArtifactsContext);
  const choice = useDockChoice(props.launchId);
  if (choice.closed) {
    return null;
  }
  const title = artifacts?.byId.get(progress.artifactId)?.name ?? progress.title;
  const { version } = progress;
  const folded = choice.folded;
  return (
    <section
      className={`chat-accord-dock${progress.reached ? " is-reached" : ""}${folded ? " is-folded" : ""}`}
      aria-label="Accord"
      data-testid="chat-accord-dock"
    >
      <div className="chat-accord-dock-head">
        <button
          type="button"
          className="chat-accord-dock-toggle"
          aria-expanded={!folded}
          title={folded ? "Show the Accord's steps" : "Fold into one line"}
          onClick={() => choice.setFolded(!folded)}
        >
          <span className="chat-accord-dock-icon" aria-hidden="true">
            <AccordMergeIcon className="chat-accord-dock-glyph" />
          </span>
          <span className="chat-accord-dock-heading">
            <span className="chat-accord-dock-title">{title}</span>
            {!folded && (
              <span className="chat-accord-dock-meta">
                <span className="chat-accord-dock-kind">Accord</span>
                {` · led by @${card.facilitator} · with ${card.members.map((handle) => `@${handle}`).join(", ")}`}
              </span>
            )}
          </span>
          <span className="chat-accord-progress-status">{accordProgressStatus(progress)}</span>
          <ChevronDown className="chat-accord-dock-chevron" size={16} aria-hidden="true" />
        </button>
        <IconButton className="chat-accord-dock-close" size="xs" label="Close" icon={X} onClick={choice.close} />
      </div>
      {!folded && (
        <>
          <ol className="chat-accord-progress-stages" aria-label="Accord progress">
            {accordProgressStages(progress).map((stage) => <Stage key={stage.key} stage={stage} participants={props.participants} />)}
          </ol>
          {version && (
            <div className="chat-accord-progress-note">
              <span className="chat-accord-progress-note-text">
                <span className="chat-accord-progress-note-head">{accordProgressNoteHead(version)}</span>
                {version.note && <span className="chat-accord-progress-note-body">{version.note}</span>}
              </span>
              <button
                type="button"
                className="chat-accord-progress-open"
                title={`Open "${title}"`}
                onClick={() => artifacts?.openArtifact(progress.artifactId)}
              >
                Open
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Where the pinned Accord goes, between the timeline and the composer. The
 *  timeline's own floating controls (`children`, the jump to the latest
 *  message) keep to the timeline, just above the card. */
export function ChatAccordDockSlot(props: {
  docked?: DockedAccord;
  conversationId: string;
  participants?: ChatParticipant[];
  /** The reader is at the latest message: keep her there as the card's
   *  height changes (it appears, folds, grows a stage). */
  keepAtLatest?: () => void;
  children?: ReactNode;
}): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  const keepAtLatest = useRef(props.keepAtLatest);
  keepAtLatest.current = props.keepAtLatest;
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return undefined;
    let height = wrap.offsetHeight;
    // It just appeared above the composer: the timeline got shorter.
    keepAtLatest.current?.();
    const observer = new ResizeObserver(() => {
      if (wrap.offsetHeight === height) return;
      height = wrap.offsetHeight;
      keepAtLatest.current?.();
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [Boolean(props.docked)]);
  if (!props.docked) {
    return <>{props.children}</>;
  }
  return (
    <div className="chat-accord-dock-wrap" ref={wrapRef}>
      {props.children}
      <ChatAccordDock
        key={props.docked.launchId}
        conversationId={props.conversationId}
        launchId={props.docked.launchId}
        card={props.docked.card}
        progress={props.docked.progress}
        participants={props.participants}
      />
    </div>
  );
}
