import { useState } from "react";
import { CaretRightIcon, PlusIcon, PushPinIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ACCORD_NEEDS_AGENT_LINE, ACCORD_NEEDS_AGENT_SETUP_LINE } from "../../../shared/accordCandidates";
import { CLI_PROVIDER_SETUP } from "../../../shared/cliReadiness";
import type { MachineListResult } from "../../../shared/machineLink";
import type { SessionsMemberRow } from "../../../shared/mainSessionView";
import { reasoningEffortOptionsForProvider } from "../../../shared/reasoningEffort";
import type { ChatParticipant, ChatProviderKind } from "../../../shared/types";

import { IconButton } from "../primitives";
import { ChatSubagentSettings } from "./chat-subagent-settings";
import { ProviderIcon } from "./provider-icon";
import { hasThreadOverride, type SubagentPanelProvider } from "./subagent-panel";
import { useSubagentProvidersActions } from "./subagent-providers-context";
import { chipModelLabel, useMemberModelCatalog } from "./chat-member-model-name";

import { defaultModelOf } from "./chat-model-access-picker";
import { MemberPlanUsageRing } from "./plan-usage/plan-usage-ring";

export type SubagentMainSession = Pick<ChatParticipant, "kind" | "model" | "reasoningEffort" | "hostId" | "homeMachineId" | "cloudRun">;

/** The Agents list opened from the Accord button, when Accord needs one more
 *  agent: a new key each time. */
export interface SubagentAddRequest {
  key: number;
  forAccord?: boolean;
}

/** The side panel's Agents (variant B, the User, 2026-11-26): a quiet row per
 *  CLI the main session gives tasks to (every CLI ready here, less those this
 *  chat took out), its model and effort beside it, its sessions folded under
 *  it until the row is opened. Add brings back a CLI this chat took out, and
 *  shows only when there is one. */
export function ChatSubagentsSection(props: {
  providers: SubagentPanelProvider[];
  /** The CLIs this chat took out that it can have back. */
  addable: readonly ChatProviderKind[];
  /** The CLIs are still being checked: nothing to say about an empty list yet. */
  checking: boolean;
  main?: SubagentMainSession;
  machines: MachineListResult;
  add?: SubagentAddRequest;
  renderRow: (row: SessionsMemberRow) => JSX.Element;
}): JSX.Element {
  const actions = useSubagentProvidersActions();
  const [open, setOpen] = useState<ReadonlySet<ChatProviderKind>>(new Set());
  // The Accord's request to add an agent, once Add was opened for it: Add does
  // not open again for it when it shows again later.
  const [answered, setAnswered] = useState<number>();
  const running = props.providers.reduce((count, provider) => count + provider.running, 0);
  const toggle = (kind: ChatProviderKind): void => setOpen((current) => {
    const next = new Set(current);
    if (!next.delete(kind)) next.add(kind);
    return next;
  });
  const canAdd = props.addable.length > 0;
  // Accord needs one more agent and none can be added here: one is set up
  // first. Not said while the CLIs are still being checked.
  const accordSetup = Boolean(props.add?.forAccord) && !canAdd && !props.checking;
  // That line answered the request: a CLI taken out afterwards does not open Add by itself.
  if (accordSetup && props.add && answered !== props.add.key) setAnswered(props.add.key);
  const empty = props.providers.length === 0 && !props.checking;
  return (
    <div className="chat-side-section" data-testid="chat-members-agents">
      <div className="chat-subagents-head">
        <h3 className="chat-side-heading">Agents</h3>
        {running > 0 && <span className="chat-subagents-running" data-testid="chat-subagents-running"><i aria-hidden />{running} running</span>}
        <span className="grow" />
        {canAdd && <ChatSubagentAdd key={props.add?.key} addable={props.addable}
          openAtStart={Boolean(props.add?.forAccord) && props.add?.key !== answered} note={props.add?.forAccord ? ACCORD_NEEDS_AGENT_LINE : undefined}
          onClosed={() => setAnswered(props.add?.key)} />}
      </div>
      {(empty || accordSetup) && (
        <div className="chat-subagents-empty" data-testid="chat-subagents-empty">
          <p className={accordSetup ? "is-note" : undefined} data-testid={accordSetup ? "chat-subagents-note" : undefined}>
            {accordSetup ? ACCORD_NEEDS_AGENT_SETUP_LINE : canAdd ? "This thread has no agents. Add one back with +." : "No CLI is ready. Set one up in Settings."}
          </p>
          {!canAdd && actions && <Button size="xs" variant="ghost" onClick={actions.openSetup} data-testid="chat-subagents-setup">Set up</Button>}
        </div>
      )}
      {props.providers.map((provider) => (
        <SubagentRow key={provider.kind} provider={provider} open={open.has(provider.kind)} onToggle={() => toggle(provider.kind)}
          main={props.main} machines={props.machines} renderRow={props.renderRow} />
      ))}
    </div>
  );
}

