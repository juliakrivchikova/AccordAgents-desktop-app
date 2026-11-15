import { BellOff, BellRing, ChevronDown, CircleCheck, Clock, PhoneCall, PhoneMissed, Send, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { useContext, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  urgentAlertAwaitsGotIt, urgentAlertOfMessage, urgentAlertOutcome, urgentAlertStatus, type UrgentAlertStatus, type UrgentAlertView
} from "../../../shared/urgentAlerts";
import type { ChatMessage, ChatParticipant } from "../../../shared/types";
import { ChatMessageWhen } from "./chat-streaming";
import { UrgentAlertActionsContext } from "./urgent-alert-context";

/** The alert a message carries, if it is an urgent alert's card. */
export function urgentAlertOf(message: Pick<ChatMessage, "metadata" | "role">): UrgentAlertView | undefined {
  // Only a card the User's server wrote (a device cannot forge one there).
  return urgentAlertOfMessage(message);
}

const STATUS_ICONS: Record<UrgentAlertStatus["icon"], LucideIcon> = {
  clock: Clock,
  ringing: PhoneCall,
  sent: Send,
  missed: PhoneMissed,
  check: CircleCheck,
  off: BellOff,
  failed: TriangleAlert
};

/**
 * An urgent alert a member raised, as the User approved it on 2026-11-15
 * (mockup "Urgent alert · new card", variant 5A): the red header whatever its
 * state, the member and the time, the message, then one status band that says
 * what happens now — when the phone rings, or how it ended — with what
 * happened before in one grey line.
 *
 * While the alert waits for her the band offers Got it and the header has no
 * cross; Got it here folds the card into one line. After Got it in Telegram
 * or on the call it stays open with the outcome and a cross that folds it.
 */
export function ChatUrgentAlertCard(props: {
  message: Pick<ChatMessage, "id" | "content" | "createdAt" | "participantId" | "participantLabel">;
  alert: UrgentAlertView;
  participant?: ChatParticipant;
}): JSX.Element {
  const { message, alert, participant } = props;
  const actions = useContext(UrgentAlertActionsContext);
  const requester = participant ? `@${participant.handle}` : message.participantLabel || "A member";
  const [now, setNow] = useState(() => Date.now());
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [expanded, setExpanded] = useState(false);
  const awaiting = urgentAlertAwaitsGotIt(alert);
  const counting = awaiting && Boolean(alert.callAt);
  useEffect(() => {
    if (!counting) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [counting]);

  /** Got it, or the cross on a card nobody closed yet: the server closes it
   *  on every device (and takes it as Got it while it waits for one). */
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

  if (alert.closedAt && !awaiting && !expanded) {
    const outcome = urgentAlertOutcome(alert);
    return (
      <article data-message-id={message.id} className="chat-urgent-alert is-folded">
        <button
          type="button"
          className={`chat-urgent-alert-folded${outcome.done ? "" : " is-unresolved"}`}
          aria-expanded={false}
          aria-label={`Urgent alert from ${requester}: ${outcome.text}. Show it`}
          onClick={() => setExpanded(true)}
        >
          <BellRing className="chat-urgent-alert-folded-bell" size={14} aria-hidden="true" />
          <span className="chat-urgent-alert-folded-preview">{message.content}</span>
          <span className="chat-urgent-alert-folded-outcome">{requester} · {outcome.text}</span>
          <ChevronDown className="chat-urgent-alert-folded-chevron" size={14} aria-hidden="true" />
        </button>
      </article>
    );
  }

  const status = urgentAlertStatus(alert, requester, now);
  const StatusIcon = STATUS_ICONS[status.icon];
  const folds = Boolean(alert.closedAt) && !awaiting;
  return (
    <article data-message-id={message.id} className="chat-urgent-alert" aria-label={`Urgent alert from ${requester}`}>
      <div className="chat-urgent-alert-panel">
        <div className="chat-urgent-alert-head">
          <BellRing className="chat-urgent-alert-bell" size={18} aria-hidden="true" />
          <span className="chat-urgent-alert-title">Urgent alert</span>
          {!awaiting && (
            <button
              type="button"
              className="chat-urgent-alert-close"
              aria-label={folds ? "Fold alert" : "Close alert"}
              aria-expanded={folds ? true : undefined}
              title={folds ? "Fold" : "Close"}
              disabled={closing}
              onClick={() => (folds ? setExpanded(false) : void close())}
            >
              <X size={18} aria-hidden="true" />
            </button>
          )}
        </div>
        {/* Who and when, inside the card above the message (the User, 2026-11-13). */}
        <div className="chat-urgent-alert-from">{requester} · <ChatMessageWhen createdAt={message.createdAt} /></div>
        <div className="chat-urgent-alert-text">{message.content}</div>
        <div className={`chat-urgent-alert-status is-${status.tone}`}>
          <StatusIcon className="chat-urgent-alert-status-icon" size={16} aria-hidden="true" />
          <div className="chat-urgent-alert-status-words">
            <div className="chat-urgent-alert-status-main">
              {status.lead}
              {status.countdown && <strong className="chat-urgent-alert-countdown">{status.countdown.text}</strong>}
              {status.tail}
            </div>
            {status.detail && <div className="chat-urgent-alert-status-detail">{status.detail}</div>}
            {error && <div className="chat-urgent-alert-error" role="alert">{awaiting ? `Not confirmed: ${error}. A call may still come.` : error}</div>}
          </div>
          {status.action === "got-it" && (
            <Button type="button" className="chat-urgent-alert-action" disabled={closing} onClick={() => void close()}>
              Got it
            </Button>
          )}
          {status.action === "set-up" && actions && (
            <Button type="button" className="chat-urgent-alert-action" onClick={() => actions.openAlertSettings()}>
              Set up alerts
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}
