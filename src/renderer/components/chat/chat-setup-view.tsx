import type { Dispatch, ReactNode, SetStateAction } from "react";
import {
  CheckCircle2,
  FolderOpen,
  Play,
  Plus,
  RefreshCw,
  Users,
  X,
  XCircle
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FormRow,
  IconButton
} from "../primitives";
import type {
  AgentHealth,
  AppSettings,
  ChatParticipantConfig,
  GitRepoInfo
} from "../../../shared/types";
import {
  chatParticipantConfigToDraft,
  chatParticipantPermissionSummary,
  labelForProviderKind,
  selectedChatParticipantDrafts,
  validateChatCliAgents,
  validateChatParticipantDrafts,
  validateChatStartupDrafts
} from "./chat-participant-drafts";

export function ChatSetup(props: {
  title: string;
  repoPath: string;
  repoInfo?: GitRepoInfo;
  selectedParticipantIds: Set<string>;
  settings: AppSettings;
  agents: AgentHealth[];
  busy: boolean;
  renderParticipantAvatar: (participant: ChatParticipantConfig) => ReactNode;
  participantRoleLabel: (participant: ChatParticipantConfig) => string;
  onTitleChange: (value: string) => void;
  onRepoPathChange: (value: string) => void;
  onRepoBlur: () => void;
  onSelectRepo: () => void;
  onSelectedParticipantIdsChange: Dispatch<SetStateAction<Set<string>>>;
  onOpenParticipantsSettings: () => void;
  onStart: () => void;
}): JSX.Element {
  const normalizedDrafts = selectedChatParticipantDrafts(props.settings.chatParticipantConfigs, props.selectedParticipantIds);
  const validation = validateChatStartupDrafts(normalizedDrafts, props.settings.chatRoleConfigs, props.agents, props.settings.chatBehaviorRules);
  const allParticipantIds = props.settings.chatParticipantConfigs
    .filter((participant) => {
      const draft = chatParticipantConfigToDraft(participant);
      return !(validateChatParticipantDrafts([draft], props.settings.chatRoleConfigs, new Set(), props.settings.chatBehaviorRules) ?? validateChatCliAgents([draft], props.agents));
    })
    .map((participant) => participant.id);
  return (
    <div className="chat-setup">
      <FormRow label="Chat title">
        <Input value={props.title} onChange={(event) => props.onTitleChange(event.target.value)} />
      </FormRow>
      <div className="flex items-end gap-2">
        <FormRow label="Repository" optional className="flex-1">
          <Input
            value={props.repoPath}
            data-testid="chat-repo-input"
            onChange={(event) => props.onRepoPathChange(event.target.value)}
            onBlur={props.onRepoBlur}
          />
        </FormRow>
        <IconButton
          size="sm"
          icon={FolderOpen}
          label="Select repository"
          tooltip="Select repository"
          variant="outline"
          onClick={props.onSelectRepo}
        />
      </div>
      {props.repoInfo && (
        <div className={`repo-status ${props.repoInfo.isRepo ? "ok" : "bad"}`}>
          {props.repoInfo.isRepo ? (
            <>
              <CheckCircle2 size={16} />
              {props.repoInfo.currentBranch || "detached"} · {props.repoInfo.statusLines.length} changed paths
            </>
          ) : (
            <>
              <XCircle size={16} />
              {props.repoInfo.error || "Not a git repository"}
            </>
          )}
        </div>
      )}
      <div className="chat-roster-editor">
        <div className="settings-section-head">
          <h2>Participants</h2>
          <div className="settings-item-actions">
            <Button variant="outline" size="sm" onClick={() => props.onSelectedParticipantIdsChange(new Set(allParticipantIds))}>
              <Users size={16} />
              Select all
            </Button>
            <Button variant="outline" size="sm" onClick={() => props.onSelectedParticipantIdsChange(new Set())}>
              <X size={16} />
              Clear
            </Button>
            <Button variant="outline" size="sm" onClick={props.onOpenParticipantsSettings}>
              <Plus size={16} />
              New participant
            </Button>
          </div>
        </div>
        {props.settings.chatParticipantConfigs.length === 0 ? (
          <div className="empty-state">
            No saved participants yet. Start chat to use @admin, or create reusable participants in Settings.
          </div>
        ) : (
          <div className="chat-participant-select-list">
            {props.settings.chatParticipantConfigs.map((participant) => {
              const draft = chatParticipantConfigToDraft(participant);
              const invalidReason = validateChatParticipantDrafts([draft], props.settings.chatRoleConfigs, new Set(), props.settings.chatBehaviorRules) ?? validateChatCliAgents([draft], props.agents);
              const selected = props.selectedParticipantIds.has(participant.id);
              return (
                <label className={`saved-participant-option ${selected ? "selected" : ""} ${invalidReason ? "disabled" : ""}`} key={participant.id}>
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={Boolean(invalidReason)}
                    onChange={(event) => {
                      props.onSelectedParticipantIdsChange((current) => {
                        const next = new Set(current);
                        if (event.target.checked) {
                          next.add(participant.id);
                        } else {
                          next.delete(participant.id);
                        }
                        return next;
                      });
                    }}
                  />
                  {props.renderParticipantAvatar(participant)}
                  <strong>@{participant.handle}</strong>
                  <span>{props.participantRoleLabel(participant)} · {labelForProviderKind(props.settings.providers, participant.kind)} · {chatParticipantPermissionSummary(participant)}</span>
                  {invalidReason && <small>{invalidReason}</small>}
                </label>
              );
            })}
          </div>
        )}
      </div>
      {validation && <div className="inline-error">{validation}</div>}
      <Button className="w-full" disabled={props.busy || Boolean(validation)} onClick={props.onStart}>
        {props.busy ? <RefreshCw size={17} className="spin" /> : <Play size={17} />}
        {props.busy ? "Starting chat..." : "Start chat"}
      </Button>
    </div>
  );
}
