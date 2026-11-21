import { useEffect, useMemo, useState } from "react";

import { normalizeChatReasoningEffort, reasoningEffortOptionsForProvider } from "../../../shared/reasoningEffort";
import { savedModelId } from "../../../shared/geminiModels";
import { mainSessionProviderKey, type MainSessionProviderOption } from "../../../shared/mainSessionProviders";
import type { CloudRunSelection } from "../../../shared/cloudRunPreparation";
import type { MachineListResult, MachineRecord } from "../../../shared/machineLink";
import type { ChatParticipant, ProviderModel, ProviderModelCatalog, ProviderReasoningEffortOption } from "../../../shared/types";
import { codexModesUnavailableReason } from "../../../shared/chatAccessModes";
import { ChatProviderMark } from "./chat-member-mark";
import { chipModelLabel, memberDefaultModelName, memberModelName, useMemberModelCatalog } from "./chat-member-model-name";
import { latestAndOlderModels } from "./chat-model-groups";
import { ComposerMenu, ComposerMenuDisclosure, ComposerMenuItem, ComposerMenuNote, ComposerMenuSection } from "./composer-menu";
import { ChatAccessControl, ChatCodexPlanToggle, TURN_RUNNING_NOTE } from "./chat-access-controls";
import { ParticipantRunLocation } from "./participant-run-location";

/** What the composer's controls show and change of a member: its provider
 *  (fixed once it exists), model, effort, permission mode and where it runs. */
