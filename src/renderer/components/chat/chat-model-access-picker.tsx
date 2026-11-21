import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, MoreHorizontal } from "lucide-react";

import { normalizeChatReasoningEffort, reasoningEffortOptionsForProvider } from "../../../shared/reasoningEffort";
import { savedModelId } from "../../../shared/geminiModels";
import { mainSessionProviderKey, type MainSessionProviderOption } from "../../../shared/mainSessionProviders";
import type { CloudRunSelection } from "../../../shared/cloudRunPreparation";
import type { ChatParticipant, ProviderModel, ProviderModelCatalog, ProviderReasoningEffortOption } from "../../../shared/types";
import { IconButton } from "../primitives";
import { applyChatAccessOption, chatAccessOptions, selectedChatAccessOption } from "../../../shared/chatAccessModes";
import { ChatProviderMark } from "./chat-member-mark";
import { chipModelLabel, memberDefaultModelName } from "./chat-member-model-name";
import { ParticipantRunLocation } from "./participant-run-location";
import { useProviderModelCatalog } from "./use-provider-model-catalog";

/** What the compact picker shows and changes of a member: its provider (fixed
 *  once it exists), model, effort, access and where it runs. */
export type ChatModelAccessValue = Pick<ChatParticipant,
  "kind" | "hostId" | "hostLabel" | "hostVendor" | "model" | "reasoningEffort" | "agentMode" | "permissions" | "homeMachineId" | "cloudRun" | "handle">;

export type ChatModelAccessPatch = Partial<Pick<ChatParticipant,
  "model" | "reasoningEffort" | "agentMode" | "permissions" | "homeMachineId" | "cloudRun" | "remoteExecution">>;

export interface ChatModelAccessAction {
  label: string;
  /** One muted line under it. */
  detail?: string;
  onSelect: () => void;
  tone?: "danger";
  disabled?: boolean;
}

/**
 * The sessions view's compact settings of one member, T3 Code's way (the
 * User, 2026-11-21): the provider (choosable only before the chat exists:
 * New chat), the provider's models with its default first, the effort, the
 * access in the CLI's own terms and, once a machine exists, where it runs.
 * Nothing else: no name, status, member rights or auto-watch. `actions`
 * (Remove from chat) sit behind a small … menu.
 */
