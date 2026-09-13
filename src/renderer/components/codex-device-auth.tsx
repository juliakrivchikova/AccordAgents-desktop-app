import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { writeClipboardText, type ClipboardWriteResult } from "../../shared/clipboard";

export function CodexDeviceAuth(props: { authUrl: string; authCode?: string }): JSX.Element {
  // A new challenge must not inherit feedback from the previous code.
  return <DeviceAuthChallenge key={`${props.authUrl}:${props.authCode ?? ""}`} {...props} />;
}

function DeviceAuthChallenge({ authUrl, authCode }: { authUrl: string; authCode?: string }): JSX.Element {
  const [copyResult, setCopyResult] = useState<ClipboardWriteResult>();
  const [copying, setCopying] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const copy = async (): Promise<void> => {
    if (!authCode || copying) return;
    setCopying(true);
    setCopyResult(await writeClipboardText(authCode, value => navigator.clipboard.writeText(value)));
    setCopying(false);
  };
  const open = async (): Promise<void> => {
    setOpenFailed(false);
    try { await window.consensus.openExternal(authUrl); }
    catch { setOpenFailed(true); }
  };
  return (
    <section className="provider-device-auth" aria-label="Codex sign-in" data-testid="cloud-run-device-auth">
      <strong>Sign in to Codex</strong>
      <p>{authCode ? "Copy this one-time code, then enter it on the sign-in page." : "Waiting for a one-time code…"}</p>
      {authCode ? (
        <div className="provider-device-auth-code-row">
          <code data-testid="cloud-run-device-auth-code">{authCode}</code>
          <button type="button" className="provider-device-auth-copy" aria-label="Copy sign-in code"
            title={copyResult === "copied" ? "Copied" : "Copy sign-in code"} disabled={copying} onClick={() => void copy()}>
            {copyResult === "copied" ? <Check size={18} aria-hidden /> : <Copy size={18} aria-hidden />}
          </button>
          {copyResult === "copied" ? <span role="status">Copied</span> : null}
        </div>
      ) : null}
      {copyResult === "failed" ? <p className="provider-device-auth-error" role="alert">Could not copy. Select the code and copy it manually.</p> : null}
      <button type="button" className="provider-device-auth-open" onClick={() => void open()}>Open Codex sign-in</button>
      {openFailed ? <p className="provider-device-auth-error" role="alert">Could not open the sign-in page: {authUrl}</p> : null}
    </section>
  );
}