export type ChatModelAccessValue = Pick<ChatParticipant,
  "kind" | "hostId" | "hostLabel" | "hostVendor" | "model" | "reasoningEffort" | "agentMode" | "permissions" | "homeMachineId" | "cloudRun" | "handle"> &
  Partial<Pick<ChatParticipant, "id" | "delegatedByParticipantId">>;

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
 * A member's settings as quiet controls under its composer, each with its
 * own small menu, as Claude's desktop app ("Opus 5.5 · Extra · Auto"), Codex
 * and T3 Code put them (the User, 2026-11-21): the model (the provider too,
 * before the chat exists: New chat), the effort, the permission mode in its
 * CLI's own terms, Codex's Plan mode beside it, and where it runs once a
 * machine exists. Nothing is saved until a choice is made; only the chosen
 * setting is sent ("" resets a model or effort to the CLI's own).
 */
export function ChatMemberComposerControls(props: {
  value: ChatModelAccessValue;
  providers?: readonly MainSessionProviderOption[];
  onProviderChange?: (option: MainSessionProviderOption) => void;
  /** Saves one choice; what it returns (a save's promise, false when it
   *  failed) is what "Runs on" waits for before it prepares a machine. */
  onChange: (patch: ChatModelAccessPatch) => unknown;
  /** Its own turn runs: its settings wait, as a CLI's apply to its next turn. */
  disabled?: boolean;
  /** Where it runs: offered once a machine exists (or it runs on one). */
  runsOn?: { locked?: boolean; moves?: boolean };
  /** The chat's main session, for a member it made: what that member's
   *  mode is held to (shown disabled with the reason, never granted). */
  mainSession?: ChatParticipant;
  testId?: string;
}): JSX.Element {
  const { value, onChange } = props;
  const prefix = props.testId ?? "chat-model";
  const { catalog, loading } = useMemberModelCatalog(value);
  const model = savedModelId(value.kind, value.model);
  const defaultModel = useMemo(() => recommendedModel(catalog), [catalog]);
  const models = useMemo(() => explicitModels(catalog), [catalog]);
  const defaultLabel = memberDefaultModelName(value, catalog);
  const efforts = useMemo(() => effortOptions(value.kind, catalog, model), [catalog, model, value.kind]);
  // An effort the chosen model does not have reads as the CLI's own here;
  // nothing is saved until the User picks one.
  const savedEffort = normalizeChatReasoningEffort(value.reasoningEffort, value.kind);
  const effort = shownEffort(savedEffort, efforts);
  const machineList = useMachines();
  const machines = machineList.machines;
  const showRunsOn = Boolean(props.runsOn) && (machines.length > 0 || Boolean(value.homeMachineId || value.cloudRun));
  // Full Access and Plan mode on a machine whose program is from before them.
  const modesReason = codexModesUnavailableReason(value, machineOf(machineList, value.homeMachineId));
  // A model chosen without the saved effort: that choice clears it too, so
  // its CLI is never given an effort the model does not have.
  const withEffortFor = (modelId: string | undefined): ChatModelAccessPatch => {
    const next = effortOptions(value.kind, catalog, modelId);
    return savedEffort && !next.some((option) => option.id === savedEffort)
      ? { model: modelId ?? "", reasoningEffort: "" as ChatModelAccessPatch["reasoningEffort"] }
      : { model: modelId ?? "" };
  };
  const modelName = memberModelName({ ...value, model }, catalog);

  return (
    <div className="chat-composer-controls" data-testid={prefix} aria-disabled={props.disabled || undefined}>
      <ComposerMenu
        testId={`${prefix}-model`}
        title={`Model: ${modelName}`}
        width={300}
        align="end"
        label={(
          <span className="chat-model-chip-label">
            <ChatProviderMark member={value} className="is-mini" />
            <span className="chat-composer-control-text">{modelName}</span>
          </span>
        )}
      >
        {(close) => (
          <ChatModelMenu
            value={value}
            providers={props.providers}
            onProviderChange={props.onProviderChange ? (option) => { close(); props.onProviderChange?.(option); } : undefined}
            model={model}
            defaultModel={defaultModel}
            defaultLabel={defaultLabel}
            models={models}
            loading={loading}
            disabled={props.disabled}
            onSelect={(modelId) => {
              close();
              if (modelId !== model) onChange(withEffortFor(modelId));
            }}
          />
        )}
      </ComposerMenu>
      {efforts.length > 0 && (
        <ComposerMenu
          testId={`${prefix}-effort`}
          title={`Effort: ${effort ? labelOf(efforts, effort) : "Default"}`}
          width={240}
          align="end"
          label={<span className={effort ? "chat-composer-control-text" : "chat-composer-control-text is-muted"}>{effort ? labelOf(efforts, effort) : "Default"}</span>}
        >
          {(close) => (
            <ChatEffortMenu
              efforts={efforts}
              effort={effort}
              disabled={props.disabled}
              onSelect={(id) => {
                close();
                if (savedEffort !== id) onChange({ reasoningEffort: id ?? "" as ChatModelAccessPatch["reasoningEffort"] });
              }}
            />
          )}
        </ComposerMenu>
      )}
      <ChatAccessControl value={value} mainSession={props.mainSession} disabled={props.disabled} modesReason={modesReason} onChange={onChange} testId={prefix} />
      {value.kind === "codex-cli" && (
        <ChatCodexPlanToggle value={value} disabled={props.disabled} modesReason={modesReason} onChange={onChange} testId={prefix} />
      )}
      {showRunsOn && (
        <ComposerMenu
          testId={`${prefix}-runs-on`}
          title={`Runs on: ${runsOnLabel(value, machines)}`}
          width={300}
          align="end"
          label={<span className="chat-composer-control-text">{runsOnLabel(value, machines)}</span>}
        >
          {() => (
            <ComposerMenuSection label="Runs on">
              <div className="composer-menu-field">
                <ParticipantRunLocation kind={value.kind} homeMachineId={value.homeMachineId} cloudRun={value.cloudRun} hideLabel
                  disabled={props.disabled} locked={props.runsOn?.locked} moves={props.runsOn?.moves} anonymous
                  onChange={(patch: { homeMachineId?: string; cloudRun?: CloudRunSelection; remoteExecution: "local" }) => onChange(patch)} />
              </div>
            </ComposerMenuSection>
          )}
        </ComposerMenu>
      )}
    </div>
  );
}

/** The model menu: the providers (New chat only), the CLI's default first,
 *  the newest model of each family with the vendor's description, and the
 *  rest under "More models" (open when the chosen model is there). */
export function ChatModelMenu(props: {
  value: ChatModelAccessValue;
  providers?: readonly MainSessionProviderOption[];
  onProviderChange?: (option: MainSessionProviderOption) => void;
  model: string | undefined;
  defaultModel: ProviderModel | undefined;
  defaultLabel: string;
  models: readonly ProviderModel[];
  loading?: boolean;
  disabled?: boolean;
  onSelect: (modelId: string | undefined) => void;
}): JSX.Element {
  const { latest, older } = useMemo(() => latestAndOlderModels(props.models, props.defaultModel ? [props.defaultModel] : []), [props.models, props.defaultModel]);
  const [moreOpen, setMoreOpen] = useState(() => older.some((item) => item.id === props.model));
  const unlisted = props.model && !props.models.some((item) => item.id === props.model) ? props.model : undefined;
  const row = (item: ProviderModel): JSX.Element => (
    <ComposerMenuItem key={item.id} testId="chat-model-option" value={item.id} selected={props.model === item.id} disabled={props.disabled}
      label={chipModelLabel(item)} detail={item.description} onSelect={() => props.onSelect(item.id)} />
  );
  return (
    <>
      {props.providers && props.onProviderChange && (
        <ComposerMenuSection label="Provider">
          {props.providers.map((option) => (
            <ComposerMenuItem key={mainSessionProviderKey(option)} testId="chat-model-provider" value={mainSessionProviderKey(option)}
              selected={mainSessionProviderKey(option) === mainSessionProviderKey(props.value)} disabled={props.disabled}
              mark={<ChatProviderMark member={{ kind: option.kind, hostLabel: option.hostLabel }} className="is-mini" />}
              label={option.label} onSelect={() => props.onProviderChange?.(option)} />
          ))}
        </ComposerMenuSection>
      )}
      <ComposerMenuSection label="Model">
        {props.disabled && <ComposerMenuNote>{TURN_RUNNING_NOTE}</ComposerMenuNote>}
        <ComposerMenuItem testId="chat-model-option" value="" selected={!props.model} disabled={props.disabled} label={props.defaultLabel}
          detail={props.defaultModel?.description ? `Default · ${props.defaultModel.description}` : "Default"} onSelect={() => props.onSelect(undefined)} />
        {latest.map(row)}
        {unlisted && (
          <ComposerMenuItem testId="chat-model-option" value={unlisted} selected disabled={props.disabled} label={unlisted} onSelect={() => props.onSelect(unlisted)} />
        )}
        {older.length > 0 && (
          <ComposerMenuDisclosure label="More models" open={moreOpen} onToggle={() => setMoreOpen((open) => !open)} testId="chat-model-more">
            {older.map(row)}
          </ComposerMenuDisclosure>
        )}
        {props.loading && <ComposerMenuNote>Reading the models…</ComposerMenuNote>}
      </ComposerMenuSection>
    </>
  );
}

/** The effort menu: the CLI's own ("Default") and the model's efforts. */
export function ChatEffortMenu(props: {
  efforts: readonly ProviderReasoningEffortOption[];
  effort: string | undefined;
  disabled?: boolean;
  onSelect: (id: ProviderReasoningEffortOption["id"] | undefined) => void;
}): JSX.Element {
  return (
    <ComposerMenuSection label="Effort">
      {props.disabled && <ComposerMenuNote>{TURN_RUNNING_NOTE}</ComposerMenuNote>}
      <ComposerMenuItem testId="chat-effort-option" value="" selected={!props.effort} disabled={props.disabled} label="Default" onSelect={() => props.onSelect(undefined)} />
      {props.efforts.map((option) => (
        <ComposerMenuItem key={option.id} testId="chat-effort-option" value={option.id} selected={props.effort === option.id} disabled={props.disabled}
          label={option.label} detail={option.description} onSelect={() => props.onSelect(option.id)} />
      ))}
    </ComposerMenuSection>
  );
}

function labelOf(efforts: readonly ProviderReasoningEffortOption[], id: string): string {
  return efforts.find((option) => option.id === id)?.label ?? id;
}

/** A machine by its id, with its last hello (connected or not). */
function machineOf(list: MachineListResult, machineId: string | undefined): { name?: string; lastHello?: MachineRecord["lastHello"] } | undefined {
  if (!machineId) return undefined;
  const record = list.machines.find((machine) => machine.id === machineId);
  const status = list.status.find((item) => item.machineId === machineId);
  return record || status ? { name: record?.name ?? status?.name, lastHello: status?.lastHello ?? record?.lastHello } : undefined;
}

function runsOnLabel(value: ChatModelAccessValue, machines: readonly MachineRecord[]): string {
  if (value.cloudRun) return "Cloud run";
  if (value.homeMachineId) return machines.find((machine) => machine.id === value.homeMachineId)?.name ?? "Machine";
  return "Local";
}

/** The effort the picker marks: the saved one when the model has it, else
 *  none (the CLI's own). */
export function shownEffort<T extends string>(effort: T | undefined, efforts: ReadonlyArray<{ id: string }>): T | undefined {
  return effort && efforts.some((option) => option.id === effort) ? effort : undefined;
}

/** The model the CLI runs on by default (the default row names it). */
function recommendedModel(catalog: ProviderModelCatalog | undefined): ProviderModel | undefined {
  return catalog?.models.find((model) => model.recommended && model.source !== "configured" && !model.hidden);
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

const NO_MACHINES: MachineListResult = { machines: [], status: [] };

/** The machines set up (cloud machines, other computers) and their last
 *  hellos: only then does a composer offer where a member runs, and a
 *  machine's program says what it can run. Kept as it was when an update
 *  changes nothing the controls read. */
function useMachines(): MachineListResult {
  const [machines, setMachines] = useState<MachineListResult>(NO_MACHINES);
  useEffect(() => {
    const bridge = typeof window === "undefined" ? undefined : window.consensus;
    if (!bridge?.listMachines) return;
    let alive = true;
    const take = (answer: Partial<MachineListResult> | undefined): void => {
      const result: MachineListResult = { machines: answer?.machines ?? [], status: answer?.status ?? [] };
      setMachines((current) => machinesKey(current) === machinesKey(result) ? current : result);
    };
    void bridge.listMachines().then((result) => { if (alive) take(result); }).catch(() => undefined);
    const off = bridge.onMachinesUpdated?.((result) => take(result));
    return () => { alive = false; off?.(); };
  }, []);
  return machines;
}

function machinesKey(list: MachineListResult): string {
  const supports = (hello: MachineRecord["lastHello"] | undefined): string => (hello?.cliModesSupported === true ? "1" : "0");
  return [
    ...list.machines.map((machine) => `${machine.id}:${machine.name}:${supports(machine.lastHello)}`),
    ...list.status.map((item) => `${item.machineId}:${item.name}:${supports(item.lastHello)}`)
  ].join("|");
}
