import { useState } from "react";
import { CheckCircle2, Copy, Loader2, QrCode, Smartphone, X } from "lucide-react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CreateMobilePairingResult } from "../../../shared/types";
import { writeClipboardText } from "../../../shared/clipboard";
import { IconButton } from "../primitives";

export function ChatMobilePairingDialog(props: {
  conversationId: string;
  disabled?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [relayUrl, setRelayUrl] = useState("");
  const [staticOriginUrl, setStaticOriginUrl] = useState("");
  const [outboxUrl, setOutboxUrl] = useState("");
  const [result, setResult] = useState<CreateMobilePairingResult | undefined>();
  const [qrDataUrl, setQrDataUrl] = useState<string | undefined>();
  const [status, setStatus] = useState<"idle" | "busy" | "copied" | "error">("idle");
  const [error, setError] = useState<string | undefined>();

  const canCreate = relayUrl.trim().startsWith("wss://") && staticOriginUrl.trim().startsWith("https://") && status !== "busy";
  const mobileUrl = result?.pwaUrl ?? result?.qrPayload;

  async function createPairing(): Promise<void> {
    if (!canCreate) {
      return;
    }
    setStatus("busy");
    setError(undefined);
    try {
      const next = await window.consensus.createMobilePairing({
        conversationId: props.conversationId,
        relayUrl: relayUrl.trim(),
        staticOriginUrl: staticOriginUrl.trim(),
        outboxUrl: outboxUrl.trim() || undefined
      });
      setResult(next);
      setQrDataUrl(await QRCode.toDataURL(next.pwaUrl ?? next.qrPayload, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 240
      }));
      setStatus("idle");
    } catch (createError) {
      setStatus("error");
      setError(createError instanceof Error ? createError.message : String(createError));
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
      <Dialog open={open} onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setStatus("idle");
          setError(undefined);
        }
      }}>
        <DialogContent className="chat-mobile-pairing-dialog" showCloseButton={false}>
          <DialogHeader className="chat-mobile-pairing-head">
            <div>
              <DialogTitle>Mobile control</DialogTitle>
              <DialogDescription>Create a QR code for this chat.</DialogDescription>
            </div>
            <DialogClose asChild>
              <IconButton label="Close mobile control" icon={X} size="sm" />
            </DialogClose>
          </DialogHeader>
          <div className="chat-mobile-pairing-grid">
            <div className="chat-mobile-pairing-fields">
              <Label htmlFor="mobile-relay-url">Relay WSS URL</Label>
              <Input
                id="mobile-relay-url"
                value={relayUrl}
                placeholder="wss://relay.example.com/v1/relay"
                onChange={(event) => setRelayUrl(event.target.value)}
              />
              <Label htmlFor="mobile-static-origin">PWA origin</Label>
              <Input
                id="mobile-static-origin"
                value={staticOriginUrl}
                placeholder="https://app.example.com/mobile/"
                onChange={(event) => setStaticOriginUrl(event.target.value)}
              />
              <Label htmlFor="mobile-outbox-url">Mailbox outbox URL</Label>
              <Input
                id="mobile-outbox-url"
                value={outboxUrl}
                placeholder="https://mailbox.example.com/v1/mailbox/events"
                onChange={(event) => setOutboxUrl(event.target.value)}
              />
              {error ? <div className="chat-mobile-pairing-error">{error}</div> : null}
            </div>
            <div className="chat-mobile-pairing-qr" aria-live="polite">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="Mobile control QR" />
              ) : (
                <QrCode size={96} aria-hidden />
              )}
              {result ? <code>{result.package.fingerprint}</code> : null}
            </div>
          </div>
          <DialogFooter className="chat-mobile-pairing-actions">
            <Button variant="outline" size="sm" onClick={() => void copyMobileUrl()} disabled={!mobileUrl}>
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
    </>
  );
}
