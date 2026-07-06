import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { CheckCircle2, Copy, Minimize2 } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { AgentContextUsage } from "../../../shared/types";
import { formatContextUsageLabel } from "../../../shared/agentContext";
import { Avatar } from "../avatar/avatar";
import type { AvatarSpec } from "../chat/chat-avatars";
import { IconButton } from "../primitives";

// One detail line shown in a participant hover card.
export interface ParticipantDetailRow {
  label: string;
  value: string;
}

// Profile shown when hovering a mention pill or an agent avatar (Slack-style hover card).
// `rows` carries Role / Provider / Mode / Context; `sessionId` is rendered separately with a
// copy affordance; `avatar` is shown in the header.
export interface ParticipantProfile {
  participantId?: string;
  handle: string;
  rows: ParticipantDetailRow[];
  sessionId?: string;
  avatar?: AvatarSpec;
}

export interface ParticipantCompactContext {
  threadId?: string;
  parentMessageId?: string;
  chatThreadRootId?: string;
}

export type ParticipantCompactHandler = (
  participantId: string,
  context?: ParticipantCompactContext
) => void | Promise<boolean>;

// Lowercased handle -> hover-card profile. Only handles present here render as highlighted
// pills; everything else (and any view without a provider, e.g. plan/review) stays plain text.
export const MentionDirectoryContext = createContext<ReadonlyMap<string, ParticipantProfile> | undefined>(undefined);

// Hover-open / grace-delay-close behaviour shared by the mention pill and the avatar trigger,
// so a hover card stays open while the cursor travels from the trigger onto the card.
export function useHoverCard(): {
  open: boolean;
  setOpen: (value: boolean) => void;
  openCard: () => void;
  scheduleClose: () => void;
} {
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<number>();

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== undefined) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  function openCard(): void {
    if (closeTimerRef.current !== undefined) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    }
    setOpen(true);
  }

  function scheduleClose(): void {
    if (closeTimerRef.current !== undefined) {
      window.clearTimeout(closeTimerRef.current);
    }
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 120);
  }

  return { open, setOpen, openCard, scheduleClose };
}

// The card body (avatar + handle header, detail rows, copyable session). Goes inside a
// PopoverContent with the `chat-mention-card` class.
export function ParticipantHoverCard(props: {
  profile: ParticipantProfile;
  compactDisabled?: boolean;
  compactContext?: ParticipantCompactContext;
  onCompactParticipant?: ParticipantCompactHandler;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const profile = props.profile;
  const sessionId = profile.sessionId?.trim();

  async function copySession(event: MouseEvent<HTMLButtonElement>): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (!sessionId) {
      return;
    }
    await navigator.clipboard.writeText(sessionId);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  function compactParticipant(event: MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
    event.stopPropagation();
    if (!profile.participantId || props.compactDisabled) {
      return;
    }
    void props.onCompactParticipant?.(profile.participantId, props.compactContext);
  }

  return (
    <>
      <div className="chat-mention-card-head">
        {profile.avatar && <Avatar className="chat-mention-card-avatar" spec={profile.avatar} tooltip={null} />}
        <div className="chat-mention-card-handle">{profileHandleLabel(profile.handle)}</div>
        {profile.participantId && props.onCompactParticipant && (
          <IconButton
            className="chat-mention-card-compact"
            size="xs"
            icon={Minimize2}
            label={`Compact ${profileHandleLabel(profile.handle)} context`}
            tooltip="Compact this member's underlying session to free context."
            disabled={props.compactDisabled}
            onClick={(event) => compactParticipant(event)}
          />
        )}
      </div>
      {profile.rows.map((row) => (
        <div className="chat-mention-card-row" key={row.label}>
          <span>{row.label}</span>
          <strong title={row.value}>{row.value}</strong>
        </div>
      ))}
      <div className="chat-mention-card-row session">
        <span>Session</span>
        <code title={sessionId}>{sessionId ?? "Not started yet"}</code>
        <button
          type="button"
          className="chat-mention-card-copy"
          disabled={!sessionId}
          title={copied ? "Copied session ID" : "Copy session ID"}
          aria-label={copied ? "Copied session ID" : "Copy session ID"}
          onClick={(event) => void copySession(event)}
        >
          {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
        </button>
      </div>
    </>
  );
}

// An agent avatar that reveals the shared hover card. Uses the conversation's mention directory
// for the full profile (role/provider/mode/context/session); falls back to whatever this message
// carries when the handle has no directory entry (e.g. the arbiter or a removed participant).
export function AgentAvatarWithDetails(props: {
  className: string;
  spec: AvatarSpec;
  contextUsage?: AgentContextUsage;
  sessionId?: string;
  handle?: string;
  compactDisabled?: boolean;
  compactContext?: ParticipantCompactContext;
  onCompactParticipant?: ParticipantCompactHandler;
}): JSX.Element {
  const directory = useContext(MentionDirectoryContext);
  const { open, setOpen, openCard, scheduleClose } = useHoverCard();
  const profile = (props.handle ? directory?.get(props.handle.toLowerCase()) : undefined) ?? fallbackProfile(props);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="agent-avatar-wrap"
          aria-label={`${props.spec.label} avatar details`}
          onMouseEnter={openCard}
          onMouseLeave={scheduleClose}
          onFocus={openCard}
          onBlur={scheduleClose}
        >
          <Avatar className={props.className} spec={props.spec} tooltip={null} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="chat-mention-card"
        side="bottom"
        align="start"
        sideOffset={8}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onMouseEnter={openCard}
        onMouseLeave={scheduleClose}
        onFocus={openCard}
        onBlur={scheduleClose}
      >
        <ParticipantHoverCard
          profile={profile}
          compactDisabled={props.compactDisabled}
          compactContext={props.compactContext}
          onCompactParticipant={props.onCompactParticipant}
        />
      </PopoverContent>
    </Popover>
  );
}

function fallbackProfile(props: { spec: AvatarSpec; contextUsage?: AgentContextUsage; sessionId?: string; handle?: string }): ParticipantProfile {
  const rows: ParticipantProfile["rows"] = [];
  if (props.contextUsage) {
    rows.push({ label: "Context", value: formatContextUsageLabel(props.contextUsage) });
  }
  return { handle: props.handle ?? props.spec.label, rows, sessionId: props.sessionId, avatar: props.spec };
}

export function profileHandleLabel(handle: string): string {
  const trimmed = handle.trim();
  if (!trimmed || trimmed.startsWith("@") || trimmed.includes(" ")) {
    return trimmed;
  }
  return `@${trimmed}`;
}
