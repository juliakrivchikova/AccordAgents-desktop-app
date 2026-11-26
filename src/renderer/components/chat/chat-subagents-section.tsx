import { useState } from "react";
import { CaretRightIcon, PlusIcon, PushPinIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CLI_PROVIDER_DISPLAY_ORDER, CLI_PROVIDER_SETUP, readinessForProvider } from "../../../shared/cliReadiness";
import type { SessionsMemberRow } from "../../../shared/mainSessionView";
import { reasoningEffortOptionsForProvider } from "../../../shared/reasoningEffort";
import type { AgentReadinessState, ChatProviderKind, ChatReasoningEffort, SubagentProviderEntry, SubagentProviderScope } from "../../../shared/types";

/** The main session's own CLI and what it runs on: a sub-agent of the same CLI
 *  with nothing set inherits them (delegation.ts). */
export interface SubagentMainSession {
  kind: ChatProviderKind;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  /** A Cloud run main session's members run there too, where Antigravity does not. */
  cloudRun?: unknown;
}
import { IconButton } from "../primitives";
import { ChatSubagentSettings } from "./chat-subagent-settings";
import { ProviderIcon } from "./provider-icon";
import { hasThreadOverride, type SubagentPanelProvider } from "./subagent-panel";
import { useSubagentProvidersActions } from "./subagent-providers-context";
import { chipModelLabel, useMemberModelCatalog } from "./chat-member-model-name";

/** The Agents list opened to add one (the Accord button, when Accord needs
 *  one more): its Add open, a new key each time, and what it is for. */
export interface SubagentAddRequest {
  key: number;
  note?: string;
}

const READINESS_TEXT: Record<AgentReadinessState, string> = {
  ready: "Ready",
  "could-not-verify": "Installed",
  "sign-in-required": "Sign in needed",
  "not-detected": "Not installed",
  "failed-to-run": "Does not start",
  disabled: "Turned off in Settings",
  checking: "Checking"
};

/** The side panel's Agents (variant B, the User, 2026-11-26): a quiet row per
 *  CLI the main session gives tasks to, its model and effort beside it, its
 *  sessions folded under it until the row is opened; Add lists the CLIs found
 *  here. A new thread with none says so and lists them in place. */
export function ChatSubagentsSection(props: {
  providers: SubagentPanelProvider[];
  /** The project's own list, for Add to say what the project already has. */
  project?: readonly SubagentProviderEntry[];
  main?: SubagentMainSession;
  /** A chat from before the list: it may give tasks to any ready CLI until one is added. */
  legacy?: boolean;
  projectScope: boolean;
  add?: SubagentAddRequest;
  renderRow: (row: SessionsMemberRow) => JSX.Element;
}): JSX.Element {
  const [open, setOpen] = useState<ReadonlySet<ChatProviderKind>>(new Set());
  // The Accord's request to add an agent that the empty list's own Add list
  // answered: the header's Add must not open again for it.
  const [answered, setAnswered] = useState<number>();
  const running = props.providers.reduce((count, provider) => count + provider.running, 0);
  const toggle = (kind: ChatProviderKind): void => setOpen((current) => {
    const next = new Set(current);
    if (!next.delete(kind)) next.add(kind);
    return next;
  });
  return (
    <div className="chat-side-section" data-testid="chat-members-agents">
      <div className="chat-subagents-head">
        <h3 className="chat-side-heading">Agents</h3>
        {running > 0 && <span className="chat-subagents-running" data-testid="chat-subagents-running"><i aria-hidden />{running} running</span>}
        <span className="grow" />
        {props.providers.length > 0 && <ChatSubagentAdd key={props.add?.key} providers={props.providers} project={props.project} main={props.main}
          projectScope={props.projectScope} openAtStart={props.add !== undefined && props.add.key !== answered} note={props.add?.note} />}
      </div>
      {props.providers.length === 0 ? (
        <div className="chat-subagents-empty" data-testid="chat-subagents-empty">
          <p className={props.add?.note ? "is-note" : undefined} data-testid={props.add?.note ? "chat-subagents-note" : undefined}>{props.add?.note ?? (props.legacy
            ? "This chat can give tasks to any ready CLI. Add one to choose which it may use."
            : "No agents yet. Add the CLIs this chat can give tasks to.")}</p>
          <SubagentPickList providers={props.providers} project={props.project} main={props.main} projectScope={props.projectScope}
            onAdded={() => setAnswered(props.add?.key)} />
        </div>
      ) : props.providers.map((provider) => (
        <SubagentRow key={provider.kind} provider={provider} open={open.has(provider.kind)} onToggle={() => toggle(provider.kind)}
          main={props.main} projectScope={props.projectScope} renderRow={props.renderRow} />
      ))}
    </div>
  );
}

