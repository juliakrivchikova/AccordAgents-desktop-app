import React, { useLayoutEffect, useMemo, useRef } from "react";
import { ArrowUp, ImagePlus, Loader2, RefreshCw, X } from "lucide-react";

import { ResizableTextarea } from "@/renderer/components/primitives";
import type {
  ChatImageInput,
  ChatParticipant,
  ChatSavedPromptConfig,
  ChatSkillMention,
  RepoFileMention
} from "../../../shared/types";
import { ChatComposerAttachmentChips } from "./chat-composer-attachment-chips";
import {
  CHAT_COMPOSER_TEXTAREA_STYLE,
  renderSkillHighlightedDraft
} from "./chat-composer-draft-utils";
import { ChatComposerMenus } from "./chat-composer-menus";
import {
  revokePendingImageUrls,
  useChatComposerImages
} from "./use-chat-composer-images";
import { useChatComposerMentions } from "./use-chat-composer-mentions";

export interface ChatComposerProps {
  participants: ChatParticipant[];
  savedPrompts: ChatSavedPromptConfig[];
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchSource = useMemo(
    () => ({
      type: "conversation" as const,
      conversationId: props.conversationId,
      repoPath: props.repoPath
    }),
    [props.conversationId, props.repoPath]
  );
  const mentions = useChatComposerMentions({
    draft: props.draft,
    searchSource,
    onDraftChange: props.onDraftChange,
    participants: props.participants,
    savedPrompts: props.savedPrompts
  });
  const images = useChatComposerImages(props.conversationId);
  const canSend = !images.hasInvalidImages && (
    Boolean(props.draft.trim()) ||
    images.readyImages.length > 0 ||
    mentions.selectedSkillMentions.length > 0
  );

  useLayoutEffect(() => {
    const pendingCaret = mentions.pendingCaretRef.current;
    if (!pendingCaret || pendingCaret.value !== props.draft) {
      return;
    }
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const position = Math.min(pendingCaret.position, textarea.value.length);
    textarea.focus();
    textarea.setSelectionRange(position, position);
    mentions.pendingCaretRef.current = undefined;
  }, [mentions.pendingCaretRef, props.draft]);

  function syncHighlightScroll(event: React.UIEvent<HTMLTextAreaElement>): void {
    if (!highlightRef.current) {
      return;
    }
    highlightRef.current.scrollTop = event.currentTarget.scrollTop;
    highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
  }

  async function sendDraft(): Promise<void> {
    if (!canSend) {
      return;
    }
    const fileMentionsToSend = mentions.selectedFileMentions;
    const skillMentionsToSend = mentions.selectedSkillMentions;
    const pendingImagesToSend = images.pendingImages;
    const imageInputs = images.readyImages.map((image): ChatImageInput => ({
      filename: image.filename,
      mimeType: image.mimeType,
      dataBase64: image.dataBase64 ?? ""
    }));
    mentions.setSelectedFileMentions([]);
    mentions.setSelectedSkillMentions([]);
    images.setPendingImages([]);
    const sent = await props.onSend(fileMentionsToSend, imageInputs, skillMentionsToSend);
    if (sent === false) {
      mentions.setSelectedFileMentions(fileMentionsToSend);
      mentions.setSelectedSkillMentions(skillMentionsToSend);
      images.setPendingImages(pendingImagesToSend);
      return;
    }
    revokePendingImageUrls(pendingImagesToSend);
  }

