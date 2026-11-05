import { useState } from "react";
import { PlugZap } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ChatAppToolApproval, ChatConnectorSignInRequest, ChatParticipant } from "../../../shared/types";
import { connectorSignInHost } from "../../../shared/connectorSignIn";
import { Avatar, avatarForParticipant } from "../avatar/avatar";
import { chatParticipantDisplayName, chatParticipantReference } from "../conversation/conversation-display";
import { avatarForChatParticipant } from "./chat-avatars";
import { formatChatTime } from "./chat-format";

function connectorSignInTitle(handle: string, request: ChatConnectorSignInRequest): string {
  const who = chatParticipantReference(handle);
  return request.action === "sign-in"
    ? `${who} needs you to sign in to ${request.connector}`
    : `${who} can't reach ${request.connector}`;
}

/** What came of an answered card. */
function connectorSignInOutcome(approval: ChatAppToolApproval, request: ChatConnectorSignInRequest): string {
  if (approval.status === "approved") {
    if (!approval.consumedAt) return `Reconnecting ${request.connector}…`;
    return approval.error ?? `Connected to ${request.connector}.`;
  }
  if (approval.status === "denied") return `Not now. ${request.connector} stays as it was.`;
  return "Closed without an answer.";
}

/** The card a member raises when its task needs an MCP server that is not
 *  connected (src/shared/connectorSignIn.ts). Sign in opens the address the
 *  member's CLI gave in the browser; Done tells the member's device to
 *  reconnect the server, Not now declines. */
export function ChatConnectorSignInCard(props: {
  approval: ChatAppToolApproval;
  request: ChatConnectorSignInRequest;
  participants: ChatParticipant[];
  submitting: boolean;
  embedded?: boolean;
  onRespond: (approvalId: string, approve: boolean) => Promise<void>;
}): JSX.Element {
  const { approval, request } = props;
  const requester = props.participants.find((participant) => participant.id === approval.requesterParticipantId);
  const requesterLabel = requester ? chatParticipantDisplayName(requester) : chatParticipantReference(approval.requesterHandle);
  const requesterAvatar = requester
    ? avatarForChatParticipant(requester, requesterLabel)
    : avatarForParticipant(requesterLabel, approval.requesterParticipantId);
  const pending = approval.status === "pending";
  const signIn = request.action === "sign-in" && Boolean(request.authUrl);
  const host = connectorSignInHost(request.authUrl);
  const [opened, setOpened] = useState(false);
  const [openError, setOpenError] = useState<string | undefined>();
  const title = connectorSignInTitle(approval.requesterHandle, request);
  const queuedDecision = approval.machineDecisionPending;

  async function openSignIn(): Promise<void> {
    if (!request.authUrl) return;
    setOpenError(undefined);
    try {
      await window.consensus.openExternal(request.authUrl);
      setOpened(true);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    }
  }

  if (queuedDecision) {
    return (
      <section className="chat-app-tool-approval-card is-compact-result" aria-label={title}
        data-app-tool-approval-id={approval.id} tabIndex={-1}>
        <Avatar className="message-avatar chat-app-tool-approval-avatar" spec={requesterAvatar} />
        <div className="chat-app-tool-approval-body">
          <strong>{queuedDecision.approve ? "Done" : "Not now"}</strong>
          <p>Waiting for machine {queuedDecision.machineName} to confirm.</p>
        </div>
      </section>
    );
  }

  return (
    <section
      className={`chat-app-tool-approval-card is-review-change chat-connector-sign-in-card ${props.embedded ? "is-embedded" : ""} ${pending ? "" : "is-compact-result"} is-${approval.status}`}
      aria-label={title}
      data-app-tool-approval-id={approval.id}
      tabIndex={-1}
    >
      <Avatar className="message-avatar chat-app-tool-approval-avatar" spec={requesterAvatar} />
      <div className="chat-app-tool-approval-body">
        <div className="chat-app-tool-approval-meta">
          <strong>{requesterLabel}</strong>
          <span className="message-provider">{pending ? "Needs a connector" : "Connector"}</span>
          <span className="message-when">{formatChatTime(approval.createdAt)}</span>
        </div>
        <div className="chat-app-tool-approval-panel is-review-change">
          <div className="chat-app-tool-review-header">
            <div className="chat-app-tool-review-chip">
              <PlugZap size={13} aria-hidden />
              {request.connector}
            </div>
          </div>
          <div className="chat-connector-sign-in-content">
            <h3 className="chat-connector-sign-in-title">{title}</h3>
            {pending ? (
              <>
                {approval.cardRefusals?.length ? (
                  <p className="chat-connector-sign-in-error">Your earlier answer was not applied: {approval.cardRefusals[approval.cardRefusals.length - 1].reason}</p>
                ) : null}
                {request.reason && <p className="chat-connector-sign-in-reason">{request.reason}</p>}
                <p className="chat-connector-sign-in-hint">
                  {signIn
                    ? opened
                      ? "Finish signing in in your browser, then press Done."
                      : `Sign in opens ${host ?? "the sign-in page"} in your browser. When you have finished, press Done.`
                    : "It failed to connect. Fix it (start its program, or correct its settings), then press Reconnect."}
                </p>
                {openError && <p className="chat-connector-sign-in-error">{openError}</p>}
              </>
            ) : (
              <p className="chat-connector-sign-in-hint">{connectorSignInOutcome(approval, request)}</p>
            )}
          </div>
          {pending && (
            <div className="chat-app-tool-review-footer">
              <button
                type="button"
                className="chat-app-tool-review-cancel"
                disabled={props.submitting}
                onClick={() => void props.onRespond(approval.id, false)}
              >
                Not now
              </button>
              {signIn && opened && (
                <button type="button" className="chat-app-tool-review-cancel" disabled={props.submitting} onClick={() => void openSignIn()}>
                  Open again
                </button>
              )}
              <Button
                type="button"
                variant="default"
                size="sm"
                className="chat-app-tool-review-submit"
                disabled={props.submitting}
                onClick={() => signIn && !opened ? void openSignIn() : void props.onRespond(approval.id, true)}
              >
                {signIn ? (opened ? "Done" : "Sign in") : "Reconnect"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
