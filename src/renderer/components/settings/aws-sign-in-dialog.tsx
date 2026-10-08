import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "../primitives";
import { AwsDialog, AwsWaiting } from "./aws-dialog";
import { cleanError } from "./aws-shared";

/** A provider sign-in the instance is waiting on, as setup reports it. */
export interface AwsSignInRequest {
  authUrl?: string;
  authCode?: string;
  authProvider?: string;
  authRequestId?: string;
  message?: string;
}

/**
 * Signing a provider in on the instance, the way its own CLI does it: Codex
 * shows a one-time code to enter on its page (codex login --device-auth);
 * Claude Code approves in the browser and gives a code to paste back (/login).
 * Before the instance has asked for anything the dialog says it is preparing.
 */
export function AwsSignInDialog(props: {
  open: boolean;
  provider: "codex-cli" | "claude-code";
  request?: AwsSignInRequest;
  onClose: () => void;
}): JSX.Element {
  const request = props.request?.authUrl ? props.request : undefined;
  const provider = request?.authProvider === "claude-code" ? "claude-code" : request ? "codex-cli" : props.provider;
  const name = provider === "claude-code" ? "Claude Code" : "Codex";
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<"input" | "submitting" | "submitted">("input");
  const [error, setError] = useState<string>();
  useEffect(() => { setCode(""); setPhase("input"); setError(undefined); }, [request?.authRequestId, request?.authUrl, props.open]);

  const open = async (): Promise<void> => {
    if (!request?.authUrl) return;
    setError(undefined);
    try { await window.consensus.openExternal(request.authUrl); }
    catch { setError(`Could not open the sign-in page: ${request.authUrl}`); }
  };
  const finish = async (): Promise<void> => {
    if (!request?.authRequestId || !code.trim() || phase !== "input") return;
    setPhase("submitting");
    setError(undefined);
    try {
      await window.consensus.submitCloudRunAuthCode({ requestId: request.authRequestId, code });
      setCode("");
      setPhase("submitted");
    } catch (cause) {
      setError(cleanError(cause));
      setPhase("input");
    }
  };
  // Only Cancel ends the sign-in; the dialog closes once the instance let go.
  const [cancelling, setCancelling] = useState(false);
  const close = async (): Promise<void> => {
    setCancelling(true);
    try {
      if (request?.authRequestId) await window.consensus.cancelCloudRunAuth(request.authRequestId).catch(() => undefined);
    } finally {
      setCancelling(false);
      props.onClose();
    }
  };

  const waiting = !request
    ? <AwsWaiting>{props.request?.message ?? "Preparing the sign-in on the instance…"}</AwsWaiting>
    : provider === "codex-cli" || phase === "submitted"
      ? <AwsWaiting>Waiting for {name} to confirm…</AwsWaiting>
      : undefined;
  return (
    <AwsDialog
      open={props.open}
      title={`Sign in to ${name} on the instance`}
      testId="aws-sign-in-dialog"
      description={provider === "claude-code"
        ? "The same sign-in as /login in Claude Code. Open the sign-in page, approve access, then paste the code Claude shows."
        : "The same sign-in as codex login. Copy the one-time code, open the sign-in page and enter the code there."}
      note={waiting}
      dismissible={false}
      onClose={() => void close()}
      actions={provider === "claude-code" ? <>
        <Button type="button" variant="outline" size="sm" disabled={cancelling} onClick={() => void close()}>Cancel</Button>
        <Button type="button" size="sm" data-testid="aws-sign-in-finish" disabled={!request || !code.trim() || phase !== "input"} onClick={() => void finish()}>
          {phase === "submitting" ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}
          Finish sign-in
        </Button>
      </> : <>
        <Button type="button" variant="outline" size="sm" disabled={cancelling} onClick={() => void close()}>Cancel</Button>
        <Button type="button" size="sm" data-testid="aws-sign-in-open" disabled={!request} onClick={() => void open()}>Open sign-in page</Button>
      </>}
    >
      {provider === "codex-cli" ? (
        request?.authCode ? (
          <div className="gen-aws-code">
            <code data-testid="aws-sign-in-code">{request.authCode}</code>
            <CopyButton text={request.authCode} label="Copy sign-in code" />
          </div>
        ) : null
      ) : (
        <>
          <div><Button type="button" variant="outline" size="sm" disabled={!request} data-testid="aws-sign-in-open" onClick={() => void open()}>Open sign-in page</Button></div>
          <label className="gen-aws-field">
            <span>Code from Claude</span>
            <input className="gen-input" type="password" autoComplete="off" spellCheck={false} aria-label="Code from Claude"
              placeholder="Paste the code" maxLength={4096} value={code} disabled={!request || phase !== "input"}
              onChange={(event) => setCode(event.currentTarget.value)} />
          </label>
        </>
      )}
      {error ? <div className="gen-row-error" role="alert">{error}</div> : null}
    </AwsDialog>
  );
}
