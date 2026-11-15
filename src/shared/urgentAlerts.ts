/**
 * Urgent alerts: a member that watches something for the User (a deployment,
 * a long job) reaches her outside the app when it goes wrong. The User's
 * server sends the member's message to her Telegram with a Got it button;
 * if nobody reacts in time it calls her phone (Twilio) and reads it out, up
 * to three calls. Got it in Telegram, 1 on the call, or closing the alert in
 * the app (computer or phone) ends it.
 *
 * The server owns every alert and writes its card into the chat itself (a
 * member's message carrying `metadata.urgentAlert`), so every device shows
 * the same state, with the computer closed too. This file is the wire format
 * the computer, machines, the server and the phone share; the phone bundles
 * it, so nothing here may import Node modules.
 */

export const HUB_ALERTS_PATH = "/v3/alerts";
/** Twilio posts the key pressed on a call here (no device signature: the
 *  request is signed by Twilio with the account's auth token instead). */
export const HUB_ALERTS_TWILIO_PATH = "/v1/alerts/twilio";

/** The writer the server's own messages carry (HUB_SERVER_WRITER on the
 *  server): only such a message shows as an alert's card. */
export const URGENT_ALERT_SERVER_WRITER = "server";

export const URGENT_ALERT_MESSAGE_MAX_CHARS = 1_000;
export const URGENT_ALERT_DEFAULT_WAIT_MINUTES = 5;
export const URGENT_ALERT_WAIT_MINUTES_MIN = 1;
export const URGENT_ALERT_WAIT_MINUTES_MAX = 60;
/** Calls in all when 1 is not pressed: the first and two more. */
export const URGENT_ALERT_CALL_ATTEMPTS = 3;
export const URGENT_ALERT_CALL_RETRY_MS = 3 * 60_000;
/** How long a call rings before Twilio gives up on it. */
export const URGENT_ALERT_RING_SECONDS = 30;

export type UrgentAlertState =
  /** Sent; waiting for a reaction until the first call. */
  | "waiting"
  /** A call rings, or the next one is due shortly. */
  | "calling"
  | "acknowledged"
  /** Three calls went without a reaction. */
  | "unanswered"
  /** Nothing is connected: the alert stayed in the chat. */
  | "not_set_up"
  /** Telegram refused it and no phone is connected. */
  | "failed";

export type UrgentAlertAckSource = "telegram" | "call" | "app";

export type UrgentAlertCallStatus =
  | "queued" | "initiated" | "ringing" | "in-progress"
  | "completed" | "busy" | "no-answer" | "failed" | "canceled";

export interface UrgentAlertCall {
  attempt: number;
  startedAt: string;
  status: UrgentAlertCallStatus;
  endedAt?: string;
  /** The call could not be placed (Twilio refused it). */
  error?: string;
}

/** An alert as every device shows it (`ChatMessageMetadata.urgentAlert`). */
export interface UrgentAlertView {
  id: string;
  state: UrgentAlertState;
  createdAt: string;
  telegram?: { sentAt?: string; error?: string };
  /** When the next call is placed while the alert waits for a reaction. */
  callAt?: string;
  calls: UrgentAlertCall[];
  ackedAt?: string;
  ackSource?: UrgentAlertAckSource;
  /** Whether a call would follow (a phone is connected). */
  phone: boolean;
  /** "keypad": 1 confirms on the call; "answer": answering it does (no
   *  server Twilio can reach, so it cannot tell which key was pressed). */
  callMode: "keypad" | "answer";
  /** Closed in the app: the card folds away on every device. */
  closedAt?: string;
}

/** States in which a call may still come; the server and every card agree. */
export const URGENT_ALERT_OPEN_STATES: readonly UrgentAlertState[] = ["waiting", "calling"];

export function isOpenUrgentAlert(alert: Pick<UrgentAlertView, "state">): boolean {
  return URGENT_ALERT_OPEN_STATES.includes(alert.state);
}

// --- settings ---------------------------------------------------------------

/** What the computer sees of the alert settings: never a key. */
export interface UrgentAlertSettingsView {
  telegram?: {
    botUsername: string;
    /** Who pressed Start (the chat alerts go to); absent until then. */
    chatName?: string;
    connected: boolean;
    /** Waiting for Start, or for Got it on the test message. */
    step?: "start" | "test";
    /** The one-time code the bot's Start link carries while it waits for
     *  Start: only that Start connects (not anyone who finds the bot). */
    startCode?: string;
    error?: string;
  };
  phone?: {
    from: string;
    to: string;
    trial: boolean;
    error?: string;
  };
  waitMinutes: number;
  callMode: "keypad" | "answer";
}

export interface UrgentAlertPhoneCheck {
  accountName: string;
  trial: boolean;
  numbers: string[];
}

// --- requests ----------------------------------------------------------------

