import { useState } from "react";
import { AlertTriangle, Eye, Pencil } from "lucide-react";

import {
  chatParticipantRequestPermissionExceeds,
  normalizeChatParticipantRequestPermission,
  normalizeChatRoleManagementPermission
} from "../../../shared/agentPermissions";
import type { ChatParticipantConfig, ChatParticipantRequestPermission, ChatRoleChangeRequest, ChatRoleConfig, ChatRoleParticipantDefaults } from "../../../shared/types";
import { MarkdownText } from "../content/markdown-text";
import { displayChatRoleLabel } from "./chat-role-labels";
import { ChatParticipantInlineAutoWatchRow, ChatParticipantSpecRow } from "./chat-participant-config-panel";
import {
  composeRoleInstructions,
  parseRoleInstructions,
  roleWordCount,
  slugFromRoleLabel
} from "../settings/role-settings-utils";

type EditableRoleOperation =
  | Extract<ChatRoleChangeRequest["operations"][number], { type: "create_role" }>
  | Extract<ChatRoleChangeRequest["operations"][number], { type: "edit_role" }>;

interface RoleReviewFields {
  label: string;
  description: string;
  instructions: string;
  frontmatterName?: string;
  hadFrontmatter: boolean;
}

export function ChatAppToolRoleChangeOperation(props: {
  request: ChatRoleChangeRequest;
  roles: ChatRoleConfig[];
  savedParticipants: ChatParticipantConfig[];
  onChange: (request: ChatRoleChangeRequest) => void;
}): JSX.Element {
  function updateRole(index: number, patch: { label?: string; instructions?: string }): void {
    props.onChange({
      ...props.request,
      operations: props.request.operations.map((operation, operationIndex): ChatRoleChangeRequest["operations"][number] => {
        if (operationIndex !== index) {
          return operation;
        }
        if (operation.type === "create_role") {
          return {
            type: "create_role",
            role: {
              ...operation.role,
              ...patch
            }
          };
        }
        if (operation.type === "archive_role") {
          return operation;
        }
        return {
          type: "edit_role",
          role: {
            ...operation.role,
            ...patch
          }
        };
      })
    });
  }

  return (
    <div className="chat-app-tool-review-stack">
      {props.request.operations.map((operation, index) => {
        if (operation.type === "archive_role") {
          const archivedRole = props.roles.find((role) => role.id === operation.role.roleConfigId);
          return (
            <div className="chat-app-tool-review-block is-role-review" key={`archive_role-${index}`}>
              <div className="chat-app-tool-review-heading">
                <strong>Deleting role</strong>
                <span>{archivedRole?.builtIn ? "Built-in role" : "Custom role"}</span>
              </div>
              <div className="chat-app-tool-review-field">
                <span>Role</span>
                <strong>{displayChatRoleLabel(archivedRole, operation.role.roleConfigId)}</strong>
              </div>
              <div className="chat-app-tool-review-warning">
                <AlertTriangle size={14} aria-hidden />
                <span>This role will be deleted. Existing members keep working under it.</span>
              </div>
            </div>
          );
        }
        const roleConfigId = operation.type === "edit_role" ? operation.role.roleConfigId : undefined;
        const existingRole = roleConfigId ? props.roles.find((role) => role.id === roleConfigId) : undefined;
        const savedPresetCount = roleConfigId
          ? props.savedParticipants.filter((participant) => participant.roleConfigId === roleConfigId).length
          : 0;
        return (
          <EditableRoleReviewOperation
            key={roleOperationKey(operation, index)}
            operation={operation}
            existingRole={existingRole}
            savedPresetCount={savedPresetCount}
            onChange={(patch) => updateRole(index, patch)}
          />
        );
      })}
    </div>
  );
}

