import { useState } from "react";
import { CheckCircle2, Copy, Loader2, QrCode, ShieldX } from "lucide-react";
import QRCode from "qrcode";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CreateMobilePairingResult, MobileControlSettings } from "../../../shared/types";
import { writeClipboardText } from "../../../shared/clipboard";

// The Revoke button is the only way to kill a pairing, and it needs the handle
// returned when the pairing was created. Settings unmounts as soon as the user
// leaves the screen, so the handle is kept here for the life of the app session
// instead of dying with the component.
let lastPairing: { result: CreateMobilePairingResult; qrDataUrl?: string } | undefined;

export function DevicePairingSection(props: {
  mobileControl?: MobileControlSettings;
}): JSX.Element {
  const [relayUrl, setRelayUrl] = useState("");
  const [staticOriginUrl, setStaticOriginUrl] = useState("");
  const [outboxUrl, setOutboxUrl] = useState("");
  const [result, setResult] = useState<CreateMobilePairingResult | undefined>(lastPairing?.result);
  const [qrDataUrl, setQrDataUrl] = useState<string | undefined>(lastPairing?.qrDataUrl);
  const [status, setStatus] = useState<"idle" | "busy" | "copied" | "revoked" | "error">("idle");
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const defaults = props.mobileControl?.defaults;
  const effectiveRelayUrl = relayUrl.trim() || defaults?.relayUrl || "";
  const effectiveStaticOriginUrl = staticOriginUrl.trim() || defaults?.staticOriginUrl || "";
  const effectiveOutboxUrl = outboxUrl.trim() || defaults?.outboxUrl || "";
  const canCreate = effectiveRelayUrl.startsWith("wss://") && effectiveStaticOriginUrl.startsWith("https://") && status !== "busy";
  const mobileUrl = result?.pwaUrl ?? result?.qrPayload;
  const hasManagedDefaults = props.mobileControl?.provider === "accord-managed" && Boolean(defaults?.relayUrl && defaults.staticOriginUrl);
  const showEndpointFields = !hasManagedDefaults;

  async function createPairing(): Promise<void> {
    if (!canCreate) {
      return;
    }
    setStatus("busy");
    setError(undefined);
    try {
      // Phone control is a device-scoped pairing: it is not tied to the chat
      // it used to be started from, which is why it lives in Settings.
      const next = await window.consensus.createMobilePairing({
        purpose: "phone-control",
        canRunCloudParticipants: true,
        canInviteOthers: false,
        relayUrl: relayUrl.trim() || undefined,
        staticOriginUrl: staticOriginUrl.trim() || undefined,
        outboxUrl: outboxUrl.trim() || undefined
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

  // W-J: revocation is terminal — the mailbox is destroyed and the same link
  // can never be reactivated, so recovery from a misclick is a full re-pair.
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
      await window.consensus.revokeMobilePairing({
        stableRoutingId: result.package.stableRoutingId,
        rendezvousId: result.package.rendezvousId,
        reason: "desktop-user"
      });
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

  return (
    <section className="gen-section">
      <h2 className="gen-section-title gen-section-title-solo">Device Pairing</h2>
      <div className="gen-card">
        <div className="gen-row">
          <div className="gen-row-text">
            <div className="gen-row-title">Mobile control</div>
            <div className="gen-row-desc">
              Scan the code with your phone to control this app from it. The pairing covers the whole app, not a single chat.
            </div>
          </div>
        </div>
        <div className="gen-card-divider" />
        <div className="gen-row gen-row-stack">
          <div className={`device-pairing-grid${showEndpointFields ? "" : " is-managed"}`}>
            {showEndpointFields ? (
              <div className="device-pairing-fields">
                <Label htmlFor="mobile-relay-url">Relay WSS URL</Label>
                <Input
                  id="mobile-relay-url"
                  value={relayUrl}
                  placeholder={defaults?.relayUrl ?? "wss://relay.example.com/v1/relay"}
                  onChange={(event) => setRelayUrl(event.target.value)}
                />
                <Label htmlFor="mobile-static-origin">PWA origin</Label>
                <Input
                  id="mobile-static-origin"
                  value={staticOriginUrl}
                  placeholder={defaults?.staticOriginUrl ?? "https://app.example.com/mobile/"}
                  onChange={(event) => setStaticOriginUrl(event.target.value)}
                />
                <Label htmlFor="mobile-outbox-url">Mailbox outbox URL</Label>
                <Input
                  id="mobile-outbox-url"
                  value={outboxUrl}
                  placeholder={effectiveOutboxUrl || "https://mailbox.example.com/v1/mailbox/events"}
                  onChange={(event) => setOutboxUrl(event.target.value)}
                />
              </div>
            ) : null}
            <div
              className="device-pairing-qr"
              aria-live="polite"
              data-pairing-purpose={result?.package.purpose ?? ""}
              data-mobile-url={mobileUrl ?? ""}
              data-expires-at={result?.package.expiresAt ?? ""}
              data-revoked={status === "revoked" ? "true" : "false"}
            >
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="Mobile control QR" />
              ) : (
                <QrCode size={96} aria-hidden />
              )}
              {result ? <code>{result.package.fingerprint}</code> : null}
              {status === "revoked" ? <span className="device-pairing-state">Revoked</span> : null}
            </div>
          </div>
          {error ? <div className="device-pairing-error">{error}</div> : null}
          {confirmingRevoke ? (
            <div className="device-pairing-error">
              This cannot be undone. The link stops working for good and the phone has to be paired again.
            </div>
          ) : null}
          <div className="gen-actions">
            <button
              type="button"
              className="gen-pill gen-pill-danger"
              data-device-pairing-action="revoke"
              disabled={!result || status === "busy" || status === "revoked"}
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
            <button
              type="button"
              className="gen-pill"
              data-device-pairing-action="generate"
              disabled={!canCreate}
              onClick={() => void createPairing()}
            >
              <span className="gen-pill-lead">
                {status === "busy" ? <Loader2 className="spin" size={16} aria-hidden /> : <QrCode size={16} aria-hidden />}
              </span>
              <span className="gen-pill-label">Generate</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
