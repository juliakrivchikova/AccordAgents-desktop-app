import { Fragment, useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import type { CloudRunWorkerCheck, CloudRunWorkerDoctorReport, CloudRunWorkerSetupProgress } from "../../../shared/types";
import { AwsWaiting } from "./aws-dialog";
import { Row } from "./aws-row";
import { AwsSignInDialog, type AwsSignInRequest } from "./aws-sign-in-dialog";
import { publishAwsAttention } from "./use-aws-attention";
import { cleanError } from "./aws-shared";

type Fix = "sign-in" | "install" | "fix";
interface SetupItem { key: string; label: string; ok: boolean; required: boolean; detail: string; fix?: Fix; provider?: "codex-cli" | "claude-code" }

const TOOLS: Record<string, { label: string; missing: string }> = {
  "gh": { label: "GitHub CLI", missing: "Missing: agents cannot open pull requests." },
  "git": { label: "git", missing: "Missing: agents cannot commit." },
  "node": { label: "Node.js", missing: "Missing: the program on the instance needs it." },
  "java": { label: "Java", missing: "Missing: agents cannot build or test Java projects." },
  "build-essential": { label: "Build tools", missing: "Missing: native npm packages cannot be built." },
  "browser": { label: "Browser for QA", missing: "Missing: agents cannot check web pages in a browser." },
  "headless-display": { label: "Screen for Electron QA", missing: "Missing: agents cannot start Electron apps." },
  "sqlite3": { label: "sqlite3", missing: "Missing: apps that need it cannot start." },
  "rsync": { label: "rsync", missing: "Missing: projects cannot be copied to the instance." }
};
const REUSE_MS = 5 * 60_000;
/** The last checks, kept across visits for the instance they were made on. */
let lastChecked: { instanceId?: string; at: number; report: CloudRunWorkerDoctorReport } | undefined;
export function forgetAwsSetupChecks(): void { lastChecked = undefined; }

/** The doctor's checks, said in product words, one row per thing that
 *  matters to the User; a provider's install and sign-in are one row. */
export function setupItems(checks: CloudRunWorkerCheck[]): SetupItem[] {
  const byId = new Map(checks.map((check) => [check.id as string, check]));
  const items: SetupItem[] = [];
  const add = (item: SetupItem): void => { items.push(item); };
  const connect = byId.get("connect");
  if (connect) add({ key: "connect", label: "Connection to the instance", ok: connect.status === "pass", required: connect.status === "fail", detail: connect.status === "pass" ? "Reached from this computer." : connect.detail ?? "Not reachable." });
  for (const [cli, auth, label, provider] of [["claude", "claude-auth", "Claude Code", "claude-code"], ["codex", "codex-auth", "Codex", "codex-cli"]] as const) {
    const installed = byId.get(cli);
    const signedIn = byId.get(auth);
    if (!installed && !signedIn) continue;
    if (installed && installed.status !== "pass") {
      add({ key: cli, label, ok: false, required: installed.status === "fail", detail: `Not installed: ${label} members cannot run on the instance.`, fix: installed.fixable ? "install" : undefined });
    } else if (signedIn && signedIn.status !== "pass") {
      add({ key: auth, label, ok: false, required: signedIn.status === "fail", detail: `Not signed in: ${label} members cannot run on the instance.`, fix: "sign-in", provider });
    } else {
      add({ key: auth, label, ok: true, required: false, detail: "Installed and signed in." });
    }
  }
  for (const check of checks) {
    if (["connect", "claude", "claude-auth", "codex", "codex-auth"].includes(check.id)) continue;
    const ok = check.status === "pass";
    const tool = TOOLS[check.id];
    if (tool) { add({ key: check.id, label: tool.label, ok, required: check.status === "fail", detail: ok ? "Installed." : tool.missing, fix: !ok && check.fixable ? "install" : undefined }); continue; }
    if (check.id === "git-identity") { add({ key: check.id, label: "Git identity", ok, required: check.status === "fail", detail: ok ? `Commits as ${check.detail ?? "your name"}.` : "Commits need a name and email.", fix: !ok && check.fixable ? "fix" : undefined }); continue; }
    if (check.id === "sudo") { add({ key: check.id, label: "Administrator rights", ok, required: check.status === "fail", detail: ok ? "The app can install what is missing." : "Without passwordless sudo the app cannot install what is missing." }); continue; }
    if (check.id === "userns") { add({ key: check.id, label: "Codex sandbox", ok, required: check.status === "fail", detail: ok ? "Allowed by the system." : "The system does not allow it: Codex cannot sandbox its commands.", fix: !ok && check.fixable ? "fix" : undefined }); continue; }
    if (check.id === "persistent-storage") { add({ key: check.id, label: "Session storage", ok, required: check.status === "fail", detail: ok ? "Kept on the disk; survives a restart." : "Sessions are on storage that does not survive a restart." }); continue; }
    add({ key: check.id, label: check.label, ok, required: check.status === "fail", detail: check.detail ?? (ok ? "Ready." : "Needs attention."), fix: !ok && check.fixable ? "fix" : undefined });
  }
  return items;
}

/**
 * Everything the agents need on the instance, checked by the app itself when
 * the page opens and after every fix: problems first with their fix, then
 * what is ready. Signing a provider in opens the provider's own sign-in.
 */
export function AwsSetupSection(props: { running: boolean; instanceId?: string }): JSX.Element | null {
  const kept = lastChecked?.instanceId === props.instanceId ? lastChecked : undefined;
  const [report, setReport] = useState<CloudRunWorkerDoctorReport | undefined>(kept?.report);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  const [setupRunning, setSetupRunning] = useState(false);
  const [progress, setProgress] = useState<CloudRunWorkerSetupProgress>();
  const [signIn, setSignIn] = useState<{ provider: "codex-cli" | "claude-code"; open: boolean }>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const check = async (): Promise<void> => {
    setChecking(true);
    setError(undefined);
    try {
      const next = await window.consensus.diagnoseCloudRunWorker(undefined);
      lastChecked = { instanceId: props.instanceId, at: Date.now(), report: next };
      if (mounted.current) setReport(next);
    } catch (cause) {
      if (mounted.current) setError(cleanError(cause));
    } finally {
      if (mounted.current) setChecking(false);
    }
  };
  useEffect(() => {
    if (!props.running) return;
    const fresh = lastChecked?.instanceId === props.instanceId ? lastChecked : undefined;
    if (!fresh) setReport(undefined);
    if (!fresh || Date.now() - fresh.at > REUSE_MS) void check();
  }, [props.running, props.instanceId]);
  useEffect(() => {
    const apply = (next: CloudRunWorkerSetupProgress): void => {
      const finished = next.stage === "complete" || next.stage === "error";
      setSetupRunning(!finished);
      setProgress(finished ? undefined : next);
      if (next.authUrl && !finished) setSignIn({ provider: next.authProvider === "claude-code" ? "claude-code" : "codex-cli", open: true });
    };
    const off = window.consensus.onCloudRunSetupProgress((next) => { if (mounted.current) apply(next); });
    void window.consensus.getCloudRunSetupProgress?.().then((next) => { if (next && mounted.current) apply(next); }).catch(() => undefined);
    return off;
  }, []);

  const runSetup = async (provider?: "codex-cli" | "claude-code"): Promise<void> => {
    setSetupRunning(true);
    setError(undefined);
    if (provider) setSignIn({ provider, open: true });
    try {
      const next = await window.consensus.setupCloudRunWorker(undefined);
      lastChecked = { instanceId: props.instanceId, at: Date.now(), report: next };
      if (mounted.current) setReport(next);
    } catch (cause) {
      if (mounted.current) setError(cleanError(cause));
    } finally {
      if (mounted.current) { setSetupRunning(false); setProgress(undefined); setSignIn(undefined); }
    }
  };

  const items = report ? setupItems(report.checks) : [];
  const failing = items.filter((item) => !item.ok);
  const required = failing.filter((item) => item.required).length;
  useEffect(() => { publishAwsAttention("setup", props.running && required > 0); }, [props.running, required]);
  if (!props.running) return null;
  const ordered = [...failing, ...items.filter((item) => item.ok)];
  const meta = checking || setupRunning ? <AwsWaiting>{setupRunning ? progress?.message ?? "Setting up…" : "Checking…"}</AwsWaiting>
    : report ? required ? `${required} of ${items.length} need attention` : failing.length ? `Ready · ${failing.length} optional` : `All ${items.length} ready` : undefined;
  return (
    <section className="gen-section" data-testid="aws-setup">
      <div className="gen-section-head">
        <h2 className="gen-section-title">Setup</h2>
        {meta ? <span className="gen-section-meta" data-testid="aws-setup-meta">{meta}</span> : null}
      </div>
      <div className="gen-card">
        {!report ? (
          <Row title="Checks" desc={error ? undefined : <AwsWaiting>Checking what the agents need on the instance…</AwsWaiting>} error={error} />
        ) : (
          <>
            {error ? <div className="gen-row gen-row-stack"><div className="gen-row-error">{error}</div></div> : null}
            {ordered.map((item, index) => (
              <Fragment key={item.key}>
                {index || error ? <div className="gen-card-divider" /> : null}
                <Row testId={`aws-setup-${item.key}`}
                  title={<><span className={`gen-aws-mark ${item.ok ? "is-ok" : item.required ? "is-fail" : "is-warn"}`} role="img" aria-label={item.ok ? "Ready" : "Needs attention"}>{item.ok ? <Check size={14} aria-hidden /> : <X size={14} aria-hidden />}</span>{item.label}</>}
                  desc={item.ok || !item.required ? item.detail : undefined}
                  error={!item.ok && item.required ? item.detail : undefined}
                  action={item.fix ? {
                    label: item.fix === "sign-in" ? "Sign in…" : setupRunning ? "Working…" : item.fix === "install" ? "Install" : "Fix",
                    disabled: setupRunning || checking,
                    onClick: () => void runSetup(item.fix === "sign-in" ? item.provider : undefined),
                    testId: `aws-setup-${item.key}-fix`
                  } : undefined} />
              </Fragment>
            ))}
          </>
        )}
      </div>
      <AwsSignInDialog open={Boolean(signIn?.open)} provider={signIn?.provider ?? "codex-cli"}
        request={progress as AwsSignInRequest | undefined} onClose={() => setSignIn((current) => current ? { ...current, open: false } : current)} />
    </section>
  );
}
