import { URGENT_ALERT_CALL_ATTEMPTS, type UrgentAlertError } from "../../shared/urgentAlerts";
import { keypadTwiml, readOutTwiml } from "../alertChannels";
import type { AlertRecord, StoredSettings } from "./types";

/** What Telegram shows for an alert as it stands. */
export function telegramText(record: Pick<AlertRecord, "view" | "requester" | "chatTitle" | "text"> & Pick<Partial<AlertRecord>, "announcedAs">, settings: Pick<StoredSettings, "waitMinutes">): string {
  const view = record.view;
  const done = view.state === "acknowledged";
  const who = record.announcedAs ?? record.requester;
  const head = `${done ? "✅" : "🔴"} Urgent alert${who ? ` · ${who}` : ""}${record.chatTitle ? ` · ${record.chatTitle}` : ""}`;
  const calls = view.calls.length;
  let footer = "";
  if (done) {
    footer = view.ackSource === "telegram" ? "You pressed Got it."
      : view.ackSource === "app" ? "Closed in the app."
      : view.callMode === "keypad" ? "You pressed 1 on the call." : "You answered the call.";
  } else if (view.state === "waiting" && view.phone) {
    footer = `I'll call you in ${settings.waitMinutes} min unless you press Got it.`;
  } else if (view.state === "calling") {
    footer = view.callAt
      ? `📞 No answer. Calling again in a few minutes (call ${calls + 1} of ${URGENT_ALERT_CALL_ATTEMPTS}). Press Got it to stop.`
      : `📞 Calling you now (call ${calls} of ${URGENT_ALERT_CALL_ATTEMPTS}). Press Got it to stop.`;
  } else if (view.state === "unanswered") {
    footer = `📞 Called you ${calls} times with no answer. Press Got it when you see this.`;
  }
  return `${head}\n\n${record.text}${footer ? `\n\n${footer}` : ""}`;
}

/** Twilio takes at most 4000 characters of TwiML in a call request: a long
 *  message (escaped, read twice) is cut rather than the call refused. */
const TWIML_MAX_CHARS = 3_900;

export function callTwiml(mode: "keypad" | "answer", spoken: string, keypadUrl: string): string {
  const build = (text: string) => mode === "keypad" ? keypadTwiml(text, keypadUrl) : readOutTwiml(text);
  let text = spoken;
  let twiml = build(text);
  while (twiml.length > TWIML_MAX_CHARS && text.length > 80) {
    text = `${text.slice(0, Math.floor(text.length * 0.8)).trimEnd()}…`;
    twiml = build(text);
  }
  return twiml;
}

export function failure(code: UrgentAlertError["code"], message: string): { ok: false; error: UrgentAlertError } {
  return { ok: false, error: { code, message } };
}

export function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export function quote(value: string): string {
  if (value.includes("\u0000")) throw new Error("A value with a NUL character cannot be stored.");
  return `'${value.replace(/'/g, "''")}'`;
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
