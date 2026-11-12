import { BellRing, Check, Clock, Phone, X } from "lucide-react";
import { useContext, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { isOpenUrgentAlert, urgentAlertLines, type UrgentAlertView } from "../../../shared/urgentAlerts";
import type { ChatMessage, ChatParticipant } from "../../../shared/types";
import { Avatar, avatarForParticipant } from "../avatar/avatar";
import { avatarForChatParticipant } from "./chat-avatars";
import { ChatMessageWhen } from "./chat-streaming";
import { UrgentAlertActionsContext } from "./urgent-alert-context";

/** The alert a message carries, if it is an urgent alert's card. */
export function urgentAlertOf(message: Pick<ChatMessage, "metadata">): UrgentAlertView | undefined {
  const alert = message.metadata?.urgentAlert;
  return alert && typeof alert === "object" && typeof alert.id === "string" ? alert : undefined;
}

/**
 * An urgent alert a member raised (the User, 2026-11-12, design "Urgent
 * alert"): a saturated red header whatever its state, the member's message,
 * and what happened since; the cross closes it, which counts as Got it while
 * a call is still due. Closed, it folds into one line that opens again.
 */
export function ChatUrgentAlertCard(props: {
  message: Pick<ChatMessage, "id" | "content" | "createdAt" | "participantId" | "participantLabel">;
  alert: UrgentAlertView;
  participant?: ChatParticipant;
}): JSX.Element {
  const { message, alert, participant } = props;
  const actions = useContext(UrgentAlertActionsContext);
  const requester = participant ? `@${participant.handle}` : message.participantLabel || "A member";
  const avatar = participant ? avatarForChatParticipant(participant, requester) : avatarForParticipant(requester, message.participantId ?? message.id);
  const [now, setNow] = useState(() => Date.now());
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [expanded, setExpanded] = useState(false);
  const counting = isOpenUrgentAlert(alert) && Boolean(alert.callAt);
  useEffect(() => {
    if (!counting) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [counting]);

  async function close(): Promise<void> {
    setClosing(true);
    setError(undefined);
    try {
      const result = await window.consensus.urgentAlertRequest({ action: "close", alertId: alert.id });
      if (!result.ok) setError(result.error.message);
      else setExpanded(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setClosing(false);
    }
  }

  if (alert.closedAt && !isOpenUrgentAlert(alert) && !expanded) {
    return (
      <article data-message-id={message.id} className="chat-urgent-alert is-folded">
        <button type="button" className="chat-urgent-alert-folded" onClick={() => setExpanded(true)} title="Show the alert">
          <BellRing size={14} aria-hidden="true" />
          <span className="chat-urgent-alert-folded-title">Urgent alert from {requester} · closed</span>
          <span className="chat-urgent-alert-folded-preview">{message.content}</span>
        </button>
      </article>
    );
  }

  const lines = urgentAlertLines(alert, requester, now);
  return (
    <article data-message-id={message.id} className="chat-urgent-alert" aria-label={`Urgent alert from ${requester}`}>
      <Avatar className="message-avatar chat-urgent-alert-avatar" spec={avatar} />
      <div className="chat-urgent-alert-body">
        <div className="chat-urgent-alert-meta">
          <strong>{requester}</strong>
          <span>Urgent alert</span>
          <span><ChatMessageWhen createdAt={message.createdAt} /></span>
        </div>
        <div className="chat-urgent-alert-panel">
          <div className="chat-urgent-alert-head">
            <BellRing className="chat-urgent-alert-bell" size={18} aria-hidden="true" />
            <span className="chat-urgent-alert-title">Urgent alert</span>
            {(!alert.closedAt || isOpenUrgentAlert(alert)) ? (
              <button
                type="button"
                className="chat-urgent-alert-close"
                aria-label={isOpenUrgentAlert(alert) ? "Close alert (no call)" : "Close alert"}
                title={isOpenUrgentAlert(alert) ? "Close: counts as Got it, so no call" : "Close"}
                disabled={closing}
                onClick={() => void close()}
              >
                <X size={18} aria-hidden="true" />
              </button>
            ) : (
              <button type="button" className="chat-urgent-alert-close" aria-label="Fold alert" title="Fold" onClick={() => setExpanded(false)}>
                <X size={18} aria-hidden="true" />
              </button>
            )}
          </div>
          <div className="chat-urgent-alert-text">{message.content}</div>
          {lines.length > 0 && (
            <ul className="chat-urgent-alert-lines">
              {lines.map((line) => (
                <li key={line.key} className={`chat-urgent-alert-line is-${line.tone}`}>
                  {line.tone === "ok" ? <Check size={14} aria-hidden="true" />
                    : line.tone === "wait" ? (line.key.startsWith("call-") ? <Phone size={14} aria-hidden="true" /> : <Clock size={14} aria-hidden="true" />)
                    : <X size={14} aria-hidden="true" />}
                  <span>{line.text}</span>
                  {line.at && <span className="chat-urgent-alert-at">· {line.at}</span>}
                </li>
              ))}
            </ul>
          )}
          {error && <p className="chat-urgent-alert-error">{error}</p>}
          {alert.state === "not_set_up" && actions && (
            <div className="chat-urgent-alert-foot">
              <Button type="button" size="sm" onClick={() => actions.openAlertSettings()}>Set up alerts</Button>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
