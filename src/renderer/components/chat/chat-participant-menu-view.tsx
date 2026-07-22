import React, { useState } from "react";
import { ChevronLeft, ChevronRight, Plus, UserPlus, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type {
  ChatParticipant,
  ChatParticipantConfig,
  ChatRoleParticipantDefaults,
  ChatParticipantWatcherState,
  CloudRunRemoteExecutionMode
} from "../../../shared/types";
import { CHAT_ASSISTANT_ROLE_ID, chatParticipantMentionHandle } from "../conversation/conversation-display";
import {
  CHAT_RUN_LOCATION_OPTIONS,
  chatRunLocationLabel,
  normalizeChatRunLocation,
  type AddableSavedParticipantConfig
} from "./chat-participant-drafts";
import { ChatParticipantRosterRow } from "./chat-participant-roster-row";
import type { ChatParticipantRosterStatus } from "./chat-roster-status";

export interface ChatParticipantMenuViewProps {
  participants: ChatParticipant[];
  participantHasRunById: ReadonlyMap<string, boolean>;
  draft: string;
  addValidation?: string;
  isRunning: boolean;
  participantStatusById: ReadonlyMap<string, ChatParticipantRosterStatus>;
  participantWatchers?: Record<string, ChatParticipantWatcherState>;
  addParticipantEditor: React.ReactNode;
  savedParticipants: AddableSavedParticipantConfig[];
  hasSavedParticipantConfigs: boolean;
  renderParticipantAvatar: (participant: ChatParticipant) => React.ReactNode;
  renderSavedParticipantAvatar: (participant: ChatParticipantConfig) => React.ReactNode;
  participantRoleLabel: (participant: ChatParticipant) => string;
  participantRoleArchived: (participant: ChatParticipant) => boolean;
  participantRoleDefaults: (participant: ChatParticipant) => ChatRoleParticipantDefaults | undefined;
  savedParticipantRoleLabel: (participant: ChatParticipantConfig) => string;
  savedParticipantSummary: (participant: ChatParticipantConfig) => string;
  onDraftChange: (value: string) => void;
  onAddParticipant: () => void;
  onAddSavedParticipant: (participant: ChatParticipantConfig, remoteExecution?: CloudRunRemoteExecutionMode) => void;
  onUpdateParticipantRuntime: (
    participantId: string,
    patch: Pick<ChatParticipant, "model" | "reasoningEffort" | "agentMode" | "permissions" | "remoteExecution" | "skipToolchainPreflight" | "autoWatch">
  ) => void;
  onCompactParticipant: (participantId: string) => void;
  onRemoveParticipant: (participantId: string) => void;
  onJumpToParticipantLastMessage: (participantId: string) => void;
  onManageInSettings: () => void;
}

export function ChatParticipantMenuView(props: ChatParticipantMenuViewProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"roster" | "create">("roster");
  const [showSaved, setShowSaved] = useState(false);
  const [savedRunLocations, setSavedRunLocations] = useState<Record<string, CloudRunRemoteExecutionMode>>({});
  const participantCountLabel = `${props.participants.length} ${props.participants.length === 1 ? "member" : "members"}`;
  const activeWatcher = props.participants.find((participant) => participant.autoWatch === true);

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (!next) {
      setView("roster");
      setShowSaved(false);
    }
  }

  function insertParticipantMention(participant: ChatParticipant): void {
    const handle = chatParticipantMentionHandle(participant, props.participants);
    props.onDraftChange(`${props.draft}${props.draft.endsWith(" ") || !props.draft ? "" : " "}@${handle} `);
    setOpen(false);
  }

  function jumpToParticipantLastMessage(participant: ChatParticipant): void {
    props.onJumpToParticipantLastMessage(participant.id);
    setOpen(false);
  }

  function participantRemoveDisabledReason(participant: ChatParticipant): string | undefined {
    if (props.isRunning) {
      return "Members cannot be removed while a turn is running";
    }
    if (participant.id === props.participants.find((item) => item.roleConfigId === CHAT_ASSISTANT_ROLE_ID)?.id) {
      return "Chat Assistant cannot be removed";
    }
    if (props.participants.length <= 1) {
      return "The last member cannot be removed";
    }
    return undefined;
  }

  function savedRunLocation(participant: ChatParticipantConfig): CloudRunRemoteExecutionMode {
    return normalizeChatRunLocation(savedRunLocations[participant.id] ?? participant.remoteExecution);
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          title="Members"
          aria-label={participantCountLabel}
          data-testid="chat-participants-trigger"
          className="chat-participants-trigger h-8 min-w-0 gap-2 rounded-full pl-1 pr-2.5 text-xs"
        >
          {props.participants.length > 0 ? (
            <span className="chat-roster-avatars" aria-hidden>
              {props.participants.slice(0, 4).map((participant) => (
                <span className="chat-roster-avatar" key={participant.handle}>
                  {props.renderParticipantAvatar(participant)}
                </span>
              ))}
            </span>
          ) : (
            <Users size={15} aria-hidden />
          )}
          <span className="tabular-nums">{props.participants.length}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        data-testid="chat-participants-popover"
        className="chat-participant-popover w-[min(560px,calc(100vw-32px))] max-h-[min(640px,calc(100vh-96px))] overflow-auto p-3"
      >
        {view === "create" ? (
          <div className="chat-participant-create">
            <div className="chat-participant-create-head">
              <button
                type="button"
                className="chat-participant-back"
                onClick={() => setView("roster")}
                aria-label="Back to members"
              >
                <ChevronLeft size={16} aria-hidden />
              </button>
              <span className="chat-popover-section-title">New member</span>
            </div>
            {props.addParticipantEditor}
            {props.addValidation && <div className="inline-error">{props.addValidation}</div>}
            <div className="chat-participant-create-actions">
              <Button variant="ghost" size="sm" onClick={() => setView("roster")}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={Boolean(props.addValidation) || props.isRunning}
                onClick={() => {
                  props.onAddParticipant();
                  setView("roster");
                }}
              >
                <Plus size={16} />
                Add to chat
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-1">
              {props.participants.map((participant) => (
                <ChatParticipantRosterRow
                  key={participant.id}
                  participant={participant}
                  removeDisabledReason={participantRemoveDisabledReason(participant)}
                  isRunning={props.isRunning}
                  status={props.participantStatusById.get(participant.id) ?? "idle"}
                  autoWatchDisabledReason={
                    activeWatcher && activeWatcher.id !== participant.id
                      ? "Only one member can watch a chat. Turn off the current watcher first."
                      : undefined
                  }
                  autoWatchPausedReason={props.participantWatchers?.[participant.id]?.pausedReason}
                  roleParticipantDefaults={props.participantRoleDefaults(participant)}
                  renderParticipantAvatar={props.renderParticipantAvatar}
                  participantRoleLabel={props.participantRoleLabel}
                  participantRoleArchived={props.participantRoleArchived}
                  runLocationLocked={props.participantHasRunById.get(participant.id) === true}
                  onInsertMention={insertParticipantMention}
                  onJumpToLastMessage={jumpToParticipantLastMessage}
                  onUpdateParticipantRuntime={props.onUpdateParticipantRuntime}
                  onCompactParticipant={props.onCompactParticipant}
                  onRemoveParticipant={props.onRemoveParticipant}
                />
              ))}
            </div>
            <button
              type="button"
              className="chat-addsaved-toggle"
              aria-expanded={showSaved}
              onClick={() => setShowSaved((value) => !value)}
            >
              <Plus size={15} aria-hidden className="chat-addsaved-plus" />
              Add a saved member
              <ChevronRight size={15} aria-hidden className={`chat-addsaved-chev${showSaved ? " is-open" : ""}`} />
            </button>
            {showSaved && (
              props.savedParticipants.length === 0 ? (
                <div className="chat-saved-participants-empty">
                  {props.hasSavedParticipantConfigs ? "All saved members are already in this chat." : "No saved members configured."}
                </div>
              ) : (
                <div className="chat-saved-participant-list">
                  {props.savedParticipants.map(({ config, invalidReason }) => (
                    <div className={`chat-saved-participant-row ${invalidReason ? "disabled" : ""}`} key={config.id}>
                      {props.renderSavedParticipantAvatar(config)}
                      <span className="chat-saved-participant-main">
                        <strong>@{config.handle}</strong>
                        <span>{props.savedParticipantRoleLabel(config)} · {props.savedParticipantSummary(config)}</span>
                        {invalidReason && <small>{invalidReason}</small>}
                      </span>
                      {config.kind === "codex-cli" && (
                        <label className="chat-saved-run-location" title={`Run ${chatRunLocationLabel(savedRunLocation(config)).toLowerCase()}`}>
                          <span>Run</span>
                          <select
                            aria-label={`Run location for @${config.handle}`}
                            value={savedRunLocation(config)}
                            disabled={Boolean(invalidReason) || props.isRunning}
                            onChange={(event) => {
                              const remoteExecution = event.currentTarget.value as CloudRunRemoteExecutionMode;
                              setSavedRunLocations((current) => ({
                                ...current,
                                [config.id]: normalizeChatRunLocation(remoteExecution)
                              }));
                            }}
                          >
                            {CHAT_RUN_LOCATION_OPTIONS.map((option) => (
                              <option value={option.value} key={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </label>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={Boolean(invalidReason) || props.isRunning}
                        onClick={() => props.onAddSavedParticipant(config, savedRunLocation(config))}
                      >
                        <Plus size={16} />
                        Add
                      </Button>
                    </div>
                  ))}
                </div>
              )
            )}
            <div className="chat-participant-footer">
              <Button variant="outline" size="sm" disabled={props.isRunning} onClick={() => setView("create")}>
                <UserPlus size={16} />
                New member
              </Button>
              <span className="chat-participant-footer-spacer" />
              <button type="button" className="chat-manage-link" onClick={props.onManageInSettings}>
                Manage in settings
              </button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
