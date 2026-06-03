import React, { useState } from "react";
import { Plus, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { AgentHealth, AppSettings, ChatParticipant } from "../../../shared/types";
import { Avatar } from "../avatar/avatar";
import {
  avatarForChatAvatarOption,
  avatarForChatParticipant
} from "./chat-avatars";
import { chatRoleLabel } from "./chat-conversation-data";
import { ChatParticipantDraftRow } from "./chat-participant-draft-row";
import type { ChatParticipantDraft } from "./chat-participant-drafts";
import {
  normalizedChatDrafts,
  validateChatCliAgents,
  validateChatParticipantDrafts
} from "./chat-participant-drafts";

export interface ChatParticipantMenuViewProps {
  participants: ChatParticipant[];
  draft: string;
  addValidation?: string;
  isRunning: boolean;
  addParticipantEditor: React.ReactNode;
  renderParticipantAvatar: (participant: ChatParticipant) => React.ReactNode;
  participantRoleLabel: (participant: ChatParticipant) => string;
  onDraftChange: (value: string) => void;
  onAddParticipant: () => void;
}

export function ChatParticipantMenu(props: {
  participants: ChatParticipant[];
  settings: AppSettings;
  agents: AgentHealth[];
  draft: string;
  addParticipantDraft: ChatParticipantDraft;
  isRunning: boolean;
  onDraftChange: (value: string) => void;
  onAddParticipantDraftChange: (draft: ChatParticipantDraft) => void;
  onAddParticipant: () => void;
}): JSX.Element {
  const addDraft = normalizedChatDrafts([props.addParticipantDraft]);
  const addValidation = validateChatParticipantDrafts(
    addDraft,
    props.settings.chatRoleConfigs,
    new Set(props.participants.map((participant) => participant.handle.toLowerCase())),
    props.settings.chatBehaviorRules
  ) ?? validateChatCliAgents(addDraft, props.agents);

  return (
    <ChatParticipantMenuView
      participants={props.participants}
      draft={props.draft}
      addValidation={addValidation}
      isRunning={props.isRunning}
      renderParticipantAvatar={(participant) => <Avatar className="mini-avatar" spec={avatarForChatParticipant(participant)} />}
      participantRoleLabel={(participant) => chatRoleLabel(props.settings.chatRoleConfigs, participant)}
      addParticipantEditor={(
        <ChatParticipantDraftRow
          draft={props.addParticipantDraft}
          settings={props.settings}
          agents={props.agents}
          renderAvatarOption={(option) => <Avatar className="avatar-choice-preview" spec={avatarForChatAvatarOption(option)} />}
          onChange={props.onAddParticipantDraftChange}
        />
      )}
      onDraftChange={props.onDraftChange}
      onAddParticipant={props.onAddParticipant}
    />
  );
}

export function ChatParticipantMenuView(props: ChatParticipantMenuViewProps): JSX.Element {
  const [open, setOpen] = useState(false);

  function insertParticipantMention(participant: ChatParticipant): void {
    props.onDraftChange(`${props.draft}${props.draft.endsWith(" ") || !props.draft ? "" : " "}@${participant.handle} `);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          title="Participants"
          aria-label={`${props.participants.length} participants`}
          data-testid="chat-participants-trigger"
          className="chat-participants-trigger h-7 min-w-0 gap-1.5 px-2 text-xs"
        >
          <Users size={15} aria-hidden />
          <span className="tabular-nums">{props.participants.length}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        data-testid="chat-participants-popover"
        className="chat-participant-popover w-[min(560px,calc(100vw-32px))] max-h-[min(640px,calc(100vh-96px))] overflow-auto p-3"
      >
        <div className="grid gap-1">
          {props.participants.map((participant) => (
            <button
              type="button"
              onClick={() => insertParticipantMention(participant)}
              key={participant.id}
              className="grid min-h-11 w-full grid-cols-[32px_minmax(0,1fr)] items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--app-text)] transition-colors hover:bg-[var(--app-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {props.renderParticipantAvatar(participant)}
              <span className="grid min-w-0 gap-0.5">
                <strong className="min-w-0 truncate text-[var(--app-text-strong)]">@{participant.handle}</strong>
                <span className="min-w-0 truncate text-xs text-[var(--app-muted)]">{props.participantRoleLabel(participant)}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="chat-menu-divider" />
        {props.addParticipantEditor}
        {props.addValidation && <div className="inline-error">{props.addValidation}</div>}
        <Button variant="outline" size="sm" disabled={Boolean(props.addValidation) || props.isRunning} onClick={props.onAddParticipant}>
          <Plus size={16} />
          Add participant
        </Button>
      </PopoverContent>
    </Popover>
  );
}
