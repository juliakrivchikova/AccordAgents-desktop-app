import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Download, FolderInput, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  MachineInstallRecord,
  MachineInstallSnapshot,
  MachineMirrorBootstrapResult,
  MachineSshTarget
} from "../../../shared/machineInstall";
import { MACHINE_INSTALL_PHASE_ORDER, machineInstallPhaseLabel } from "../../../shared/machineInstall";

/**
 * Installing and upgrading the runtime on a machine, from Settings.
 *
 * This is the one place in the product that reaches a machine over SSH, and it
 * only ever does setup: everything a member does travels over the relay. The
 * panel shows the steps the desktop is walking, the provider sign-in the
 * machine performs itself, and — when something fails — what is true on the
 * machine right now.
 */
export function MachineSetupPanel(props: {
  machineId: string;
  machineName: string;
  install?: MachineInstallRecord;
  onDone: () => void;
}): JSX.Element {
  const { machineId, install } = props;
  const [target, setTarget] = useState<MachineSshTarget>(() => install?.target ?? { host: "", user: "ubuntu" });
  const [installRoot, setInstallRoot] = useState(install?.installRoot ?? "");
  // Which provider the members on this machine will use. "" keeps the previous
  // behaviour (no provider check); picking one makes the setup require that
  // provider to be installed AND signed in ON the machine, and hand over its
  // sign-in when it is not.
  const [requiredProvider, setRequiredProvider] = useState<"" | "codex-cli" | "claude-code">("");
  const [snapshot, setSnapshot] = useState<MachineInstallSnapshot | undefined>(install?.lastOperation);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [mirror, setMirror] = useState<MachineMirrorBootstrapResult | undefined>();

  useEffect(() => {
    return window.consensus.onMachineInstallProgress((next) => {
      if (next.machineId === machineId) {
        setSnapshot(next);
      }
    });
  }, [machineId]);

  const alreadyInstalled = Boolean(install?.installedVersion);
  const running = busy && snapshot !== undefined && !isTerminal(snapshot);

  async function run(kind: "install" | "upgrade"): Promise<void> {
    if (busy || !target.host.trim()) {
      return;
    }
    setBusy(true);
    setError(undefined);
    setMirror(undefined);
    const request = {
      machineId,
      operationId: `${kind}-${Date.now()}`,
      target: { ...target, host: target.host.trim() },
      ...(installRoot.trim() ? { installRoot: installRoot.trim() } : {}),
      ...(requiredProvider ? { requiredProvider } : {})
    };
    try {
      const result = kind === "install"
        ? await window.consensus.installMachine(request)
        : await window.consensus.upgradeMachine(request);
      setSnapshot(result.snapshot);
      props.onDone();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setBusy(false);
    }
  }

  async function copyProject(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      setMirror(await window.consensus.bootstrapMachineProjectMirror({ machineId, localPath: "" }));
    } catch (mirrorError) {
      setError(mirrorError instanceof Error ? mirrorError.message : String(mirrorError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="machine-setup" data-testid="machine-setup-panel" data-machine={machineId}>
      <div className="machine-setup-fields">
        <div className="machine-setup-field">
          <Label htmlFor={`machine-host-${machineId}`}>Address</Label>
          <Input
            id={`machine-host-${machineId}`}
            data-testid="machine-setup-host"
            value={target.host}
            placeholder="203.0.113.4"
            onChange={(event) => setTarget((current) => ({ ...current, host: event.target.value }))}
          />
        </div>
        <div className="machine-setup-field">
          <Label htmlFor={`machine-user-${machineId}`}>User</Label>
          <Input
            id={`machine-user-${machineId}`}
            data-testid="machine-setup-user"
            value={target.user ?? ""}
            placeholder="ubuntu"
            onChange={(event) => setTarget((current) => ({ ...current, user: event.target.value }))}
          />
        </div>
        <div className="machine-setup-field machine-setup-field-wide">
          <Label htmlFor={`machine-key-${machineId}`}>SSH key file</Label>
          <Input
            id={`machine-key-${machineId}`}
            data-testid="machine-setup-key"
            value={target.identityFile ?? ""}
            placeholder="~/.ssh/id_ed25519"
            onChange={(event) => setTarget((current) => ({ ...current, identityFile: event.target.value }))}
          />
        </div>
        <div className="machine-setup-field">
          <Label htmlFor={`machine-provider-${machineId}`}>Provider to sign in</Label>
          <select
            id={`machine-provider-${machineId}`}
            className="machine-setup-select"
            data-testid="machine-setup-provider"
            value={requiredProvider}
            onChange={(event) => setRequiredProvider(event.target.value as "" | "codex-cli" | "claude-code")}
          >
            <option value="">Do not check</option>
            <option value="codex-cli">Codex CLI</option>
            <option value="claude-code">Claude Code</option>
          </select>
        </div>
        <div className="machine-setup-field">
          <Label htmlFor={`machine-root-${machineId}`}>Install directory (optional)</Label>
          <Input
            id={`machine-root-${machineId}`}
            data-testid="machine-setup-root"
            value={installRoot}
            placeholder="~/accordagents-machine"
            onChange={(event) => setInstallRoot(event.target.value)}
          />
        </div>
      </div>
      <div className="machine-setup-actions">
        <button
          type="button"
          className="gen-pill is-primary"
          data-testid="machine-setup-run"
          disabled={busy || !target.host.trim()}
          onClick={() => void run(alreadyInstalled ? "upgrade" : "install")}
        >
          <span className="gen-pill-lead">{running ? <Loader2 className="spin" size={14} aria-hidden /> : <Download size={14} aria-hidden />}</span>
          <span className="gen-pill-label">{alreadyInstalled ? "Upgrade runtime" : "Install runtime"}</span>
        </button>
        <button
          type="button"
          className="gen-pill"
          data-testid="machine-setup-mirror"
          disabled={busy || !install?.installRoot}
          onClick={() => void copyProject()}
        >
          <span className="gen-pill-lead"><FolderInput size={14} aria-hidden /></span>
          <span className="gen-pill-label">Put project on machine</span>
        </button>
      </div>
      {snapshot ? <MachineSetupSteps snapshot={snapshot} /> : null}
      {mirror ? (
        <div className="machine-setup-note" data-testid="machine-setup-mirror-result" data-action={mirror.action}>
          {mirror.message}
        </div>
      ) : null}
      {error ? <div className="device-pairing-error" data-testid="machine-setup-error">{error}</div> : null}
    </div>
  );
}

function MachineSetupSteps(props: { snapshot: MachineInstallSnapshot }): JSX.Element {
  const { snapshot } = props;
  const steps = useMemo(() => MACHINE_INSTALL_PHASE_ORDER.filter((phase) => phase !== "ready"), []);
  const failed = snapshot.phase === "error" || snapshot.phase === "needs-attention";
  return (
    <div className="machine-setup-progress" data-testid="machine-setup-progress" data-phase={snapshot.phase}>
      <ol className="machine-setup-steps">
        {steps.map((phase) => {
          const done = snapshot.completed.includes(phase) || snapshot.phase === "ready";
          const current = snapshot.phase === phase;
          return (
            <li
              key={phase}
              className={`machine-setup-step${done ? " is-done" : ""}${current ? " is-current" : ""}`}
              data-step={phase}
              data-state={done ? "done" : current ? (failed ? "failed" : "current") : "pending"}
            >
              <span className="machine-setup-step-mark" aria-hidden>
                {done ? <Check size={12} /> : current && !failed ? <Loader2 className="spin" size={12} /> : current ? <AlertTriangle size={12} /> : null}
              </span>
              <span>{machineInstallPhaseLabel(phase)}</span>
            </li>
          );
        })}
      </ol>
      <div className="machine-setup-message" data-testid="machine-setup-message">{snapshot.message}</div>
      {snapshot.authUrl ? (
        <div className="machine-setup-note" data-testid="machine-setup-auth">
          Sign in on the machine: <code>{snapshot.authUrl}</code>
          {snapshot.authCode ? <> — code <code>{snapshot.authCode}</code></> : null}
        </div>
      ) : null}
      {snapshot.warnings?.map((warning) => (
        <div key={warning} className="machine-setup-note" data-testid="machine-setup-warning">{warning}</div>
      ))}
      {snapshot.recovery ? (
        <div className="machine-setup-recovery" data-testid="machine-setup-recovery" data-kind={snapshot.recovery.kind}>
          <div>{snapshot.recovery.detail}</div>
          {snapshot.recovery.blockingPids?.length ? (
            <div className="machine-setup-note">Still running on the machine: {snapshot.recovery.blockingPids.join(", ")}.</div>
          ) : null}
          {snapshot.recovery.serviceLog ? (
            <pre className="machine-setup-log" data-testid="machine-setup-log">{snapshot.recovery.serviceLog}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function isTerminal(snapshot: MachineInstallSnapshot): boolean {
  return snapshot.phase === "ready" || snapshot.phase === "error" || snapshot.phase === "needs-attention";
}
