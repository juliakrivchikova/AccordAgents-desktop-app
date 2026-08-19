import { useState } from "react";
import { CheckCircle2, Copy, Loader2, QrCode, ShieldX, Smartphone, X } from "lucide-react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CreateMobilePairingResult, MobileControlSettings } from "../../../shared/types";
import { writeClipboardText } from "../../../shared/clipboard";
import { IconButton } from "../primitives";

export function ChatMobilePairingDialog(props: {
  conversationId: string;
  mobileControl?: MobileControlSettings;
  disabled?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <>
      <IconButton
        label="Mobile control"
        icon={Smartphone}
        disabled={props.disabled}
        tooltip="Mobile control"
        className="topbar-icon-button"
        size="sm"
        onClick={() => setOpen(true)}
      />
      <MobilePairingDialogContent
        conversationId={props.conversationId}
        mobileControl={props.mobileControl}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

// Exported for the W-J test: the confirmation gate is behavior of this
// component, so the test drives the real dialog rather than a stand-in.
export function MobilePairingDialogContent(props: {
  conversationId: string;
  mobileControl?: MobileControlSettings;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const [relayUrl, setRelayUrl] = useState("");
  const [staticOriginUrl, setStaticOriginUrl] = useState("");
  const [outboxUrl, setOutboxUrl] = useState("");
  const [result, setResult] = useState<CreateMobilePairingResult | undefined>();
  const [qrDataUrl, setQrDataUrl] = useState<string | undefined>();
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
      const next = await window.consensus.createMobilePairing({
        conversationId: props.conversationId,
        purpose: "phone-control",
        canRunCloudParticipants: true,
        canInviteOthers: false,
        relayUrl: relayUrl.trim() || undefined,
        staticOriginUrl: staticOriginUrl.trim() || undefined,
        outboxUrl: outboxUrl.trim() || undefined
      });
      setResult(next);
      setQrDataUrl(await QRCode.toDataURL(next.pwaUrl ?? next.qrPayload, {
        errorCorrectionLevel: "Q",
        margin: 4,
        width: 260
      }));
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
    <Dialog
      open={props.open}
      onOpenChange={(nextOpen) => {
        props.onOpenChange(nextOpen);
        if (!nextOpen) {
          // Closing disarms the confirmation: reopening must not find a
          // primed destructive button one click from firing.
          setConfirmingRevoke(false);
        }
        if (!nextOpen && status !== "revoked") {
          setStatus("idle");
          setError(undefined);
        }
      }}
    >
        <DialogContent className="chat-mobile-pairing-dialog" showCloseButton={false}>
          <DialogHeader className="chat-mobile-pairing-head">
            <div className="chat-mobile-pairing-title-row">
              <div>
                <DialogTitle>Mobile control</DialogTitle>
                <DialogDescription>Connect your phone to this app.</DialogDescription>
              </div>
              <DialogClose asChild>
                <button type="button" className="chat-mobile-pairing-close" aria-label="Close mobile control">
                  <X size={17} aria-hidden />
                </button>
              </DialogClose>
            </div>
          </DialogHeader>
          <div className={`chat-mobile-pairing-grid${showEndpointFields ? "" : " is-managed"}`}>
            {showEndpointFields ? (
              <div className="chat-mobile-pairing-fields">
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
                {error ? <div className="chat-mobile-pairing-error">{error}</div> : null}
              </div>
            ) : null}
            <div
              className="chat-mobile-pairing-qr"
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
              {status === "revoked" ? <span className="chat-mobile-pairing-state">Revoked</span> : null}
            </div>
          </div>
          {!showEndpointFields && error ? <div className="chat-mobile-pairing-error">{error}</div> : null}
          {confirmingRevoke ? (
            <div className="chat-mobile-pairing-error">
              This cannot be undone. The link stops working for good and the phone has to be paired again.
            </div>
          ) : null}
          <DialogFooter className="chat-mobile-pairing-actions">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void revokePairing()}
              disabled={!result || status === "busy" || status === "revoked"}
            >
              <ShieldX aria-hidden />
              {confirmingRevoke ? "Revoke permanently" : "Revoke"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void copyMobileUrl()} disabled={!mobileUrl || status === "revoked"}>
              {status === "copied" ? <CheckCircle2 aria-hidden /> : <Copy aria-hidden />}
              {status === "copied" ? "Copied" : "Copy URL"}
            </Button>
            <Button size="sm" onClick={() => void createPairing()} disabled={!canCreate}>
              {status === "busy" ? <Loader2 className="spin" aria-hidden /> : <QrCode aria-hidden />}
              Generate
            </Button>
          </DialogFooter>
        </DialogContent>
    </Dialog>
  );
}
