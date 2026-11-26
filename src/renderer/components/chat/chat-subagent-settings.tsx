import { useState } from "react";
import { SlidersHorizontalIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ChatReasoningEffort, SubagentProviderScope } from "../../../shared/types";
import { AppSelect, IconButton } from "../primitives";
import { chipModelLabel, useMemberModelCatalog } from "./chat-member-model-name";
import { effortOptions } from "./chat-model-access-picker";
import { ProviderIcon } from "./provider-icon";
import type { SubagentPanelProvider } from "./subagent-panel";
import { useSubagentProvidersActions } from "./subagent-providers-context";

/** The settings of one of the chat's sub-agents (variant B): which scope the
 *  change is for, its model and effort there, and an explicit Apply; Reset
 *  takes back what that scope set, Remove takes it out of that scope's list. */
export function ChatSubagentSettings(props: { provider: SubagentPanelProvider; projectScope: boolean }): JSX.Element | null {
  const actions = useSubagentProvidersActions();
  const [open, setOpen] = useState(false);
  if (!actions) {
    return null;
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton icon={SlidersHorizontalIcon} label={`${props.provider.label} model and effort`} tooltip="Model and effort" className="chat-subagent-settings-trigger" data-testid="chat-subagent-settings" />
      </PopoverTrigger>
      <PopoverContent align="end" className="chat-subagent-pop w-[300px] gap-0 p-0" data-testid="chat-subagent-settings-pop">
        {open && <SubagentSettingsForm provider={props.provider} projectScope={props.projectScope} onDone={() => setOpen(false)} />}
      </PopoverContent>
    </Popover>
  );
}

function SubagentSettingsForm(props: { provider: SubagentPanelProvider; projectScope: boolean; onDone: () => void }): JSX.Element {
  const actions = useSubagentProvidersActions()!;
  const { provider } = props;
  // It opens where the values it shows come from: this thread when either is the
  // thread's (its pin), the project's list when they are the project's.
  const fromThread = provider.modelFrom === "thread" || provider.effortFrom === "thread";
  const fromProject = provider.modelFrom === "project" || provider.effortFrom === "project";
  const [chosenScope, setScope] = useState<SubagentProviderScope>(!fromThread && fromProject ? "project" : "thread");
  const scope: SubagentProviderScope = props.projectScope ? chosenScope : "thread";
  const entry = scope === "thread" ? provider.threadEntry : provider.projectEntry;
  const [model, setModel] = useState(entry?.model ?? "");
  const [effort, setEffort] = useState<string>(entry?.reasoningEffort ?? "");
  const [busy, setBusy] = useState(false);
  const { catalog } = useMemberModelCatalog({ kind: provider.kind });
  // What "Default" means at this scope: the project's value under a chat's own,
  // the CLI's own under the project's.
  const inherited = scope === "thread" ? provider.projectEntry : undefined;
  const effortsFor = (modelId: string) => effortOptions(provider.kind, catalog, modelId || inherited?.model);
  const efforts = effortsFor(model);
  const switchScope = (next: SubagentProviderScope): void => {
    const nextEntry = next === "thread" ? provider.threadEntry : provider.projectEntry;
    setScope(next);
    setModel(nextEntry?.model ?? "");
    setEffort(nextEntry?.reasoningEffort ?? "");
  };
  const chooseModel = (next: string): void => {
    setModel(next);
    // An effort the new model lacks goes back to its default.
    if (effort && !effortsFor(next).some((item) => item.id === effort)) setEffort("");
  };
  const modelLabel = (id: string | undefined): string | undefined => {
    const found = id ? catalog?.models.find((item) => item.id === id) : undefined;
    return found ? chipModelLabel(found) : id;
  };
  const effortLabel = (id: string | undefined): string | undefined => id ? efforts.find((item) => item.id === id)?.label ?? id : undefined;
  const defaultLabel = (value: string | undefined): string => value ? `Default (${value})` : "Default";
  const listed = (catalog?.models ?? []).filter((item) => !item.hidden).map((item) => ({ value: item.id, label: chipModelLabel(item) }));
  const modelOptions = [
    { value: "", label: defaultLabel(modelLabel(inherited?.model)) },
    ...listed,
    ...(model && !listed.some((item) => item.value === model) ? [{ value: model, label: modelLabel(model) ?? model }] : [])
  ];
  // A model chosen here starts from its own default effort, not the project's.
  const inheritedEffort = model ? undefined : inherited?.reasoningEffort;
  const effortChoices = [
    { value: "", label: defaultLabel(effortLabel(inheritedEffort)) },
    ...efforts.map((item) => ({ value: item.id, label: item.label })),
    // A saved effort the model no longer lists is still shown, not hidden behind Default.
    ...(effort && !efforts.some((item) => item.id === effort) ? [{ value: effort, label: effortLabel(effort) ?? effort }] : [])
  ];
  const run = async (change: Parameters<typeof actions.update>[1]): Promise<void> => {
    setBusy(true);
    const ok = await actions.update(scope, change);
    setBusy(false);
    if (ok) props.onDone();
  };
  const working = provider.running + provider.waiting > 0;
  // Nothing to remove from the project's list when it is not there.
  const removable = scope === "project" ? Boolean(provider.projectEntry) : true;
  return (
    <>
      <div className="chat-subagent-pop-head">
        <ProviderIcon kind={provider.kind} label={provider.label} className="chat-provider-icon" bare />
        <span>{provider.label}</span>
      </div>
      <div className="chat-subagent-pop-body">
        <Tabs value={scope} onValueChange={(value) => switchScope(value as SubagentProviderScope)}>
          <TabsList className="w-full">
            <TabsTrigger value="thread" className="flex-1">This thread</TabsTrigger>
            <TabsTrigger value="project" className="flex-1" disabled={!props.projectScope}>Project</TabsTrigger>
          </TabsList>
        </Tabs>
        <label className="chat-subagent-field">
          <span>Model</span>
          <AppSelect size="sm" className="w-full" value={model} options={modelOptions} placeholder="Default" ariaLabel={`${provider.label} model`} testId="chat-subagent-model" onValueChange={chooseModel} />
        </label>
        {/* Antigravity runs its model's own effort: no choice to make. */}
        {efforts.length > 0 && (
          <label className="chat-subagent-field">
            <span>Effort</span>
            <AppSelect size="sm" className="w-full" value={effort} options={effortChoices} placeholder="Default" ariaLabel={`${provider.label} effort`} testId="chat-subagent-effort" onValueChange={setEffort} />
          </label>
        )}
        <p className="chat-subagent-pop-note">
          {scope === "thread"
            ? "For this thread only. New tasks start on it; agents already working keep theirs."
            : "For every thread in this project that does not set its own."}
          {working && " Remove is available once its agents finish."}
        </p>
      </div>
      <div className="chat-subagent-pop-foot">
        <Button variant="ghost" size="sm" disabled={busy || (!entry?.model && !entry?.reasoningEffort)} onClick={() => void run({ type: "set", kind: provider.kind })}>Reset</Button>
        <Button variant="destructive" size="sm" disabled={busy || working || !removable}
          onClick={() => void run({ type: "remove", kind: provider.kind })}>Remove</Button>
        <span className="grow" />
        <Button size="sm" disabled={busy} data-testid="chat-subagent-apply"
          onClick={() => void run({ type: "set", kind: provider.kind, model: model || undefined, reasoningEffort: (effort || undefined) as ChatReasoningEffort | undefined })}>Apply</Button>
      </div>
    </>
  );
}
