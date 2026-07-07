import { useEffect, useMemo, useState } from "react";
import { Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AgentHealth, AppSettings, ChatAgentMode, ChatParticipantConfigUpdate, ChatProviderKind, ChatRosterChangeParticipantInput } from "../../../shared/types";
import { normalizeChatAgentMode } from "../../../shared/agentPermissions";
import { chatReasoningEffortLabel, normalizeChatReasoningEffort, reasoningEffortOptionsForProvider } from "../../../shared/reasoningEffort";
import { participantProviderLabel } from "../chat/chat-conversation-data";
import { displayChatRoleLabel } from "../chat/chat-role-labels";
import { ChatParticipantAvatarField, ChatParticipantInlineModelRow, ChatParticipantInlinePermissionsRow, ChatParticipantInlineRequestParticipantsRow, ChatParticipantInlineSelectRow, ChatParticipantSpecRow } from "../chat/chat-participant-config-panel";
import type { ChatParticipantDraft } from "../chat/chat-participant-drafts";
import { CHAT_AGENT_MODE_OPTIONS, CHAT_RUN_LOCATION_OPTIONS, WORKFLOW_MANAGER_ROLE_ID, chatAgentModeLabel, chatCliProviderLabel, normalizeChatRunLocation, normalizedChatDrafts, sameParticipantDraft, updateChatParticipantDraft, validateChatCliAgents, validateChatParticipantDrafts } from "../chat/chat-participant-drafts";
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog";
import {
  ParticipantEditorHandleField,
  ParticipantEditorSwitch,
  initialDraft,
  type ParticipantEditorState
} from "./participant-settings-utils";

type ChatParticipantDraftPatch = Parameters<typeof updateChatParticipantDraft>[2];
const AUTO_WATCH_GENERIC_DESCRIPTION = "Let this member watch new chat messages and decide whether to act.";
const AUTO_WATCH_MANAGER_DESCRIPTION = "Workflow Manager always watches new chat messages.";

