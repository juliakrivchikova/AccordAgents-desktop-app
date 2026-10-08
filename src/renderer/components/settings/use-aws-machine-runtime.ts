import { useEffect, useState } from "react";
import type { AwsWorkerStatus } from "../../../shared/types";
import type { MachineLinkStatus, MachineListResult, MachineRecord } from "../../../shared/machineLink";
import {
  machineRuntimeStatus,
  type MachineInstallRecord,
  type MachineInstallSnapshot,
  type MachineRuntimeStatus
} from "../../../shared/machineInstall";

export interface AwsMachineRuntime {
  /** The program on this instance that this desktop installed, once known. */
  machine?: MachineRecord;
  link?: MachineLinkStatus;
  install?: MachineInstallRecord;
  /** What the program is running now, as it said hello, else as installed. */
  runningVersion?: string;
  /** The version the desktop brings it to: the desktop's own. */
  desktopVersion?: string;
  /** Updating, update waiting or failed; nothing when it is up to date. */
  runtime?: MachineRuntimeStatus;
  /** The last update or setup failed for this reason, said by the machine. */
  failure?: string;
  /** The machine list could not be read. */
  unavailable: boolean;
  /** The list has been read at least once. */
  loaded: boolean;
}

/** The cloud program on the AWS instance: its version, its updates and its
 *  link to this computer, kept current from the desktop's own events. */
export function useAwsMachineRuntime(status: AwsWorkerStatus | null): AwsMachineRuntime {
  const [machines, setMachines] = useState<MachineListResult>();
  const [unavailable, setUnavailable] = useState(false);
  const [installs, setInstalls] = useState<MachineInstallRecord[]>([]);
  const [liveOps, setLiveOps] = useState<Record<string, MachineInstallSnapshot>>({});
  const [desktopVersion, setDesktopVersion] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    let version = 0;
    void window.consensus.listMachines().then(value => { if (!cancelled && version === 0) setMachines(value); })
      .catch(() => { if (!cancelled && version === 0) setUnavailable(true); });
    const off = window.consensus.onMachinesUpdated(value => { version++; if (!cancelled) { setMachines(value); setUnavailable(false); } });
    const refreshInstalls = (): void => {
      void window.consensus.listMachineInstalls?.().then(records => { if (!cancelled) setInstalls(records); }).catch(() => undefined);
    };
    refreshInstalls();
    void window.consensus.getAppVersion?.().then(value => { if (!cancelled) setDesktopVersion(value); }).catch(() => undefined);
    const offInstall = window.consensus.onMachineInstallProgress?.(snapshot => {
      setLiveOps(current => ({ ...current, [snapshot.machineId]: snapshot }));
      refreshInstalls();
    });
    return () => { cancelled = true; off(); offInstall?.(); };
  }, []);

  const id = status?.actualSpec?.instanceId ?? status?.handle?.instanceId;
  const machine = id ? machines?.machines.find(item => item.awsInstanceId === id) : undefined;
  const link = machines?.status.find(item => item.machineId === machine?.id);
  const install = machine ? installs.find(item => item.machineId === machine.id) : undefined;
  const runningVersion = link?.lastHello?.appVersion ?? install?.installedVersion;
  const runtime = machine
    ? machineRuntimeStatus({ install, live: liveOps[machine.id], connected: link?.connected === true, runningVersion, desktopVersion })
    : undefined;
  const last = install?.lastOperation;
  const failure = runtime?.state === "failed" ? (last?.error ?? last?.message) : undefined;
  return { machine, link, install, runningVersion, desktopVersion, runtime, failure, unavailable, loaded: Boolean(machines) };
}