function EditableRoleReviewOperation(props: {
  operation: EditableRoleOperation;
  existingRole?: ChatRoleConfig;
  savedPresetCount: number;
  onChange: (patch: { label: string; instructions: string }) => void;
}): JSX.Element {
  const [previewInstructions, setPreviewInstructions] = useState(true);
  const [fields, setFields] = useState<RoleReviewFields>(() => roleFieldsFromOperation(props.operation));
  const instructionWordCount = roleWordCount(fields.instructions);
  const trimmedInstructions = fields.instructions.trim();

  function updateFields(patch: Partial<Pick<RoleReviewFields, "label" | "description" | "instructions">>): void {
    const next = { ...fields, ...patch };
    setFields(next);
    props.onChange({
      label: next.label,
      instructions: composeOperationInstructions(props.operation.type, next)
    });
  }

  function updateDescription(value: string): void {
    updateFields({ description: normalizeRoleDescriptionInput(value) });
  }

  return (
    <div className={`chat-app-tool-review-block is-role-review ${props.operation.type === "create_role" ? "is-new-role" : "is-edit-role"}`}>
      <label className="chat-app-tool-review-field is-role-name">
        <span className="chat-app-tool-review-field-head">
          <span>Role name</span>
          <em>{fields.label.length} / 60</em>
        </span>
        <input
          value={fields.label}
          maxLength={60}
          onChange={(event) => updateFields({ label: event.currentTarget.value })}
        />
      </label>
      <label className="chat-app-tool-review-field is-description">
        <span>Description</span>
        <textarea
          value={fields.description}
          rows={3}
          onChange={(event) => updateDescription(event.currentTarget.value)}
        />
      </label>
      <div className="chat-app-tool-review-field is-instructions">
        <span className="chat-app-tool-review-field-head">
          <span>Instructions</span>
          <span className="chat-app-tool-review-instructions-meta">
            <em>{instructionWordCount} {instructionWordCount === 1 ? "word" : "words"}</em>
            <span className="chat-app-tool-review-preview-toggle" role="group" aria-label="Instructions view">
              <button
                type="button"
                className={previewInstructions ? "is-active" : ""}
                aria-pressed={previewInstructions}
                onClick={() => setPreviewInstructions(true)}
              >
                <Eye size={13} aria-hidden />
                Preview
              </button>
              <button
                type="button"
                className={!previewInstructions ? "is-active" : ""}
                aria-pressed={!previewInstructions}
                onClick={() => setPreviewInstructions(false)}
              >
                <Pencil size={13} aria-hidden />
                Edit
              </button>
            </span>
          </span>
        </span>
        {previewInstructions ? (
          <div className="chat-app-tool-review-instructions-preview">
            {trimmedInstructions ? <MarkdownText content={trimmedInstructions} /> : <span>No instructions yet.</span>}
          </div>
        ) : (
          <textarea
            value={fields.instructions}
            rows={7}
            onChange={(event) => updateFields({ instructions: event.currentTarget.value })}
          />
        )}
      </div>
      <RoleParticipantDefaultsReview defaults={roleParticipantDefaultsForOperation(props.operation, props.existingRole)} />
      {roleManagementDefaultEscalates(props.operation, props.existingRole) && (
        <div className="chat-app-tool-review-warning">
          <AlertTriangle size={14} aria-hidden />
          <span>Management escalation: this role default grants or raises role/member management for inheriting members.</span>
        </div>
      )}
      {props.operation.type === "edit_role" && props.savedPresetCount > 0 && (
        <div className="chat-app-tool-review-warning">
          <AlertTriangle size={14} aria-hidden />
          <span>Editing this role affects members already using it.</span>
        </div>
      )}
    </div>
  );
}

function roleManagementDefaultEscalates(operation: EditableRoleOperation, existingRole?: ChatRoleConfig): boolean {
  const nextDefault = normalizeChatRoleManagementPermission(
    roleParticipantDefaultsForOperation(operation, existingRole)?.manageRolesParticipants
  );
  const previousDefault = operation.type === "edit_role"
    ? normalizeChatRoleManagementPermission(existingRole?.participantDefaults?.manageRolesParticipants)
    : "deny";
  return chatParticipantRequestPermissionExceeds(nextDefault, previousDefault);
}

function roleParticipantDefaultsForOperation(
  operation: EditableRoleOperation,
  existingRole?: ChatRoleConfig
): ChatRoleParticipantDefaults | undefined {
  return Object.prototype.hasOwnProperty.call(operation.role, "participantDefaults")
    ? operation.role.participantDefaults
    : existingRole?.participantDefaults;
}

function RoleParticipantDefaultsReview(props: { defaults?: ChatRoleParticipantDefaults }): JSX.Element {
  const autoWatch = props.defaults?.autoWatch === true;
  const requestParticipants = normalizeChatParticipantRequestPermission(props.defaults?.requestParticipants);
  const requestCompaction = normalizeChatParticipantRequestPermission(props.defaults?.requestCompaction);
  const manageRolesParticipants = normalizeChatRoleManagementPermission(props.defaults?.manageRolesParticipants);
  return (
    <div className="chat-app-tool-review-spec">
      <ChatParticipantInlineAutoWatchRow
        checked={autoWatch}
        disabled
        onChange={() => {}}
        description="Default for new members using this role."
      />
      <ChatParticipantSpecRow label="Request members">
        <strong>{requestParticipantsLabel(requestParticipants)}</strong>
      </ChatParticipantSpecRow>
      <ChatParticipantSpecRow label="Request compaction">
        <strong>{requestParticipantsLabel(requestCompaction)}</strong>
      </ChatParticipantSpecRow>
      <ChatParticipantSpecRow label="Manage roles & members">
        <strong>{requestParticipantsLabel(manageRolesParticipants)}</strong>
      </ChatParticipantSpecRow>
    </div>
  );
}

function requestParticipantsLabel(value: ChatParticipantRequestPermission): string {
  if (value === "allow") {
    return "Allow without approval";
  }
  if (value === "deny") {
    return "Deny";
  }
  return "Always ask approval";
}

function roleFieldsFromOperation(operation: EditableRoleOperation): RoleReviewFields {
  const parts = parseRoleInstructions(operation.role.instructions);
  return {
    label: operation.role.label,
    description: parts.description,
    instructions: parts.body,
    frontmatterName: parts.frontmatterName,
    hadFrontmatter: parts.hadFrontmatter
  };
}

function composeOperationInstructions(operationType: EditableRoleOperation["type"], fields: RoleReviewFields): string {
  const trimmedLabel = fields.label.trim();
  const trimmedDescription = fields.description.trim();
  const trimmedInstructions = fields.instructions.trim();
  return composeRoleInstructions({
    name: fields.frontmatterName || slugFromRoleLabel(trimmedLabel),
    description: trimmedDescription,
    body: trimmedInstructions,
    includeFrontmatter: Boolean(trimmedDescription || fields.hadFrontmatter || operationType === "create_role")
  });
}

function normalizeRoleDescriptionInput(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n+/g, " ");
}

function roleOperationKey(operation: EditableRoleOperation, index: number): string {
  if (operation.type === "edit_role") {
    return `${operation.type}-${operation.role.roleConfigId}`;
  }
  return `${operation.type}-${operation.role.draftRoleRef ?? index}`;
}
