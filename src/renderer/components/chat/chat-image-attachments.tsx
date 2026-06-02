import { useEffect, useMemo, useState } from "react";
import { ImagePlus } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import type { ChatImageAttachment } from "../../../shared/types";
import { formatBytes } from "./chat-format";

export function ChatImageAttachmentStrip(props: {
  conversationId: string;
  attachments: ChatImageAttachment[];
}): JSX.Element {
  const [dataById, setDataById] = useState<Record<string, { dataUrl?: string; error?: string }>>({});
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const signature = useMemo(
    () => props.attachments.map((attachment) => `${attachment.id}:${attachment.sizeBytes}`).join("|"),
    [props.attachments]
  );
  const selectedAttachment = useMemo(
    () => selectedId ? props.attachments.find((attachment) => attachment.id === selectedId) : undefined,
    [props.attachments, selectedId]
  );
  const selectedData = selectedId ? dataById[selectedId]?.dataUrl : undefined;

  useEffect(() => {
    let cancelled = false;
    setDataById({});
    for (const attachment of props.attachments) {
      void window.consensus.readChatAttachment({
        conversationId: props.conversationId,
        attachmentId: attachment.id
      }).then((result) => {
        if (cancelled) {
          return;
        }
        setDataById((current) => ({
          ...current,
          [attachment.id]: {
            dataUrl: `data:${result.attachment.mimeType};base64,${result.dataBase64}`
          }
        }));
      }).catch((error) => {
        if (cancelled) {
          return;
        }
        setDataById((current) => ({
          ...current,
          [attachment.id]: {
            error: chatAttachmentErrorText(error)
          }
        }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [props.conversationId, signature]);

  return (
    <>
      <div className="chat-image-attachments" aria-label="Attached images">
        {props.attachments.map((attachment) => {
          const imageData = dataById[attachment.id];
          return (
            <button
              type="button"
              className={`chat-image-attachment ${imageData?.error ? "error" : ""}`}
              disabled={!imageData?.dataUrl}
              onClick={() => setSelectedId(attachment.id)}
              title={imageData?.error ?? attachment.filename}
              key={attachment.id}
            >
              {imageData?.dataUrl ? (
                <img src={imageData.dataUrl} alt={attachment.filename} />
              ) : (
                <ImagePlus size={18} aria-hidden />
              )}
              <span>{attachment.filename}</span>
              <small>
                {imageData?.error
                  ? "Unavailable"
                  : `${attachment.width}x${attachment.height} · ${formatBytes(attachment.sizeBytes)}`}
              </small>
            </button>
          );
        })}
      </div>
      <Dialog open={Boolean(selectedAttachment)} onOpenChange={(open) => {
        if (!open) {
          setSelectedId(undefined);
        }
      }}>
        <DialogContent className="chat-image-preview-dialog">
          <DialogHeader>
            <DialogTitle>{selectedAttachment?.filename ?? "Image"}</DialogTitle>
            <DialogDescription>
              {selectedAttachment ? `${selectedAttachment.width}x${selectedAttachment.height} · ${formatBytes(selectedAttachment.sizeBytes)}` : ""}
            </DialogDescription>
          </DialogHeader>
          {selectedAttachment && selectedData && (
            <div className="chat-image-preview-frame">
              <img src={selectedData} alt={selectedAttachment.filename} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function chatAttachmentErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
