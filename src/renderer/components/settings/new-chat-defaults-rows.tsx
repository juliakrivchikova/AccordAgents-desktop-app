// Settings → General → New chats (the User, 2026-11-22; mockup
// general-new-chats): how a new chat starts. Its CLI (the setting the Chat
// Assistant used, AppSettings.assistantProviderKind), that CLI's model,
// effort and permission mode in its own terms, where it runs, and whether it
// compacts its context without asking (src/shared/newChatDefaults.ts). The
// New chat screen's controls start from these; a choice there is that
// chat's only. The words name no main session (src/shared/sessionsViewText.ts).
import { Fragment, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import type {
  AgentHealth,
  ChatProviderKind,
  NewChatDefaults,
  NewChatDefaultsUpdate,
  ProviderSettings
} from "../../../shared/types";
import { cliProviderMetadata, deriveAgentReadiness, resolveAssistantProviderKind } from "../../../shared/cliReadiness";
import { isChatProviderKind } from "../../../shared/chatProviders";
import {
  chatAccessMenuOptions,
  chatAccessModeSet,
  chatAccessOptions,
  codexModesUnavailableReason,
  FULL_ACCESS_CONFIRMATION,
  startChatAccessOption,
  type ChatAccessOption
} from "../../../shared/chatAccessModes";
import { normalizeNewChatDefaults } from "../../../shared/newChatDefaults";
import { savedModelId } from "../../../shared/geminiModels";
import { AppSelect } from "../primitives";
import { ChatProviderMark } from "../chat/chat-member-mark";
import { chipModelLabel, memberDefaultModelName, useMemberModelCatalog } from "../chat/chat-member-model-name";
import { defaultModelOf, effortOptions, explicitModels } from "../chat/chat-model-access-picker";
import { machineOf, useCliStartDefaults, useMachineList } from "../chat/use-cli-start-defaults";
import { isMacPlatform } from "../../lib/platform";

const SELECT_CLASS_NAME = "assistant-provider-select min-h-7 border-ui-border bg-ui-bg text-ui-13";

/** The select's value for "the CLI's own" (a select has no empty value). */
const CLI_OWN = "__cli-own__";
/** The select's value for this computer. */
const THIS_COMPUTER = "__this-computer__";

export const COMPACT_WITHOUT_ASKING_DESCRIPTION =
  "When the context window fills up, the agent summarizes the older part of the conversation to free space, like /compact in Claude Code. Off: it asks you first.";

export function providerDisplayLabel(provider: Pick<ProviderSettings, "kind" | "label">): string {
  return isChatProviderKind(provider.kind) ? cliProviderMetadata(provider.kind).label : provider.label;
}

/** The Mode row's description: the CLI's own modes by their own names, and
 *  what Antigravity cannot do here, as the composer's menu says it. */
export function newChatModeDescription(kind: ChatProviderKind): string {
  const set = chatAccessModeSet(kind);
  const modes = `${cliProviderMetadata(kind).label}'s modes: ${chatAccessOptions(kind).map((option) => option.label).join(", ")}.`;
  return set.note ? `${modes} ${set.note}` : modes;
}

function Row(props: { title: string; description?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="gen-row">
      <div className="gen-row-text">
        <div className="gen-row-title">{props.title}</div>
        {props.description && <div className="gen-row-desc">{props.description}</div>}
      </div>
      {props.children}
    </div>
  );
}

export function NewChatDefaultsRows(props: {
  providers: ProviderSettings[];
  agents: AgentHealth[];
  assistantProviderKind?: ChatProviderKind;
  newChatDefaults?: NewChatDefaults;
  setAssistantProviderKind: (kind: ChatProviderKind) => Promise<void>;
  setNewChatDefaults: (update: NewChatDefaultsUpdate) => Promise<void>;
}): JSX.Element {
  // The CLI the rows below are for: the one saved, else the one a new chat
  // would take now.
  const kind = props.assistantProviderKind ?? resolveAssistantProviderKind({ agents: props.agents, providers: props.providers });
  const defaults = normalizeNewChatDefaults(props.newChatDefaults);
  const own = kind && defaults.kind === kind ? defaults : undefined;
  const machineList = useMachineList();
  const machines = machineList.machines;
  const homeMachineId = defaults.homeMachineId && machines.some((machine) => machine.id === defaults.homeMachineId) ? defaults.homeMachineId : undefined;
  const { catalog } = useMemberModelCatalog({ kind: kind ?? "codex-cli" }, Boolean(kind));
  // What the User's own config starts the CLI on where a new chat runs: the
  // model, effort and mode "the CLI's own" means there.
  const start = useCliStartDefaults(kind ? { kind, homeMachineId } : undefined, machineList);
  const [confirming, setConfirming] = useState<ChatAccessOption>();

  const providerSelect = (
    <AppSelect
      value={props.assistantProviderKind ?? ""}
      options={props.providers.filter((provider) => isChatProviderKind(provider.kind)).map((provider) => {
        const readiness = deriveAgentReadiness(
          props.agents.find((agent) => agent.kind === provider.kind),
          provider.enabled
        );
        const displayLabel = providerDisplayLabel(provider);
        return {
          value: provider.kind,
          label: readiness === "ready" ? displayLabel : `${displayLabel} (not ready)`,
          icon: isChatProviderKind(provider.kind) ? <ChatProviderMark member={{ kind: provider.kind }} className="is-mini" /> : undefined,
          disabled: readiness !== "ready"
        };
      })}
      placeholder="Choose provider"
      ariaLabel="Provider"
      testId="assistant-provider-select"
      size="sm"
      className={SELECT_CLASS_NAME}
      onValueChange={(value) => {
        if (isChatProviderKind(value)) {
          void props.setAssistantProviderKind(value);
        }
      }}
    />
  );
  if (!kind) {
    return (
      <Fragment>
        <Row title="Provider" description="The CLI a new chat runs on.">{providerSelect}</Row>
        <div className="gen-card-divider" />
        <CompactRow defaults={defaults} setNewChatDefaults={props.setNewChatDefaults} />
      </Fragment>
    );
  }

  const cliLabel = cliProviderMetadata(kind).label;
  // The model rows as the composer's model menu lists them: the one the CLI
  // runs by default first (named, not "Default"), then the others.
  const model = savedModelId(kind, own?.model);
  const defaultModel = defaultModelOf(catalog, start?.model);
  const models = explicitModels(catalog, defaultModel);
  const unlisted = model && !models.some((item) => item.id === model) ? model : undefined;
  const modelOptions = [
    { value: CLI_OWN, label: memberDefaultModelName({ kind }, catalog, start) },
    ...models.map((item) => ({ value: item.id, label: chipModelLabel(item) })),
    ...(unlisted ? [{ value: unlisted, label: unlisted }] : [])
  ];
  const efforts = effortOptions(kind, catalog, model ?? defaultModel?.id);
  const effort = own?.reasoningEffort && efforts.some((item) => item.id === own.reasoningEffort) ? own.reasoningEffort : undefined;
  const configEffort = !model ? efforts.find((item) => item.id === start?.reasoningEffort) : undefined;
  const effortSelectOptions = [
    { value: CLI_OWN, label: configEffort ? `Default (${configEffort.label})` : "Default" },
    ...efforts.map((item) => ({ value: item.id, label: item.label }))
  ];
  // The mode chosen, else the one her config starts the CLI in there.
  const access = own?.access ? startChatAccessOption(kind, own.access) : startChatAccessOption(kind, start?.access);
  const modesReason = codexModesUnavailableReason({ kind, homeMachineId }, machineOf(machineList, homeMachineId));
  const accessSelectOptions = chatAccessMenuOptions(kind, access).map((option) => ({
    value: option.id,
    label: option.label,
    disabled: option.agentMode === "full-access" && option.id !== access.id && Boolean(modesReason)
  }));
  const thisComputer = isMacPlatform() ? "This Mac" : "This computer";

  return (
    <Fragment>
      <Row title="Provider" description="The CLI a new chat runs on.">{providerSelect}</Row>
      <div className="gen-card-divider" />
      <Row title="Model" description={`From ${cliLabel}'s own model list.`}>
        <AppSelect
          value={model ?? CLI_OWN}
          options={modelOptions}
          placeholder="Choose model"
          ariaLabel="Model"
          testId="new-chat-model-select"
          size="sm"
          className={SELECT_CLASS_NAME}
          onValueChange={(value) => {
            const next = value === CLI_OWN ? undefined : value;
            if (next === model) return;
            // A model without the chosen effort takes the CLI's own effort, so
            // its CLI is never given one the model does not have.
            const nextEfforts = effortOptions(kind, catalog, next ?? defaultModel?.id);
            const dropEffort = Boolean(own?.reasoningEffort) && !nextEfforts.some((item) => item.id === own?.reasoningEffort);
            void props.setNewChatDefaults({ kind, model: next ?? null, ...(dropEffort ? { reasoningEffort: null } : {}) });
          }}
        />
      </Row>
      {efforts.length > 0 && (
        <>
          <div className="gen-card-divider" />
          <Row title="Effort">
            <AppSelect
              value={effort ?? CLI_OWN}
              options={effortSelectOptions}
              placeholder="Choose effort"
              ariaLabel="Effort"
              testId="new-chat-effort-select"
              size="sm"
              className={SELECT_CLASS_NAME}
              onValueChange={(value) => {
                const next = value === CLI_OWN ? undefined : efforts.find((item) => item.id === value)?.id;
                if (next !== effort) void props.setNewChatDefaults({ kind, reasoningEffort: next ?? null });
              }}
            />
          </Row>
        </>
      )}
      <div className="gen-card-divider" />
      <Row title="Mode" description={access.agentMode === "full-access" && modesReason
        // A new chat there starts in the mode Codex starts in instead.
        ? `${newChatModeDescription(kind)} ${modesReason}`
        : newChatModeDescription(kind)}>
        <AppSelect
          value={access.id}
          options={accessSelectOptions}
          placeholder="Choose mode"
          ariaLabel={chatAccessModeSet(kind).title}
          testId="new-chat-mode-select"
          size="sm"
          className={SELECT_CLASS_NAME}
          onValueChange={(value) => {
            const option = chatAccessMenuOptions(kind, access).find((item) => item.id === value);
            if (!option || option.id === access.id) return;
            // Codex asks before Full Access, in its own words.
            if (option.agentMode === "full-access") setConfirming(option);
            else void props.setNewChatDefaults({ kind, access: option.id });
          }}
        />
      </Row>
      <div className="gen-card-divider" />
      <Row title="Runs on">
        <AppSelect
          value={homeMachineId ?? THIS_COMPUTER}
          options={[
            { value: THIS_COMPUTER, label: thisComputer },
            ...machines.map((machine) => ({ value: machine.id, label: machine.name }))
          ]}
          placeholder="Choose where it runs"
          ariaLabel="Runs on"
          testId="new-chat-runs-on-select"
          size="sm"
          className={SELECT_CLASS_NAME}
          disabled={machines.length === 0}
          onValueChange={(value) => {
            const next = value === THIS_COMPUTER ? undefined : value;
            if (next !== homeMachineId) void props.setNewChatDefaults({ homeMachineId: next ?? null });
          }}
        />
      </Row>
      <div className="gen-card-divider" />
      <CompactRow defaults={defaults} setNewChatDefaults={props.setNewChatDefaults} />
      <FullAccessConfirmDialog
        option={confirming}
        onCancel={() => setConfirming(undefined)}
        onConfirm={() => {
          const option = confirming;
          setConfirming(undefined);
          if (option) void props.setNewChatDefaults({ kind, access: option.id });
        }}
      />
    </Fragment>
  );
}

function CompactRow(props: { defaults: NewChatDefaults; setNewChatDefaults: (update: NewChatDefaultsUpdate) => Promise<void> }): JSX.Element {
  return (
    <Row title="Compact without asking" description={COMPACT_WITHOUT_ASKING_DESCRIPTION}>
      <label className="toggle">
        <input
          type="checkbox"
          aria-label="Compact without asking"
          data-testid="new-chat-compact-toggle"
          checked={props.defaults.compactWithoutAsking}
          onChange={(event) => void props.setNewChatDefaults({ compactWithoutAsking: event.target.checked })}
        />
        <span />
      </label>
    </Row>
  );
}

/** Codex's question before Full Access (Codex 0.155.1's `/permissions`,
 *  FULL_ACCESS_CONFIRMATION): only "Yes, continue anyway" sets it. */
function FullAccessConfirmDialog(props: { option?: ChatAccessOption; onConfirm: () => void; onCancel: () => void }): JSX.Element {
  return (
    <Dialog open={Boolean(props.option)} onOpenChange={(open) => { if (!open) props.onCancel(); }}>
      <DialogContent className="settings-delete-dialog" showCloseButton={false} data-testid="new-chat-full-access-confirm">
        <DialogHeader>
          <DialogTitle>{FULL_ACCESS_CONFIRMATION.title}</DialogTitle>
          <DialogDescription>{FULL_ACCESS_CONFIRMATION.body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" title={FULL_ACCESS_CONFIRMATION.cancel.detail} onClick={props.onCancel}
            data-testid="new-chat-full-access-cancel">
            {FULL_ACCESS_CONFIRMATION.cancel.label}
          </Button>
          <Button type="button" size="sm" title={FULL_ACCESS_CONFIRMATION.confirm.detail} onClick={props.onConfirm} autoFocus
            data-testid="new-chat-full-access-yes">
            {FULL_ACCESS_CONFIRMATION.confirm.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
