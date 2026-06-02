import React, { useEffect, useRef, useState } from "react";
import { FileText, ImagePlus, RefreshCw, SendHorizontal, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ResizableTextarea } from "@/renderer/components/primitives";
import type {
  ChatImageInput,
  ChatParticipant,
  RepoFileMention,
  RepoFileSearchResult
} from "../../../shared/types";
import { defaultImageFilename, formatBytes } from "./chat-format";

const CHAT_IMAGE_MAX_ATTACHMENTS = 5;
const CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const CHAT_IMAGE_ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

interface PendingChatImage {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  objectUrl?: string;
  dataBase64?: string;
  status: "loading" | "ready" | "error";
  error?: string;
}

export interface ChatComposerProps {
  participants: ChatParticipant[];
  conversationId?: string;
  repoPath?: string;
  draft: string;
  placeholder: string;
  isRunning: boolean;
  status?: React.ReactNode;
  className?: string;
  rows?: number;
  maxHeight?: number;
  testId?: string;
  renderParticipantAvatar: (participant: ChatParticipant) => React.ReactNode;
  participantRoleLabel: (participant: ChatParticipant) => string;
  onDraftChange: (value: string) => void;
  onSend: (repoFileMentions?: RepoFileMention[], imageAttachments?: ChatImageInput[]) => boolean | void | Promise<boolean | void>;
}

