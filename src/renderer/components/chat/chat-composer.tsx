import React, { useEffect, useRef, useState } from "react";
import { ArrowUp, FileText, ImagePlus, ListChecks, Loader2, RefreshCw, X } from "lucide-react";

import { ResizableTextarea } from "@/renderer/components/primitives";
import type {
  ChatImageInput,
  ChatParticipant,
  ChatSkillMention,
  RepoFileMention,
  RepoFileSearchResult,
  UserSkillSummary,
  UserSkillTargetSummary
} from "../../../shared/types";
import { providerLabel } from "./chat-conversation-data";
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
  activeRunCount?: number;
  onStopAllRuns?: () => void;
  status?: React.ReactNode;
  className?: string;
  rows?: number;
  maxHeight?: number;
  testId?: string;
  renderParticipantAvatar: (participant: ChatParticipant) => React.ReactNode;
  participantRoleLabel: (participant: ChatParticipant) => string;
  onDraftChange: (value: string) => void;
  onSend: (repoFileMentions?: RepoFileMention[], imageAttachments?: ChatImageInput[], skillMentions?: ChatSkillMention[]) => boolean | void | Promise<boolean | void>;
}

export function ChatComposer(props: ChatComposerProps): JSX.Element {
  const [mentionQuery, setMentionQuery] = useState<string | undefined>();
  const [mentionIndex, setMentionIndex] = useState(0);
  const [fileQuery, setFileQuery] = useState<string | undefined>();
  const [fileIndex, setFileIndex] = useState(0);
  const [fileOptions, setFileOptions] = useState<RepoFileSearchResult[]>([]);
  const [skillQuery, setSkillQuery] = useState<string | undefined>();
  const [skillIndex, setSkillIndex] = useState(0);
  const [skillOptions, setSkillOptions] = useState<UserSkillSummary[]>([]);
  const [skillTarget, setSkillTarget] = useState<UserSkillTargetSummary | undefined>();
  const [selectedSkillMentions, setSelectedSkillMentions] = useState<ChatSkillMention[]>([]);
  const [selectedFileMentions, setSelectedFileMentions] = useState<RepoFileMention[]>([]);
  const [pendingImages, setPendingImages] = useState<PendingChatImage[]>([]);
  const pendingImagesRef = useRef<PendingChatImage[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileSearchRequestRef = useRef(0);
  const skillSearchRequestRef = useRef(0);
  const readyImages = pendingImages.filter((image) => image.status === "ready" && image.dataBase64);
  const hasInvalidImages = pendingImages.some((image) => image.status !== "ready");
  const canSend = !hasInvalidImages && (Boolean(props.draft.trim()) || readyImages.length > 0 || selectedSkillMentions.length > 0);
  const mentionOptions = mentionQuery === undefined
    ? []
    : props.participants.filter((participant) => participant.handle.toLowerCase().includes(mentionQuery.toLowerCase()));
  const visibleFileOptions = fileQuery === undefined ? [] : fileOptions;
  const visibleSkillOptions = skillQuery === undefined ? [] : skillOptions;
  const skillTargetLabel = skillTarget ? skillPickerTargetLabel(skillTarget, props.participants) : undefined;
  const showSkillHighlights = selectedSkillMentions.some((mention) => draftHasSkillMention(props.draft, mention.frontmatterName));

  useEffect(() => {
    setFileQuery(undefined);
    setFileOptions([]);
    setSkillQuery(undefined);
    setSkillOptions([]);
    setSkillTarget(undefined);
    setSelectedSkillMentions([]);
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
    setSelectedSkillMentions((current) => current.filter((mention) => draftHasSkillMention(props.draft, mention.frontmatterName)));
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

  useEffect(() => {
    if (skillQuery === undefined || !props.conversationId) {
      setSkillOptions([]);
      return;
    }
    const requestId = skillSearchRequestRef.current + 1;
    skillSearchRequestRef.current = requestId;
    const timeout = window.setTimeout(() => {
      void window.consensus.searchUserSkills({
        conversationId: props.conversationId ?? "",
        query: skillQuery,
        content: props.draft,
        limit: 50
      }).then((result) => {
        if (skillSearchRequestRef.current === requestId) {
          setSkillOptions(result.skills);
          setSkillTarget(result.target);
          setSkillIndex(0);
        }
      }).catch(() => {
        if (skillSearchRequestRef.current === requestId) {
          setSkillOptions([]);
          setSkillTarget(undefined);
        }
      });
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [skillQuery, props.conversationId, props.draft]);

  function updateDraft(value: string): void {
    props.onDraftChange(value);
    const nextFileQuery = props.conversationId && props.repoPath ? activeFileQuery(value) : undefined;
    const nextMentionQuery = nextFileQuery === undefined ? activeMentionQuery(value) : undefined;
    const nextSkillQuery = nextFileQuery === undefined && nextMentionQuery === undefined ? activeSkillQuery(value) : undefined;
    setFileQuery(nextFileQuery);
    setMentionQuery(nextMentionQuery);
    setSkillQuery(nextSkillQuery);
    setMentionIndex(0);
    setFileIndex(0);
    setSkillIndex(0);
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

  function insertSkillMention(skill: UserSkillSummary): void {
    if (skill.capabilityState !== "invocable" || skill.ambiguous) {
      return;
    }
    props.onDraftChange(replaceActiveSkillMention(props.draft, skill.frontmatterName));
    setSelectedSkillMentions((current) => {
      if (current.some((mention) => mention.skillId === skill.skillId)) {
        return current;
      }
      const { providerKinds: _providerKinds, scopeKinds: _scopeKinds, statusMessage: _statusMessage, ambiguous: _ambiguous, ...mention } = skill;
      return [...current, mention];
    });
    setSkillQuery(undefined);
    setSkillOptions([]);
    setSkillTarget(undefined);
    setSkillIndex(0);
  }

  function removeFileMention(filePath: string): void {
    props.onDraftChange(removeFileMentionToken(props.draft, filePath));
    setSelectedFileMentions((current) => current.filter((mention) => mention.path !== filePath));
  }

  function removeSkillMention(mention: ChatSkillMention): void {
    props.onDraftChange(removeSkillMentionToken(props.draft, mention.frontmatterName));
    setSelectedSkillMentions((current) => current.filter((item) => item.skillId !== mention.skillId));
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

  function syncHighlightScroll(event: React.UIEvent<HTMLTextAreaElement>): void {
    if (!highlightRef.current) {
      return;
    }
    highlightRef.current.scrollTop = event.currentTarget.scrollTop;
    highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
  }

  async function sendDraft(): Promise<void> {
    if (canSend) {
      const fileMentionsToSend = selectedFileMentions;
      const skillMentionsToSend = selectedSkillMentions;
      const pendingImagesToSend = pendingImages;
      const imageInputs = readyImages.map((image): ChatImageInput => ({
        filename: image.filename,
        mimeType: image.mimeType,
        dataBase64: image.dataBase64 ?? ""
      }));
      setSelectedFileMentions([]);
      setSelectedSkillMentions([]);
      setPendingImages([]);
      const sent = await props.onSend(fileMentionsToSend, imageInputs, skillMentionsToSend);
      if (sent === false) {
        setSelectedFileMentions(fileMentionsToSend);
        setSelectedSkillMentions(skillMentionsToSend);
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
      {selectedSkillMentions.length > 0 && (
        <div className="file-mention-chips skill-mention-chips" aria-label="Selected skills">
          {selectedSkillMentions.map((mention) => (
            <button type="button" onClick={() => removeSkillMention(mention)} key={mention.skillId}>
              <ListChecks size={14} />
              <span>{mention.displayName}</span>
              <small>{mention.variants.map((variant) => providerLabel(variant.providerKind)).join(", ")}</small>
              <X size={13} />
            </button>
          ))}
        </div>
      )}
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
      <div className="chat-composer-shell">
        <div className={["chat-input-wrap", showSkillHighlights ? "has-skill-highlights" : ""].filter(Boolean).join(" ")}>
        {mentionOptions.length > 0 && (
          <div className="mention-menu" role="listbox">
            <div className="chat-popover-section-title">Participants</div>
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
            <div className="chat-popover-section-title">Repository files</div>
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
        {skillQuery !== undefined && (visibleSkillOptions.length > 0 || skillTargetLabel) && (
          <div className="mention-menu skill-mention-menu" role="listbox">
            <div className="chat-popover-section-title">Skills</div>
            {skillTargetLabel && <div className="skill-mention-menu-context">{skillTargetLabel}</div>}
            {visibleSkillOptions.map((skill, index) => {
              const disabled = skill.capabilityState !== "invocable" || skill.ambiguous;
              return (
                <button
                  className={index === skillIndex ? "selected" : ""}
                  disabled={disabled}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    insertSkillMention(skill);
                  }}
                  role="option"
                  aria-selected={index === skillIndex}
                  key={skill.skillId}
                >
                  <span className="file-mention-icon"><ListChecks size={18} /></span>
                  <strong>{skill.displayName}</strong>
                  <span>{skill.description ?? skill.statusMessage ?? "User skill"}</span>
                  <small>{skill.providerKinds.map(providerLabel).join(", ")}</small>
                  {!disabled && index === 0 && <kbd>Enter</kbd>}
                </button>
              );
            })}
          </div>
        )}
        <ResizableTextarea
          ref={textareaRef}
          value={props.draft}
          className={[
            "border-0 bg-transparent text-sm leading-normal shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent",
            showSkillHighlights ? "skill-highlight-textarea" : ""
          ].filter(Boolean).join(" ")}
          spellCheck={!showSkillHighlights}
          onChange={(event) => updateDraft(event.target.value)}
          onScroll={syncHighlightScroll}
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
            if (visibleSkillOptions.length > 0 && event.key === "ArrowDown") {
              event.preventDefault();
              setSkillIndex((current) => (current + 1) % visibleSkillOptions.length);
              return;
            }
            if (visibleSkillOptions.length > 0 && event.key === "ArrowUp") {
              event.preventDefault();
              setSkillIndex((current) => (current - 1 + visibleSkillOptions.length) % visibleSkillOptions.length);
              return;
            }
            if (visibleSkillOptions.length > 0 && (event.key === "Enter" || event.key === "Tab")) {
              event.preventDefault();
              insertSkillMention(visibleSkillOptions[skillIndex] ?? visibleSkillOptions[0]);
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
              setSkillQuery(undefined);
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
            setSkillQuery(undefined);
          }, 120)}
          rows={props.rows ?? 2}
          maxHeight={props.maxHeight ?? 260}
          placeholder={props.placeholder}
        />
        {showSkillHighlights && (
          <div ref={highlightRef} className="chat-draft-highlight" aria-hidden="true">
            {renderSkillHighlightedDraft(props.draft, selectedSkillMentions)}
          </div>
        )}
        </div>
        <div className="chat-composer-toolbar">
          <div className="chat-composer-tools">
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
            <button
              type="button"
              className="composer-icon-button"
              title="Attach image"
              aria-label="Attach image"
              onClick={() => fileInputRef.current?.click()}
            >
              <ImagePlus size={18} />
            </button>
            {(props.activeRunCount ?? 0) > 0 && props.onStopAllRuns && (
              <button
                type="button"
                className="composer-active-run"
                title="Stop all running participants"
                aria-label={`Stop ${props.activeRunCount} active ${props.activeRunCount === 1 ? "run" : "runs"}`}
                onClick={props.onStopAllRuns}
              >
                <Loader2 size={13} className="spin" aria-hidden />
                <span>{props.activeRunCount} active {props.activeRunCount === 1 ? "run" : "runs"}</span>
                <X size={13} aria-hidden />
              </button>
            )}
          </div>
          <div className="chat-composer-actions">
            <button
              type="button"
              className="composer-send-button"
              title="Send"
              aria-label="Send message"
              disabled={!canSend}
              onClick={() => void sendDraft()}
            >
              {props.isRunning ? <RefreshCw size={17} className="spin" /> : <ArrowUp size={18} strokeWidth={2.4} />}
            </button>
          </div>
        </div>
      </div>
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

function activeSkillQuery(value: string): string | undefined {
  const match = value.match(/(?:^|\s)\/([A-Za-z0-9_-]*)$/);
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

function replaceActiveSkillMention(value: string, skillName: string): string {
  const match = value.match(/(?:^|\s)\/([A-Za-z0-9_-]*)$/);
  if (!match || match.index === undefined) {
    return `${value}${value.endsWith(" ") || !value ? "" : " "}/${skillName} `;
  }
  const prefix = value.slice(0, match.index);
  const leadingSpace = match[0].startsWith(" ") ? " " : "";
  return `${prefix}${leadingSpace}/${skillName} `;
}

function removeSkillMentionToken(value: string, skillName: string): string {
  const escaped = escapeRegExp(skillName);
  return value
    .replace(new RegExp(`(^|\\s)/${escaped}(?=\\s|$)`, "g"), "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

function draftHasSkillMention(value: string, skillName: string): boolean {
  return new RegExp(`(^|\\s)/${escapeRegExp(skillName)}(?=\\s|$)`).test(value);
}

function renderSkillHighlightedDraft(value: string, mentions: ChatSkillMention[]): React.ReactNode[] {
  const byName = new Map<string, ChatSkillMention>();
  for (const mention of mentions) {
    byName.set(mention.frontmatterName, mention);
  }
  const names = Array.from(byName.keys()).sort((left, right) => right.length - left.length);
  if (names.length === 0 || !value) {
    return [value || "\u00a0"];
  }
  const pattern = new RegExp(`(^|\\s)/(${names.map(escapeRegExp).join("|")})(?=\\s|$)`, "g");
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let index = 0;
  for (const match of value.matchAll(pattern)) {
    const leading = match[1] ?? "";
    const name = match[2] ?? "";
    const start = (match.index ?? 0) + leading.length;
    const end = start + name.length + 1;
    if (start > cursor) {
      nodes.push(value.slice(cursor, start));
    }
    nodes.push(
      <span className="chat-draft-skill-token" key={`${name}-${index}`}>
        {value.slice(start, end)}
      </span>
    );
    cursor = end;
    index += 1;
  }
  if (cursor < value.length) {
    nodes.push(value.slice(cursor));
  }
  return nodes.length > 0 ? nodes : [value];
}

function draftHasFileMention(value: string, filePath: string): boolean {
  return new RegExp(`(^|\\s)#${escapeRegExp(filePath)}(?=\\s|$)`).test(value);
}

function repoFileBasename(filePath: string): string {
  return filePath.split("/").filter(Boolean).pop() ?? filePath;
}

function skillPickerTargetLabel(target: UserSkillTargetSummary, participants: ChatParticipant[]): string {
  if (!target.hasClearTargets || target.providerKinds.length === 0) {
    return "Mention a participant to select a skill";
  }
  const handles = target.participantIds
    .map((id) => participants.find((participant) => participant.id === id)?.handle)
    .filter((handle): handle is string => Boolean(handle))
    .map((handle) => `@${handle}`);
  const providerText = target.providerKinds.map(providerLabel).join(", ");
  return `For ${handles.length > 0 ? handles.join(", ") : "selected target"} · ${providerText}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
