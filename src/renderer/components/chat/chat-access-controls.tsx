import { useEffect, useRef, useState } from "react";
import { ClipboardList, Eye, Lock, PenLine, ShieldCheck, ShieldOff, SlidersHorizontal, type LucideIcon } from "lucide-react";

import { effectiveChatAgentPermissionsForProvider, normalizeChatAgentMode, normalizeChatAgentPermissions } from "../../../shared/agentPermissions";
import {
  applyChatAccessOption,
  chatAccessMenuOptions,
  chatAccessModeSet,
  codexPlanModeOn,
  FULL_ACCESS_CONFIRMATION,
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
  /** A narrow composer: the mode's icon, its name in the tooltip and menu. */
  iconOnly?: boolean;
}): JSX.Element {
  const { value } = props;
  const set = chatAccessModeSet(value.kind);
  const access = selectedChatAccessOption(value.kind, value.agentMode, value.permissions);
  const label = access?.label ?? "Custom";
  return (
    <ComposerMenu testId={`${props.testId}-mode`} title={`${set.title}: ${label}`} width={320} align="end"
      {...iconTriggerProps(Boolean(props.iconOnly))}
      label={props.iconOnly ? <ComposerControlIcon icon={accessIcon(access)} label={label} /> : <span className="chat-composer-control-text">{label}</span>}>
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

/** A composer control drawn as an icon (a narrow composer): no chevron, its
 *  quieter padding. */
export function iconTriggerProps(iconOnly: boolean): { bare: boolean; triggerClassName?: string } {
  return iconOnly ? { bare: true, triggerClassName: "chat-model-chip composer-menu-trigger is-icon" } : { bare: false };
}

/** A control's value as an icon in a narrow composer; its name stays for
 *  screen readers (the control's tooltip and menu say it too). */
export function ComposerControlIcon(props: { icon: LucideIcon; label: string }): JSX.Element {
  const Icon = props.icon;
  return (
    <span className="chat-composer-control-icon">
      <Icon size={14} aria-hidden />
      <span className="sr-only">{props.label}</span>
    </span>
  );
}

/** A mode's icon, as T3 Code draws its permission modes: a lock for asking
 *  before changes, a pen for edits without asking, a list for planning, a
 *  checked shield for the CLI deciding, a crossed one for Full Access. */
export function accessIcon(option: ChatAccessOption | undefined): LucideIcon {
  if (!option) return SlidersHorizontal;
  if (option.agentMode === "full-access") return ShieldOff;
  if (option.agentMode === "auto") return ShieldCheck;
  if (option.agentMode === "plan") return ClipboardList;
  if (option.id === "read-only") return Eye;
  return option.workspaceWrite ? PenLine : Lock;
}

/** A CLI's permission modes under its own title, each with the vendor's
 *  description; one a member is held back from is disabled with the reason.
 *  Codex's Full Access is asked about first, in Codex's own words. */
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
  const [confirming, setConfirming] = useState<ChatAccessOption>();
  if (confirming) {
    return (
      <FullAccessConfirmation
        disabled={props.disabled}
        onConfirm={() => { if (!props.disabled) props.onSelect(confirming); }}
        onBack={() => setConfirming(undefined)} />
    );
  }
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
            onSelect={() => option.agentMode === "full-access" && option.id !== access?.id ? setConfirming(option) : props.onSelect(option)} />
        );
      })}
      {set.note && <ComposerMenuNote testId="chat-access-note">{set.note}</ComposerMenuNote>}
    </ComposerMenuSection>
  );
}

/** Codex's question before Full Access, in place of its list (Codex 0.155.1's
 *  `/permissions`): only "Yes, continue anyway" switches; "Cancel" goes back
 *  to the list. The keyboard lands on "Yes", as Codex's cursor does. */
