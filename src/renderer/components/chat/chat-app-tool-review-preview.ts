import type {
  ChatAppToolApproval,
  ChatParticipantChangeRequest,
  ChatRoleChangeRequest
} from "../../../shared/types";
import { chatParticipantReference } from "../conversation/conversation-display";
import { handleListText } from "./chat-app-tool-member-removal";

/** What a settled role or member card was about, read from its request: an
 *  approved card's request is what was applied, with the User's edits to a
 *  handle or a role name, while its summary is what the member first asked
 *  for. Worded as that summary is (ChatService), which stays the fallback
 *  where the request does not name it (a deleted role). */
export function reviewResultPreview(
  approval: ChatAppToolApproval,
  roleRequest: ChatRoleChangeRequest | undefined,
  participantChange: ChatParticipantChangeRequest | undefined,
  /** The sessions view names no handles: members added are counted. */
  sessions = false
): string {
  const parts = [
    roleRequest ? rolePreview(roleRequest) : null,
    participantChange ? (sessions ? `Add ${participantChange.operations.length === 1 ? "a member" : `${participantChange.operations.length} members`}` : participantPreview(participantChange)) : null
  ].filter((part) => part !== null);
  return parts.length > 0 && parts.every(Boolean) ? parts.join("; ") : approval.summary;
}

function rolePreview(request: ChatRoleChangeRequest): string | undefined {
  if (request.operations.length !== 1) {
    return request.operations.length > 1 ? `Apply ${request.operations.length} role changes` : undefined;
  }
  const operation = request.operations[0];
  if (operation.type === "archive_role") {
    return undefined;
  }
  return `${operation.type === "create_role" ? "Create" : "Edit"} role "${operation.role.label}"`;
}

/** A saved member is added under the handle it had then, which its card
 *  cannot change: the summary names it, and a saved member renamed since
 *  must not rename the line. Only new members' handles are hers to edit. */
function participantPreview(request: ChatParticipantChangeRequest): string | undefined {
  const handles: string[] = [];
  for (const operation of request.operations) {
    if (operation.type === "add_existing_participant_to_chat") {
      return undefined;
    }
    handles.push(chatParticipantReference(operation.participant.handle));
  }
  return handles.length > 0 ? `Add ${handleListText(handles)}` : undefined;
}