export type HubAlertRequest =
  /** A member's tool call: the device it runs on asks. */
  | { action: "raise"; conversationId: string; participantId: string; text: string; requestId: string }
  /** The User closes it in the app (her computer, a machine never, a phone). */
  | { action: "close"; alertId: string }
  // The owner's settings (Settings → Alerts).
  | { action: "settings" }
  | { action: "telegram.connect"; token: string }
  | { action: "telegram.disconnect" }
  | { action: "telegram.test" }
  | { action: "phone.check"; accountSid: string; authToken: string }
  | { action: "phone.buy"; accountSid: string; authToken: string }
  | { action: "phone.save"; accountSid: string; authToken: string; from: string; to: string }
  | { action: "phone.test" }
  | { action: "phone.disconnect" }
  | { action: "wait"; minutes: number }
  /** Where Twilio reaches this server (the computer says what it links to;
   *  absent for the server inside the app). */
  | { action: "public-url"; url?: string };

/** What the User's computer asks (never a member's raise). */
export type UrgentAlertUserRequest = Exclude<HubAlertRequest, { action: "raise" } | { action: "public-url" }>;

export const URGENT_ALERT_USER_ACTIONS: ReadonlySet<string> = new Set([
  "close", "settings", "telegram.connect", "telegram.disconnect", "telegram.test",
  "phone.check", "phone.buy", "phone.save", "phone.test", "phone.disconnect", "wait"
]);

export interface UrgentAlertError {
  code: "invalid_request" | "access_denied" | "not_set_up" | "channel_failed" | "server_unavailable";
  message: string;
}

export type HubAlertResult<T> = { ok: true; value: T } | { ok: false; error: UrgentAlertError };

/** What a member's tool call returns. */
export interface UrgentAlertRaised {
  alertId: string;
  messageId: string;
  state: UrgentAlertState;
  telegram: boolean;
  phone: boolean;
}

/** E.164: a plus and 8 to 15 digits. */
export function normalizePhoneNumber(raw: string): string | undefined {
  const digits = raw.replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : undefined;
}

export function maskedPhoneNumber(number: string): string {
  return number.length > 7 ? `${number.slice(0, 4)} ••• ${number.slice(-3)}` : number;
}

// --- what a card says (the computer and the phone show the same words) ---
//
// The card the User approved on 2026-11-15 (five reviews, mockup "Urgent
// alert · new card", header variant 5A): the red header always, the member's
// message, then one status band that answers "what now, and when does my
// phone ring", with what happened before in one grey line under it.