  return (
    <div className={["chat-composer", props.className].filter(Boolean).join(" ")} data-testid={props.testId}>
      {props.status && <div className="chat-composer-status">{props.status}</div>}
      <ChatComposerAttachmentChips
        pendingImages={images.pendingImages}
        removeFileMention={mentions.removeFileMention}
        removePendingImage={images.removePendingImage}
        removeSkillMention={mentions.removeSkillMention}
        selectedFileMentions={mentions.selectedFileMentions}
        selectedSkillMentions={mentions.selectedSkillMentions}
      />
      <div className="chat-composer-shell">
        <div className={["chat-input-wrap", mentions.showSkillHighlights ? "has-skill-highlights" : ""].filter(Boolean).join(" ")}>
        <ChatComposerMenus
          fileIndex={mentions.fileIndex}
          insertCompactCommand={mentions.insertCompactCommand}
          insertFileMention={mentions.insertFileMention}
          insertMention={mentions.insertMention}
          insertSavedPrompt={mentions.insertSavedPrompt}
          insertSkillMention={mentions.insertSkillMention}
          mentionIndex={mentions.mentionIndex}
          mentionOptions={mentions.mentionOptions}
          participantRoleLabel={props.participantRoleLabel}
          renderParticipantAvatar={props.renderParticipantAvatar}
          skillIndex={mentions.skillIndex}
          skillQuery={mentions.skillQuery}
          skillTargetLabel={mentions.skillTargetLabel}
          visibleCommandOptions={mentions.visibleCommandOptions}
          visibleFileOptions={mentions.visibleFileOptions}
          visiblePromptOptions={mentions.visiblePromptOptions}
          visibleSkillOptions={mentions.visibleSkillOptions}
        />
        <ResizableTextarea
          ref={textareaRef}
          value={props.draft}
          className={[
            "border-0 bg-transparent text-sm leading-normal shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent",
            mentions.showSkillHighlights ? "skill-highlight-textarea" : ""
          ].filter(Boolean).join(" ")}
          spellCheck={!mentions.showSkillHighlights}
          onChange={(event) => mentions.updateDraft(event.target.value)}
          onScroll={syncHighlightScroll}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (files.some((file) => file.type.startsWith("image/"))) {
              event.preventDefault();
              void images.addImageFiles(files);
            }
          }}
          onDrop={(event) => {
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (files.some((file) => file.type.startsWith("image/"))) {
              event.preventDefault();
              void images.addImageFiles(files);
            }
          }}
          onDragOver={(event) => {
            if (Array.from(event.dataTransfer.types).includes("Files")) {
              event.preventDefault();
            }
          }}
          style={CHAT_COMPOSER_TEXTAREA_STYLE}
          onKeyDown={(event) => {
            if (mentions.visibleFileOptions.length > 0 && event.key === "ArrowDown") {
              event.preventDefault();
              mentions.setFileIndex((current) => (current + 1) % mentions.visibleFileOptions.length);
              return;
            }
            if (mentions.visibleFileOptions.length > 0 && event.key === "ArrowUp") {
              event.preventDefault();
              mentions.setFileIndex((current) => (current - 1 + mentions.visibleFileOptions.length) % mentions.visibleFileOptions.length);
              return;
            }
            if (mentions.visibleFileOptions.length > 0 && (event.key === "Enter" || event.key === "Tab")) {
              event.preventDefault();
              mentions.insertFileMention(mentions.visibleFileOptions[mentions.fileIndex] ?? mentions.visibleFileOptions[0]);
              return;
            }
            if (mentions.visibleSlashOptionCount > 0 && event.key === "ArrowDown") {
              event.preventDefault();
              mentions.setSkillIndex((current) => (current + 1) % mentions.visibleSlashOptionCount);
              return;
            }
            if (mentions.visibleSlashOptionCount > 0 && event.key === "ArrowUp") {
              event.preventDefault();
              mentions.setSkillIndex((current) => (current - 1 + mentions.visibleSlashOptionCount) % mentions.visibleSlashOptionCount);
              return;
            }
            if (mentions.visibleSlashOptionCount > 0 && (event.key === "Enter" || event.key === "Tab")) {
              event.preventDefault();
              mentions.insertSlashOptionAtIndex(mentions.skillIndex);
              return;
            }
            if (mentions.mentionOptions.length > 0 && event.key === "ArrowDown") {
              event.preventDefault();
              mentions.setMentionIndex((current) => (current + 1) % mentions.mentionOptions.length);
              return;
            }
            if (mentions.mentionOptions.length > 0 && event.key === "ArrowUp") {
              event.preventDefault();
              mentions.setMentionIndex((current) => (current - 1 + mentions.mentionOptions.length) % mentions.mentionOptions.length);
              return;
            }
            if (mentions.mentionOptions.length > 0 && (event.key === "Enter" || event.key === "Tab")) {
              event.preventDefault();
              mentions.insertMention(mentions.mentionOptions[mentions.mentionIndex] ?? mentions.mentionOptions[0]);
              return;
            }
            if (event.key === "Escape") {
              mentions.setMentionQuery(undefined);
              mentions.setFileQuery(undefined);
              mentions.setSkillQuery(undefined);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendDraft();
            }
          }}
          onBlur={() => window.setTimeout(() => {
            mentions.setMentionQuery(undefined);
            mentions.setFileQuery(undefined);
            mentions.setSkillQuery(undefined);
          }, 120)}
          rows={props.rows ?? 1}
          maxHeight={props.maxHeight ?? 160}
          placeholder={props.placeholder}
        />
        {mentions.showSkillHighlights && (
          <div ref={highlightRef} className="chat-draft-highlight" aria-hidden="true">
            {renderSkillHighlightedDraft(props.draft, mentions.selectedSkillMentions)}
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
                void images.addImageFiles(files);
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