export function ParticipantEditorDialog(props: {
  editor?: ParticipantEditorState;
  settings: AppSettings;
  agents: AgentHealth[];
  onSave: (update: ChatParticipantConfigUpdate) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const participant = props.editor?.type === "edit" ? props.editor.participant : undefined;
  const open = Boolean(props.editor);
  const existingHandles = useMemo(
    () => new Set(
      props.settings.chatParticipantConfigs
        .filter((item) => item.id !== participant?.id)
        .map((item) => item.handle.toLowerCase())
    ),
    [participant?.id, props.settings.chatParticipantConfigs]
  );
  const [draft, setDraft] = useState<ChatParticipantDraft>(() => initialDraft(props.settings, participant, existingHandles));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(initialDraft(props.settings, participant, existingHandles));
      setSaving(false);
      setDeleting(false);
      setDeleteConfirmOpen(false);
    }
  }, [existingHandles, open, participant, props.settings]);

  const normalized = normalizedChatDrafts([draft])[0];
  const normalizedMode = normalizeChatAgentMode(draft.agentMode);
  const changed = !participant || !sameParticipantDraft(normalized, participant);
  const validation = validateChatParticipantDrafts([draft], props.settings.chatRoleConfigs, existingHandles, props.settings.chatBehaviorRules)
    ?? validateChatCliAgents([normalized], props.agents);
  const canSave = changed && !validation && !saving;
  const roleLabel = displayChatRoleLabel(
    props.settings.chatRoleConfigs.find((role) => role.id === draft.roleConfigId),
    draft.roleConfigId
  );
  const isWorkflowManager = draft.roleConfigId === WORKFLOW_MANAGER_ROLE_ID;
  // Hide archived (deleted) roles from the picker so no new references form, but keep the
  // member's current role selectable so editing an existing binding never goes blank.
  const roleOptions = props.settings.chatRoleConfigs
    .filter((role) => !role.archivedAt || role.id === draft.roleConfigId)
    .map((role) => ({ value: role.id, label: role.archivedAt ? `${displayChatRoleLabel(role)} (deleted)` : displayChatRoleLabel(role) }));
  const providerOptions = (["codex-cli", "claude-code"] as ChatProviderKind[]).map((kind) => ({
    value: kind,
    label: chatCliProviderLabel(kind)
  }));
  const editorHandle = normalized.handle || draft.handle.trim().replace(/^@/, "") || "new-participant";
  const draftParticipant: ChatRosterChangeParticipantInput = {
    handle: editorHandle,
    roleConfigId: draft.roleConfigId,
    behaviorRuleIds: draft.behaviorRuleIds,
    kind: draft.kind,
    model: draft.model,
    reasoningEffort: draft.reasoningEffort,
    avatarId: draft.avatarId,
    agentMode: draft.agentMode,
    permissions: draft.permissions
  };

  function patchDraft(patch: ChatParticipantDraftPatch): void {
    setDraft((current) => {
      const next = updateChatParticipantDraft(current, props.settings, patch);
      return patch.roleConfigId !== undefined && patch.roleConfigId !== current.roleConfigId
        ? { ...next, handle: current.handle }
        : next;
    });
  }

  function updateHandle(handle: string): void {
    setDraft((current) => ({ ...current, handle: handle.replace(/^@+/, "") }));
  }

  function toggleBehaviorRule(ruleId: string, checked: boolean): void {
    setDraft((current) => {
      const selected = new Set(current.behaviorRuleIds);
      if (checked) {
        selected.add(ruleId);
      } else {
        selected.delete(ruleId);
      }
      const behaviorRuleIds = props.settings.chatBehaviorRules.map((rule) => rule.id).filter((id) => selected.has(id));
      return updateChatParticipantDraft(current, props.settings, { behaviorRuleIds });
    });
  }

  async function save(): Promise<void> {
    if (!canSave) {
      return;
    }
    setSaving(true);
    try {
      await props.onSave({ id: participant?.id, ...normalized, autoWatchEnabled: normalized.autoWatch });
      props.onClose();
    } finally {
      setSaving(false);
    }
  }

  async function deleteParticipant(): Promise<void> {
    if (!participant || deleting) {
      return;
    }
    setDeleting(true);
    try {
      await props.onDelete(participant.id);
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
      <DialogContent className="participants-editor-dialog" showCloseButton={false}>
        <DialogHeader className="participants-editor-head">
          <div className="participants-editor-profile">
            <ChatParticipantAvatarField
              kind={draft.kind}
              handle={editorHandle}
              avatarId={draft.avatarId}
              onSelect={(avatarId) => patchDraft({ avatarId })}
            />
            <span className="participants-editor-title-block">
              <DialogTitle>@{editorHandle}</DialogTitle>
              <DialogDescription>{roleLabel || "Saved member preset"}</DialogDescription>
            </span>
            <DialogClose asChild>
              <button type="button" className="participants-editor-close" aria-label="Close member editor">
                <X size={15} aria-hidden />
              </button>
            </DialogClose>
          </div>
        </DialogHeader>
        <div className="participants-editor-body">
          <div className="chat-app-tool-review-spec participants-editor-table">
            <ChatParticipantSpecRow label="Status">
              <strong>{participant ? "Saved member preset" : "New member preset"}</strong>
            </ChatParticipantSpecRow>
            <ChatParticipantSpecRow label="Handle">
              <ParticipantEditorHandleField handle={draft.handle} onChange={updateHandle} />
            </ChatParticipantSpecRow>
            <ChatParticipantInlineSelectRow
              label="Role"
              value={roleLabel}
              current={draft.roleConfigId}
              options={roleOptions}
              searchable
              searchPlaceholder="Filter roles"
              emptyLabel="No roles found"
              onSelect={(value) => patchDraft({ roleConfigId: value })}
            />
            <ChatParticipantInlineSelectRow
              label="Provider / CLI"
              value={participantProviderLabel(draft.kind)}
              current={draft.kind}
              options={providerOptions}
              onSelect={(value) => patchDraft({ kind: value as ChatProviderKind })}
            />
            {draft.kind === "codex-cli" && (
              <ChatParticipantInlineSelectRow
                label="Run location"
                value={normalizeChatRunLocation(draft.remoteExecution) === "remote" ? "Remote" : "Local"}
                current={normalizeChatRunLocation(draft.remoteExecution)}
                options={CHAT_RUN_LOCATION_OPTIONS}
                onSelect={(value) => patchDraft({ remoteExecution: normalizeChatRunLocation(value) })}
              />
            )}
            {draft.kind === "codex-cli" && normalizeChatRunLocation(draft.remoteExecution) === "remote" && (
              <ChatParticipantSpecRow label="Preflight">
                <ParticipantEditorSwitch
                  label="Skip toolchain preflight"
                  description="Bypass repository toolchain checks when detection is wrong."
                  checked={draft.skipToolchainPreflight}
                  onChange={(checked) => patchDraft({ skipToolchainPreflight: checked })}
                />
              </ChatParticipantSpecRow>
            )}
            <ChatParticipantInlineModelRow
              kind={draft.kind}
              model={draft.model}
              onSelect={(model) => setDraft({ ...draft, model })}
            />
            <ChatParticipantInlineSelectRow
              label="Reasoning"
              value={draft.reasoningEffort ? chatReasoningEffortLabel(draft.reasoningEffort) : "CLI default"}
              current={draft.reasoningEffort ?? ""}
              options={[
                { value: "", label: "CLI default" },
                ...reasoningEffortOptionsForProvider(draft.kind).map((option) => ({ value: option.id, label: option.label }))
              ]}
              onSelect={(value) => patchDraft({ reasoningEffort: value ? normalizeChatReasoningEffort(value, draft.kind) : undefined })}
            />
            <ChatParticipantInlineSelectRow
              label="Mode"
              value={chatAgentModeLabel(draft.agentMode)}
              current={normalizedMode}
              options={CHAT_AGENT_MODE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
              onSelect={(value) => patchDraft({ agentMode: value as ChatAgentMode })}
            />
            {normalizedMode === "default" && (
              <ChatParticipantInlinePermissionsRow
                participant={draftParticipant}
                onChange={(permissions) => patchDraft({ permissions })}
              />
            )}
            <ChatParticipantSpecRow label="Auto-watch">
              <ParticipantEditorSwitch
                label="Watch new chat activity"
                description={isWorkflowManager ? AUTO_WATCH_MANAGER_DESCRIPTION : AUTO_WATCH_GENERIC_DESCRIPTION}
                checked={draft.autoWatch}
                disabled={isWorkflowManager}
                onChange={(checked) => patchDraft({ autoWatch: checked })}
              />
            </ChatParticipantSpecRow>
            <ChatParticipantInlineRequestParticipantsRow
              participant={draftParticipant}
              onChange={(permissions) => patchDraft({ permissions })}
            />
          </div>

          {props.settings.chatBehaviorRules.length > 0 && (
            <section className="participants-editor-section">
              <h3 className="participants-editor-section-title">Behavior rules</h3>
              <div className="participants-editor-rule-list">
                {props.settings.chatBehaviorRules.map((rule) => (
                  <ParticipantEditorSwitch
                    className="participants-editor-rule-row"
                    label={rule.label}
                    description={rule.instructions}
                    checked={draft.behaviorRuleIds.includes(rule.id)}
                    onChange={(checked) => toggleBehaviorRule(rule.id, checked)}
                    key={rule.id}
                  />
                ))}
              </div>
            </section>
          )}

          {validation && <div className="inline-error participants-editor-error">{validation}</div>}
        </div>
        <DialogFooter className="participants-editor-footer">
          {participant && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="participants-editor-delete"
              disabled={saving || deleting}
              title="Delete this saved member preset. Existing chats keep their copied member."
              data-testid="settings-participant-modal-delete"
              onClick={() => setDeleteConfirmOpen(true)}
            >
              <Trash2 size={14} aria-hidden />
              Delete preset
            </Button>
          )}
          <DialogClose asChild>
            <Button type="button" variant="outline" size="sm" disabled={saving}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" size="sm" disabled={!canSave} onClick={() => void save()}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {participant && (
      <DeleteConfirmationDialog
        open={deleteConfirmOpen}
        title={`Delete @${participant.handle}?`}
        description="Delete this saved member preset? Existing chats keep their copied member."
        confirmLabel="Delete"
        pending={deleting}
        onOpenChange={setDeleteConfirmOpen}
        onConfirm={deleteParticipant}
      />
    )}
    </>
  );
}