export function urgentAlertClock(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "4:12" until a moment `ms` from now. */
export function urgentAlertCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The status band: its main line (`lead`, then the countdown in bold when a
 *  call is due, then `tail`), a grey line under it, and what the band offers. */
export interface UrgentAlertStatus {
  /** "now": it waits for her; "done": she reacted; "bad": it never reached her. */
  tone: "now" | "done" | "bad";
  icon: "clock" | "ringing" | "sent" | "missed" | "check" | "off" | "failed";
  lead: string;
  /** The next call's moment and the time left until it, while it is ahead. */
  countdown?: { to: string; text: string };
  tail?: string;
  detail?: string;
  /** "got-it" while the alert waits for her (no cross then); "set-up" when it
   *  never left the app. */
  action?: "got-it" | "set-up";
}

/** Whether the alert still waits for her Got it: the card offers the button
 *  and no cross. The server takes Got it in these states (unanswered too). */
export function urgentAlertAwaitsGotIt(alert: Pick<UrgentAlertView, "state">): boolean {
  return alert.state === "waiting" || alert.state === "calling" || alert.state === "unanswered";
}

export function urgentAlertStatus(alert: UrgentAlertView, requester: string, now: number): UrgentAlertStatus {
  const calls = alert.calls ?? [];
  const telegramSent = Boolean(alert.telegram?.sentAt);
  switch (alert.state) {
    case "not_set_up":
      return { tone: "bad", icon: "off", lead: "Not sent outside the app",
        detail: `Alerts aren't set up, so ${requester} could reach you only here.`, action: "set-up" };
    case "failed":
      return { tone: "bad", icon: "failed", lead: "Not sent outside the app",
        detail: `Telegram didn't take it${alert.telegram?.error ? ` (${alert.telegram.error})` : ""} and no phone is connected.`, action: "set-up" };
    case "acknowledged": {
      const at = urgentAlertClock(alert.ackedAt);
      const by = alert.ackSource === "telegram" ? "you pressed it in Telegram"
        : alert.ackSource === "app" ? "you pressed it in the app"
        : alert.callMode === "keypad" ? `you pressed 1 on call ${Math.max(calls.length, 1)}`
        : `you answered call ${Math.max(calls.length, 1)}`;
      // The call she answered is the Got it itself, not history.
      const before = alert.ackSource === "call" ? calls.slice(0, -1) : calls;
      const history = [...historyParts(alert, before)];
      if (alert.phone && calls.length === 0) history.push("No call was made");
      return { tone: "done", icon: "check", lead: `Got it · ${by}${at ? ` at ${at}` : ""}`, detail: joined(history) };
    }
    case "unanswered": {
      const placed = calls.some((call) => !call.error);
      const lead = !placed ? "Couldn't call you · no more calls"
        : `Nobody answered ${calls.length === 1 ? "the call" : `${calls.length} calls`} · no more calls`;
      return { tone: "bad", icon: "missed", lead, detail: joined(historyParts(alert, calls)), action: "got-it" };
    }
    default:
      break;
  }
  // Waiting or calling: it still waits for her.
  const due = alert.callAt ? Date.parse(alert.callAt) : Number.NaN;
  const ringing = calls.find((call) => !call.endedAt && !call.error && RINGING.has(call.status));
  if (!ringing && Number.isFinite(due) && due > now) {
    const countdown = { to: alert.callAt as string, text: urgentAlertCountdown(due - now) };
    if (calls.length === 0) {
      return { tone: "now", icon: "clock", lead: "Calling you in ", countdown,
        detail: telegramSent ? "Sent to Telegram. Got it here or there stops the call." : "Got it here stops the call.", action: "got-it" };
    }
    return { tone: "now", icon: "clock", lead: "Calling again in ", countdown,
      tail: ` · call ${calls.length + 1} of ${URGENT_ALERT_CALL_ATTEMPTS}`, detail: joined(historyParts(alert, calls)), action: "got-it" };
  }
  if (ringing || alert.phone) {
    // Ringing, or its moment came and the server is placing it.
    const attempt = ringing ? ringing.attempt : calls.length + 1;
    return { tone: "now", icon: "ringing", lead: `Calling you now · call ${Math.min(attempt, URGENT_ALERT_CALL_ATTEMPTS)} of ${URGENT_ALERT_CALL_ATTEMPTS}`,
      detail: alert.callMode === "keypad" ? "Answer and press 1, or press Got it here." : "Answer it, or press Got it here.", action: "got-it" };
  }
  // No phone: Telegram is all there is.
  return { tone: "now", icon: "sent", lead: telegramSent ? "Sent to Telegram" : "Waiting for Got it",
    detail: "No phone is connected, so no call will follow.", action: "got-it" };
}

/** A closed card's one line: how it ended. `done` when she reacted. */
export function urgentAlertOutcome(alert: UrgentAlertView): { text: string; done: boolean } {
  if (alert.state === "acknowledged") {
    const at = urgentAlertClock(alert.ackedAt);
    const how = alert.ackSource === "telegram" ? "Got it in Telegram"
      : alert.ackSource === "app" ? "Got it in the app"
      : alert.callMode === "keypad" ? "Got it on the call" : "Answered the call";
    return { text: at ? `${how} ${at}` : how, done: true };
  }
  if (alert.state === "not_set_up" || alert.state === "failed") return { text: "Not sent outside the app", done: false };
  if (alert.state === "unanswered") return { text: "No answer", done: false };
  return { text: "Open", done: false };
}

const RINGING: ReadonlySet<UrgentAlertCallStatus> = new Set(["queued", "initiated", "ringing", "in-progress"]);

/** What happened before now, oldest first: Telegram, then the calls (one
 *  part for all of them when they ended the same way). */
function historyParts(alert: UrgentAlertView, calls: UrgentAlertCall[]): string[] {
  const parts: string[] = [];
  if (alert.telegram?.sentAt) parts.push("Sent to Telegram");
  else if (alert.telegram?.error) parts.push("Telegram didn't take it");
  const ended = calls.filter((call) => call.error || !RINGING.has(call.status) || call.endedAt);
  const outcomes = ended.map((call) => callOutcome(call, alert));
  if (ended.length > 1 && outcomes.every((outcome) => outcome === outcomes[0])) {
    parts.push(`Calls at ${ended.map((call) => urgentAlertClock(call.startedAt)).join(", ")}: ${outcomes[0]}`);
  } else {
    ended.forEach((call, index) => parts.push(`Call ${call.attempt} at ${urgentAlertClock(call.startedAt)}: ${outcomes[index]}`));
  }
  return parts;
}

function callOutcome(call: UrgentAlertCall, alert: UrgentAlertView): string {
  if (call.error) return `couldn't place it (${call.error})`;
  switch (call.status) {
    case "completed": return alert.callMode === "keypad" ? "1 wasn't pressed" : "answered";
    case "busy": return "busy";
    case "canceled": return "stopped";
    case "failed": return "couldn't place it";
    default: return "no answer";
  }
}

function joined(parts: string[]): string | undefined {
  return parts.length ? parts.join(" · ") : undefined;
}

/** A message that is an urgent alert's card: written by the User's server
 *  (a device cannot forge one there) on a member's row. */
export function urgentAlertOfMessage(message: { role?: string; metadata?: { serverWriter?: unknown; urgentAlert?: unknown } }): UrgentAlertView | undefined {
  if (message.role !== "participant" || message.metadata?.serverWriter !== URGENT_ALERT_SERVER_WRITER) return undefined;
  const alert = message.metadata?.urgentAlert as UrgentAlertView | undefined;
  return alert && typeof alert === "object" && typeof alert.id === "string" ? alert : undefined;
}