export function ChatModelAccessPanel(props: {
  value: ChatModelAccessValue;
  providers?: readonly MainSessionProviderOption[];
  onProviderChange?: (option: MainSessionProviderOption) => void;
  /** Saves one choice; what it returns (a save's promise, false when it
   *  failed) is what "Runs on" waits for before it prepares a machine. */
  onChange: (patch: ChatModelAccessPatch) => unknown;
  disabled?: boolean;
  /** Where it runs: offered once a machine exists (or it runs on one). */
  runsOn?: { locked?: boolean; moves?: boolean };
  actions?: readonly ChatModelAccessAction[];
  testId?: string;
}): JSX.Element {
  const { value } = props;
  const host = value.hostId && value.hostVendor ? { id: value.hostId, vendor: value.hostVendor, cli: value.kind } : undefined;
  const { catalog, loading } = useProviderModelCatalog(value.kind, host);
  const model = savedModelId(value.kind, value.model);
  const models = useMemo(() => explicitModels(catalog), [catalog]);
  const defaultLabel = memberDefaultModelName(value, catalog);
  const efforts = useMemo(() => effortOptions(value.kind, catalog, model), [catalog, model, value.kind]);
  // An effort the chosen model does not have reads as the CLI's own here;
  // nothing is saved until the User picks one (opening the picker, even
  // while the member runs, changes nothing).
  const effort = shownEffort(normalizeChatReasoningEffort(value.reasoningEffort, value.kind), efforts);
  const access = selectedChatAccessOption(value.kind, value.agentMode, value.permissions);
  const machinesExist = useMachinesExist();
  const showRunsOn = Boolean(props.runsOn) && (machinesExist || Boolean(value.homeMachineId || value.cloudRun));
  const [menuOpen, setMenuOpen] = useState(false);
  const { onChange } = props;
  // A model chosen without the saved effort: that choice clears it too, so
  // its CLI is never given an effort the model does not have.
  const savedEffort = normalizeChatReasoningEffort(value.reasoningEffort, value.kind);
  // "" is the explicit reset to the CLI's own model or effort.
  const withEffortFor = (modelId: string | undefined): ChatModelAccessPatch => {
    const next = effortOptions(value.kind, catalog, modelId);
    return savedEffort && !next.some((option) => option.id === savedEffort)
      ? { model: modelId ?? "", reasoningEffort: "" as ChatModelAccessPatch["reasoningEffort"] }
      : { model: modelId ?? "" };
  };

  return (
    <div className="chat-model-access" data-testid={props.testId ?? "chat-model-access"} aria-disabled={props.disabled || undefined}>
      {props.actions && props.actions.length > 0 && (
        <div className="chat-model-access-more">
          <IconButton size="xs" icon={MoreHorizontal} label="More" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)} />
          {menuOpen && (
            <div className="chat-model-access-menu" role="menu">
              {props.actions.map((action) => (
                <button key={action.label} type="button" role="menuitem" disabled={action.disabled}
                  className={action.tone === "danger" ? "chat-model-access-row is-danger" : "chat-model-access-row"}
                  data-testid="chat-model-access-action" title={action.detail} onClick={() => { setMenuOpen(false); action.onSelect(); }}>
                  <span className="chat-model-access-row-label">{action.label}</span>
                  {action.detail && <span className="chat-model-access-row-detail">{action.detail}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {props.providers && props.onProviderChange && (
        <PickerSection label="Provider">
          {props.providers.map((option) => {
            const selected = mainSessionProviderKey(option) === mainSessionProviderKey(value);
            return (
              <PickerRow key={mainSessionProviderKey(option)} selected={selected} disabled={props.disabled} testId="chat-model-access-provider"
                mark={<ChatProviderMark member={{ kind: option.kind, hostLabel: option.hostLabel }} className="is-mini" />}
                label={option.label} onSelect={() => props.onProviderChange?.(option)} />
            );
          })}
        </PickerSection>
      )}
      <PickerSection label="Model">
        <PickerRow selected={!model} disabled={props.disabled} testId="chat-model-access-model" label={defaultLabel} detail="Default"
          onSelect={() => { if (model) onChange(withEffortFor(undefined)); }} />
        {models.map((item) => (
          <PickerRow key={item.id} selected={model === item.id} disabled={props.disabled} testId="chat-model-access-model"
            label={chipModelLabel(item)} onSelect={() => { if (model !== item.id) onChange(withEffortFor(item.id)); }} />
        ))}
        {model && !models.some((item) => item.id === model) && (
          <PickerRow selected disabled={props.disabled} testId="chat-model-access-model" label={model} onSelect={() => undefined} />
        )}
        {loading && <p className="chat-model-access-note">Reading the models…</p>}
      </PickerSection>
      <PickerSection label="Effort">
        <div className="chat-model-access-efforts" role="radiogroup" aria-label="Effort">
          {[{ id: undefined, label: "Default" } as const, ...efforts].map((option) => (
            <button key={option.id ?? "default"} type="button" role="radio" aria-checked={effort === option.id}
              className={effort === option.id ? "chat-model-access-effort is-selected" : "chat-model-access-effort"}
              data-testid="chat-model-access-effort" disabled={props.disabled}
              onClick={() => { if (savedEffort !== option.id) onChange({ reasoningEffort: option.id ?? "" as ChatModelAccessPatch["reasoningEffort"] }); }}>
              {option.label}
            </button>
          ))}
        </div>
      </PickerSection>
      <PickerSection label="Access">
        {chatAccessOptions(value.kind).map((option) => (
          <PickerRow key={option.id} selected={option.id === access?.id} disabled={props.disabled} testId="chat-model-access-mode"
            label={option.label} detail={option.detail}
            onSelect={() => { if (option.id !== access?.id) onChange(applyChatAccessOption(option, value.permissions)); }} />
        ))}
        {!access && (
          <p className="chat-model-access-note" data-testid="chat-model-access-custom">
            Custom access, set in the classic view. Choose a mode to run in the CLI's own.
          </p>
        )}
      </PickerSection>
      {showRunsOn && (
        <PickerSection label="Runs on">
          <ParticipantRunLocation kind={value.kind} homeMachineId={value.homeMachineId} cloudRun={value.cloudRun} hideLabel
            disabled={props.disabled} locked={props.runsOn?.locked} moves={props.runsOn?.moves} anonymous
            onChange={(patch: { homeMachineId?: string; cloudRun?: CloudRunSelection; remoteExecution: "local" }) => onChange(patch)} />
        </PickerSection>
      )}
    </div>
  );
}

function PickerSection(props: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="chat-model-access-section">
      <div className="chat-model-access-label">{props.label}</div>
      {props.children}
    </div>
  );
}

function PickerRow(props: {
  label: string;
  detail?: string;
  mark?: ReactNode;
  selected: boolean;
  disabled?: boolean;
  testId: string;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button type="button" role="menuitemradio" aria-checked={props.selected} disabled={props.disabled}
      className={props.selected ? "chat-model-access-row is-selected" : "chat-model-access-row"}
      data-testid={props.testId} onClick={props.onSelect}>
      {props.mark}
      <span className="chat-model-access-row-label">{props.label}</span>
      {props.detail && <span className="chat-model-access-row-detail">{props.detail}</span>}
      <span className="chat-model-access-check" aria-hidden="true">{props.selected && <Check size={14} />}</span>
    </button>
  );
}

/** The effort the picker marks: the saved one when the model has it, else
 *  none (the CLI's own). */
export function shownEffort<T extends string>(effort: T | undefined, efforts: ReadonlyArray<{ id: string }>): T | undefined {
  return effort && efforts.some((option) => option.id === effort) ? effort : undefined;
}

/** The models offered besides the default row: the CLI's list without the
 *  one it runs on by default (the default row names it) and hidden ones. */
function explicitModels(catalog: ProviderModelCatalog | undefined): ProviderModel[] {
  return (catalog?.models ?? []).filter((model) => !model.hidden && !(model.recommended && model.source !== "configured"));
}

/** The efforts of the chosen model (of the CLI's default one while none is
 *  chosen), else the CLI's own list. */
function effortOptions(kind: ChatParticipant["kind"], catalog: ProviderModelCatalog | undefined, model: string | undefined): ProviderReasoningEffortOption[] {
  const listed = catalog?.models.find((item) => model ? item.id === model : item.recommended && item.source !== "configured");
  return listed?.supportedReasoningEfforts?.length ? listed.supportedReasoningEfforts : reasoningEffortOptionsForProvider(kind);
}

/** Whether any machine (a cloud machine, another computer) is set up: only
 *  then does the picker offer where a member runs. */
function useMachinesExist(): boolean {
  const [exist, setExist] = useState(false);
  useEffect(() => {
    const bridge = typeof window === "undefined" ? undefined : window.consensus;
    if (!bridge?.listMachines) return;
    let alive = true;
    void bridge.listMachines().then((result) => { if (alive) setExist(result.machines.length > 0); }).catch(() => undefined);
    const off = bridge.onMachinesUpdated?.((result) => setExist(result.machines.length > 0));
    return () => { alive = false; off?.(); };
  }, []);
  return exist;
}
