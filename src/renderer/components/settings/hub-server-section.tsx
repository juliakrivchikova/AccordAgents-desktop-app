import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { HubSetupPhase, HubSetupState } from "../../../shared/hubSetup";
import { AwsCommandBox, AwsDialog } from "./aws-dialog";
import { ADMIN_COMMAND_TEXT, cleanError } from "./aws-shared";

const PHASES: Array<{ id: HubSetupPhase; label: string }> = [
  { id: "connecting", label: "Connect" },
  { id: "preparing", label: "Packages" },
  { id: "uploading", label: "Program" },
  { id: "owner", label: "Owner" },
  { id: "chats", label: "Chats" },
  { id: "starting", label: "Start" },
  { id: "certificate", label: "Certificate" },
  { id: "checking", label: "Check" }
];

/**
 * The User's own server: her chats, search and phone are served from a small
 * server in her AWS account. Setting it up is the AWS setup's shape: one
 * command to run in Terminal with an AWS administrator account, its last line
 * pasted here, and the app installs the rest over SSH.
 */
export function HubServerSection(): JSX.Element {
  const [state, setState] = useState<HubSetupState>();
  const [open, setOpen] = useState(false);
  const [region, setRegion] = useState("us-east-1");
  const [command, setCommand] = useState("");
  const [commandError, setCommandError] = useState<string>();
  const [blob, setBlob] = useState("");
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    void window.consensus.getHubSetupState().then((next) => { if (mounted.current) setState(next); }).catch(() => undefined);
    return window.consensus.onHubSetupProgress((next) => { if (mounted.current) setState(next); });
  }, []);

  const loadCommand = async (next: string): Promise<void> => {
    setCommandError(undefined);
    try {
      const result = await window.consensus.getHubSetupCommand({ region: next.trim() });
      if (mounted.current) setCommand(result.command);
    } catch (cause) {
      if (mounted.current) { setCommand(""); setCommandError(cleanError(cause)); }
    }
  };
  useEffect(() => {
    if (!open) return;
    if (state?.server?.region) setRegion(state.server.region);
    void loadCommand(state?.server?.region ?? region);
  }, [open]);

  const installing = state?.status === "installing";
  const install = async (): Promise<void> => {
    setError(undefined);
    try {
      const next = await window.consensus.installHub({ blob });
      if (mounted.current) {
        setState(next);
        if (next.status === "ready") { setBlob(""); setOpen(false); }
      }
    } catch (cause) {
      if (mounted.current) setError(cleanError(cause));
    }
  };

  const ready = state?.status === "ready";
  const failed = state?.status === "failed" ? state.message : undefined;
  const current = state?.phase ? PHASES.findIndex((phase) => phase.id === state.phase) : -1;
  const failedStep = state?.status === "failed" ? current : -1;
  const description = ready
    ? `Running at ${state?.url}${state?.server?.installedVersion ? ` · version ${state.server.installedVersion}` : ""}. Your chats and search are kept there; a phone connects to it.`
    : installing
      ? state?.message ?? "Setting up…"
      : "Keep your chats, search and phone on a small server in your AWS account, about $5 a month.";
  return (
    <section className="gen-section" data-testid="hub-server">
      <div className="gen-section-head">
        <h2 className="gen-section-title">Your server</h2>
      </div>
      <div className="gen-card">
        <div className="gen-row">
          <div className="gen-row-text">
            <div className="gen-row-title">Server</div>
            <div className="gen-row-desc" data-testid="hub-server-status">{description}</div>
            {failed && !open ? <div className="gen-row-error" role="alert">Setup failed: {failed}</div> : null}
          </div>
          <Button type="button" variant="outline" size="sm" data-testid="hub-server-setup" disabled={installing} onClick={() => setOpen(true)}>
            {installing ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}
            {installing ? "Setting up…" : ready ? "Set up again…" : failed ? "Try again…" : "Set up…"}
          </Button>
        </div>
      </div>
      <AwsDialog
        open={open}
        title="Set up your server"
        testId="hub-server-dialog"
        busy={installing}
        onClose={() => setOpen(false)}
        description={`The command creates a small Lightsail server (512 MB, $5 a month) in your AWS account, or finds the one it made before, and lets this computer in. ${ADMIN_COMMAND_TEXT}, then paste its last line here. The app installs the rest and copies your chats there.`}
        actions={<>
          <Button type="button" variant="outline" size="sm" disabled={installing} onClick={() => setOpen(false)}>{installing ? "Working…" : "Cancel"}</Button>
          <Button type="button" size="sm" data-testid="hub-server-install" disabled={installing || !blob.trim()} onClick={() => void install()}>
            {installing ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}
            {installing ? "Installing…" : "Install"}
          </Button>
        </>}
      >
        <label className="gen-aws-field">
          <span>Region</span>
          <input className="gen-input" aria-label="AWS region" value={region} disabled={installing}
            onChange={(event) => setRegion(event.target.value)} onBlur={() => void loadCommand(region)} />
        </label>
        <AwsCommandBox command={command} error={commandError} label="Copy server setup command" testId="hub-server-command" />
        <label className="gen-aws-field">
          <span>Paste the result</span>
          <textarea className="gen-input gen-aws-paste" aria-label="Server setup result" placeholder="accord-hub-v1:…" data-testid="hub-server-paste"
            value={blob} disabled={installing} onChange={(event) => setBlob(event.target.value)} />
        </label>
        {installing || (state?.status === "failed" && state.phase) ? (
          <ol className={`gen-aws-progress is-${installing ? "setting-up" : "error"}`} data-testid="hub-server-progress" aria-label="Server setup progress">
            {PHASES.map((phase, index) => (
              <li key={phase.id} className={index < current ? "is-done" : index === current && installing ? "is-current" : index === failedStep ? "is-failed" : ""}>
                <span aria-hidden>{index < current ? "✓" : index === failedStep ? "✕" : index + 1}</span>
                <span>{phase.label}</span>
              </li>
            ))}
          </ol>
        ) : null}
        {installing ? <div className="gen-row-desc" data-testid="hub-server-message">{state?.message}</div> : null}
        {error || failed ? <div className="gen-row-error" role="alert" data-testid="hub-server-error">{error ?? failed}</div> : null}
      </AwsDialog>
    </section>
  );
}
