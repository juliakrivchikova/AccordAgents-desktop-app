import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ChatProviderKind } from "../../../shared/types";
import type { MachineRecord } from "../../../shared/machineLink";
import type { CloudRunPreparationProgress } from "../../../shared/cloudRunPreparation";

export function ParticipantRunLocation(props: {
  kind: ChatProviderKind;
  homeMachineId?: string;
  unassigned?: boolean;
  disabled?: boolean;
  locked?: boolean;
  hideLabel?: boolean;
  onChange: (patch: { homeMachineId?: string; remoteExecution: "local" }) => void;
  onPreparingChange?: (preparing: boolean) => void;
}): JSX.Element {
  const [machines, setMachines] = useState<MachineRecord[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [progress, setProgress] = useState<CloudRunPreparationProgress>();
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  const operation = useRef<string>();
  const latestProps = useRef(props);
  latestProps.current = props;
  useEffect(() => {
    mounted.current = true;
    void window.consensus.listMachines().then(result => { if (mounted.current) setMachines(result.machines); }).catch(() => undefined);
    const off = window.consensus.onMachinesUpdated?.(result => setMachines(result.machines));
    return () => { mounted.current = false; off?.(); };
  }, []);
  const selected = props.homeMachineId
    ? `machine:${props.homeMachineId}` : props.unassigned ? "unassigned" : "local";
  const options = [
    { value: "local", label: "Local · this computer" },
    ...(props.kind !== "gemini-cli" ? [{ value: "cloud", label: "Cloud run · AWS" }] : []),
    ...machines.map(machine => ({ value: `machine:${machine.id}`, label: machine.awsInstanceId ? `${machine.name} · ${machine.awsInstanceId}` : machine.name })),
    ...(props.unassigned && !props.homeMachineId ? [{ value: "unassigned", label: "Choose Local or Cloud run" }] : [])
  ];
  if (props.homeMachineId && !machines.some(machine => machine.id === props.homeMachineId)) {
    options.push({ value: selected, label: "Machine (unavailable)" });
  }
  const lockedReason = "The machine is locked after the first run. Remove and add the member again to choose another.";

  async function select(value: string): Promise<void> {
    if (props.disabled || props.locked || preparing || value === "unassigned") return;
    setError(undefined);
    const selectedMachine = machines.find(machine => value === `machine:${machine.id}`);
    if (value !== "cloud" && !selectedMachine?.awsInstanceId) {
      props.onChange({ homeMachineId: value.startsWith("machine:") ? value.slice(8) : undefined, remoteExecution: "local" });
      return;
    }
    if (props.kind !== "codex-cli" && props.kind !== "claude-code") return;
    operation.current = crypto.randomUUID();
    setPreparing(true);
    props.onPreparingChange?.(true);
    setProgress({ operationId: operation.current, message: "Preparing Cloud run…" });
    const off = window.consensus.onCloudRunPreparationProgress(snapshot => {
      if (mounted.current && snapshot.operationId === operation.current) setProgress(snapshot);
    });
    try {
      const result = await window.consensus.prepareCloudRun({ operationId: operation.current, provider: props.kind,
        ...(selectedMachine?.awsInstanceId ? { instanceId: selectedMachine.awsInstanceId } : {}) });
      if (!mounted.current) return;
      if (latestProps.current.kind !== props.kind) throw new Error("The provider changed during setup. Select Cloud run again for this provider.");
      setMachines(current => [...current.filter(machine => machine.id !== result.machine.id), result.machine]);
      latestProps.current.onChange({ homeMachineId: result.machine.id, remoteExecution: "local" });
    } catch (caught) {
      if (mounted.current) setError((caught instanceof Error ? caught.message : String(caught))
        .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
    } finally {
      off();
      if (mounted.current) { setPreparing(false); props.onPreparingChange?.(false); }
    }
  }

  return (
    <div className="participant-run-location">
      <div className="chat-rt-toggleline">
        {!props.hideLabel && <span className="chat-rt-toggle-label">Run on:</span>}
        <span className={`chat-rt-ghost${props.disabled || props.locked || preparing ? " is-disabled" : ""}`} title={props.locked ? lockedReason : undefined}>
          <span className="chat-rt-ghost-val">{preparing ? "Preparing Cloud run…" : options.find(option => option.value === selected)?.label}</span>
          <ChevronDown size={11} aria-hidden />
          <select className="chat-rt-ghost-native" aria-label="Run on" value={selected}
            disabled={props.disabled || props.locked || preparing} onChange={event => void select(event.currentTarget.value)}>
            {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </span>
      </div>
      {props.locked && <p className="text-muted-foreground text-xs">{lockedReason}</p>}
      {preparing && <p className="text-muted-foreground text-xs" role="status">{progress?.message}</p>}
      {preparing && progress?.authUrl && <p className="text-xs"><button type="button" className="gen-doctor-auth-link" onClick={() => void window.consensus.openExternal(progress.authUrl!)}>Sign in on the cloud machine</button>{progress.authCode ? ` · Code: ${progress.authCode}` : ""}</p>}
      {error && <div className="text-xs"><p className="text-destructive" role="alert">{error}</p>
        <button type="button" className="gen-doctor-auth-link" disabled={preparing || props.locked || props.disabled} onClick={() => void select("cloud")}>Retry Cloud run</button></div>}
    </div>
  );
}
