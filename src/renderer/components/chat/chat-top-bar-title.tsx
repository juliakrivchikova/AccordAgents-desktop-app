import React, { useEffect, useRef, useState } from "react";
import { Check, Pencil, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { IconButton } from "../primitives";
import type { Conversation } from "../../../shared/types";

export function normalizeChatTitle(value: string): string {
  return value.trim().slice(0, 80) || "Chat";
}

export function ChatTopBarTitle(props: {
  conversation: Pick<Conversation, "id" | "title">;
  isRunning: boolean;
  onRenameTitle: (title: string) => Promise<boolean>;
}): JSX.Element {
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(props.conversation.title);
  const [titleSaving, setTitleSaving] = useState(false);
  const titleEditorRef = useRef<HTMLDivElement>(null);
  const normalizedTitleDraft = normalizeChatTitle(titleDraft);
  const titleSaveDisabled = props.isRunning || titleSaving || !titleDraft.trim() || normalizedTitleDraft === props.conversation.title;

  function startTitleRename(): void {
    setTitleDraft(props.conversation.title);
    setRenamingTitle(true);
  }

  function cancelTitleRename(): void {
    setTitleDraft(props.conversation.title);
    setRenamingTitle(false);
  }

  async function saveTitleRename(): Promise<void> {
    if (titleSaveDisabled) {
      return;
    }
    setTitleSaving(true);
    try {
      const saved = await props.onRenameTitle(titleDraft);
      if (saved) {
        setRenamingTitle(false);
      }
    } finally {
      setTitleSaving(false);
    }
  }

  function handleTitleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveTitleRename();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelTitleRename();
    }
  }

  useEffect(() => {
    setRenamingTitle(false);
    setTitleSaving(false);
    setTitleDraft(props.conversation.title);
  }, [props.conversation.id]);

  useEffect(() => {
    if (!renamingTitle) {
      setTitleDraft(props.conversation.title);
    }
  }, [props.conversation.title, renamingTitle]);

  useEffect(() => {
    if (!renamingTitle) {
      return;
    }
    window.requestAnimationFrame(() => {
      const input = titleEditorRef.current?.querySelector("input");
      input?.focus();
      input?.select();
    });
  }, [renamingTitle]);

  return (
    <div className="topbar-chat-title">
      {renamingTitle ? (
        <div className="topbar-chat-title-editor" ref={titleEditorRef}>
          <Input
            value={titleDraft}
            maxLength={80}
            aria-label="Chat name"
            disabled={titleSaving}
            data-testid="chat-title-input"
            onChange={(event) => setTitleDraft(event.target.value)}
            onKeyDown={handleTitleKeyDown}
          />
          <IconButton
            size="xs"
            icon={Check}
            label="Save chat name"
            tooltip="Save chat name"
            disabled={titleSaveDisabled}
            data-testid="chat-title-save"
            onClick={() => void saveTitleRename()}
          />
          <IconButton
            size="xs"
            icon={X}
            label="Cancel chat name edit"
            tooltip="Cancel chat name edit"
            disabled={titleSaving}
            data-testid="chat-title-cancel"
            onClick={cancelTitleRename}
          />
        </div>
      ) : (
        <div className="topbar-chat-title-row">
          <span className="topbar-chat-title-text">{props.conversation.title}</span>
          <IconButton
            className="border-0 bg-transparent text-[var(--app-muted)] shadow-none hover:border-0 hover:bg-[var(--app-surface-hover)] hover:text-[var(--app-text-strong)]"
            size="xs"
            icon={Pencil}
            label="Edit chat name"
            tooltip={props.isRunning ? "Chat name cannot be edited while participants are running" : "Edit chat name"}
            disabled={props.isRunning}
            data-testid="chat-title-edit"
            onClick={startTitleRename}
          />
        </div>
      )}
    </div>
  );
}
