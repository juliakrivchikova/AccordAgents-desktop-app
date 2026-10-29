import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HUB_SETUP_BLOB_PREFIX, HUB_SETUP_STEPS, parseHubServerBlob, type HubSetupState, type HubSetupStep } from "../../../shared/hubSetup";
import { AwsCommandBox, AwsDialog } from "./aws-dialog";
import { ADMIN_COMMAND_TEXT, AwsPasteField, cleanError } from "./aws-shared";

const STEP_LABELS: Record<HubSetupStep, string> = {
  connecting: "Connect",
  preparing: "Packages",
  uploading: "Program",
  owner: "Owner",
  starting: "Start",
  certificate: "Certificate",
  checking: "Check"
};

const HUB_STATE_REFRESH_MS = 10_000;

/** Where a pasted line points, for the User to see before anything is copied
 *  there: read as Install reads it, so a line it refuses names no place. */
export function pastedDestination(text: string): string | undefined {
  try {
    const server = parseHubServerBlob(text);
    return `${server.instanceName} at ${server.ip} (${server.region})`;
  } catch {
    return undefined;
  }
}

/**
 * The User's own server: her chats and search are kept on a small server in
 * her AWS account. Setting it up is the AWS setup's shape: one
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
  /** The line the start-over question was about: another line is asked anew. */
  const [askedBlob, setAskedBlob] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    const refresh = (): void => {
      void window.consensus.getHubSetupState().then((next) => { if (mounted.current) setState(next); }).catch(() => undefined);
    };
    refresh();
    // Whether the server answers changes on its own; an install reports its
    // own progress.
    const timer = window.setInterval(refresh, HUB_STATE_REFRESH_MS);
    const stop = window.consensus.onHubSetupProgress((next) => { if (mounted.current) setState(next); });
    return () => { window.clearInterval(timer); stop(); };
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
  const installing = state?.status === "installing";
  useEffect(() => {
    if (!open || installing) return;
    const known = state?.server?.region ?? state?.defaultRegion;
    if (known) setRegion(known);
    void loadCommand(known ?? region);
  }, [open]);

  const run = async (request: { blob?: string; startOver?: boolean }): Promise<void> => {
    setError(undefined);
    try {
      const next = await window.consensus.installHub(request);
      if (mounted.current) {
        setState(next);
        setAskedBlob(next.reason === "another-owner" ? request.blob : undefined);
        if (next.status === "ready") { setBlob(""); setOpen(false); }
      }
    } catch (cause) {
      if (mounted.current) setError(cleanError(cause));
    }
  };

  const ready = state?.status === "ready";
  const failed = state?.status === "failed" ? state.message : undefined;
  const askingStartOver = state?.status === "failed" && state.reason === "another-owner" && askedBlob !== undefined && askedBlob === blob;
  const updateAvailable = ready && Boolean(state?.server?.installedVersion && state.server.installedVersion !== state.bundledVersion);
  const current = state?.phase ? HUB_SETUP_STEPS.indexOf(state.phase as HubSetupStep) : -1;
  const failedStep = state?.status === "failed" ? current : -1;
  const running = state?.url
    ? `Running at ${state.url}${state.server?.installedVersion ? ` · version ${state.server.installedVersion}` : ""}. The text of your chats and their search are kept there.`
    : undefined;
  const description = installing
    ? state?.message ?? "Setting up…"
    : running ?? "Keep the text of your chats and their search on a small server in your AWS account, about $5 a month.";
  const unreachable = ready && !installing && state?.reachable === false;
  const destination = pastedDestination(blob);
  const actionLabel = installing ? "Show progress…" : updateAvailable ? "Update…" : ready ? "Set up again…" : failed ? "Try again…" : "Set up…";
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
            {!open && (error || failed) ? <div className="gen-row-error" role="alert">{error ?? `Setup stopped: ${failed}`}</div> : null}
            {unreachable ? <div className="gen-row-error" data-testid="hub-server-unreachable">This computer is not reaching the server right now; it keeps trying.</div> : null}
            {ready && !installing ? (state?.notices ?? []).map((notice) => (
              <div key={notice} className="gen-row-desc" data-testid="hub-server-notice">{notice}</div>
            )) : null}
          </div>
          <Button type="button" variant="outline" size="sm" data-testid="hub-server-setup"
            onClick={() => (updateAvailable ? void run({}) : setOpen(true))}>
            {installing ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}
            {actionLabel}
          </Button>
        </div>
      </div>
      <AwsDialog
        open={open}
        title="Set up your server"
        testId="hub-server-dialog"
        onClose={() => setOpen(false)}
        description={`The command creates a small Lightsail server (512 MB, $5 a month) in your AWS account, or finds the one it made before, and lets this computer in. ${ADMIN_COMMAND_TEXT}, then paste its last line here. The app installs the rest and copies the text of your chats there the first time; attachments stay on this computer.`}
        actions={<>
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>{installing ? "Hide" : "Cancel"}</Button>
          {askingStartOver ? (
            <Button type="button" size="sm" data-testid="hub-server-start-over" disabled={installing || !blob.trim()} onClick={() => void run({ blob, startOver: true })}>
              Start over for this computer
            </Button>
          ) : (
            <Button type="button" size="sm" data-testid="hub-server-install" disabled={installing || !blob.trim()} onClick={() => void run({ blob })}>
              {installing ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}
              {installing ? "Installing…" : "Install"}
            </Button>
          )}
        </>}
      >
        <label className="gen-aws-field">
          <span>Region</span>
          <input className="gen-input" aria-label="AWS region" value={region} disabled={installing}
            onChange={(event) => setRegion(event.target.value)} onBlur={() => void loadCommand(region)} />
        </label>
        <AwsCommandBox command={command} error={commandError} label="Copy server setup command" testId="hub-server-command" />
        <AwsPasteField value={blob} disabled={installing} onChange={setBlob} ariaLabel="Server setup result" placeholder={`${HUB_SETUP_BLOB_PREFIX}…`} testId="hub-server-paste" />
        {destination ? <div className="gen-row-desc" data-testid="hub-server-destination">Installs on {destination}.</div> : null}
        {installing || state?.status === "failed" ? (
          <ol className="gen-aws-progress" data-testid="hub-server-progress" aria-label="Server setup progress">
            {HUB_SETUP_STEPS.map((step, index) => {
              const done = index < current;
              const className = done ? "is-done" : index === current && installing ? "is-current" : index === failedStep ? "is-failed" : "";
              return (
                <li key={step} className={className}>
                  <span aria-hidden>{done ? "✓" : index === failedStep ? "✕" : index + 1}</span>
                  <span>{STEP_LABELS[step]}</span>
                </li>
              );
            })}
          </ol>
        ) : null}
        {installing ? <div className="gen-row-desc" data-testid="hub-server-message">{state?.message}</div> : null}
        {error || failed ? <div className="gen-row-error" role="alert" data-testid="hub-server-error">{error ?? failed}</div> : null}
      </AwsDialog>
    </section>
  );
}
