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

export function isOpenUrgentAlert(alert: Pick<UrgentAlertView, "state">): boolean {
  return alert.state === "waiting" || alert.state === "calling";
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

// --- what a card says (the computer and the phone show the same lines) ---

export function urgentAlertClock(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function left(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} left`;
}

export type UrgentAlertLine = { key: string; tone: "ok" | "wait" | "bad" | "plain"; text: string; at?: string };

/** What happened so far, one line each, as the server keeps it. */
export function urgentAlertLines(alert: UrgentAlertView, requester: string, now: number): UrgentAlertLine[] {
  const lines: UrgentAlertLine[] = [];
  if (alert.state === "not_set_up") {
    lines.push({ key: "setup", tone: "bad", text: `Alerts aren't set up, so ${requester} couldn't reach you outside the app.` });
    return lines;
  }
  if (alert.telegram?.sentAt) lines.push({ key: "telegram", tone: "ok", text: "Sent to Telegram", at: urgentAlertClock(alert.telegram.sentAt) });
  else if (alert.telegram?.error) lines.push({ key: "telegram", tone: "bad", text: `Telegram didn't take it: ${alert.telegram.error}` });
  if (alert.state === "failed") lines.push({ key: "failed", tone: "bad", text: "No phone is connected, so it reached you only here." });
  alert.calls.forEach((call) => lines.push(callLine(call, alert)));
  if (isOpenUrgentAlert(alert) && alert.callAt) {
    const due = Date.parse(alert.callAt);
    const again = alert.calls.length > 0;
    lines.push({
      key: "next",
      tone: "wait",
      text: `${again ? "Calling again" : "Calling you"} at ${urgentAlertClock(alert.callAt)} unless you press Got it`,
      at: Number.isFinite(due) ? left(due - now) : undefined
    });
  }
  if (alert.state === "acknowledged") {
    const how = alert.ackSource === "telegram" ? "You pressed Got it"
      : alert.ackSource === "app" ? "Closed in the app"
      : alert.callMode === "keypad" ? "You pressed 1 on the call" : "You answered the call";
    lines.push({ key: "ack", tone: "ok", text: how, at: urgentAlertClock(alert.ackedAt) });
    if (alert.phone && alert.calls.length === 0) lines.push({ key: "nocall", tone: "plain", text: "No call" });
  }
  if (alert.state === "unanswered") {
    lines.push({ key: "unanswered", tone: "bad", text: `Called you ${alert.calls.length} times with no answer` });
  }
  return lines;
}

function callLine(call: UrgentAlertCall, alert: UrgentAlertView): UrgentAlertLine {
  const of = `call ${call.attempt} of ${URGENT_ALERT_CALL_ATTEMPTS}`;
  const at = urgentAlertClock(call.startedAt);
  if (call.error) return { key: `call-${call.attempt}`, tone: "bad", text: `Couldn't place ${of}: ${call.error}`, at };
  switch (call.status) {
    case "queued":
    case "initiated":
    case "ringing":
    case "in-progress":
      return { key: `call-${call.attempt}`, tone: "wait", text: `Calling you now (${of})`, at };
    case "completed":
      return {
        key: `call-${call.attempt}`,
        tone: alert.state === "acknowledged" && alert.ackSource === "call" ? "ok" : "plain",
        text: alert.state === "acknowledged" && alert.ackSource === "call" ? `Called you (${of})` : `Called you (${of}): 1 wasn't pressed`,
        at
      };
    case "busy":
      return { key: `call-${call.attempt}`, tone: "plain", text: `Called you (${of}): busy`, at };
    case "canceled":
      return { key: `call-${call.attempt}`, tone: "plain", text: `Call ${call.attempt} stopped`, at };
    default:
      return { key: `call-${call.attempt}`, tone: "plain", text: `Called you (${of}): no answer`, at };
  }
}
