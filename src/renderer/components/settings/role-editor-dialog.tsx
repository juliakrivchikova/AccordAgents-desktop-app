import { useEffect, useState } from "react";
import { Eye, LockKeyhole, Pencil, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ChatParticipantRequestPermission, ChatRoleConfig, ChatRoleConfigUpdate, ChatRoleParticipantDefaults } from "../../../shared/types";
import { AppSelect, ResizableTextarea } from "../primitives";
import { displayChatRoleLabel } from "../chat/chat-role-labels";
import { ChatParticipantSpecRow } from "../chat/chat-participant-config-panel";
import { MarkdownText } from "../content/markdown-text";
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog";
import { ParticipantEditorSwitch } from "./participant-settings-utils";
import {
  CHAT_ROLE_INSTRUCTIONS_MAX_CHARS,
  CHAT_ROLE_LABEL_MAX_CHARS,
  RoleKindBadge,
  composeRoleInstructions,
  displayChatRoleDescription,
  parseRoleInstructions,
  roleWordCount,
  slugFromRoleLabel,
  type RoleEditorState
} from "./role-settings-utils";
import { WORKFLOW_MANAGER_ROLE_ID } from "../chat/chat-participant-drafts";

const ROLE_REQUEST_PARTICIPANTS_OPTIONS: Array<{ value: ChatParticipantRequestPermission; label: string }> = [
  { value: "ask", label: "Always ask approval" },
  { value: "allow", label: "Allow without approval" },
  { value: "deny", label: "Deny" }
];

function roleParticipantDefaultsForDisplay(
  defaults: ChatRoleParticipantDefaults | undefined,
  roleId: string | undefined
): ChatRoleParticipantDefaults {
  if (roleId === WORKFLOW_MANAGER_ROLE_ID) {
    return {
      autoWatch: true,
      requestParticipants: "allow",
      requestCompaction: defaults?.requestCompaction ?? "ask",
      manageRolesParticipants: defaults?.manageRolesParticipants ?? "deny"
    };
  }
  return {
    autoWatch: defaults?.autoWatch === true,
    requestParticipants: defaults?.requestParticipants ?? "ask",
    requestCompaction: defaults?.requestCompaction ?? "ask",
    manageRolesParticipants: defaults?.manageRolesParticipants ?? "deny"
  };
}

function roleParticipantDefaultsForSave(defaults: ChatRoleParticipantDefaults): ChatRoleParticipantDefaults {
  return {
    autoWatch: defaults.autoWatch === true,
    requestParticipants: defaults.requestParticipants ?? "ask",
    requestCompaction: defaults.requestCompaction ?? "ask",
    manageRolesParticipants: defaults.manageRolesParticipants ?? "deny"
  };
}

function roleParticipantDefaultsEqual(left: ChatRoleParticipantDefaults, right: ChatRoleParticipantDefaults): boolean {
  return left.autoWatch === right.autoWatch &&
    left.requestParticipants === right.requestParticipants &&
    left.requestCompaction === right.requestCompaction &&
    left.manageRolesParticipants === right.manageRolesParticipants;
}

function requestParticipantsLabel(value: ChatParticipantRequestPermission | undefined): string {
  return ROLE_REQUEST_PARTICIPANTS_OPTIONS.find((option) => option.value === value)?.label ?? "Always ask approval";
}

