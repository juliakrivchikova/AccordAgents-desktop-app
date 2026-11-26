// Settings → General → Agents (the User, 2026-11-26): each CLI's model and
// effort for the agents a chat gives tasks to. A chat's Agents list is every
// ready CLI on these values; a chat changes them for itself in its side panel
// (src/shared/subagentProviders.ts). The pickers and their words are New
// chats' (new-chat-defaults-rows.tsx): "the CLI's own" is named as the CLI
// runs it by default. The words name no main session.
import { Fragment } from "react";

import type { MachineListResult } from "../../../shared/machineLink";
import type { AgentHealth, ChatProviderKind, ProviderSettings, SubagentDefaultUpdate, SubagentProviderEntry } from "../../../shared/types";
import { CLI_PROVIDER_DISPLAY_ORDER, cliProviderMetadata, readinessForProvider } from "../../../shared/cliReadiness";
import { AppSelect } from "../primitives";
import { ChatProviderMark } from "../chat/chat-member-mark";
import { chipModelLabel, memberDefaultModelName, useMemberModelCatalog } from "../chat/chat-member-model-name";
import { defaultModelOf, effortOptions, explicitModels } from "../chat/chat-model-access-picker";
import { useCliStartDefaults, useMachineList } from "../chat/use-cli-start-defaults";

/** New chats' select, filling its column so every CLI's pickers line up. */
const SELECT_CLASS_NAME = "assistant-provider-select min-h-7 w-full border-ui-border bg-ui-bg text-ui-13";

/** The select's value for "the CLI's own" (a select has no empty value). */
const CLI_OWN = "__cli-own__";

export const SUBAGENT_DEFAULTS_DESCRIPTION =
  "The model and effort of the agents a chat gives tasks to. A chat can change them for itself in its side panel.";

export function SubagentDefaultsRows(props: {
  providers: ProviderSettings[];
  agents: AgentHealth[];
  subagentDefaults?: SubagentProviderEntry[];
  setSubagentDefault: (update: SubagentDefaultUpdate) => Promise<void>;
}): JSX.Element {
  const machines = useMachineList();
  return (
    <>
      {CLI_PROVIDER_DISPLAY_ORDER.map((kind, index) => (
        <Fragment key={kind}>
          {index > 0 && <div className="gen-card-divider" />}
          <SubagentDefaultRow
            kind={kind}
            // A CLI that is not ready here has no list to read yet.
            ready={readinessForProvider(kind, props.agents, props.providers) === "ready"}
            entry={props.subagentDefaults?.find((item) => item.kind === kind)}
            machines={machines}
            setSubagentDefault={props.setSubagentDefault}
          />
        </Fragment>
      ))}
    </>
  );
}

function SubagentDefaultRow(props: {
  kind: ChatProviderKind;
  ready: boolean;
  entry?: SubagentProviderEntry;
  machines: MachineListResult;
  setSubagentDefault: (update: SubagentDefaultUpdate) => Promise<void>;
}): JSX.Element {
  const { kind, entry } = props;
  const label = cliProviderMetadata(kind).label;
  const { catalog } = useMemberModelCatalog({ kind }, props.ready);
  // What the User's own config starts the CLI on here: "the CLI's own".
  const start = useCliStartDefaults(props.ready ? { kind } : undefined, props.machines);
  const model = entry?.model;
  const defaultModel = defaultModelOf(catalog, start?.model);
  const models = explicitModels(catalog, defaultModel);
  const unlisted = model && !models.some((item) => item.id === model) ? model : undefined;
  const modelOptions = [
    { value: CLI_OWN, label: memberDefaultModelName({ kind }, catalog, start) },
    ...models.map((item) => ({ value: item.id, label: chipModelLabel(item) })),
    ...(unlisted ? [{ value: unlisted, label: unlisted }] : [])
  ];
  const efforts = effortOptions(kind, catalog, model ?? defaultModel?.id);
  const effort = entry?.reasoningEffort;
  const configEffort = !model ? efforts.find((item) => item.id === start?.reasoningEffort) : undefined;
  const effortSelectOptions = [
    { value: CLI_OWN, label: configEffort ? `Default (${configEffort.label})` : "Default" },
    ...efforts.map((item) => ({ value: item.id, label: item.label })),
    // A saved effort the model no longer lists is still shown, not hidden behind Default.
    ...(effort && !efforts.some((item) => item.id === effort) ? [{ value: effort, label: effort }] : [])
  ];
  return (
    <div className="gen-row gen-subagent-row" data-testid="subagent-default-row" data-provider-kind={kind}>
      <ChatProviderMark member={{ kind }} className="is-mini" />
      <div className="gen-row-text">
        <div className="gen-row-title">{label}</div>
      </div>
      <div className="gen-subagent-controls">
        <AppSelect
          value={model ?? CLI_OWN}
          options={modelOptions}
          placeholder="Choose model"
          ariaLabel={`${label} model`}
          testId="subagent-default-model"
          size="sm"
          className={SELECT_CLASS_NAME}
          onValueChange={(value) => {
            const next = value === CLI_OWN ? undefined : value;
            if (next === model) return;
            // A model without the chosen effort takes the CLI's own effort, so
            // its CLI is never given one the model does not have.
            const nextEfforts = effortOptions(kind, catalog, next ?? defaultModel?.id);
            const dropEffort = Boolean(effort) && !nextEfforts.some((item) => item.id === effort);
            void props.setSubagentDefault({ kind, model: next ?? null, ...(dropEffort ? { reasoningEffort: null } : {}) });
          }}
        />
        {/* Antigravity runs its model's own effort: no choice to make. */}
        {efforts.length > 0 && (
          <AppSelect
            value={effort ?? CLI_OWN}
            options={effortSelectOptions}
            placeholder="Choose effort"
            ariaLabel={`${label} effort`}
            testId="subagent-default-effort"
            size="sm"
            className={SELECT_CLASS_NAME}
            onValueChange={(value) => {
              const next = value === CLI_OWN ? undefined : value;
              if (next !== effort) void props.setSubagentDefault({ kind, reasoningEffort: (next ?? null) as SubagentDefaultUpdate["reasoningEffort"] });
            }}
          />
        )}
      </div>
    </div>
  );
}
