import { useEffect, useState } from "react";
import { CheckCircle2, Copy, Loader2, QrCode, ShieldX } from "lucide-react";
import QRCode from "qrcode";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CreatePhoneInviteResult, MobileControlSettings } from "../../../shared/types";
import { writeClipboardText } from "../../../shared/clipboard";

// The Revoke button is the only way to kill a pairing, and it needs the handle
// returned when the pairing was created. Settings unmounts as soon as the user
// leaves the screen, so the handle is kept here for the life of the app session
// instead of dying with the component.
let lastPairing: { result: CreatePhoneInviteResult; qrDataUrl?: string } | undefined;

// The handle above outlives every render, so a test that wants the untouched
// section has to clear it rather than rely on running first.
export function forgetDevicePairingForTests(): void {
  lastPairing = undefined;
}

export function DevicePairingSection(props: {
  mobileControl?: MobileControlSettings;
}): JSX.Element {
  const [staticOriginUrl, setStaticOriginUrl] = useState("");
  const [result, setResult] = useState<CreatePhoneInviteResult | undefined>(lastPairing?.result);
  const [qrDataUrl, setQrDataUrl] = useState<string | undefined>(lastPairing?.qrDataUrl);
  const [status, setStatus] = useState<"idle" | "busy" | "copied" | "revoked" | "error">("idle");
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // A phone connects through the User's own server: none, no pairing.
  const [serverReady, setServerReady] = useState<boolean | undefined>();
  useEffect(() => {
    let live = true;
    const take = (state: { url?: string }) => { if (live) setServerReady(Boolean(state.url)); };
    void window.consensus.getHubSetupState?.().then(take).catch(() => undefined);
    const stop = window.consensus.onHubSetupProgress?.(take);
    return () => { live = false; stop?.(); };
  }, []);

  const defaults = props.mobileControl?.defaults;
  const effectiveStaticOriginUrl = staticOriginUrl.trim() || defaults?.staticOriginUrl || "";
  // The phone pairs with the User's server; only the phone app's own address
  // can differ from the usual one.
  const canCreate = serverReady === true && /^https?:\/\//.test(effectiveStaticOriginUrl) && status !== "busy";
  const mobileUrl = result?.pwaUrl ?? result?.qrPayload;
  const showEndpointFields = !defaults?.staticOriginUrl;

  async function createPairing(): Promise<void> {
    if (!canCreate) {
      return;
    }
    setStatus("busy");
    setError(undefined);
    try {
      // Phone control covers every chat: it is not tied to the chat it used
      // to be started from, which is why it lives in Settings. The code is
      // for the User's server: the phone pairs with it, not with this Mac.
      const next = await window.consensus.createPhoneInvite({
        staticOriginUrl: staticOriginUrl.trim() || undefined
      });
      setResult(next);
      const nextQrDataUrl = await QRCode.toDataURL(next.pwaUrl ?? next.qrPayload, {
        errorCorrectionLevel: "Q",
        margin: 4,
        width: 260
      });
      setQrDataUrl(nextQrDataUrl);
      lastPairing = { result: next, qrDataUrl: nextQrDataUrl };
      setStatus("idle");
    } catch (createError) {
      setStatus("error");
      setError(createError instanceof Error ? createError.message : String(createError));
    }
  }

  // W-J: revocation is terminal — the code stops working on the User's server
  // and a phone paired with it is removed, so recovery from a misclick is a
  // full re-pair.
  // The first click asks; only the second revokes.
  async function revokePairing(): Promise<void> {
    if (!result || status === "busy") {
      return;
    }
    if (!confirmingRevoke) {
      setConfirmingRevoke(true);
      setError(undefined);
      return;
    }
    setConfirmingRevoke(false);
    setStatus("busy");
    setError(undefined);
    try {
      await window.consensus.revokePhoneInvite({ inviteId: result.inviteId });
      lastPairing = undefined;
      setStatus("revoked");
    } catch (revokeError) {
      setStatus("error");
      setError(revokeError instanceof Error ? revokeError.message : String(revokeError));
    }
  }

  async function copyMobileUrl(): Promise<void> {
    if (!mobileUrl) {
      return;
    }
    const copied = await writeClipboardText(mobileUrl, (value) => navigator.clipboard.writeText(value));
    setStatus(copied === "copied" ? "copied" : "error");
    if (copied !== "copied") {
      setError("Copy failed.");
    }
  }

  // With nothing paired yet there is only one control, so the card reads like
  // every other settings row: text on the left, the action on the right. The
  // code, its fingerprint and the rest of the actions unfold underneath once a
  // pairing exists.
  const expanded = showEndpointFields || Boolean(result) || Boolean(error);
  const generateButton = (
    <button
      type="button"
      className="gen-pill device-pairing-generate"
      data-device-pairing-action="generate"
      disabled={!canCreate}
      onClick={() => void createPairing()}
    >
      <span className="gen-pill-lead">
        {status === "busy" ? <Loader2 className="spin" size={16} aria-hidden /> : <QrCode size={16} aria-hidden />}
      </span>
      <span className="gen-pill-label">Generate</span>
    </button>
  );

  return (
    <section className="gen-section">
      <h2 className="gen-section-title gen-section-title-solo">Device Pairing</h2>
      <div className="gen-card">
        <div className="gen-row">
          <div className="gen-row-text">
            <div className="gen-row-title">Mobile control</div>
            <div className="gen-row-desc" data-testid="device-pairing-desc">
              {serverReady === false
                ? "Set up your server first (Your server, above): the phone connects through it."
                : "Scan the code with your phone to control this app from it. The pairing covers the whole app, not a single chat."}
            </div>
          </div>
          <div className="gen-row-control">{generateButton}</div>
        </div>
        {expanded ? (
          <>
            <div className="gen-card-divider" />
            <div className="gen-row device-pairing-body">
              <div className={`device-pairing-grid${showEndpointFields ? "" : " is-managed"}`}>
                {showEndpointFields ? (
                  <div className="device-pairing-fields">
                    <Label htmlFor="mobile-static-origin">PWA origin</Label>
                    <Input
                      id="mobile-static-origin"
                      value={staticOriginUrl}
                      placeholder="https://app.example.com/mobile/"
                      onChange={(event) => setStaticOriginUrl(event.target.value)}
                    />
                  </div>
                ) : null}
                {result ? (
                  <div
                    className="device-pairing-qr"
                    aria-live="polite"
                    data-pairing-purpose="phone-control"
                    data-mobile-url={mobileUrl ?? ""}
                    data-expires-at={result.expiresAt ?? ""}
                    data-revoked={status === "revoked" ? "true" : "false"}
                  >
                    {qrDataUrl ? (
                      <img src={qrDataUrl} alt="Mobile control QR" />
                    ) : (
                      <QrCode size={96} aria-hidden />
                    )}
                    {status === "revoked" ? <span className="device-pairing-state">Revoked</span> : null}
                  </div>
                ) : null}
              </div>
              {error ? <div className="device-pairing-error">{error}</div> : null}
              {confirmingRevoke ? (
                <div className="device-pairing-error">
                  This cannot be undone. The code stops working for good, a phone paired with it is removed, and it has to be paired again.
                </div>
              ) : null}
              <div className="gen-actions">
                {result ? (
                  <>
                    <button
                      type="button"
                      className="gen-pill gen-pill-danger"
                      data-device-pairing-action="revoke"
                      disabled={status === "busy" || status === "revoked"}
                      onClick={() => void revokePairing()}
                    >
                      <span className="gen-pill-lead"><ShieldX size={16} aria-hidden /></span>
                      <span className="gen-pill-label">{confirmingRevoke ? "Revoke permanently" : "Revoke"}</span>
                    </button>
                    <button
                      type="button"
                      className="gen-pill"
                      data-device-pairing-action="copy"
                      disabled={!mobileUrl || status === "revoked"}
                      onClick={() => void copyMobileUrl()}
                    >
                      <span className="gen-pill-lead">
                        {status === "copied" ? <CheckCircle2 size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
                      </span>
                      <span className="gen-pill-label">{status === "copied" ? "Copied" : "Copy URL"}</span>
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