export function ChatRoleEditorDialog(props: {
  editor?: RoleEditorState;
  roles: ChatRoleConfig[];
  savedParticipantPresetsByRole: Map<string, number>;
  onSave: (update: ChatRoleConfigUpdate) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
  onDuplicate: (role: ChatRoleConfig) => void;
  onClose: () => void;
}): JSX.Element {
  const editingRoleId = props.editor?.type === "edit" ? props.editor.roleId : undefined;
  const role = editingRoleId ? props.roles.find((item) => item.id === editingRoleId) : undefined;
  const open = props.editor?.type === "new" || Boolean(role);
  const roleParts = parseRoleInstructions(role?.instructions ?? "");
  const displayLabel = role ? displayChatRoleLabel(role) : undefined;
  const initialLabel = props.editor?.type === "new" ? props.editor.initialLabel ?? "" : displayLabel ?? "";
  const initialDescription = props.editor?.type === "new"
    ? props.editor.initialDescription ?? ""
    : displayChatRoleDescription(role, roleParts.description);
  const initialInstructions = props.editor?.type === "new" ? props.editor.initialInstructions ?? "" : roleParts.body;
  const initialParticipantDefaults = props.editor?.type === "new"
    ? roleParticipantDefaultsForDisplay(props.editor.initialParticipantDefaults, undefined)
    : roleParticipantDefaultsForDisplay(role?.participantDefaults, role?.id);
  const readOnly = props.editor?.type === "edit" && Boolean(role?.builtIn);
  const initialPreview = props.editor?.type === "edit";
  const [label, setLabel] = useState(initialLabel);
  const [description, setDescription] = useState(initialDescription);
  const [instructions, setInstructions] = useState(initialInstructions);
  const [participantDefaults, setParticipantDefaults] = useState<ChatRoleParticipantDefaults>(initialParticipantDefaults);
  const [preview, setPreview] = useState(initialPreview);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setLabel(initialLabel);
    setDescription(initialDescription);
    setInstructions(initialInstructions);
    setParticipantDefaults(initialParticipantDefaults);
    setPreview(initialPreview);
    setSaving(false);
    setDeleting(false);
    setDeleteConfirmOpen(false);
  }, [
    initialDescription,
    initialInstructions,
    initialLabel,
    initialParticipantDefaults.autoWatch,
    initialParticipantDefaults.manageRolesParticipants,
    initialParticipantDefaults.requestCompaction,
    initialParticipantDefaults.requestParticipants,
    initialPreview,
    open
  ]);

  const trimmedLabel = label.trim();
  const trimmedDescription = description.trim();
  const trimmedInstructions = instructions.trim();
  const composedInstructions = composeRoleInstructions({
    name: roleParts.frontmatterName || slugFromRoleLabel(trimmedLabel),
    description: trimmedDescription,
    body: trimmedInstructions,
    includeFrontmatter: Boolean(trimmedDescription || roleParts.hadFrontmatter || props.editor?.type === "new")
  });
  const validation = trimmedLabel.length > CHAT_ROLE_LABEL_MAX_CHARS
    ? `Role name must be ${CHAT_ROLE_LABEL_MAX_CHARS} characters or less.`
    : composedInstructions.length > CHAT_ROLE_INSTRUCTIONS_MAX_CHARS
      ? `Role instructions must be ${CHAT_ROLE_INSTRUCTIONS_MAX_CHARS.toLocaleString()} characters or less.`
      : undefined;
  const changed = props.editor?.type === "new"
    ? Boolean(trimmedLabel || trimmedDescription || trimmedInstructions || !roleParticipantDefaultsEqual(participantDefaults, initialParticipantDefaults))
    : Boolean(role && (
      trimmedLabel !== role.label ||
      trimmedDescription !== roleParts.description ||
      trimmedInstructions !== roleParts.body ||
      !roleParticipantDefaultsEqual(participantDefaults, initialParticipantDefaults)
    ));
  const canSave = !readOnly && !saving && Boolean(trimmedLabel && trimmedInstructions) && !validation && changed;
  const wordCount = roleWordCount(instructions);
  const title = props.editor?.type === "new" ? trimmedLabel || "New role" : displayLabel ?? "Role";
  const readOnlyDefaults = roleParticipantDefaultsForDisplay(role?.participantDefaults, props.editor?.type === "new" ? undefined : role?.id);

  async function save(): Promise<void> {
    if (!canSave) {
      return;
    }
    setSaving(true);
    try {
      await props.onSave({
        id: props.editor?.type === "edit" ? role?.id : undefined,
        label: trimmedLabel,
        instructions: composedInstructions,
        participantDefaults: roleParticipantDefaultsForSave(participantDefaults)
      });
      props.onClose();
    } finally {
      setSaving(false);
    }
  }

  // Delete (archive) is offered for editable custom roles only; built-ins and new roles cannot be deleted.
  const usageCount = role ? (props.savedParticipantPresetsByRole.get(role.id) ?? 0) : 0;
  const showDelete = props.editor?.type === "edit" && Boolean(role) && !role?.builtIn;
  const canDelete = showDelete && usageCount === 0 && !deleting;

  async function deleteRole(): Promise<void> {
    if (!role || !canDelete) {
      return;
    }
    setDeleting(true);
    try {
      await props.onArchive(role.id);
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
      <DialogContent className="roles-editor-dialog" data-testid="settings-role-modal" showCloseButton={false}>
        <DialogHeader className="roles-editor-head">
          <div className="roles-editor-title-row">
            <span className="roles-editor-title-text">
              <DialogTitle>{title}</DialogTitle>
            </span>
            <RoleKindBadge builtIn={Boolean(role?.builtIn && props.editor?.type === "edit")} />
            <DialogClose asChild>
              <button type="button" className="roles-editor-close" aria-label="Close role editor" data-testid="settings-role-modal-close">
                <X size={15} aria-hidden />
              </button>
            </DialogClose>
          </div>
        </DialogHeader>
        <div className="roles-editor-body">
          {readOnly && role && (
            <div className="roles-readonly-banner" data-testid="settings-role-builtin-banner">
              <LockKeyhole size={17} aria-hidden />
              <span>This is a built-in role and is read-only. Duplicate it to create an editable copy.</span>
              <Button
                type="button"
                className="roles-duplicate-button"
                data-testid="settings-role-duplicate"
                onClick={() => props.onDuplicate(role)}
              >
                Duplicate to edit
              </Button>
            </div>
          )}

          <label className="roles-field-label" htmlFor="role-editor-name">Name</label>
          <Input
            id="role-editor-name"
            className="roles-editor-input"
            data-testid="settings-role-modal-name"
            value={label}
            readOnly={readOnly}
            maxLength={CHAT_ROLE_LABEL_MAX_CHARS}
            placeholder="e.g. Security auditor"
            onChange={(event) => setLabel(event.target.value)}
          />

          <label className="roles-field-label roles-field-label-spaced" htmlFor="role-editor-description">Description</label>
          <ResizableTextarea
            id="role-editor-description"
            className="roles-editor-description"
            data-testid="settings-role-modal-description"
            value={description}
            readOnly={readOnly}
            rows={2}
            maxHeight={160}
            placeholder="A short summary of what this role is for..."
            onChange={(event) => setDescription(event.target.value)}
          />

          <section className="roles-default-settings" aria-label="Default member settings">
            <span className="roles-default-settings-title">Default member settings</span>
            {readOnly ? (
                <div className="chat-app-tool-review-spec roles-default-settings-table">
                  <ChatParticipantSpecRow label="Auto-watch">
                    <ParticipantEditorSwitch
                      className="roles-default-settings-toggle"
                      label="Default for new members"
                      description="Watch new chat messages and decide whether to act."
                      checked={readOnlyDefaults.autoWatch === true}
                      disabled
                      onChange={() => {}}
                    />
                  </ChatParticipantSpecRow>
                  <ChatParticipantSpecRow label="Request members">
                    <strong>{requestParticipantsLabel(readOnlyDefaults.requestParticipants)}</strong>
                  </ChatParticipantSpecRow>
                  <ChatParticipantSpecRow label="Request compaction">
                    <strong>{requestParticipantsLabel(readOnlyDefaults.requestCompaction)}</strong>
                  </ChatParticipantSpecRow>
                  <ChatParticipantSpecRow label="Manage roles & members">
                    <strong>{requestParticipantsLabel(readOnlyDefaults.manageRolesParticipants)}</strong>
                  </ChatParticipantSpecRow>
              </div>
            ) : (
              <div className="chat-app-tool-review-spec roles-default-settings-table">
                <ChatParticipantSpecRow label="Auto-watch">
                  <ParticipantEditorSwitch
                    className="roles-default-settings-toggle"
                    label="Default for new members"
                    description="Watch new chat messages and decide whether to act."
                    checked={participantDefaults.autoWatch === true}
                    onChange={(checked) => setParticipantDefaults((current) => ({ ...current, autoWatch: checked }))}
                  />
                </ChatParticipantSpecRow>
                <ChatParticipantSpecRow label="Request members">
                  <div className="roles-default-settings-select">
                    <AppSelect
                      value={participantDefaults.requestParticipants ?? "ask"}
                      options={ROLE_REQUEST_PARTICIPANTS_OPTIONS}
                      placeholder="Request members"
                      ariaLabel="Default request members permission"
                      testId="settings-role-default-request-participants"
                      onValueChange={(value) => setParticipantDefaults((current) => ({
                        ...current,
                        requestParticipants: value as ChatParticipantRequestPermission
                      }))}
                    />
                  </div>
                </ChatParticipantSpecRow>
                <ChatParticipantSpecRow label="Request compaction">
                  <div className="roles-default-settings-select">
                    <AppSelect
                      value={participantDefaults.requestCompaction ?? "ask"}
                      options={ROLE_REQUEST_PARTICIPANTS_OPTIONS}
                      placeholder="Request compaction"
                      ariaLabel="Default request compaction permission"
                      testId="settings-role-default-request-compaction"
                      onValueChange={(value) => setParticipantDefaults((current) => ({
                        ...current,
                        requestCompaction: value as ChatParticipantRequestPermission
                      }))}
                    />
                  </div>
                </ChatParticipantSpecRow>
                <ChatParticipantSpecRow label="Manage roles & members">
                  <div className="roles-default-settings-select">
                    <AppSelect
                      value={participantDefaults.manageRolesParticipants ?? "deny"}
                      options={ROLE_REQUEST_PARTICIPANTS_OPTIONS}
                      placeholder="Manage roles & members"
                      ariaLabel="Default manage roles and members permission"
                      testId="settings-role-default-manage-roles-participants"
                      onValueChange={(value) => setParticipantDefaults((current) => ({
                        ...current,
                        manageRolesParticipants: value as ChatParticipantRequestPermission
                      }))}
                    />
                  </div>
                </ChatParticipantSpecRow>
              </div>
            )}
          </section>

          <div className="roles-instructions-head">
            <label className="roles-field-label" htmlFor="role-editor-instructions">Instructions</label>
            <span>{wordCount} {wordCount === 1 ? "word" : "words"}</span>
            {!readOnly && (
              <span className="roles-preview-toggle" aria-label="Instruction editor mode">
                <button
                  type="button"
                  className={preview ? "is-selected" : ""}
                  data-testid="settings-role-modal-preview"
                  onClick={() => setPreview(true)}
                >
                  <Eye size={14} aria-hidden />
                  Preview
                </button>
                <button
                  type="button"
                  className={!preview ? "is-selected" : ""}
                  data-testid="settings-role-modal-edit"
                  onClick={() => setPreview(false)}
                >
                  <Pencil size={14} aria-hidden />
                  Edit
                </button>
              </span>
            )}
          </div>

          {preview || readOnly ? (
            <div className={`roles-preview-box ${readOnly ? "is-readonly" : ""}`} data-testid="settings-role-modal-preview-content">
              {trimmedInstructions ? <MarkdownText content={trimmedInstructions} /> : <span>No instructions yet.</span>}
            </div>
          ) : (
            <ResizableTextarea
              id="role-editor-instructions"
              className="roles-editor-textarea"
              data-testid="settings-role-modal-instructions"
              value={instructions}
              maxLength={CHAT_ROLE_INSTRUCTIONS_MAX_CHARS}
              rows={16}
              maxHeight={520}
              placeholder="Describe what this role does and how it should behave..."
              onChange={(event) => setInstructions(event.target.value)}
            />
          )}
          {validation && <div className="inline-error roles-editor-error">{validation}</div>}
        </div>
        <DialogFooter className="roles-editor-footer">
          {showDelete && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="roles-editor-delete"
              disabled={!canDelete}
              title={usageCount > 0
                ? `In use by ${usageCount} saved member preset${usageCount === 1 ? "" : "s"}. Reassign or remove them first.`
                : undefined}
              data-testid="settings-role-modal-delete"
              onClick={() => setDeleteConfirmOpen(true)}
            >
              <Trash2 size={14} aria-hidden />
              Delete role
            </Button>
          )}
          <DialogClose asChild>
            <Button type="button" variant="outline" size="sm" className="roles-editor-cancel" disabled={saving} data-testid="settings-role-modal-cancel">
              {readOnly ? "Close" : "Cancel"}
            </Button>
          </DialogClose>
          {!readOnly && (
            <Button
              type="button"
              size="sm"
              className="roles-editor-save"
              disabled={!canSave}
              data-testid="settings-role-modal-save"
              onClick={() => void save()}
            >
              {saving ? "Saving..." : props.editor?.type === "new" ? "Create role" : "Save"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {role && (
      <DeleteConfirmationDialog
        open={deleteConfirmOpen}
        title={`Delete ${role.label}?`}
        description="Delete this custom role? Existing archived references stay resolvable, but the role will be hidden from settings and pickers."
        confirmLabel="Delete"
        pending={deleting}
        onOpenChange={setDeleteConfirmOpen}
        onConfirm={deleteRole}
      />
    )}
    </>
  );
}
