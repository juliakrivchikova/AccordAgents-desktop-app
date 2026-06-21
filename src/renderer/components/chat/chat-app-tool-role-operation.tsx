import { useState } from "react";
import { AlertTriangle, Eye, Pencil } from "lucide-react";

import type { ChatParticipantConfig, ChatRoleChangeRequest, ChatRoleConfig } from "../../../shared/types";
import { MarkdownText } from "../content/markdown-text";
import { wordCount } from "./chat-app-tool-roster";

export function ChatAppToolRoleChangeOperation(props: {
  request: ChatRoleChangeRequest;
  roles: ChatRoleConfig[];
  savedParticipants: ChatParticipantConfig[];
  onChange: (request: ChatRoleChangeRequest) => void;
}): JSX.Element {
  const [previewInstructions, setPreviewInstructions] = useState(true);

  function updateReason(reason: string): void {
    props.onChange({
      ...props.request,
      reason
    });
  }

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
                <strong>{archivedRole?.label ?? operation.role.roleConfigId}</strong>
              </div>
              <div className="chat-app-tool-review-warning">
                <AlertTriangle size={14} aria-hidden />
                <span>This role will be deleted. Existing participants keep working under it.</span>
              </div>
            </div>
          );
        }
        const roleConfigId = operation.type === "edit_role" ? operation.role.roleConfigId : undefined;
        const savedPresetCount = roleConfigId
          ? props.savedParticipants.filter((participant) => participant.roleConfigId === roleConfigId).length
          : 0;
        const instructionWordCount = wordCount(operation.role.instructions);
        return (
          <div className={`chat-app-tool-review-block is-role-review ${operation.type === "create_role" ? "is-new-role" : "is-edit-role"}`} key={`${operation.type}-${index}`}>
            <label className="chat-app-tool-review-field is-role-name">
              <span className="chat-app-tool-review-field-head">
                <span>Role name</span>
                <em>{operation.role.label.length} / 60</em>
              </span>
              <input
                value={operation.role.label}
                maxLength={60}
                onChange={(event) => updateRole(index, { label: event.currentTarget.value })}
              />
            </label>
            <label className="chat-app-tool-review-field is-description">
              <span>Description</span>
              <textarea
                value={props.request.reason ?? ""}
                rows={3}
                onChange={(event) => updateReason(event.currentTarget.value)}
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
                  {operation.role.instructions}
                </div>
              ) : (
                <textarea
                  value={operation.role.instructions}
                  rows={7}
                  onChange={(event) => updateRole(index, { instructions: event.currentTarget.value })}
                />
              )}
            </div>
            {operation.type === "edit_role" && savedPresetCount > 0 && (
              <div className="chat-app-tool-review-warning">
                <AlertTriangle size={14} aria-hidden />
                <span>Editing this role affects participants already using it.</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