export function ChatComposer(props: ChatComposerProps): JSX.Element {
  const [mentionQuery, setMentionQuery] = useState<string | undefined>();
  const [mentionIndex, setMentionIndex] = useState(0);
  const [fileQuery, setFileQuery] = useState<string | undefined>();
  const [fileIndex, setFileIndex] = useState(0);
  const [fileOptions, setFileOptions] = useState<RepoFileSearchResult[]>([]);
  const [selectedFileMentions, setSelectedFileMentions] = useState<RepoFileMention[]>([]);
  const [pendingImages, setPendingImages] = useState<PendingChatImage[]>([]);
  const pendingImagesRef = useRef<PendingChatImage[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileSearchRequestRef = useRef(0);
  const readyImages = pendingImages.filter((image) => image.status === "ready" && image.dataBase64);
  const hasInvalidImages = pendingImages.some((image) => image.status !== "ready");
  const canSend = !hasInvalidImages && (Boolean(props.draft.trim()) || readyImages.length > 0);
  const mentionOptions = mentionQuery === undefined
    ? []
    : props.participants.filter((participant) => participant.handle.toLowerCase().includes(mentionQuery.toLowerCase()));
  const visibleFileOptions = fileQuery === undefined ? [] : fileOptions;

  useEffect(() => {
    setFileQuery(undefined);
    setFileOptions([]);
    setSelectedFileMentions([]);
    setPendingImages((current) => {
      for (const image of current) {
        if (image.objectUrl) {
          URL.revokeObjectURL(image.objectUrl);
        }
      }
      return [];
    });
  }, [props.conversationId]);

  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  }, [pendingImages]);

  useEffect(() => {
    return () => {
      for (const image of pendingImagesRef.current) {
        if (image.objectUrl) {
          URL.revokeObjectURL(image.objectUrl);
        }
      }
    };
  }, []);

  useEffect(() => {
    setSelectedFileMentions((current) => current.filter((mention) => draftHasFileMention(props.draft, mention.path)));
  }, [props.draft]);

  useEffect(() => {
    if (fileQuery === undefined || !props.conversationId || !props.repoPath) {
      setFileOptions([]);
      return;
    }
    const requestId = fileSearchRequestRef.current + 1;
    fileSearchRequestRef.current = requestId;
    const timeout = window.setTimeout(() => {
      void window.consensus.searchRepoFiles({
        conversationId: props.conversationId ?? "",
        query: fileQuery,
        limit: 50
      }).then((results) => {
        if (fileSearchRequestRef.current === requestId) {
          setFileOptions(results);
          setFileIndex(0);
        }
      }).catch(() => {
        if (fileSearchRequestRef.current === requestId) {
          setFileOptions([]);
        }
      });
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [fileQuery, props.conversationId, props.repoPath]);

  function updateDraft(value: string): void {
    props.onDraftChange(value);
    const nextFileQuery = props.conversationId && props.repoPath ? activeFileQuery(value) : undefined;
    setFileQuery(nextFileQuery);
    setMentionQuery(nextFileQuery === undefined ? activeMentionQuery(value) : undefined);
    setMentionIndex(0);
    setFileIndex(0);
  }

  function insertMention(participant: ChatParticipant): void {
    props.onDraftChange(replaceActiveMention(props.draft, participant.handle));
    setMentionQuery(undefined);
    setMentionIndex(0);
  }

  function insertFileMention(file: RepoFileSearchResult): void {
    props.onDraftChange(replaceActiveFileMention(props.draft, file.path));
    setSelectedFileMentions((current) => {
      if (current.some((mention) => mention.path === file.path)) {
        return current;
      }
      return [...current, { path: file.path }];
    });
    setFileQuery(undefined);
    setFileOptions([]);
    setFileIndex(0);
  }

  function removeFileMention(filePath: string): void {
    props.onDraftChange(removeFileMentionToken(props.draft, filePath));
    setSelectedFileMentions((current) => current.filter((mention) => mention.path !== filePath));
  }

  async function addImageFiles(files: File[]): Promise<void> {
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }
    const availableSlots = CHAT_IMAGE_MAX_ATTACHMENTS - pendingImages.length;
    if (availableSlots <= 0) {
      setPendingImages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          filename: "Too many images",
          mimeType: "",
          sizeBytes: 0,
          status: "error",
          error: `Attach at most ${CHAT_IMAGE_MAX_ATTACHMENTS} images.`
        }
      ]);
      return;
    }
    const acceptedFiles = imageFiles.slice(0, availableSlots);
    const overflow = imageFiles.length - acceptedFiles.length;
    const placeholders = acceptedFiles.map((file): PendingChatImage => {
      const validationError = pendingImageValidationError(file);
      return {
        id: crypto.randomUUID(),
        filename: file.name || defaultImageFilename(file.type),
        mimeType: file.type,
        sizeBytes: file.size,
        objectUrl: validationError ? undefined : URL.createObjectURL(file),
        status: validationError ? "error" : "loading",
        error: validationError
      };
    });
    setPendingImages((current) => [
      ...current,
      ...placeholders,
      ...(overflow > 0
        ? [{
            id: crypto.randomUUID(),
            filename: "Too many images",
            mimeType: "",
            sizeBytes: 0,
            status: "error" as const,
            error: `Attach at most ${CHAT_IMAGE_MAX_ATTACHMENTS} images.`
          }]
        : [])
    ]);
    await Promise.all(placeholders.map(async (placeholder, index) => {
      if (placeholder.status === "error") {
        return;
      }
      try {
        const dataBase64 = await readFileAsBase64(acceptedFiles[index]);
        setPendingImages((current) => current.map((image) => image.id === placeholder.id
          ? { ...image, dataBase64, status: "ready" }
          : image
        ));
      } catch {
        setPendingImages((current) => current.map((image) => image.id === placeholder.id
          ? { ...image, status: "error", error: "Could not read this image." }
          : image
        ));
      }
    }));
  }

  function removePendingImage(imageId: string): void {
    setPendingImages((current) => {
      const removed = current.find((image) => image.id === imageId);
      if (removed?.objectUrl) {
        URL.revokeObjectURL(removed.objectUrl);
      }
      return current.filter((image) => image.id !== imageId);
    });
  }

  async function sendDraft(): Promise<void> {
    if (canSend) {
      const fileMentionsToSend = selectedFileMentions;
      const pendingImagesToSend = pendingImages;
      const imageInputs = readyImages.map((image): ChatImageInput => ({
        filename: image.filename,
        mimeType: image.mimeType,
        dataBase64: image.dataBase64 ?? ""
      }));
      setSelectedFileMentions([]);
      setPendingImages([]);
      const sent = await props.onSend(fileMentionsToSend, imageInputs);
      if (sent === false) {
        setSelectedFileMentions(fileMentionsToSend);
        setPendingImages(pendingImagesToSend);
        return;
      }
      for (const image of pendingImagesToSend) {
        if (image.objectUrl) {
          URL.revokeObjectURL(image.objectUrl);
        }
      }
    }
  }

  return (
    <div className={["chat-composer", props.className].filter(Boolean).join(" ")} data-testid={props.testId}>
      {props.status && <div className="chat-composer-status">{props.status}</div>}
      {selectedFileMentions.length > 0 && (
        <div className="file-mention-chips" aria-label="Referenced repository files">
          {selectedFileMentions.map((mention) => (
            <button type="button" onClick={() => removeFileMention(mention.path)} key={mention.path}>
              <FileText size={14} />
              <span>{mention.path}</span>
              <X size={13} />
            </button>
          ))}
        </div>
      )}
      {pendingImages.length > 0 && (
        <div className="pending-image-strip" aria-label="Pending image attachments">
          {pendingImages.map((image) => (
            <div className={`pending-image-item ${image.status}`} key={image.id}>
              {image.objectUrl ? (
                <img src={image.objectUrl} alt="" />
              ) : (
                <ImagePlus size={18} aria-hidden />
              )}
              <div>
                <strong>{image.filename}</strong>
                <span>{image.error ?? `${formatBytes(image.sizeBytes)}${image.status === "loading" ? " · reading" : ""}`}</span>
              </div>
              <button type="button" aria-label={`Remove ${image.filename}`} onClick={() => removePendingImage(image.id)}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="chat-input-wrap">
        {mentionOptions.length > 0 && (
          <div className="mention-menu" role="listbox">
            {mentionOptions.map((participant, index) => (
              <button
                className={index === mentionIndex ? "selected" : ""}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertMention(participant);
                }}
                role="option"
                aria-selected={index === mentionIndex}
                key={participant.id}
              >
                {props.renderParticipantAvatar(participant)}
                <strong>@{participant.handle}</strong>
                <span>{props.participantRoleLabel(participant)}</span>
                {index === 0 && <kbd>Enter</kbd>}
              </button>
            ))}
          </div>
        )}
        {visibleFileOptions.length > 0 && (
          <div className="mention-menu file-mention-menu" role="listbox">
            {visibleFileOptions.map((file, index) => (
              <button
                className={index === fileIndex ? "selected" : ""}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertFileMention(file);
                }}
                role="option"
                aria-selected={index === fileIndex}
                key={file.path}
              >
                <span className="file-mention-icon"><FileText size={18} /></span>
                <strong>{repoFileBasename(file.path)}</strong>
                <span>{file.path}</span>
                {index === 0 && <kbd>Enter</kbd>}
              </button>
            ))}
          </div>
        )}
        <ResizableTextarea
          value={props.draft}
          onChange={(event) => updateDraft(event.target.value)}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (files.some((file) => file.type.startsWith("image/"))) {
              event.preventDefault();
              void addImageFiles(files);
            }
          }}
          onDrop={(event) => {
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (files.some((file) => file.type.startsWith("image/"))) {
              event.preventDefault();
              void addImageFiles(files);
            }
          }}
          onDragOver={(event) => {
            if (Array.from(event.dataTransfer.types).includes("Files")) {
              event.preventDefault();
            }
          }}
          onKeyDown={(event) => {
            if (visibleFileOptions.length > 0 && event.key === "ArrowDown") {
              event.preventDefault();
              setFileIndex((current) => (current + 1) % visibleFileOptions.length);
              return;
            }
            if (visibleFileOptions.length > 0 && event.key === "ArrowUp") {
              event.preventDefault();
              setFileIndex((current) => (current - 1 + visibleFileOptions.length) % visibleFileOptions.length);
              return;
            }
            if (visibleFileOptions.length > 0 && (event.key === "Enter" || event.key === "Tab")) {
              event.preventDefault();
              insertFileMention(visibleFileOptions[fileIndex] ?? visibleFileOptions[0]);
              return;
            }
            if (mentionOptions.length > 0 && event.key === "ArrowDown") {
              event.preventDefault();
              setMentionIndex((current) => (current + 1) % mentionOptions.length);
              return;
            }
            if (mentionOptions.length > 0 && event.key === "ArrowUp") {
              event.preventDefault();
              setMentionIndex((current) => (current - 1 + mentionOptions.length) % mentionOptions.length);
              return;
            }
            if (mentionOptions.length > 0 && (event.key === "Enter" || event.key === "Tab")) {
              event.preventDefault();
              insertMention(mentionOptions[mentionIndex] ?? mentionOptions[0]);
              return;
            }
            if (event.key === "Escape") {
              setMentionQuery(undefined);
              setFileQuery(undefined);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendDraft();
            }
          }}
          onBlur={() => window.setTimeout(() => {
            setMentionQuery(undefined);
            setFileQuery(undefined);
          }, 120)}
          rows={props.rows ?? 2}
          maxHeight={props.maxHeight ?? 260}
          placeholder={props.placeholder}
        />
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          void addImageFiles(files);
        }}
      />
      <Button size="sm" variant="outline" title="Attach image" aria-label="Attach image" onClick={() => fileInputRef.current?.click()}>
        <ImagePlus size={18} />
      </Button>
      <Button size="sm" title="Send" disabled={!canSend} onClick={() => void sendDraft()}>
        {props.isRunning ? <RefreshCw size={18} className="spin" /> : <SendHorizontal size={18} />}
      </Button>
    </div>
  );
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read image."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Unable to read image."));
        return;
      }
      resolve(reader.result.replace(/^data:[^;]+;base64,/, ""));
    };
    reader.readAsDataURL(file);
  });
}