function FullAccessConfirmation(props: { disabled?: boolean; onConfirm: () => void; onBack: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus({ preventScroll: true });
  }, []);
  return (
    <div ref={ref} className="composer-menu-confirm" data-testid="chat-full-access-confirm">
      <ComposerMenuSection label={FULL_ACCESS_CONFIRMATION.title} testId="chat-full-access-confirm-section">
        <ComposerMenuNote testId="chat-full-access-confirm-body">{FULL_ACCESS_CONFIRMATION.body}</ComposerMenuNote>
        {props.disabled && <ComposerMenuNote testId="chat-full-access-confirm-busy">{TURN_RUNNING_NOTE}</ComposerMenuNote>}
        <ComposerMenuItem role="menuitem" testId="chat-full-access-confirm-yes" disabled={props.disabled} label={FULL_ACCESS_CONFIRMATION.confirm.label}
          detail={FULL_ACCESS_CONFIRMATION.confirm.detail} onSelect={props.onConfirm} />
        <ComposerMenuItem role="menuitem" testId="chat-full-access-confirm-cancel" label={FULL_ACCESS_CONFIRMATION.cancel.label}
          detail={FULL_ACCESS_CONFIRMATION.cancel.detail} onSelect={props.onBack} />
      </ComposerMenuSection>
    </div>
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
  /** A narrow composer: its icon, its name in the tooltip. */
  iconOnly?: boolean;
}): JSX.Element | null {
  const { value } = props;
  const plan = chatAccessModeSet("codex-cli").plan;
  if (!plan || !selectedChatAccessOption(value.kind, value.agentMode, value.permissions)) return null;
  const on = codexPlanModeOn(value.kind, value.agentMode, value.permissions);
  const blocked = !on ? props.modesReason : undefined;
  const title = props.disabled ? `${plan.label}. ${TURN_RUNNING_NOTE}` : blocked ? `${plan.label}. ${blocked}` : plan.label;
  return (
    <button type="button" className={`chat-model-chip chat-composer-toggle${on ? " is-on" : ""}${props.iconOnly ? " is-icon" : ""}`}
      data-testid={`${props.testId}-plan`} aria-pressed={on} title={title} aria-label={title} disabled={props.disabled || Boolean(blocked)}
      onClick={() => props.onChange(withCodexPlanMode(value.agentMode, value.permissions, !on))}>
      {props.iconOnly ? <ComposerControlIcon icon={ClipboardList} label={plan.label} /> : <span className="chat-composer-control-text">{plan.label}</span>}
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
 *  (memberAsItRunsNow); none otherwise. Said as the sessions view says it,
 *  naming no main session: its mode is the chat's (the main composer's). */
export function accessHeldReason(value: ChatModelAccessValue, option: ChatAccessOption, mainSession: ChatParticipant | undefined): string | undefined {
  if (!value.delegatedByParticipantId || !mainSession || !value.id || mainSession.id === value.id) return undefined;
  const applied = applyChatAccessOption(option, value.permissions);
  const member = { ...value, id: value.id, roleConfigId: "", agentMode: applied.agentMode, permissions: applied.permissions } as ChatParticipant;
  const running = memberAsItRunsNow(member, mainSession);
  // What it may do in the mode (Plan edits nothing either way).
  const edits = (mode: ChatParticipant["agentMode"], permissions: ChatParticipant["permissions"]): boolean =>
    effectiveChatAgentPermissionsForProvider(value.kind, normalizeChatAgentMode(mode), normalizeChatAgentPermissions(permissions)).workspaceWrite;
  const held = normalizeChatAgentMode(running.agentMode) !== normalizeChatAgentMode(applied.agentMode) ||
    edits(running.agentMode, running.permissions) !== edits(applied.agentMode, applied.permissions);
  if (!held) return undefined;
  const mainMode = selectedChatAccessOption(mainSession.kind, mainSession.agentMode, mainSession.permissions)?.label ?? "Custom";
  return `Not above the chat's mode (${mainMode}).`;
}
