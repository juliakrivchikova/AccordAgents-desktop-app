import { normalizeChatAgentMode, normalizeChatAgentPermissions } from "../../../shared/agentPermissions";
import {
  applyChatAccessOption,
  chatAccessMenuOptions,
  chatAccessModeSet,
  codexPlanModeOn,
  selectedChatAccessOption,
  withCodexPlanMode,
  type ChatAccessOption
} from "../../../shared/chatAccessModes";
import { memberAsItRunsNow } from "../../../shared/forkToNewChat";
import type { ChatParticipant } from "../../../shared/types";
import type { ChatModelAccessPatch, ChatModelAccessValue } from "./chat-model-access-picker";
import { ComposerMenu, ComposerMenuItem, ComposerMenuNote, ComposerMenuSection } from "./composer-menu";

// The permission mode control under a sessions-view composer and Codex's
// Plan mode beside it (src/shared/chatAccessModes.ts): each CLI's own modes,
// named and described in the vendor's words.

/** The permission mode control: the chosen mode by the CLI's name ("Custom"
 *  for rights set in the classic view), opening its CLI's own list. */
export function ChatAccessControl(props: {
  value: ChatModelAccessValue;
  mainSession?: ChatParticipant;
  disabled?: boolean;
  modesReason?: string;
  onChange: (patch: ChatModelAccessPatch) => unknown;
  testId: string;
}): JSX.Element {
  const { value } = props;
  const set = chatAccessModeSet(value.kind);
  const access = selectedChatAccessOption(value.kind, value.agentMode, value.permissions);
  const label = access?.label ?? "Custom";
  return (
    <ComposerMenu testId={`${props.testId}-mode`} title={`${set.title}: ${label}`} width={320} align="end"
      label={<span className="chat-composer-control-text">{label}</span>}>
      {(close) => (
        <ChatAccessMenu value={value} mainSession={props.mainSession} disabled={props.disabled} modesReason={props.modesReason}
          onSelect={(option) => {
            close();
            if (option.id === access?.id) return;
            props.onChange(applyChatAccessOptionKeepingPlan(value, option));
          }} />
      )}
    </ComposerMenu>
  );
}

/** A CLI's permission modes under its own title, each with the vendor's
 *  description; one a member is held back from is disabled with the reason. */
export function ChatAccessMenu(props: {
  value: ChatModelAccessValue;
  mainSession?: ChatParticipant;
  disabled?: boolean;
  /** Why Codex's Full Access cannot be chosen where it runs. */
  modesReason?: string;
  onSelect: (option: ChatAccessOption) => void;
}): JSX.Element {
  const { value } = props;
  const set = chatAccessModeSet(value.kind);
  const access = selectedChatAccessOption(value.kind, value.agentMode, value.permissions);
  return (
    <ComposerMenuSection label={set.title} testId="chat-access-menu">
      {props.disabled && <ComposerMenuNote testId="chat-access-busy">{TURN_RUNNING_NOTE}</ComposerMenuNote>}
      {!access && (
        <ComposerMenuNote testId="chat-access-custom">Custom access, set in the classic view. Choose a mode to run in the CLI's own.</ComposerMenuNote>
      )}
      {chatAccessMenuOptions(value.kind, access).map((option) => {
        const held = accessHeldReason(value, option, props.mainSession) ??
          (option.agentMode === "full-access" && option.id !== access?.id ? props.modesReason : undefined);
        return (
          <ComposerMenuItem key={option.id} testId="chat-access-option" value={option.id} selected={option.id === access?.id}
            disabled={props.disabled || Boolean(held)} label={option.label} detail={held ?? option.detail}
            onSelect={() => props.onSelect(option)} />
        );
      })}
      {set.note && <ComposerMenuNote testId="chat-access-note">{set.note}</ComposerMenuNote>}
    </ComposerMenuSection>
  );
}

/** Codex's Plan mode, its own toggle beside the permissions (as `/plan` and
 *  Shift+Tab switch it in Codex's terminal); in the CLI's own mode only. */
export function ChatCodexPlanToggle(props: {
  value: ChatModelAccessValue;
  disabled?: boolean;
  /** Why it cannot be turned on where it runs (it can always be turned off). */
  modesReason?: string;
  onChange: (patch: ChatModelAccessPatch) => unknown;
  testId: string;
}): JSX.Element | null {
  const { value } = props;
  const plan = chatAccessModeSet("codex-cli").plan;
  if (!plan || !selectedChatAccessOption(value.kind, value.agentMode, value.permissions)) return null;
  const on = codexPlanModeOn(value.kind, value.agentMode, value.permissions);
  const blocked = !on ? props.modesReason : undefined;
  const title = props.disabled ? `${plan.label}. ${TURN_RUNNING_NOTE}` : blocked ? `${plan.label}. ${blocked}` : plan.label;
  return (
    <button type="button" className={on ? "chat-model-chip chat-composer-toggle is-on" : "chat-model-chip chat-composer-toggle"}
      data-testid={`${props.testId}-plan`} aria-pressed={on} title={title} aria-label={title} disabled={props.disabled || Boolean(blocked)}
      onClick={() => props.onChange(withCodexPlanMode(value.agentMode, value.permissions, !on))}>
      <span className="chat-composer-control-text">{plan.label}</span>
    </button>
  );
}

/** Said in a menu while its member's turn runs: a CLI's settings apply to
 *  its next turn. */
export const TURN_RUNNING_NOTE = "Its turn is running: change this when it ends.";

/** A member's settings with its CLI's mode set to `option`, Codex's Plan
 *  mode kept as it is (a member saved in Plan from before keeps it too). */
export function applyChatAccessOptionKeepingPlan(value: Pick<ChatModelAccessValue, "kind" | "agentMode" | "permissions">, option: ChatAccessOption): ChatModelAccessPatch {
  const applied = applyChatAccessOption(option, value.permissions);
  if (value.kind !== "codex-cli") return applied;
  return withCodexPlanMode(applied.agentMode, applied.permissions, codexPlanModeOn(value.kind, value.agentMode, value.permissions));
}

/** Why a member cannot have this mode: one the main session made never runs
 *  above the main session's mode and rights as they are now
 *  (memberAsItRunsNow); none otherwise. */
export function accessHeldReason(value: ChatModelAccessValue, option: ChatAccessOption, mainSession: ChatParticipant | undefined): string | undefined {
  if (!value.delegatedByParticipantId || !mainSession || !value.id || mainSession.id === value.id) return undefined;
  const applied = applyChatAccessOption(option, value.permissions);
  const member = { ...value, id: value.id, roleConfigId: "", agentMode: applied.agentMode, permissions: applied.permissions } as ChatParticipant;
  const running = memberAsItRunsNow(member, mainSession);
  const held = normalizeChatAgentMode(running.agentMode) !== normalizeChatAgentMode(applied.agentMode) ||
    normalizeChatAgentPermissions(running.permissions).workspaceWrite !== applied.permissions.workspaceWrite;
  if (!held) return undefined;
  const mainMode = selectedChatAccessOption(mainSession.kind, mainSession.agentMode, mainSession.permissions)?.label ?? "Custom";
  return `Not above the main session's mode (${mainMode}).`;
}
