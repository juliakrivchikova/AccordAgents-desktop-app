import { useMemo, useRef, useState } from "react";
import { CloudIcon, GaugeIcon, LaptopIcon, HardDrivesIcon } from "@phosphor-icons/react";

import { normalizeChatReasoningEffort, reasoningEffortOptionsForProvider } from "../../../shared/reasoningEffort";
import { savedModelId } from "../../../shared/geminiModels";
import { mainSessionProviderKey, type MainSessionProviderOption } from "../../../shared/mainSessionProviders";
import type { CloudRunSelection } from "../../../shared/cloudRunPreparation";
import type { MachineRecord } from "../../../shared/machineLink";
import type { ChatParticipant, ProviderModel, ProviderModelCatalog, ProviderReasoningEffortOption } from "../../../shared/types";
import { codexModesUnavailableReason, codexPlanModeOn, liveModeChangeReaches, selectedChatAccessOption } from "../../../shared/chatAccessModes";
import { ChatProviderMark } from "./chat-member-mark";
import { chipModelLabel, memberDefaultModelName, memberModelName, useMemberModelCatalog } from "./chat-member-model-name";
import { latestAndOlderModels } from "./chat-model-groups";
import { ComposerMenu, ComposerMenuDisclosure, ComposerMenuItem, ComposerMenuNote, ComposerMenuSection } from "./composer-menu";
import { ChatAccessControl, ChatCodexPlanToggle, ComposerControlIcon, iconTriggerProps, modeChangesWhileTurnRuns, TURN_RUNNING_NOTE } from "./chat-access-controls";
import { machineIdOf, machineOf, useCliStartDefaults, useMachineList } from "./use-cli-start-defaults";
import { COMPOSER_DENSITY, useComposerDensity } from "./use-composer-density";
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
  const machineList = useMachineList();
  const machines = machineList.machines;
  // What the User's own config starts its CLI in where it runs (a machine
  // reads its own): the model a member without one of its own runs, and
  // the effort its config sets.
  const start = useCliStartDefaults({ kind: value.kind, homeMachineId: value.homeMachineId, cloudRun: value.cloudRun }, machineList);
  const startModel = value.hostId ? undefined : start?.model;
  const model = savedModelId(value.kind, value.model);
  const defaultModel = useMemo(() => defaultModelOf(catalog, startModel), [catalog, startModel]);
  const models = useMemo(() => explicitModels(catalog, defaultModel), [catalog, defaultModel]);
  const defaultLabel = memberDefaultModelName(value, catalog, start);
  const efforts = useMemo(() => effortOptions(value.kind, catalog, model ?? defaultModel?.id), [catalog, defaultModel, model, value.kind]);
  // An effort the chosen model does not have reads as the CLI's own here;
  // nothing is saved until the User picks one.
  const savedEffort = normalizeChatReasoningEffort(value.reasoningEffort, value.kind);
  const effort = shownEffort(savedEffort, efforts);
  // None chosen: the effort her config sets, for the model it starts on.
  const configEffort = !effort && !model && !value.hostId ? shownEffort(start?.reasoningEffort, efforts) : undefined;
  const effortLabel = effort ? labelOf(efforts, effort) : configEffort ? labelOf(efforts, configEffort) : "Default";
  const showRunsOn = Boolean(props.runsOn) && (machines.length > 0 || Boolean(value.homeMachineId || value.cloudRun));
  // Full Access and Plan mode on a machine whose program is from before them
  // (for Cloud run, the machine on the AWS instance it names).
  const modesMachineId = machineIdOf(value, machineList);
  const modesReason = codexModesUnavailableReason({ kind: value.kind, homeMachineId: modesMachineId }, machineOf(machineList, modesMachineId));
  // The mode while its turn runs: where its CLI takes one then (Shift+Tab in
  // Claude Code), on this computer or a machine whose program sets it in the
  // live process; anywhere else it waits for the turn to end.
  const modeWhileTurnRuns = modeChangesWhileTurnRuns(value.kind) && liveModeChangeReaches(value, machineOf(machineList, modesMachineId));
  // A model chosen without the saved effort: that choice clears it too, so
  // its CLI is never given an effort the model does not have.
  const withEffortFor = (modelId: string | undefined): ChatModelAccessPatch => {
    const next = effortOptions(value.kind, catalog, modelId ?? defaultModel?.id);
    return savedEffort && !next.some((option) => option.id === savedEffort)
      ? { model: modelId ?? "", reasoningEffort: "" as ChatModelAccessPatch["reasoningEffort"] }
      : { model: modelId ?? "" };
  };
  const modelName = memberModelName({ ...value, model }, catalog, start);
  const access = selectedChatAccessOption(value.kind, value.agentMode, value.permissions);
  const runsOn = runsOnLabel(value, machines);
  // In a narrow composer the controls turn into icons one by one (where it
  // runs, Plan mode, the mode, the effort), then the model loses its glyph
  // and last its name shortens: never a one-letter stub.
  const rowRef = useRef<HTMLDivElement>(null);
  const density = useComposerDensity(rowRef, [modelName, effortLabel, access?.id ?? "custom", value.kind, showRunsOn ? runsOn : "",
    codexPlanModeOn(value.kind, value.agentMode, value.permissions) ? "plan" : ""].join("\u0000"));
  const effortIcon = density >= COMPOSER_DENSITY.effortIcon;
  const runsOnIcon = density >= COMPOSER_DENSITY.runsOnIcon;

  return (
    <div ref={rowRef} className="chat-composer-controls" data-testid={prefix} data-density={density} aria-disabled={props.disabled || undefined}>
      <ComposerMenu
        testId={`${prefix}-model`}
        title={`Model: ${modelName}`}
        width={300}
        align="end"
        label={(
          <span className="chat-model-chip-label">
            {density < COMPOSER_DENSITY.modelWithoutGlyph && <ChatProviderMark member={value} className="is-mini" />}
            <span className={density >= COMPOSER_DENSITY.modelShortened ? "chat-composer-control-text is-model is-shortened" : "chat-composer-control-text is-model"}>{modelName}</span>
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
          title={`Effort: ${effortLabel}`}
          width={240}
          align="end"
          {...iconTriggerProps(effortIcon)}
          label={effortIcon
            ? <ComposerControlIcon icon={GaugeIcon} label={effortLabel} />
            : <span className={effort || configEffort ? "chat-composer-control-text" : "chat-composer-control-text is-muted"}>{effortLabel}</span>}
        >
          {(close) => (
            <ChatEffortMenu
              efforts={efforts}
              effort={effort}
              defaultDetail={configEffort ? labelOf(efforts, configEffort) : undefined}
              disabled={props.disabled}
              onSelect={(id) => {
                close();
                if (savedEffort !== id) onChange({ reasoningEffort: id ?? "" as ChatModelAccessPatch["reasoningEffort"] });
              }}
            />
          )}
        </ComposerMenu>
      )}
      <ChatAccessControl value={value} mainSession={props.mainSession} disabled={props.disabled && !modeWhileTurnRuns} modesReason={modesReason} onChange={onChange} testId={prefix}
        iconOnly={density >= COMPOSER_DENSITY.modeIcon} />
      {value.kind === "codex-cli" && (
        <ChatCodexPlanToggle value={value} disabled={props.disabled} modesReason={modesReason} onChange={onChange} testId={prefix} iconOnly={density >= COMPOSER_DENSITY.planIcon} />
      )}
      {showRunsOn && (
        <ComposerMenu
          testId={`${prefix}-runs-on`}
          title={`Runs on: ${runsOn}`}
          width={300}
          align="end"
          {...iconTriggerProps(runsOnIcon)}
          label={runsOnIcon
            ? <ComposerControlIcon icon={value.cloudRun ? CloudIcon : value.homeMachineId ? HardDrivesIcon : LaptopIcon} label={runsOn} />
            : <span className="chat-composer-control-text">{runsOn}</span>}
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
  /** The effort Default runs at, when the User's config sets one. */
  defaultDetail?: string;
  disabled?: boolean;
  onSelect: (id: ProviderReasoningEffortOption["id"] | undefined) => void;
}): JSX.Element {
  return (
    <ComposerMenuSection label="Effort">
      {props.disabled && <ComposerMenuNote>{TURN_RUNNING_NOTE}</ComposerMenuNote>}
      <ComposerMenuItem testId="chat-effort-option" value="" selected={!props.effort} disabled={props.disabled} label="Default" detail={props.defaultDetail}
        onSelect={() => props.onSelect(undefined)} />
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

/** The model the CLI runs when none is chosen (the default row names it):
 *  the one the User's config starts it on where it runs, when this list has
 *  it, else the one the list marks (her config's on this computer). */
export function defaultModelOf(catalog: ProviderModelCatalog | undefined, startModel: string | undefined): ProviderModel | undefined {
  const usable = (model: ProviderModel): boolean => model.source !== "configured" && !model.hidden;
  return (startModel ? catalog?.models.find((model) => model.id === startModel && usable(model)) : undefined) ??
    catalog?.models.find((model) => model.recommended && usable(model));
}

/** The models offered besides the default row: the CLI's list without the
 *  one it runs by default (the default row names it) and hidden ones. */
export function explicitModels(catalog: ProviderModelCatalog | undefined, defaultModel: ProviderModel | undefined): ProviderModel[] {
  return (catalog?.models ?? []).filter((model) => !model.hidden && model !== defaultModel);
}

/** The efforts of the chosen model (of the one it runs by default while none
 *  is chosen), else the CLI's own list. */
export function effortOptions(kind: ChatParticipant["kind"], catalog: ProviderModelCatalog | undefined, model: string | undefined): ProviderReasoningEffortOption[] {
  const listed = catalog?.models.find((item) => model ? item.id === model : item.recommended && item.source !== "configured");
  return listed?.supportedReasoningEfforts?.length ? listed.supportedReasoningEfforts : reasoningEffortOptionsForProvider(kind);
}
