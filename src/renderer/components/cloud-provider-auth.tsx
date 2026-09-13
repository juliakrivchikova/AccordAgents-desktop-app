import { useEffect, useRef, useState } from "react";
import { CodexDeviceAuth } from "./codex-device-auth";

interface Props {
  authUrl: string;
  authCode?: string;
  authProvider?: string;
  authRequestId?: string;
}

export function CloudProviderAuth(props: Props): JSX.Element {
  return props.authProvider === "claude-code"
    ? <ClaudeSignIn key={props.authRequestId ?? props.authUrl} {...props} />
    : <CodexDeviceAuth authUrl={props.authUrl} authCode={props.authCode} />;
}

function ClaudeSignIn({ authUrl, authRequestId }: Props): JSX.Element {
  const card = useRef<HTMLElement>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState<"input" | "submitting" | "submitted" | "cancelling">("input");
  const [checked, setChecked] = useState(false);
  useEffect(() => { card.current?.scrollIntoView({ block: "nearest" }); }, []);
  useEffect(() => {
    let mounted = true;
    const check = async (): Promise<void> => {
      try {
        const result = !!authRequestId && await window.consensus.isCloudRunAuthActive(authRequestId);
        if (mounted) { setActive(result); setChecked(true); }
      } catch { if (mounted) { setActive(false); setError("Could not check sign-in. Try again when the app reconnects."); } }
    };
    void check();
    const timer = setInterval(() => void check(), 2000);
    return () => { mounted = false; clearInterval(timer); };
  }, [authRequestId]);

  const submit = async (): Promise<void> => {
    if (!active || phase !== "input" || !authRequestId || !code.trim()) return;
    setError(""); setPhase("submitting");
    try {
      await window.consensus.submitCloudRunAuthCode({ requestId: authRequestId, code });
      setCode(""); setPhase("submitted");
    } catch (caught) { setError(cleanError(caught)); setPhase("input"); }
  };
  const cancel = async (): Promise<void> => {
    if (!authRequestId || phase === "cancelling") return;
    setError(""); setPhase("cancelling"); setCode("");
    try { await window.consensus.cancelCloudRunAuth(authRequestId); }
    catch (caught) { setError(cleanError(caught)); setPhase("input"); }
  };

  return (
    <section ref={card} className="provider-device-auth" aria-label="Claude sign-in" data-testid="cloud-run-claude-auth">
      <strong>Sign in to Claude</strong>
      <p>Open the sign-in page and approve access. If Claude gives you a code, paste it below to finish.</p>
      <button type="button" className="provider-device-auth-open" disabled={!active}
        onClick={() => { void window.consensus.openExternal(authUrl).catch(() => setError("Could not open the sign-in page. Try opening it again.")); }}>Open Claude sign-in</button>
      <form className="provider-auth-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <label>Code from Claude
          <input type="password" autoComplete="off" spellCheck={false} aria-label="Code from Claude" maxLength={4096}
            placeholder="Paste the complete code" value={code} disabled={!active || phase !== "input"}
            onChange={event => setCode(event.currentTarget.value)} />
        </label>
        <div className="provider-auth-actions">
          <button type="submit" className="provider-device-auth-open" disabled={!active || phase !== "input" || !code.trim()}>Complete sign-in</button>
          <button type="button" className="provider-device-auth-open" disabled={!active || phase === "cancelling"} onClick={() => void cancel()}>Cancel sign-in</button>
        </div>
      </form>
      {active && phase !== "input" ? <p role="status">{phase === "cancelling" ? "Cancelling sign-in…" : "Waiting for Claude to confirm sign-in…"}</p> : null}
      {checked && !active ? <p role="status">This sign-in is no longer active. Check the setup result or start setup again.</p> : null}
      {error ? <p className="provider-device-auth-error" role="alert">{error}</p> : null}
    </section>
  );
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}
