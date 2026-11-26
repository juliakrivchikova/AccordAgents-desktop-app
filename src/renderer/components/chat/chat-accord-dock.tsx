import { Fragment, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { CheckIcon, CaretDownIcon, CaretRightIcon, XIcon } from "@phosphor-icons/react";
import {
  accordProgressNoteHead, accordProgressStages, accordProgressStatus, type AccordStage, type AccordStepState
} from "../../../shared/accordProgress";
import type { AccordLaunchCard } from "../../../shared/accordLaunchCard";
import type { MachineListResult } from "../../../shared/machineLink";
import type { ChatParticipant } from "../../../shared/types";
import type { DockedAccord } from "./use-accord-progress";
import { ArtifactsContext } from "../artifacts/artifacts-context";
import { avatarForParticipant } from "../avatar/avatar";
import { IconButton } from "../primitives";
import { AccordMergeIcon } from "./accord-merge-icon";
import {
  accordDockClosing, accordDockFolded, accordDockVersion, setAccordDockClosing, setAccordDockFolded, subscribeAccordDock
} from "./accord-dock-store";
import { avatarForChatParticipant } from "./chat-avatars";
import { ChatMemberMark } from "./chat-member-mark";
import { useChatSessionsLinks, useSessionsViewText } from "./chat-sessions-links";
import { useMachineList } from "./use-cli-start-defaults";
import { useMemberModelSummary } from "./use-member-model-summary";

// The chat's newest Accord, pinned above the composer (the User, 2026-11-08):
// where it stands, with every member's draft and signature, the current
// version's note and Open for the whole document. Its head folds it into one
// line (this device's own choice, accord-dock-store.ts). Its cross folds it
// into a line at the end of the chat as it stands then, on every device (the
// User, 2026-11-16): the line opens the same card there, and its cross folds
// it back (ChatAccordClosedLine). In the sessions view (docs/main-session.md)
// the card is in the right panel (ChatAccordPanel) and above the composer
// stays one line that opens it there (the User, 2026-11-20).

/** Folded, for the Accord the dock shows, and whether its cross was just
 *  pressed here: a newer Accord in the chat shows again, unfolded. */
function useDockChoice(launchId: string) {
  useSyncExternalStore(subscribeAccordDock, accordDockVersion);
  return {
    closing: accordDockClosing(launchId),
    folded: accordDockFolded(launchId),
    setFolded: (folded: boolean) => setAccordDockFolded(launchId, folded)
  };
}

function StageMark(props: { state: AccordStepState }): JSX.Element {
  return (
    <span className={`chat-accord-progress-mark is-${props.state}`} aria-hidden="true">
      {props.state === "done" && <CheckIcon size={12} />}
    </span>
  );
}

function MemberMark(props: { handle: string; participants?: ChatParticipant[] }): JSX.Element | null {
  const label = `@${props.handle}`;
  const participant = props.participants?.find((item) => item.handle.toLowerCase() === props.handle.toLowerCase());
  const avatar = participant ? avatarForChatParticipant(participant, label) : avatarForParticipant(label);
  return <ChatMemberMark className="chat-accord-progress-avatar" markClassName="is-chip" avatar={avatar} member={participant} tooltip={null} />;
}

const handleKey = (handle: string): string => handle.replace(/^@/, "").toLowerCase();

/** The main session in the sessions view, which the card's head names by
 *  nothing (it is the session the card is in). */
function useIsUnnamedMain(): (handle: string) => boolean {
  const links = useChatSessionsLinks();
  return (handle) => Boolean(links?.mainHandle) && handleKey(handle) === links?.mainHandle?.toLowerCase();
}

/** The model a member runs on and its effort, as its composer's chips name
 *  them ("Opus 5.5 Extra High"). */
function MemberModelLabel(props: { member: ChatParticipant; machines: MachineListResult }): JSX.Element {
  const { model, effort } = useMemberModelSummary(props.member, props.machines);
  return <>{effort ? `${model} ${effort}` : model}</>;
}

/** A member's name on an Accord's card: its handle in the classic view; in
 *  the sessions view (no handles there) the model it runs on and its effort
 *  (the User, 2026-11-26), a former member its task's title. */
function AccordMemberName(props: { handle: string; participants?: ChatParticipant[]; machines: MachineListResult }): JSX.Element {
  const links = useChatSessionsLinks();
  const key = handleKey(props.handle);
  if (!links) return <>{`@${props.handle.replace(/^@/, "")}`}</>;
  const member = props.participants?.find((item) => item.handle.toLowerCase() === key);
  if (member) return <MemberModelLabel member={member} machines={props.machines} />;
  return <>{links.byHandle.get(key)?.title ?? props.handle.replace(/^@/, "")}</>;
}

/** What a click on a stage opens: a member's draft, the published version. */
interface StageOpeners {
  draft?: (handle: string) => void;
  version?: () => void;
}

function Stage(props: { stage: AccordStage; participants?: ChatParticipant[]; machines: MachineListResult; open: StageOpeners }): JSX.Element {
  const { stage, open } = props;
  const detail = useSessionsViewText()(stage.detail ?? "");
  const openVersion = stage.key === "publish" ? open.version : undefined;
  return (
    <li className={`chat-accord-progress-stage is-${stage.state}`}>
      <StageMark state={stage.state} />
      <span className="chat-accord-progress-stage-text">
        {openVersion
          ? <button type="button" className="chat-accord-progress-label is-link" onClick={openVersion}><span className="sr-only">Open </span>{stage.label}</button>
          : <span className="chat-accord-progress-label">{stage.label}</span>}
        {detail && <span className="chat-accord-progress-detail">{detail}</span>}
        {stage.members.length > 0 && (
          <span className="chat-accord-progress-members">
            {stage.members.map((member) => {
              const className = `chat-accord-progress-member${member.given ? " is-given" : member.waiting ? " is-waiting" : ""}`;
              const content = (
                <>
                  <span aria-hidden="true" className="chat-accord-progress-avatar-slot">
                    <MemberMark handle={member.handle} participants={props.participants} />
                  </span>
                  <span><AccordMemberName handle={member.handle} participants={props.participants} machines={props.machines} /></span>
                  {member.given && <CheckIcon className="chat-accord-progress-member-check" size={12} aria-label="done" />}
                </>
              );
              // A submitted draft opens in the document's panel (the User, 2026-11-26).
              const openDraft = stage.key === "drafts" && member.given ? open.draft : undefined;
              return openDraft
                ? (
                  <button key={member.handle} type="button" className={`${className} is-link`} onClick={() => openDraft(member.handle)}>
                    <span className="sr-only">Open the draft of </span>
                    {content}
                  </button>
                )
                : <span key={member.handle} className={className}>{content}</span>;
            })}
          </span>
        )}
      </span>
    </li>
  );
}

/** The Accord's name: its document's, as the artifacts know it now, or as
 *  its newest note gave it. */
export function accordDisplayTitle(
  artifacts: { byId: ReadonlyMap<string, { name: string }> } | undefined,
  progress: Pick<DockedAccord["progress"], "artifactId" | "title">
): string {
  return artifacts?.byId.get(progress.artifactId)?.name ?? progress.title;
}

/** The Accord's card: its head (which folds it into one line), its stages
 *  and the current version's note with Open. Pinned above the composer,
 *  opened from the line a closed Accord left in the chat, and whole in the
 *  sessions view's right panel (no fold, no cross there). */
export function ChatAccordCard(props: {
  launch: DockedAccord;
  participants?: ChatParticipant[];
  folded: boolean;
  onToggleFold?: () => void;
  closeLabel?: string;
  onClose?: () => void;
}): JSX.Element {
  const { progress } = props.launch;
  const artifacts = useContext(ArtifactsContext);
  const title = accordDisplayTitle(artifacts, progress);
  const { version } = progress;
  const folded = props.folded;
  const appText = useSessionsViewText();
  const machines = useMachineList();
  // A member's draft and the published version open in the document's panel
  // (the User, 2026-11-26).
  const open: StageOpeners = artifacts
    ? {
        draft: (handle) => artifacts.openArtifact(progress.artifactId, { draftAuthor: handle }),
        ...(version ? { version: () => artifacts.openArtifact(progress.artifactId, { version: version.number }) } : {})
      }
    : {};
  return (
    <section
      className={`chat-accord-dock${progress.reached ? " is-reached" : ""}${folded ? " is-folded" : ""}`}
      aria-label="Accord"
      data-testid="chat-accord-dock"
    >
      <div className="chat-accord-dock-head">
        {props.onToggleFold ? (
          <button
            type="button"
            className="chat-accord-dock-toggle"
            aria-expanded={!folded}
            title={folded ? "Show the Accord's steps" : "Fold into one line"}
            onClick={props.onToggleFold}
          >
            <AccordHeading launch={props.launch} title={title} folded={folded} participants={props.participants} machines={machines} />
            <CaretDownIcon className="chat-accord-dock-chevron" size={16} aria-hidden="true" />
          </button>
        ) : (
          <div className="chat-accord-dock-toggle is-static">
            <AccordHeading launch={props.launch} title={title} folded={folded} participants={props.participants} machines={machines} />
          </div>
        )}
        {props.onClose && (
          <IconButton className="chat-accord-dock-close" size="xs" label={props.closeLabel ?? "Close"} icon={XIcon} onClick={props.onClose} />
        )}
      </div>
      {!folded && (
        <>
          <ol className="chat-accord-progress-stages" aria-label="Accord progress">
            {accordProgressStages(progress).map((stage) => <Stage key={stage.key} stage={stage} participants={props.participants} machines={machines} open={open} />)}
          </ol>
          {version && (
            <div className="chat-accord-progress-note">
              <span className="chat-accord-progress-note-text">
                <span className="chat-accord-progress-note-head">{appText(accordProgressNoteHead(version))}</span>
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

/** " · led by X · with Y, Z": the main session in the sessions view is
 *  left out (named by nothing there). */
function AccordHeadingPeople(props: { card: AccordLaunchCard; participants?: ChatParticipant[]; machines: MachineListResult }): JSX.Element {
  const unnamed = useIsUnnamedMain();
  const { card } = props;
  const members = card.members.filter((handle) => !unnamed(handle));
  const name = (handle: string): JSX.Element => <AccordMemberName handle={handle} participants={props.participants} machines={props.machines} />;
  return (
    <>
      {!unnamed(card.facilitator) && <> · led by {name(card.facilitator)}</>}
      {members.length > 0 && (
        <> · with {members.map((handle, index) => <Fragment key={handle}>{index > 0 && ", "}{name(handle)}</Fragment>)}</>
      )}
    </>
  );
}

function AccordHeading(props: {
  launch: DockedAccord;
  title: string;
  folded: boolean;
  participants?: ChatParticipant[];
  machines: MachineListResult;
}): JSX.Element {
  const { card, progress } = props.launch;
  return (
    <>
      <span className="chat-accord-dock-icon" aria-hidden="true">
        <AccordMergeIcon className="chat-accord-dock-glyph" />
      </span>
      <span className="chat-accord-dock-heading">
        <span className="chat-accord-dock-title">{props.title}</span>
        {!props.folded && (
          <span className="chat-accord-dock-meta">
            <span className="chat-accord-dock-kind">Accord</span>
            <AccordHeadingPeople card={card} participants={props.participants} machines={props.machines} />
          </span>
        )}
      </span>
      <span className="chat-accord-progress-status">{accordProgressStatus(progress)}</span>
    </>
  );
}

/** An Accord in one line: "Accord · its name · where it stands ›". Above the
 *  composer in the sessions view, and at the top of its members panel; it
 *  opens the Accord in the right panel. */
export function ChatAccordRow(props: { launch: DockedAccord; open?: boolean; testId: string; onOpen: () => void }): JSX.Element {
  const artifacts = useContext(ArtifactsContext);
  const title = accordDisplayTitle(artifacts, props.launch.progress);
  return (
    <button
      type="button"
      className="chat-accord-row"
      aria-pressed={props.open}
      title={`Open the Accord "${title}"`}
      data-testid={props.testId}
      data-launch-id={props.launch.launchId}
      onClick={props.onOpen}
    >
      <AccordMergeIcon className="chat-accord-row-glyph" />
      <span className="chat-accord-row-kind">Accord</span>
      <span className="chat-accord-row-title">{title}</span>
      <span className="chat-accord-row-status">{accordProgressStatus(props.launch.progress)}</span>
      <CaretRightIcon className="chat-accord-row-chevron" size={14} aria-hidden="true" />
    </button>
  );
}

export function ChatAccordDock(props: {
  conversationId: string;
  launch: DockedAccord;
  participants?: ChatParticipant[];
  /** The sessions view: one line that opens the Accord in the right panel. */
  onOpenInPanel?: (launchId: string) => void;
  panelOpen?: boolean;
}): JSX.Element | null {
  const { launch } = props;
  const choice = useDockChoice(launch.launchId);
  const artifacts = useContext(ArtifactsContext);
  if (choice.closing) {
    return null;
  }
  async function close(): Promise<void> {
    // Gone from above the composer at once; its line and the chat's record
    // of it come with the chat.
    setAccordDockClosing(launch.launchId, true);
    try {
      await window.consensus.closeAccordCard({
        conversationId: props.conversationId,
        launchMessageId: launch.launchId,
        title: accordDisplayTitle(artifacts, launch.progress)
      });
    } catch {
      // Not written: the card stays where it was, for another try.
      setAccordDockClosing(launch.launchId, false);
    }
  }
  if (props.onOpenInPanel) {
    const open = props.onOpenInPanel;
    return (
      <div className="chat-accord-strip" aria-label="Accord" data-testid="chat-accord-strip">
        <ChatAccordRow launch={launch} open={props.panelOpen} testId="chat-accord-strip-open" onOpen={() => open(launch.launchId)} />
        <IconButton className="chat-accord-dock-close" size="xs" label="Close" icon={XIcon} onClick={() => void close()} />
      </div>
    );
  }
  return (
    <ChatAccordCard
      launch={launch}
      participants={props.participants}
      folded={choice.folded}
      onToggleFold={() => choice.setFolded(!choice.folded)}
      closeLabel="Close"
      onClose={() => void close()}
    />
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
  /** The sessions view: the pinned card is one line opening the right panel. */
  onOpenInPanel?: (launchId: string) => void;
  panelLaunchId?: string;
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
        launch={props.docked}
        participants={props.participants}
        onOpenInPanel={props.onOpenInPanel}
        panelOpen={props.panelLaunchId === props.docked.launchId}
      />
    </div>
  );
}
