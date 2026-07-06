import { useState, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, CornerDownLeft, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  ChatAppToolApproval,
  ChatAppToolApprovalRequest,
  ChatAppToolApprovalScope,
  ChatParticipant,
  ChatParticipantChangeRequest,
  ChatParticipantConfig,
  ChatRoleChangeRequest,
  ChatRoleConfig,
  ChatRoleParticipantChangeRequest
} from "../../../shared/types";
import { Avatar, avatarForParticipant } from "../avatar/avatar";
import { chatParticipantDisplayName, chatParticipantReference } from "../conversation/conversation-display";
import { MarkdownText } from "../content/markdown-text";
import { avatarForChatParticipant } from "./chat-avatars";
import { formatChatTime } from "./chat-format";
import { APP_ROSTER_REQUEST_CHANGE_TOOL, chatParticipantChangeRequest, chatParticipantRequestApprovalRequest, chatPermissionChangeRequest, chatRoleChangeRequest, chatRoleParticipantChangeRequest, chatToolPermissionRequest, participantProviderLabel } from "./chat-conversation-data";
import { approvalOptions, approvalQuestion, approvalReason, ChatAppToolReviewFooter, ChatAppToolReviewResult, ChatAppToolReviewStatus, participantReviewChipLabel, reviewPrimaryLabel, roleReviewChipLabel, temporaryRolesForReview } from "./chat-app-tool-approval-review";
import { ChatAppToolPermissionOperation, ChatAppToolParticipantRequestOperation, ChatAppToolPermissionPromptOperation } from "./chat-app-tool-permission-operations";
import { ChatAppToolRosterOperation, ChatAppToolRosterPermissionEnvelope, RosterApprovalTitle, rosterApprovalQuestion } from "./chat-app-tool-roster";
import { ChatAppToolRoleChangeOperation } from "./chat-app-tool-role-operation";
import { ChatAppToolParticipantChangeOperation } from "./chat-app-tool-participant-operation";

