import type { AppSettings, ChatParticipantConfig, ChatProviderKind } from "../../../shared/types";
import { chatReasoningEffortLabel } from "../../../shared/reasoningEffort";
import { Avatar } from "../avatar/avatar";
import { avatarForChatParticipant } from "../chat/chat-avatars";
import { chatRoleLabel, participantProviderLabel } from "../chat/chat-conversation-data";
import { participantModeLabel, participantPermissionChips, participantRules, providerClass } from "./participant-settings-utils";

export function AvatarStack({ participants, max = 3 }: { participants: ChatParticipantConfig[]; max?: number }): JSX.Element {
  const shown = participants.slice(0, max);
  const remaining = participants.length - shown.length;
  return (
    <span className="participants-avatar-stack" aria-hidden>
      {shown.map((participant) => (
        <span className="participants-avatar-stack-item" key={participant.id}>
          <Avatar
            className="participants-mini-avatar"
            spec={avatarForChatParticipant(participant, `@${participant.handle}`)}
            tooltip={null}
          />
        </span>
      ))}
      {remaining > 0 && <span className="participants-avatar-stack-more">+{remaining}</span>}
    </span>
  );
}

export function ParticipantPresetCard(props: {
  participant: ChatParticipantConfig;
  settings: AppSettings;
  onOpen: () => void;
}): JSX.Element {
  const roleLabel = chatRoleLabel(props.settings.chatRoleConfigs, props.participant);
  const roleArchived = Boolean(
    props.settings.chatRoleConfigs.find((role) => role.id === props.participant.roleConfigId)?.archivedAt
  );
  const rules = participantRules(props.settings, props.participant);
  const permissionChips = participantPermissionChips(props.participant);
  return (
    <button
      type="button"
      className="participant-preset-card"
      data-testid={`settings-participant-card-${props.participant.id}`}
      onClick={props.onOpen}
    >
      <div className="participant-preset-card-head">
        <Avatar
          className="participants-card-avatar"
          spec={avatarForChatParticipant(props.participant, `@${props.participant.handle}`)}
        />
        <span className="participant-preset-title">
          <strong>@{props.participant.handle}</strong>
          <small>
            {roleLabel}
            {roleArchived && <span className="participant-role-archived-badge">Archived role</span>}
          </small>
        </span>
      </div>

      <dl className="participant-preset-facts">
        <ParticipantFact
          label="Provider"
          value={participantProviderLabel(props.participant.kind)}
          providerKind={props.participant.kind}
        />
        <ParticipantFact label="Model" value={props.participant.model?.trim() || "CLI default"} />
        <ParticipantFact
          label="Reasoning"
          value={props.participant.reasoningEffort ? chatReasoningEffortLabel(props.participant.reasoningEffort) : "Default"}
        />
        <ParticipantFact label="Mode" value={participantModeLabel(props.participant)} />
      </dl>

      {(permissionChips.length > 0 || rules.length > 0) && <span className="participant-preset-divider" />}

      {permissionChips.length > 0 && (
        <ParticipantChipBlock title="Permissions" chips={permissionChips.map((chip) => chip.label)} />
      )}
      {rules.length > 0 && (
        <ParticipantChipBlock title="Rules" chips={rules.map((rule) => rule.label)} />
      )}
    </button>
  );
}

function ParticipantFact(props: {
  label: string;
  value: string;
  providerKind?: ChatProviderKind;
}): JSX.Element {
  return (
    <div className="participant-preset-fact">
      <dt>{props.label}</dt>
      <dd className={props.providerKind ? `participant-provider-value ${providerClass(props.providerKind)}` : undefined}>
        {props.providerKind && <span className="participant-provider-dot" aria-hidden />}
        {props.value}
      </dd>
    </div>
  );
}

function ParticipantChipBlock(props: { title: string; chips: string[] }): JSX.Element {
  return (
    <div className="participant-chip-block">
      <span>{props.title}</span>
      <div className="participant-chip-list">
        {props.chips.map((chip) => (
          <strong className="participant-chip" key={chip}>{chip}</strong>
        ))}
      </div>
    </div>
  );
}

