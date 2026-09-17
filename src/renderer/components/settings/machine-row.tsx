import { Server, Settings2, Trash2 } from "lucide-react";
import type { MachineLinkStatus, MachineRecord } from "../../../shared/machineLink";
import { machineRuntimeStatus, type MachineInstallRecord, type MachineInstallSnapshot } from "../../../shared/machineInstall";
import { MachineSetupPanel } from "./machine-setup-panel";

/** One enrolled machine in Settings → Machines: its connection, its runtime
 *  and what the desktop is doing to that runtime right now. */
export function MachineRow(props: {
  machine: MachineRecord;
  live: MachineLinkStatus | undefined;
  install: MachineInstallRecord | undefined;
  /** The setup or update streaming for this machine, if any. */
  liveOp: MachineInstallSnapshot | undefined;
  desktopVersion: string | undefined;
  setupOpen: boolean;
  busy: boolean;
  onToggleSetup: () => void;
  onSetupDone: () => void;
  onShowEnrollment: () => void;
  onRemove: () => void;
}): JSX.Element {
  const { machine, live, install } = props;
  const connected = live?.connected === true;
  const runtimeStatus = machineRuntimeStatus({
    install, live: props.liveOp, connected, runningVersion: live?.lastHello?.appVersion, desktopVersion: props.desktopVersion
  });
  return (
    <li className="gen-row machines-row" data-testid="machine-row" data-connected={connected ? "true" : "false"}>
      <div className="gen-row-text">
        <div className="gen-row-title machines-row-title">
          <Server size={14} aria-hidden />
          <span>{machine.name}</span>
          <span className={`machines-state${connected ? " is-connected" : ""}`}>{connected ? "Connected" : "Not connected"}</span>
          {live?.warning && <span className="machines-warning" role="status">{live.warning}</span>}
        </div>
        <div className="gen-row-desc">
          {live?.lastHello
            ? `${live.lastHello.machineName} · ${live.lastHello.platform} · app ${live.lastHello.appVersion}`
            : "Waiting for the machine runtime to connect."}
          {machine.lastSeenAt ? ` Last seen ${new Date(machine.lastSeenAt).toLocaleString()}.` : ""}
          {install?.installedVersion
            ? ` Runtime ${install.installedVersion} installed from this desktop.`
            : install
              ? " Set up from this desktop is unfinished."
              : ""}
        </div>
        {runtimeStatus ? (
          <div className="gen-row-desc machines-runtime-status" data-testid="machine-runtime-status" data-state={runtimeStatus.state} role="status">
            {runtimeStatus.text}
          </div>
        ) : null}
        {props.setupOpen ? (
          <MachineSetupPanel
            machineId={machine.id}
            machineName={machine.name}
            install={install}
            onDone={props.onSetupDone}
          />
        ) : null}
      </div>
      <div className="gen-row-control machines-row-actions">
        <button
          type="button"
          className="gen-pill"
          data-testid="machine-setup-toggle"
          aria-expanded={props.setupOpen}
          onClick={props.onToggleSetup}
        >
          <span className="gen-pill-lead"><Settings2 size={14} aria-hidden /></span>
          <span className="gen-pill-label">{install?.installedVersion ? "Upgrade" : "Set up"}</span>
        </button>
        <button type="button" className="gen-pill" onClick={props.onShowEnrollment} data-testid="machine-show-enrollment">
          <span className="gen-pill-label">Enrollment</span>
        </button>
        <button type="button" className="gen-pill machines-remove" onClick={props.onRemove} data-testid="machine-remove" disabled={props.busy}>
          <span className="gen-pill-lead"><Trash2 size={14} aria-hidden /></span>
          <span className="gen-pill-label">Remove</span>
        </button>
      </div>
    </li>
  );
}
