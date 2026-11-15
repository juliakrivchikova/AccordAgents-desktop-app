import { BellOff, BellRing, ChevronDown, CircleCheck, Clock, PhoneCall, PhoneMissed, Send, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  urgentAlertAwaitsGotIt, urgentAlertFailureText, urgentAlertOutcome, urgentAlertStatus, type UrgentAlertStatus, type UrgentAlertView
} from "../../../shared/urgentAlerts";
import type { ChatMessage, ChatParticipant } from "../../../shared/types";
import { ChatMessageWhen } from "./chat-streaming";
import { UrgentAlertActionsContext } from "./urgent-alert-context";

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
  const { message, participant } = props;
  // What the server answered to Got it here, shown until its new card comes
  // through the feed (a slow feed must not bring Got it back meanwhile).
  const [answered, setAnswered] = useState<UrgentAlertView | undefined>();
  const alert = answered ?? props.alert;
  const actions = useContext(UrgentAlertActionsContext);
  const requester = participant ? `@${participant.handle}` : message.participantLabel || "A member";
  const [now, setNow] = useState(() => Date.now());
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [expanded, setExpanded] = useState(false);
  const awaiting = urgentAlertAwaitsGotIt(alert);
  const counting = awaiting && Boolean(alert.callAt);
  const folded = Boolean(alert.closedAt) && !awaiting && !expanded;
  // Keyboard focus follows the card when she folds or opens it: the button
  // she pressed is gone, so the one that undoes it takes the focus.
  const card = useRef<HTMLElement>(null);
  const keepFocus = useRef(false);
  useEffect(() => setAnswered(undefined), [props.alert.state, props.alert.closedAt]);
  // A failed Got it holds while the alert still waits for one (a call placed
  // meanwhile changes nothing about it); once it no longer waits, or is
  // closed, it is moot.
  useEffect(() => setError(undefined), [awaiting, alert.closedAt]);
  useEffect(() => {
    if (!counting) return undefined;
    const due = Date.parse(alert.callAt ?? "");
    setNow(Date.now());
    // Ticks until the moment of the call, then stops: past it the card says
    // the call is being placed and waits for the server.
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (!(current < due)) clearInterval(timer);
    }, 1_000);
    return () => clearInterval(timer);
  }, [counting, alert.callAt]);
  useLayoutEffect(() => {
    if (!keepFocus.current) return;
    keepFocus.current = false;
    // Only when the focus was lost with the button: never taken from where
    // she went meanwhile (the composer while the server answered).
    const active = document.activeElement;
    if (active && active !== document.body && !card.current?.contains(active)) return;
    card.current?.querySelector<HTMLElement>(folded ? ".chat-urgent-alert-folded" : ".chat-urgent-alert-close")?.focus({ preventScroll: true });
  }, [folded]);

  function rememberFocus(): void {
    keepFocus.current = Boolean(card.current?.contains(document.activeElement));
  }

  /** Got it, or the cross on a card nobody closed yet: the server closes it
   *  on every device (and takes it as Got it while it waits for one). */
  async function close(): Promise<void> {
    rememberFocus();
    setClosing(true);
    setError(undefined);
    try {
      const result = await window.consensus.urgentAlertRequest({ action: "close", alertId: alert.id });
      if (!result.ok) {
        keepFocus.current = false;
        setError(result.error.message);
      } else {
        setExpanded(false);
        const view = result.value as UrgentAlertView | undefined;
        if (view && typeof view === "object" && view.id === alert.id && typeof view.state === "string") setAnswered(view);
      }
    } catch (failure) {
      keepFocus.current = false;
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setClosing(false);
    }
  }

  if (folded) {
    const outcome = urgentAlertOutcome(alert);
    return (
      <article ref={card} data-message-id={message.id} className="chat-urgent-alert is-folded">
        <button
          type="button"
          className={`chat-urgent-alert-folded${outcome.done ? "" : " is-unresolved"}`}
          aria-expanded={false}
          onClick={() => {
            rememberFocus();
            setExpanded(true);
          }}
        >
          <BellRing className="chat-urgent-alert-folded-bell" size={14} aria-hidden="true" />
          <span className="sr-only">Urgent alert: </span>
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
    <article ref={card} data-message-id={message.id} className="chat-urgent-alert" aria-label={`Urgent alert from ${requester}`}>
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
              onClick={() => {
                if (!folds) return void close();
                rememberFocus();
                setExpanded(false);
              }}
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
            {error && <div className="chat-urgent-alert-error" role="alert">{urgentAlertFailureText(awaiting, error)}</div>}
          </div>
          {status.action === "got-it" && (
            <Button type="button" className={ACTION_CLASSES} disabled={closing} onClick={() => void close()}>
              Got it
            </Button>
          )}
          {status.action === "set-up" && actions && (
            <Button type="button" className={ACTION_CLASSES} onClick={() => actions.openAlertSettings()}>
              Set up alerts
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

/** The band's button: the app's primary button, a little wider and bolder;
 *  while Got it is on its way it stays a dimmed primary, not a grey ghost on
 *  the band's grey. */
const ACTION_CLASSES = "px-[15px] font-semibold disabled:border-[var(--app-primary)] disabled:bg-primary disabled:text-primary-foreground disabled:opacity-50";