function SubagentRow(props: {
  provider: SubagentPanelProvider;
  open: boolean;
  onToggle: () => void;
  main?: SubagentMainSession;
  machines: MachineListResult;
  renderRow: (row: SessionsMemberRow) => JSX.Element;
}): JSX.Element {
  const { provider } = props;
  return (
    <div className={`chat-subagent${props.open ? " is-open" : ""}${provider.offList ? " is-off-list" : ""}`} data-testid="chat-subagent" data-provider-kind={provider.kind}>
      <div className="chat-subagent-row">
        <button type="button" className="chat-subagent-toggle" aria-expanded={props.open} onClick={props.onToggle} data-testid="chat-subagent-toggle">
          <CaretRightIcon className="chat-subagent-caret" size={12} aria-hidden />
          <ProviderIcon kind={provider.kind} label={provider.label} className="chat-provider-icon" bare />
          <span className="chat-subagent-name">{provider.label}</span>
          {!props.open && <SubagentCount provider={provider} />}
        </button>
        <SubagentValues provider={provider} main={props.main} machines={props.machines} />
        {!provider.offList && <ChatSubagentSettings provider={provider} />}
      </div>
      {props.open && (provider.rows.length > 0
        ? <ul className="chat-agent-list chat-subagent-sessions">{provider.rows.map(props.renderRow)}</ul>
        : <p className="chat-subagent-none">{provider.offList ? "Not in this thread's agents any more." : "No tasks yet."}</p>)}
    </div>
  );
}

/** How many of its sessions work now (amber while one waits for the User). */
function SubagentCount(props: { provider: SubagentPanelProvider }): JSX.Element | null {
  const active = props.provider.running + props.provider.waiting;
  if (active === 0) {
    return null;
  }
  return (
    <span className={`chat-subagent-count${props.provider.waiting > 0 ? " is-waiting" : ""}`} data-testid="chat-subagent-count">
      <i aria-hidden />{active}
    </span>
  );
}

/** Its model and effort as quiet text, a pin when this thread set them. With
 *  nothing set, what its members will run on: the main session's own model and
 *  effort for the same CLI, else the CLI's default. */
function SubagentValues(props: { provider: SubagentPanelProvider; main?: SubagentMainSession; machines: MachineListResult }): JSX.Element {
  const { provider } = props;
  const { catalog } = useMemberModelCatalog({ kind: provider.kind });
  // As delegation.ts gives them: the main session's model only when nothing
  // is set for its CLI, its effort only with its own model.
  const same = props.main?.kind === provider.kind;
  const modelId = provider.model ?? (same && !provider.reasoningEffort ? props.main?.model : undefined);
  const account = {
    kind: provider.kind,
    model: modelId,
    hostId: same && !provider.model ? props.main?.hostId : undefined,
    homeMachineId: props.main?.homeMachineId,
    cloudRun: props.main?.cloudRun
  };
  const found = modelId ? catalog?.models.find((item) => item.id === modelId) : undefined;
  const model = found ? chipModelLabel(found) : modelId ?? "Default";
  const inheritsEffort = same && modelId === props.main?.model;
  const effortId = provider.reasoningEffort ?? (inheritsEffort ? props.main?.reasoningEffort : undefined);
  const effort = effortId ? reasoningEffortOptionsForProvider(provider.kind).find((item) => item.id === effortId)?.label ?? effortId : undefined;
  return (
    <>
      <MemberPlanUsageRing participant={account} hoverSide="left" machines={props.machines} defaultModel={defaultModelOf(catalog, catalog?.startDefaults?.model)?.id} />
      <span className="chat-subagent-values" data-testid="chat-subagent-values">
        {hasThreadOverride(provider) && <PushPinIcon size={12} aria-label="Set for this thread" />}
        <span className={provider.model ? "is-set" : undefined}>{model}</span>
        {effort && <span className={provider.reasoningEffort ? "is-set" : undefined}>{effort}</span>}
      </span>
    </>
  );
}

function ChatSubagentAdd(props: {
  addable: readonly ChatProviderKind[];
  openAtStart: boolean;
  note?: string;
  onClosed: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(props.openAtStart);
  const change = (next: boolean): void => {
    setOpen(next);
    if (!next) props.onClosed();
  };
  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger asChild>
        <IconButton icon={PlusIcon} label="Add agent" tooltip="Add agent" data-testid="chat-subagent-add" />
      </PopoverTrigger>
      <PopoverContent align="end" className="chat-subagent-pop w-[300px] gap-0 p-0">
        {props.note && <p className="chat-subagent-pick-note" data-testid="chat-subagents-note">{props.note}</p>}
        <SubagentPickList addable={props.addable} onAdded={() => change(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** The CLIs this chat took out that are ready here, to bring back. */
function SubagentPickList(props: { addable: readonly ChatProviderKind[]; onAdded: () => void }): JSX.Element | null {
  const actions = useSubagentProvidersActions();
  const [busy, setBusy] = useState(false);
  if (!actions) {
    return null;
  }
  const add = async (kind: ChatProviderKind): Promise<void> => {
    setBusy(true);
    const ok = await actions.update({ type: "add", kind });
    setBusy(false);
    if (ok) props.onAdded();
  };
  return (
    <div className="chat-subagent-pick" data-testid="chat-subagent-pick">
      {props.addable.map((kind) => {
        const label = CLI_PROVIDER_SETUP[kind].label;
        return (
          <div className="chat-subagent-pick-row" key={kind} data-provider-kind={kind}>
            <ProviderIcon kind={kind} label={label} className="chat-provider-icon" bare />
            <span className="chat-subagent-pick-name">{label}</span>
            <span className="grow" />
            <Button size="xs" variant="ghost" disabled={busy} data-testid="chat-subagent-pick-add" onClick={() => void add(kind)}>Add</Button>
          </div>
        );
      })}
    </div>
  );
}