function pendingImageValidationError(file: File): string | undefined {
  if (!CHAT_IMAGE_ALLOWED_MIME_TYPES.has(file.type)) {
    return "Use PNG, JPEG, or WebP.";
  }
  if (file.size > CHAT_IMAGE_MAX_BYTES) {
    return `Use images up to ${formatBytes(CHAT_IMAGE_MAX_BYTES)}.`;
  }
  return undefined;
}

function activeMentionQuery(value: string): string | undefined {
  const match = value.match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
  return match ? match[1] : undefined;
}

function activeFileQuery(value: string): string | undefined {
  const match = value.match(/(?:^|\s)#([^\s#]*)$/);
  return match ? match[1] : undefined;
}

function replaceActiveMention(value: string, handle: string): string {
  const match = value.match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
  if (!match || match.index === undefined) {
    return `${value}${value.endsWith(" ") || !value ? "" : " "}@${handle} `;
  }
  const prefix = value.slice(0, match.index);
  const leadingSpace = match[0].startsWith(" ") ? " " : "";
  return `${prefix}${leadingSpace}@${handle} `;
}

function replaceActiveFileMention(value: string, filePath: string): string {
  const match = value.match(/(?:^|\s)#([^\s#]*)$/);
  if (!match || match.index === undefined) {
    return `${value}${value.endsWith(" ") || !value ? "" : " "}#${filePath} `;
  }
  const prefix = value.slice(0, match.index);
  const leadingSpace = match[0].startsWith(" ") ? " " : "";
  return `${prefix}${leadingSpace}#${filePath} `;
}

function removeFileMentionToken(value: string, filePath: string): string {
  const escaped = escapeRegExp(filePath);
  return value
    .replace(new RegExp(`(^|\\s)#${escaped}(?=\\s|$)`, "g"), "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

function draftHasFileMention(value: string, filePath: string): boolean {
  return new RegExp(`(^|\\s)#${escapeRegExp(filePath)}(?=\\s|$)`).test(value);
}

function repoFileBasename(filePath: string): string {
  return filePath.split("/").filter(Boolean).pop() ?? filePath;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
