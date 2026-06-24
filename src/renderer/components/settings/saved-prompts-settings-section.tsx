import { useEffect, useMemo, useState } from "react";
import { FileText, Plus, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  CHAT_SAVED_PROMPT_BODY_MAX_CHARS,
  CHAT_SAVED_PROMPT_LABEL_MAX_CHARS,
  CHAT_SAVED_PROMPT_TRIGGER_MAX_CHARS,
  isValidChatSavedPromptTrigger,
  limitChatSavedPromptBody,
  normalizeChatSavedPromptTrigger
} from "../../../shared/chatSavedPrompts";
import type { AppSettings, ChatSavedPromptConfig, ChatSavedPromptConfigUpdate } from "../../../shared/types";
import { ResizableTextarea } from "../primitives";
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog";

export function SavedPromptsSettingsSection(props: {
  settings: AppSettings;
  onSave: (update: ChatSavedPromptConfigUpdate) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}): JSX.Element {
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<SavedPromptEditorState | undefined>();
  const normalizedSearch = search.trim().toLowerCase();
  const visiblePrompts = useMemo(() => {
    return props.settings.chatSavedPrompts
      .filter((prompt) => {
        if (!normalizedSearch) {
          return true;
        }
        return `${prompt.label} ${prompt.trigger} ${prompt.body}`.toLowerCase().includes(normalizedSearch);
      })
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [normalizedSearch, props.settings.chatSavedPrompts]);
  const promptCount = props.settings.chatSavedPrompts.length;
  const countLabel = `${promptCount} prompt${promptCount === 1 ? "" : "s"}`;
  return (
    <section className="rules-settings-screen prompts-settings-screen">
      <div className="rules-settings-toolbar">
        <label className="rules-search" aria-label="Search prompts">
          <Search size={16} aria-hidden />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search prompts"
            data-testid="saved-prompts-search"
          />
        </label>
        <span className="rules-count">{countLabel}</span>
        <span className="rules-toolbar-spacer" />
        <Button className="rules-new-button" size="lg" data-testid="saved-prompts-new" onClick={() => setEditor({ type: "new" })}>
          <Plus size={16} aria-hidden />
          New prompt
        </Button>
      </div>

      {visiblePrompts.length === 0 ? (
        <div className="rules-empty-state">
          {promptCount === 0 ? "No saved prompts yet." : "No prompts match your search."}
        </div>
      ) : (
        <div className="rules-card-grid">
          {visiblePrompts.map((prompt) => (
            <SavedPromptCard
              prompt={prompt}
              onOpen={() => setEditor({ type: "edit", prompt })}
              key={prompt.id}
            />
          ))}
        </div>
      )}

      <SavedPromptEditorDialog
        editor={editor}
        existingPrompts={props.settings.chatSavedPrompts}
        onSave={props.onSave}
        onDelete={props.onDelete}
        onClose={() => setEditor(undefined)}
      />
    </section>
  );
}

type SavedPromptEditorState =
  | { type: "new" }
  | { type: "edit"; prompt: ChatSavedPromptConfig };

function SavedPromptCard(props: {
  prompt: ChatSavedPromptConfig;
  onOpen: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="behavior-rule-card saved-prompt-card"
      data-testid="saved-prompt-card"
      data-trigger={props.prompt.trigger}
      onClick={props.onOpen}
    >
      <span className="behavior-rule-card-head">
        <strong>{props.prompt.label}</strong>
        <span>/{props.prompt.trigger}</span>
      </span>
      <span className="behavior-rule-card-desc">{promptCardDescription(props.prompt)}</span>
      <span className="behavior-rule-no-participants">
        <FileText size={15} aria-hidden />
        Inserts editable text
      </span>
    </button>
  );
}

function SavedPromptEditorDialog(props: {
  editor?: SavedPromptEditorState;
  existingPrompts: ChatSavedPromptConfig[];
  onSave: (update: ChatSavedPromptConfigUpdate) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const prompt = props.editor?.type === "edit" ? props.editor.prompt : undefined;
  const open = Boolean(props.editor);
  const [label, setLabel] = useState(prompt?.label ?? "");
  const [trigger, setTrigger] = useState(prompt?.trigger ?? "");
  const [body, setBody] = useState(prompt?.body ?? "");
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (open) {
      setLabel(prompt?.label ?? "");
      setTrigger(prompt?.trigger ?? "");
      setBody(prompt?.body ?? "");
      setSaving(false);
      setDeleteOpen(false);
      setDeleting(false);
    }
  }, [open, prompt]);

  const trimmedLabel = label.trim();
  const trimmedTrigger = normalizeChatSavedPromptTrigger(trigger);
  const trimmedBody = body.trim();
  const duplicateTrigger = props.existingPrompts.find((item) =>
    item.id !== prompt?.id && item.trigger.toLowerCase() === trimmedTrigger.toLowerCase()
  );
  const validation = trimmedLabel.length > CHAT_SAVED_PROMPT_LABEL_MAX_CHARS
    ? `Prompt name must be ${CHAT_SAVED_PROMPT_LABEL_MAX_CHARS} characters or less.`
    : trimmedTrigger.length > CHAT_SAVED_PROMPT_TRIGGER_MAX_CHARS
      ? `Slash trigger must be ${CHAT_SAVED_PROMPT_TRIGGER_MAX_CHARS} characters or less.`
      : trimmedTrigger && !isValidChatSavedPromptTrigger(trimmedTrigger)
        ? "Slash trigger may use letters, numbers, underscores, and hyphens only."
        : duplicateTrigger
          ? `/${trimmedTrigger} already exists.`
          : trimmedBody.length > CHAT_SAVED_PROMPT_BODY_MAX_CHARS
            ? `Prompt body must be ${CHAT_SAVED_PROMPT_BODY_MAX_CHARS} characters or less.`
            : undefined;
  const changed =
    trimmedLabel !== (prompt?.label ?? "") ||
    trimmedTrigger !== (prompt?.trigger ?? "") ||
    trimmedBody !== (prompt?.body ?? "");
  const canSave = Boolean(trimmedLabel && trimmedTrigger && trimmedBody) && !validation && (!prompt || changed) && !saving;
  const title = prompt ? label.trim() || prompt.label : trimmedLabel || "New prompt";

  async function save(): Promise<void> {
    if (!canSave) {
      return;
    }
    setSaving(true);
    try {
      await props.onSave({ id: prompt?.id, label: trimmedLabel, trigger: trimmedTrigger, body: trimmedBody });
      props.onClose();
    } finally {
      setSaving(false);
    }
  }

  async function deletePrompt(): Promise<void> {
    if (!prompt) {
      return;
    }
    setDeleting(true);
    try {
      await props.onDelete(prompt.id);
      props.onClose();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          props.onClose();
        }
      }}>
        <DialogContent className="rules-editor-dialog prompts-editor-dialog" showCloseButton={false}>
          <DialogHeader className="rules-editor-head">
            <div className="rules-editor-title-row">
              <span className="rules-editor-title-block">
                <DialogTitle>{title}</DialogTitle>
                <DialogDescription>{prompt ? `v${prompt.version} saved prompt` : "Reusable composer prompt"}</DialogDescription>
              </span>
              <DialogClose asChild>
                <button type="button" className="rules-editor-close" aria-label="Close prompt editor">
                  <X size={16} aria-hidden />
                </button>
              </DialogClose>
            </div>
          </DialogHeader>
          <div className="rules-editor-body">
            <label className="rules-editor-label" htmlFor="saved-prompt-name">Name</label>
            <Input
              id="saved-prompt-name"
              className="rules-editor-input"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={CHAT_SAVED_PROMPT_LABEL_MAX_CHARS}
              placeholder="e.g. Bug repro"
              data-testid="saved-prompt-name"
            />

            <label className="rules-editor-label rules-editor-label-spaced" htmlFor="saved-prompt-trigger">Slash trigger</label>
            <Input
              id="saved-prompt-trigger"
              className="rules-editor-input"
              value={trigger}
              onChange={(event) => setTrigger(event.target.value)}
              maxLength={CHAT_SAVED_PROMPT_TRIGGER_MAX_CHARS + 1}
              placeholder="e.g. bug-repro"
              data-testid="saved-prompt-trigger"
            />

            <label className="rules-editor-label rules-editor-label-spaced" htmlFor="saved-prompt-body">Prompt body</label>
            <ResizableTextarea
              id="saved-prompt-body"
              className="rules-editor-textarea"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={CHAT_SAVED_PROMPT_BODY_MAX_CHARS}
              rows={11}
              maxHeight={420}
              placeholder="Write the text that should be inserted into the composer..."
              data-testid="saved-prompt-body"
            />
            <div className="rules-editor-meta">
              {trimmedBody.length}/{CHAT_SAVED_PROMPT_BODY_MAX_CHARS} characters
            </div>
            {validation && <div className="inline-error rules-editor-error">{validation}</div>}
          </div>
          <DialogFooter className="rules-editor-footer">
            {prompt && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={saving || deleting}
                data-testid="saved-prompt-delete"
                onClick={() => setDeleteOpen(true)}
              >
                <X size={16} />
                Delete
              </Button>
            )}
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm" disabled={saving || deleting}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" size="sm" disabled={!canSave || deleting} data-testid="saved-prompt-save" onClick={() => void save()}>
              {saving ? "Saving..." : prompt ? "Save" : "Create prompt"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {prompt && (
        <DeleteConfirmationDialog
          open={deleteOpen}
          title={`Delete ${prompt.label}?`}
          description="This saved prompt will be removed from the slash picker."
          confirmLabel="Delete prompt"
          pending={deleting}
          onOpenChange={setDeleteOpen}
          onConfirm={deletePrompt}
        />
      )}
    </>
  );
}

function promptCardDescription(prompt: ChatSavedPromptConfig): string {
  return (
    limitChatSavedPromptBody(
      prompt.body
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith("#") && !line.startsWith(">") && !line.startsWith("-")) || prompt.body,
      180
    ).replace(/\*\*|`/g, "") || "Reusable composer prompt."
  );
}