export function ChatAppToolApprovalCard(props: {
  approval: ChatAppToolApproval;
  participants: ChatParticipant[];
  savedParticipants: ChatParticipantConfig[];
  roles: ChatRoleConfig[];
  submitting: boolean;
  onRespond: (
    approvalId: string,
    approve: boolean,
    scope?: ChatAppToolApprovalScope,
    draftOverride?: ChatAppToolApprovalRequest
  ) => Promise<void>;
}): JSX.Element {
  const permissionRequest = chatPermissionChangeRequest(props.approval);
  const toolPermissionRequest = chatToolPermissionRequest(props.approval);
  const combinedRequest = chatRoleParticipantChangeRequest(props.approval);
  const roleRequest = chatRoleChangeRequest(props.approval);
  const participantChange = chatParticipantChangeRequest(props.approval);
  const participantRequest = chatParticipantRequestApprovalRequest(props.approval);
  const inferredParticipantRequest = participantRequest?.source === "inferred";
  const preferOnceApproval = Boolean(permissionRequest && permissionRequest.kind !== "portable");
  const added = props.approval.toolName === APP_ROSTER_REQUEST_CHANGE_TOOL && "operations" in props.approval.request
    ? props.approval.request.operations.filter((operation) => operation.type === "add")
    : [];
  const rosterApproval = !permissionRequest && !combinedRequest && !roleRequest && !participantChange && !participantRequest && added.length > 0;
  const [combinedDraft, setCombinedDraft] = useState<ChatRoleParticipantChangeRequest | undefined>(combinedRequest);
  const [roleDraft, setRoleDraft] = useState<ChatRoleChangeRequest | undefined>(combinedRequest?.roleRequest ?? roleRequest);
  const [participantDraft, setParticipantDraft] = useState<ChatParticipantChangeRequest | undefined>(combinedRequest?.participantRequest ?? participantChange);
  const effectiveCombinedRequest = combinedRequest
    ? combinedDraft ?? {
        ...combinedRequest,
        roleRequest: roleDraft ?? combinedRequest.roleRequest,
        participantRequest: participantDraft ?? combinedRequest.participantRequest
      }
    : undefined;
  const effectiveRoleRequest = effectiveCombinedRequest?.roleRequest ?? (roleRequest ? roleDraft ?? roleRequest : undefined);
  const effectiveParticipantChange = effectiveCombinedRequest?.participantRequest ?? (participantChange ? participantDraft ?? participantChange : undefined);
  const reviewChange = Boolean(effectiveCombinedRequest || effectiveRoleRequest || effectiveParticipantChange);
  const readOnly = props.approval.status !== "pending";
  const options = approvalOptions(
    props.approval,
    permissionRequest,
    effectiveRoleRequest,
    effectiveParticipantChange,
    participantRequest,
    toolPermissionRequest,
    added,
    inferredParticipantRequest
  );
  const defaultIndex = rosterApproval || preferOnceApproval || inferredParticipantRequest ? 0 : Math.min(1, options.length - 1);
  const [selectedIndex, setSelectedIndex] = useState(defaultIndex);
  const requester = props.participants.find((participant) => participant.id === props.approval.requesterParticipantId);
  const requesterLabel = requester ? chatParticipantDisplayName(requester) : chatParticipantReference(props.approval.requesterHandle);
  const requesterAvatar = requester
    ? avatarForChatParticipant(requester, requesterLabel)
    : avatarForParticipant(requesterLabel, props.approval.requesterParticipantId);
  const approvalPrompt = effectiveCombinedRequest
    ? `${chatParticipantReference(props.approval.requesterHandle)} wants to create a role and add a member`
    : approvalQuestion(props.approval, permissionRequest, effectiveRoleRequest, effectiveParticipantChange, participantRequest, toolPermissionRequest);
  const displayPrompt = rosterApproval ? rosterApprovalQuestion(props.approval, added) : approvalPrompt;

  if (reviewChange && readOnly) {
    return (
      <section className={`chat-app-tool-approval-card is-review-change is-compact-result is-${props.approval.status}`} aria-label={displayPrompt}>
        <Avatar className="message-avatar chat-app-tool-approval-avatar" spec={requesterAvatar} />
        <div className="chat-app-tool-approval-body">
          <div className="chat-app-tool-approval-meta">
            <strong>{requesterLabel}</strong>
            {requester && <span className="message-provider">Proposed changes</span>}
            <span className="message-when">{formatChatTime(props.approval.createdAt)}</span>
          </div>
          <ChatAppToolReviewResult
            approval={props.approval}
            roleRequest={combinedRequest?.roleRequest ?? roleRequest}
            participantChange={combinedRequest?.participantRequest ?? participantChange}
            combinedRequest={combinedRequest}
            savedParticipants={props.savedParticipants}
          />
        </div>
      </section>
    );
  }

  function submit(): void {
    if (readOnly) {
      return;
    }
    const option = options[Math.min(selectedIndex, options.length - 1)];
    if (option) {
      const draftOverride = option.approve
        ? effectiveCombinedRequest ?? effectiveRoleRequest ?? effectiveParticipantChange
        : undefined;
      void props.onRespond(props.approval.id, option.approve, option.scope, draftOverride);
    }
  }

  function approveReviewChange(): void {
    if (readOnly) {
      return;
    }
    const option = options.find((item) => item.approve);
    if (!option) {
      return;
    }
    void props.onRespond(
      props.approval.id,
      true,
      option.scope,
      effectiveCombinedRequest ?? effectiveRoleRequest ?? effectiveParticipantChange
    );
  }

  function handleOptionsKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (props.submitting) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) => Math.min(options.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) => Math.max(0, index - 1));
    } else if (/^[1-9]$/.test(event.key)) {
      const next = Number(event.key) - 1;
      if (next < options.length) {
        event.preventDefault();
        setSelectedIndex(next);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  }

  return (
    <section className={`chat-app-tool-approval-card ${rosterApproval ? "is-roster-request" : ""} ${reviewChange ? "is-review-change" : ""} is-${props.approval.status}`} aria-label={displayPrompt}>
      <Avatar className="message-avatar chat-app-tool-approval-avatar" spec={requesterAvatar} />
      <div className="chat-app-tool-approval-body">
        <div className="chat-app-tool-approval-meta">
          <strong>{requesterLabel}</strong>
          {requester && <span className="message-provider">{reviewChange ? "Proposes changes for your approval" : participantProviderLabel(requester.kind)}</span>}
          <span className="message-when">{formatChatTime(props.approval.createdAt)}</span>
        </div>
        <div className={`chat-app-tool-approval-panel ${rosterApproval ? "is-roster-request" : ""} ${reviewChange ? "is-review-change" : ""}`}>
          {rosterApproval && <div className="chat-app-tool-approval-eyebrow">Member request</div>}
          {reviewChange && (
            <div className="chat-app-tool-review-header">
              <div className="chat-app-tool-review-chip">
                <Sparkles size={13} aria-hidden />
                {effectiveCombinedRequest ? "Role + member" : effectiveRoleRequest ? roleReviewChipLabel(effectiveRoleRequest) : participantReviewChipLabel(effectiveParticipantChange)}
              </div>
            </div>
          )}
          {!reviewChange && <h3>{rosterApproval ? <RosterApprovalTitle requesterHandle={props.approval.requesterHandle} added={added} /> : displayPrompt}</h3>}
          {readOnly && <ChatAppToolReviewStatus approval={props.approval} />}
          <fieldset className="chat-app-tool-review-fieldset" disabled={props.submitting}>
          {permissionRequest ? (
            <ChatAppToolPermissionOperation request={permissionRequest} />
          ) : toolPermissionRequest ? (
            <ChatAppToolPermissionPromptOperation request={toolPermissionRequest} />
          ) : effectiveCombinedRequest ? (
            <div className="chat-app-tool-review-stack">
              <ChatAppToolRoleChangeOperation
                request={effectiveCombinedRequest.roleRequest}
                roles={props.roles}
                savedParticipants={props.savedParticipants}
                onChange={(nextRoleRequest) => {
                  setRoleDraft(nextRoleRequest);
                  setCombinedDraft((current) => ({
                    ...(current ?? effectiveCombinedRequest),
                    roleRequest: nextRoleRequest
                  }));
                }}
              />
              <div className="chat-app-tool-review-dependency">This member will use the new role.</div>
              <ChatAppToolParticipantChangeOperation
                request={effectiveCombinedRequest.participantRequest}
                roles={[...props.roles, ...temporaryRolesForReview(effectiveCombinedRequest.roleRequest)]}
                savedParticipants={props.savedParticipants}
                onChange={(nextParticipantRequest) => {
                  setParticipantDraft(nextParticipantRequest);
                  setCombinedDraft((current) => ({
                    ...(current ?? effectiveCombinedRequest),
                    participantRequest: nextParticipantRequest
                  }));
                }}
              />
            </div>
          ) : effectiveRoleRequest ? (
            <ChatAppToolRoleChangeOperation
              request={effectiveRoleRequest}
              roles={props.roles}
              savedParticipants={props.savedParticipants}
              onChange={setRoleDraft}
            />
          ) : effectiveParticipantChange ? (
            <ChatAppToolParticipantChangeOperation
              request={effectiveParticipantChange}
              roles={props.roles}
              savedParticipants={props.savedParticipants}
              onChange={setParticipantDraft}
            />
          ) : participantRequest ? (
            <ChatAppToolParticipantRequestOperation request={participantRequest} requesterHandle={props.approval.requesterHandle} />
          ) : (
            <div className="chat-app-tool-roster-list">
              {added.map((operation, index) => (
                <ChatAppToolRosterOperation operation={operation} roles={props.roles} key={`${operation.participant.handle}-${index}`} />
              ))}
            </div>
          )}
          </fieldset>
          {approvalReason(props.approval, effectiveCombinedRequest) && !effectiveRoleRequest && (
            <div className="chat-app-tool-approval-reason">
              <MarkdownText content={approvalReason(props.approval, effectiveCombinedRequest) ?? ""} />
            </div>
          )}
          {rosterApproval && <ChatAppToolRosterPermissionEnvelope operations={added} />}
          {permissionRequest && (
            <p className="chat-app-tool-scope-note">
              Applies only to {requesterLabel}. Allow once expires after the next run; chat grants stay enabled for this member in this chat.
            </p>
          )}
          {toolPermissionRequest && (
            <p className="chat-app-tool-scope-note">
              Applies only to {requesterLabel}. Allow once approves this blocked call; chat grants apply to future {toolPermissionRequest.toolName} calls from this member in this chat.
            </p>
          )}
          {participantRequest && (
            <p className="chat-app-tool-scope-note">
              Approval runs the requested member{participantRequest.requests.length === 1 ? "" : "s"} and then returns to {requesterLabel} after replies or errors. {inferredParticipantRequest ? "Inferred requests are approved one time." : "Chat grants apply only to this requester and target set."}
            </p>
          )}
          {reviewChange && readOnly ? null : reviewChange ? (
            <ChatAppToolReviewFooter
              primaryLabel={reviewPrimaryLabel(effectiveRoleRequest, effectiveParticipantChange, effectiveCombinedRequest)}
              submitting={props.submitting}
              onCancel={() => void props.onRespond(props.approval.id, false)}
              onApprove={approveReviewChange}
            />
          ) : (
            <>
              <div
                className="chat-approval-options"
                role="listbox"
                tabIndex={0}
                aria-label="Approval options"
                onKeyDown={handleOptionsKeyDown}
              >
                {options.map((option, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                className={`chat-approval-option ${index === selectedIndex ? "selected" : ""}`}
                disabled={props.submitting}
                onClick={() => setSelectedIndex(index)}
                key={option.key}
              >
                <span className="chat-approval-option-num">{index + 1}.</span>
                <span className="chat-approval-option-label">{option.label}</span>
                {index === selectedIndex && (
                  <span className="chat-approval-option-keys" aria-hidden>
                    <ArrowUp size={16} />
                    <ArrowDown size={16} />
                  </span>
                )}
              </button>
                ))}
              </div>
              <div className="chat-approval-footer">
                <button
                  type="button"
                  className="chat-approval-skip"
                  disabled={props.submitting}
                  onClick={() => void props.onRespond(props.approval.id, false)}
                >
                  Skip
                </button>
                <Button variant="default" size="sm" className="chat-approval-submit" disabled={props.submitting} onClick={submit}>
                  <span>Submit</span>
                  <CornerDownLeft size={14} aria-hidden />
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
