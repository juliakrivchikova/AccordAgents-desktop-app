import { useEffect, useMemo, useState } from "react";
import { Plus, Search, Users, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { AppSettings, ChatBehaviorRuleConfig, ChatBehaviorRuleConfigUpdate, ChatParticipantConfig } from "../../../shared/types";
import { CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS, CHAT_BEHAVIOR_RULE_LABEL_MAX_CHARS } from "../../../shared/chatBehaviorRules";
import { ResizableTextarea } from "../primitives";
import { Avatar } from "../avatar/avatar";
import { avatarForChatParticipant } from "../chat/chat-avatars";

export function BehaviorRuleSettingsSection(props: {
  settings: AppSettings;
  onSave: (update: ChatBehaviorRuleConfigUpdate) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}): JSX.Element {
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<BehaviorRuleEditorState | undefined>();
  const normalizedSearch = search.trim().toLowerCase();
  const visibleRules = useMemo(() => {
    return props.settings.chatBehaviorRules
      .filter((rule) => {
        if (!normalizedSearch) {
          return true;
        }
        return `${rule.label} ${rule.instructions}`.toLowerCase().includes(normalizedSearch);
      })
      .sort((left, right) => {
        const leftCount = behaviorRuleParticipants(props.settings, left.id).length;
        const rightCount = behaviorRuleParticipants(props.settings, right.id).length;
        return rightCount === leftCount ? left.label.localeCompare(right.label) : rightCount - leftCount;
      });
  }, [normalizedSearch, props.settings]);
  const ruleCount = props.settings.chatBehaviorRules.length;
  const countLabel = `${ruleCount} rule${ruleCount === 1 ? "" : "s"}`;
  return (
    <section className="rules-settings-screen">
      <div className="rules-settings-toolbar">
        <label className="rules-search" aria-label="Search rules">
          <Search size={16} aria-hidden />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search rules"
          />
        </label>
        <span className="rules-count">{countLabel}</span>
        <span className="rules-toolbar-spacer" />
        <Button className="rules-new-button" size="lg" onClick={() => setEditor({ type: "new" })}>
          <Plus size={16} aria-hidden />
          New rule
        </Button>
      </div>

      {visibleRules.length === 0 ? (
        <div className="rules-empty-state">
          {ruleCount === 0 ? "No behavior rules yet." : "No rules match your search."}
        </div>
      ) : (
        <div className="rules-card-grid">
          {visibleRules.map((rule) => (
            <BehaviorRuleCard
              rule={rule}
              participants={behaviorRuleParticipants(props.settings, rule.id)}
              onOpen={() => setEditor({ type: "edit", rule })}
              key={rule.id}
            />
          ))}
        </div>
      )}

      <BehaviorRuleEditorDialog
        editor={editor}
        onSave={props.onSave}
        onDelete={props.onDelete}
        onClose={() => setEditor(undefined)}
      />
    </section>
  );
}

type BehaviorRuleEditorState =
  | { type: "new" }
  | { type: "edit"; rule: ChatBehaviorRuleConfig };

function BehaviorRuleCard(props: {
  rule: ChatBehaviorRuleConfig;
  participants: ChatParticipantConfig[];
  onOpen: () => void;
}): JSX.Element {
  const participantCount = props.participants.length;
  return (
    <button type="button" className="behavior-rule-card" onClick={props.onOpen}>
      <span className="behavior-rule-card-head">
        <strong>{props.rule.label}</strong>
        {participantCount > 0 && <span>{participantCount}</span>}
      </span>
      <span className="behavior-rule-card-desc">{ruleCardDescription(props.rule)}</span>
      {participantCount > 0 ? (
        <BehaviorRuleAvatarStack participants={props.participants} />
      ) : (
        <span className="behavior-rule-no-participants">
          <Users size={15} aria-hidden />
          No members yet
        </span>
      )}
    </button>
  );
}

function BehaviorRuleAvatarStack(props: { participants: ChatParticipantConfig[] }): JSX.Element {
  const shown = props.participants.slice(0, 3);
  const remaining = props.participants.length - shown.length;
  return (
    <span className="behavior-rule-avatar-row" aria-label={`${props.participants.length} ${props.participants.length === 1 ? "member uses" : "members use"} this rule`}>
      <span className="behavior-rule-avatar-stack" aria-hidden>
        {shown.map((participant) => (
          <span className="behavior-rule-avatar-stack-item" key={participant.id}>
            <Avatar
              className="rules-mini-avatar"
              spec={avatarForChatParticipant(participant, `@${participant.handle}`)}
              tooltip={null}
            />
          </span>
        ))}
      </span>
      {remaining > 0 && <span className="behavior-rule-avatar-more">+{remaining}</span>}
    </span>
  );
}

function BehaviorRuleEditorDialog(props: {
  editor?: BehaviorRuleEditorState;
  onSave: (update: ChatBehaviorRuleConfigUpdate) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const rule = props.editor?.type === "edit" ? props.editor.rule : undefined;
  const open = Boolean(props.editor);
  const [label, setLabel] = useState(rule?.label ?? "");
  const [instructions, setInstructions] = useState(rule?.instructions ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setLabel(rule?.label ?? "");
      setInstructions(rule?.instructions ?? "");
      setSaving(false);
    }
  }, [open, rule]);

  const trimmedLabel = label.trim();
  const trimmedInstructions = instructions.trim();
  const validation = trimmedLabel.length > CHAT_BEHAVIOR_RULE_LABEL_MAX_CHARS
    ? `Rule name must be ${CHAT_BEHAVIOR_RULE_LABEL_MAX_CHARS} characters or less.`
    : trimmedInstructions.length > CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS
      ? `Rule instructions must be ${CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS} characters or less.`
      : undefined;
  const changed = trimmedLabel !== (rule?.label ?? "") || trimmedInstructions !== (rule?.instructions ?? "");
  const canSave = Boolean(trimmedLabel && trimmedInstructions) && !validation && (!rule || changed) && !saving;
  const title = rule ? label.trim() || rule.label : trimmedLabel || "New rule";

  async function save(): Promise<void> {
    if (!canSave) {
      return;
    }
    setSaving(true);
    try {
      await props.onSave({ id: rule?.id, label: trimmedLabel, instructions: trimmedInstructions });
      props.onClose();
    } finally {
      setSaving(false);
    }
  }

  async function deleteRule(): Promise<void> {
    if (!rule) {
      return;
    }
    await props.onDelete(rule.id);
    props.onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) {
        props.onClose();
      }
    }}>
      <DialogContent className="rules-editor-dialog" showCloseButton={false}>
        <DialogHeader className="rules-editor-head">
          <div className="rules-editor-title-row">
            <span className="rules-editor-title-block">
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{rule ? `v${rule.version} behavior rule` : "Reusable behavior rule"}</DialogDescription>
            </span>
            <DialogClose asChild>
              <button type="button" className="rules-editor-close" aria-label="Close rule editor">
                <X size={16} aria-hidden />
              </button>
            </DialogClose>
          </div>
        </DialogHeader>
        <div className="rules-editor-body">
          <label className="rules-editor-label" htmlFor="behavior-rule-name">Name</label>
          <Input
            id="behavior-rule-name"
            className="rules-editor-input"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={CHAT_BEHAVIOR_RULE_LABEL_MAX_CHARS}
            placeholder="e.g. Always respond in English"
          />

          <label className="rules-editor-label rules-editor-label-spaced" htmlFor="behavior-rule-instructions">
            Instructions
          </label>
          <ResizableTextarea
            id="behavior-rule-instructions"
            className="rules-editor-textarea"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            maxLength={CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS}
            rows={9}
            maxHeight={360}
            placeholder="Describe the rule and how members should follow it..."
          />
          <div className="rules-editor-meta">
            {trimmedInstructions.length}/{CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS} characters
          </div>
          {validation && <div className="inline-error rules-editor-error">{validation}</div>}
        </div>
        <DialogFooter className="rules-editor-footer">
          {rule && (
            <ConfirmDeleteButton
              label="Delete"
              title={`Delete ${rule.label}?`}
              description="This rule will be removed from saved members that use it."
              confirmLabel="Delete rule"
              onConfirm={deleteRule}
            />
          )}
          <DialogClose asChild>
            <Button type="button" variant="outline" size="sm" disabled={saving}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" size="sm" disabled={!canSave} onClick={() => void save()}>
            {saving ? "Saving..." : rule ? "Save" : "Create rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function behaviorRuleParticipants(settings: AppSettings, ruleId: string): ChatParticipantConfig[] {
  return settings.chatParticipantConfigs.filter((participant) => participant.behaviorRuleIds?.includes(ruleId));
}

function ruleCardDescription(rule: ChatBehaviorRuleConfig): string {
  return (
    rule.instructions
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#") && !line.startsWith(">") && !line.startsWith("-"))
      ?.replace(/\*\*|`/g, "") || "Reusable member behavior."
  );
}

function ConfirmDeleteButton(props: {
  label: string;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const confirm = async (): Promise<void> => {
    setPending(true);
    try {
      await props.onConfirm();
      setOpen(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="destructive" size="sm">
          <X size={16} />
          {props.label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" size="sm" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="destructive" size="sm" disabled={pending} onClick={() => void confirm()}>
            <X size={16} />
            {pending ? "Deleting..." : props.confirmLabel ?? props.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
