import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ChatProviderKind } from "../../../shared/types";
import type { MachineRecord } from "../../../shared/machineLink";
import type { CloudRunPreparationState, CloudRunSelection } from "../../../shared/cloudRunPreparation";
import { CloudProviderAuth } from "../cloud-provider-auth";

export function ParticipantRunLocation(props: {
  kind: ChatProviderKind;
  homeMachineId?: string;
  cloudRun?: CloudRunSelection;
  unassigned?: boolean;
  disabled?: boolean;
  locked?: boolean;
  hideLabel?: boolean;
  onChange: (patch: { homeMachineId?: string; cloudRun?: CloudRunSelection; remoteExecution: "local" }) => unknown;
}): JSX.Element {
  const [machines, setMachines] = useState<MachineRecord[]>([]);
  const [selectionError, setSelectionError] = useState<string>();
  const [progress, setProgress] = useState<CloudRunPreparationState>();
  useEffect(() => {
    let alive = true;
    void window.consensus.listMachines().then(result => { if (alive) setMachines(result.machines); }).catch(() => undefined);
    const off = window.consensus.onMachinesUpdated?.(result => setMachines(result.machines));
    return () => { alive = false; off?.(); };
  }, []);
  useEffect(() => {
    setProgress(undefined);
    if (!props.cloudRun || (props.kind !== "codex-cli" && props.kind !== "claude-code")) return;
    let alive = true;
    let received = false;
    const matches = (snapshot: CloudRunPreparationState): boolean => snapshot.provider === props.kind
      && snapshot.instanceId === props.cloudRun?.instanceId;
    const off = window.consensus.onCloudRunPreparationProgress(snapshot => {
      if (matches(snapshot)) { received = true; setProgress(snapshot); }
    });
    void window.consensus.getCloudRunPreparation({ provider: props.kind, instanceId: props.cloudRun.instanceId })
      .then(snapshot => { if (alive && !received && snapshot && matches(snapshot)) setProgress(snapshot); })
      .catch(() => undefined);
    return () => { alive = false; off(); };
  }, [props.kind, Boolean(props.cloudRun), props.cloudRun?.instanceId]);
  const selected = props.cloudRun ? "cloud" : props.homeMachineId
    ? `machine:${props.homeMachineId}` : props.unassigned ? "unassigned" : "local";
  const options = [
    { value: "local", label: "Local · this computer" },
    ...(props.kind !== "gemini-cli" ? [{ value: "cloud", label: "Cloud run · AWS" }] : []),
    ...machines.map(machine => ({ value: `machine:${machine.id}`, label: machine.awsInstanceId ? `${machine.name} · ${machine.awsInstanceId}` : machine.name })),
    ...(props.unassigned && !props.homeMachineId ? [{ value: "unassigned", label: "Choose Local or Cloud run" }] : [])
  ];
  if (props.homeMachineId && !props.cloudRun && !machines.some(machine => machine.id === props.homeMachineId)) {
    options.push({ value: selected, label: "Machine (unavailable)" });
  }
  const lockedReason = "The machine is locked after the first run. Remove and add the member again to choose another.";

  function prepare(selection: CloudRunSelection): void {
    const provider = props.kind;
    if (provider !== "codex-cli" && provider !== "claude-code") return;
    // The main process owns this work and its latest snapshot. Closing this
    // control never cancels it or loses the saved choice; completion never
    // writes a late machine selection over a newer Local choice.
    void window.consensus.prepareCloudRun({ operationId: crypto.randomUUID(), provider, instanceId: selection.instanceId })
      .catch(() => {}); // The main-process owner exposes errors through its snapshot.
  }

  function select(value: string): void {
    if (props.disabled || props.locked || value === "unassigned") return;
    setSelectionError(undefined);
    const selectedMachine = machines.find(machine => value === `machine:${machine.id}`);
    if (value !== "cloud" && !selectedMachine?.awsInstanceId) {
      props.onChange({ homeMachineId: value.startsWith("machine:") ? value.slice(8) : undefined, cloudRun: undefined, remoteExecution: "local" });
      return;
    }
    if (props.kind !== "codex-cli" && props.kind !== "claude-code") return;
    const selection = selectedMachine?.awsInstanceId ? { instanceId: selectedMachine.awsInstanceId } : {};
    void Promise.resolve(props.onChange({ homeMachineId: undefined, cloudRun: selection, remoteExecution: "local" }))
      .then(saved => { if (saved !== false) prepare(selection); })
      .catch(error => setSelectionError(error instanceof Error ? error.message : String(error)));
  }

  const preparing = progress?.phase === "preparing";
  return (
    <div className="participant-run-location">
      <div className="chat-rt-toggleline">
        {!props.hideLabel && <span className="chat-rt-toggle-label">Run on:</span>}
        <span className={`chat-rt-ghost${props.disabled || props.locked ? " is-disabled" : ""}`} title={props.locked ? lockedReason : undefined}>
          <span className="chat-rt-ghost-val">{options.find(option => option.value === selected)?.label}</span>
          <ChevronDown size={11} aria-hidden />
          <select className="chat-rt-ghost-native" aria-label="Run on" value={selected}
            disabled={props.disabled || props.locked} onChange={event => select(event.currentTarget.value)}>
            {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </span>
      </div>
      {selectionError && <p role="alert" className="text-destructive text-xs">{selectionError}</p>}
      {props.locked && <p className="text-muted-foreground text-xs">{lockedReason}</p>}
      {props.cloudRun && preparing && <p className="text-muted-foreground text-xs" role="status">{progress.message} You can close this window.</p>}
      {props.cloudRun && preparing && progress.authUrl && <CloudProviderAuth authUrl={progress.authUrl} authCode={progress.authCode} authProvider={progress.authProvider} authRequestId={progress.authRequestId} />}
      {props.cloudRun && progress?.phase === "error" && <div className="text-xs"><p className="text-destructive" role="alert">{progress?.message}</p>
        <button type="button" className="gen-doctor-auth-link" disabled={preparing || props.disabled} onClick={() => prepare(props.cloudRun!)}>Retry Cloud setup</button></div>}
    </div>
  );
}