function SubagentRow(props: {
  provider: SubagentPanelProvider;
  open: boolean;
  onToggle: () => void;
  main?: SubagentMainSession;
  projectScope: boolean;
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
        <SubagentValues provider={provider} main={props.main} />
        {!provider.offList && <ChatSubagentSettings provider={provider} projectScope={props.projectScope} />}
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
function SubagentValues(props: { provider: SubagentPanelProvider; main?: SubagentMainSession }): JSX.Element {
  const { provider } = props;
  const { catalog } = useMemberModelCatalog({ kind: provider.kind });
  const inherits = props.main?.kind === provider.kind;
  const modelId = provider.model ?? (inherits ? props.main?.model : undefined);
  const found = modelId ? catalog?.models.find((item) => item.id === modelId) : undefined;
  const model = found ? chipModelLabel(found) : modelId ?? "Default";
  // Its effort goes with its own model (delegation.ts): not with another model set here.
  const inheritsEffort = inherits && (!provider.model || provider.model === props.main?.model);
  const effortId = provider.reasoningEffort ?? (inheritsEffort ? props.main?.reasoningEffort : undefined);
  const effort = effortId ? reasoningEffortOptionsForProvider(provider.kind).find((item) => item.id === effortId)?.label ?? effortId : undefined;
  return (
    <span className="chat-subagent-values" data-testid="chat-subagent-values">
      {hasThreadOverride(provider) && <PushPinIcon size={12} aria-label="Set for this thread" />}
      <span className={provider.model ? "is-set" : undefined}>{model}</span>
      {effort && <span className={provider.reasoningEffort ? "is-set" : undefined}>{effort}</span>}
    </span>
  );
}

function ChatSubagentAdd(props: {
  providers: SubagentPanelProvider[];
  project?: readonly SubagentProviderEntry[];
  main?: SubagentMainSession;
  projectScope: boolean;
  openAtStart: boolean;
  note?: string;
}): JSX.Element {
  const [open, setOpen] = useState(props.openAtStart);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton icon={PlusIcon} label="Add agent" tooltip="Add agent" data-testid="chat-subagent-add" />
      </PopoverTrigger>
      <PopoverContent align="end" className="chat-subagent-pop w-[300px] gap-0 p-0">
        {props.note && <p className="chat-subagent-pick-note" data-testid="chat-subagents-note">{props.note}</p>}
        <SubagentPickList providers={props.providers} project={props.project} main={props.main} projectScope={props.projectScope} onAdded={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** The CLIs to add, with how each stands on this computer (Set up opens
 *  Settings for one that is not ready here; a main session on a machine runs it
 *  there, so Add is never held back); the scope it is added to. */
function SubagentPickList(props: { providers: SubagentPanelProvider[]; project?: readonly SubagentProviderEntry[]; main?: SubagentMainSession; projectScope: boolean; onAdded?: () => void }): JSX.Element | null {
  const actions = useSubagentProvidersActions();
  const [chosenScope, setScope] = useState<SubagentProviderScope>("thread");
  const [busy, setBusy] = useState(false);
  // A chat with no project folder has only its own list.
  const scope: SubagentProviderScope = props.projectScope ? chosenScope : "thread";
  if (!actions) {
    return null;
  }
  const add = async (kind: ChatProviderKind): Promise<void> => {
    setBusy(true);
    const ok = await actions.update(scope, { type: "add", kind });
    setBusy(false);
    if (ok) props.onAdded?.();
  };
  return (
    <div className="chat-subagent-pick" data-testid="chat-subagent-pick">
      {props.projectScope && (
        <div className="chat-subagent-pick-scope">
          <span>Add to</span>
          <Tabs value={scope} onValueChange={(value) => setScope(value as SubagentProviderScope)}>
            <TabsList>
              <TabsTrigger value="thread">This thread</TabsTrigger>
              <TabsTrigger value="project">Project</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      )}
      {CLI_PROVIDER_DISPLAY_ORDER.map((kind) => {
        const readiness = readinessForProvider(kind, [...actions.agents], [...actions.providers]);
        const addable = readiness === "ready" || readiness === "could-not-verify";
        // In a Cloud run chat its members run there, where Antigravity does not (this thread only).
        const unavailable = scope === "thread" && Boolean(props.main?.cloudRun) && kind === "gemini-cli";
        const label = CLI_PROVIDER_SETUP[kind].label;
        const added = scope === "project"
          ? Boolean(props.project?.some((entry) => entry.kind === kind))
          : props.providers.some((provider) => provider.kind === kind && !provider.offList);
        return (
          <div className="chat-subagent-pick-row" key={kind} data-provider-kind={kind}>
            <ProviderIcon kind={kind} label={label} className="chat-provider-icon" bare />
            <span className="chat-subagent-pick-copy">
              <span className="chat-subagent-pick-name">{label}</span>
              <span className={`chat-subagent-pick-detail${addable && !unavailable ? "" : " is-off"}`}>{unavailable ? "Not on Cloud run" : READINESS_TEXT[readiness]}</span>
            </span>
            {!added && !addable && !unavailable && <Button size="xs" variant="ghost" onClick={actions.openSetup}>Set up</Button>}
            {added ? <span className="chat-subagent-pick-added">Added</span>
              : !unavailable && <Button size="xs" variant="outline" disabled={busy} data-testid="chat-subagent-pick-add" onClick={() => void add(kind)}>Add</Button>}
          </div>
        );
      })}
    </div>
  );
}
