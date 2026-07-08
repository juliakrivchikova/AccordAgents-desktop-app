import React, { useLayoutEffect, useMemo, useRef } from "react";
import { ArrowUp, ImagePlus, RefreshCw } from "lucide-react";

import { ResizableTextarea } from "@/renderer/components/primitives";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
  draftStartsWithPluginMention,
  renderSlashHighlightedDraft
} from "./chat-composer-draft-utils";
import { ChatActiveRunPopover, type ChatActiveRunParticipantRow } from "./chat-active-run-popover";
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
  activeRunParticipantRows?: ChatActiveRunParticipantRow[];
  onStopAllRuns?: () => void;
  onStopParticipantRuns?: (runIds: string[]) => void;
  status?: React.ReactNode;
  className?: string;
  rows?: number;
  maxHeight?: number;
  testId?: string;
  renderParticipantAvatar: (participant: ChatParticipant) => React.ReactNode;
  participantRoleLabel: (participant: ChatParticipant) => string;
  onDraftChange: (value: string) => void;
  onSend: (repoFileMentions?: RepoFileMention[], imageAttachments?: ChatImageInput[], skillMentions?: ChatSkillMention[]) => boolean | void | Promise<boolean | void>;
  accordDisabledReason?: string;
  onOpenAccord?: () => void;
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
  const hasLeadingPluginToken = draftStartsWithPluginMention(props.draft, mentions.selectedPluginMentions);
  const accordTooltip = props.accordDisabledReason ?? "Start an Accord: reach agreement among chat members";
  const activeRunCount = props.activeRunCount ?? 0;
  const activeRunParticipantRows = props.activeRunParticipantRows ?? [];

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
          insertPluginMention={mentions.insertPluginMention}
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
          visiblePluginOptions={mentions.visiblePluginOptions}
        />
        <ResizableTextarea
          ref={textareaRef}
          value={props.draft}
          className={[
            "border-0 bg-transparent text-sm leading-normal shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent",
            mentions.showSkillHighlights ? "skill-highlight-textarea" : "",
            hasLeadingPluginToken ? "has-leading-plugin-token" : ""
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
            {renderSlashHighlightedDraft(props.draft, mentions.selectedSkillMentions, mentions.selectedPluginMentions)}
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
            {activeRunCount > 0 && props.onStopAllRuns && (
              <ChatActiveRunPopover
                activeRunCount={activeRunCount}
                activeRunParticipantRows={activeRunParticipantRows}
                renderParticipantAvatar={props.renderParticipantAvatar}
                participantRoleLabel={props.participantRoleLabel}
                onStopAllRuns={props.onStopAllRuns}
                onStopParticipantRuns={props.onStopParticipantRuns}
              />
            )}
          </div>
          <div className="chat-composer-actions">
            {props.onOpenAccord && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="composer-accord-tooltip-trigger">
                    <button
                      type="button"
                      className="composer-accord-button"
                      aria-label="Start Accord"
                      disabled={Boolean(props.accordDisabledReason)}
                      data-testid="chat-accord-button"
                      onClick={props.onOpenAccord}
                    >
                      {/* Custom merge glyph so each branch can keep its own color. */}
                      <svg
                        className="composer-accord-icon"
                        width={18}
                        height={18}
                        viewBox="0 0 24 24"
                        fill="none"
                        strokeWidth={2.4}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d="m8 6 4-4 4 4" stroke="var(--app-accord-icon-top)" />
                        <path d="M12 2v10.3" stroke="var(--app-accord-icon-top)" />
                        <path d="M12 12.3a4 4 0 0 1-1.172 2.872L4 22" stroke="var(--app-accord-icon-left)" />
                        <path d="m20 22-5-5" stroke="var(--app-accord-icon-right)" />
                      </svg>
                    </button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">{accordTooltip}</TooltipContent>
              </Tooltip>
            )}
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
