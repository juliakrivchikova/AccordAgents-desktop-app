/**
 * What Settings → Alerts says about each state, as the User approved it on
 * 2026-11-15 (five reviews, mockup "Settings → Alerts · new page"): one line
 * on top that answers "will an alert reach me now", a status beside each
 * channel's name that never says Ready next to an error, and the last test
 * of each channel. Worded here so tests pin it; the page only draws it.
 */

import {
  URGENT_ALERT_CALL_ATTEMPTS,
  URGENT_ALERT_CALL_RETRY_MS,
  URGENT_ALERT_TEST_STALE_MS,
  urgentAlertPhoneTestPassed,
  type UrgentAlertPhoneTest,
  type UrgentAlertSettingsView
} from "./urgentAlerts";

export type AlertsBandKind = "ok" | "bad" | "warn" | "off" | "partial";

export interface AlertsBand {
  kind: AlertsBandKind;
  title: string;
  detail: string;
  action?: "reconnect-telegram" | "reconnect-phone" | "set-up-server";
}

export type AlertsChannelStatus = "ready" | "attention" | "not-finished" | "not-set-up" | "not-tested";

export const ALERTS_STATUS_LABEL: Record<AlertsChannelStatus, string> = {
  ready: "Ready",
  attention: "Needs attention",
  "not-finished": "Not finished",
  "not-set-up": "Not set up",
  "not-tested": "Not tested"
};

export function alertsTelegramStatus(view: Pick<UrgentAlertSettingsView, "telegram">): AlertsChannelStatus {
  const telegram = view.telegram;
  if (!telegram) return "not-set-up";
  if (telegram.error) return "attention";
  return telegram.connected ? "ready" : "not-finished";
}

export function alertsPhoneStatus(view: Pick<UrgentAlertSettingsView, "phone" | "callMode">): AlertsChannelStatus {
  const phone = view.phone;
  if (!phone) return "not-set-up";
  if (phone.error) return "attention";
  return urgentAlertPhoneTestPassed(phone.lastTest, view.callMode) ? "ready" : "not-tested";
}

/** The one line on top: what reaches her now, the worst first. */
export function alertsBand(view: UrgentAlertSettingsView): AlertsBand {
  const telegram = view.telegram;
  const phone = view.phone;
  const telegramWorks = Boolean(telegram?.connected && !telegram.error);
  const phoneWorks = Boolean(phone && !phone.error);
  if (telegram?.error) {
    return {
      kind: "bad",
      title: "Telegram isn't delivering alerts",
      detail: `${sentence(telegram.error)}${phoneWorks ? " Calls still work." : ""}`,
      action: "reconnect-telegram"
    };
  }
  if (phone?.error) {
    return {
      kind: "bad",
      title: "Calls aren't going out",
      detail: `${sentence(phone.error)}${telegramWorks ? " Telegram still works." : ""}`,
      action: "reconnect-phone"
    };
  }
  if (!telegramWorks && !phoneWorks) {
    return { kind: "off", title: "Alerts are off", detail: "An alert stays in the chat; nothing reaches you outside the app." };
  }
  if (view.embedded) {
    return {
      kind: "warn",
      title: "Alerts work only while this Mac is awake",
      detail: `Your server runs inside this app: if the Mac sleeps, nothing is sent and nothing rings.${phoneWorks ? " Answering the call counts as Got it, even voicemail." : ""}`,
      action: "set-up-server"
    };
  }
  if (phoneWorks && view.callMode === "answer") {
    return {
      kind: "warn",
      title: "Answering the call counts as Got it",
      detail: "Twilio can't reach your server, so it can't hear 1 on the call. Answering it, even voicemail, counts as Got it."
    };
  }
  if (telegramWorks && !phoneWorks) {
    return { kind: "partial", title: "Alerts reach you in Telegram only", detail: "No call follows. Add a phone call so a missed message still reaches you." };
  }
  if (phoneWorks && !telegramWorks) {
    return {
      kind: "partial",
      title: "Alerts reach you only as a call",
      detail: `The first call comes ${view.waitMinutes} min after an alert. Connect Telegram to get the message at once.`
    };
  }
  return { kind: "ok", title: "Alerts will reach you", detail: "Telegram at once, then a call if you don't press Got it. Works with this Mac closed." };
}

/** How the flow names a channel that does not work right now. */
export type AlertsFlowChannel = "ready" | "broken" | "not-finished" | "none";

export function alertsFlowChannels(view: Pick<UrgentAlertSettingsView, "telegram" | "phone">): { telegram: AlertsFlowChannel; phone: AlertsFlowChannel } {
  const telegram = alertsTelegramStatus(view);
  return {
    telegram: telegram === "ready" ? "ready" : telegram === "attention" ? "broken" : telegram === "not-finished" ? "not-finished" : "none",
    phone: !view.phone ? "none" : view.phone.error ? "broken" : "ready"
  };
}

export const ALERTS_FLOW_CHANNEL_WORD: Record<Exclude<AlertsFlowChannel, "ready">, string> = {
  broken: "not working",
  "not-finished": "not finished",
  none: "not set up"
};

/** The page's first sentence ends with what ends a call: 1, or answering it. */
export function alertsIntroCall(view: Pick<UrgentAlertSettingsView, "callMode">): string {
  return view.callMode === "answer" ? "answering the call counts as Got it." : "press 1 on the call for Got it.";
}

/** A test call in the connect dialog, in words (none before the first). */
export function alertsDialogTestLine(test: UrgentAlertPhoneTest | undefined, to: string, keypad: boolean): string {
  if (!test) return keypad ? "We call your phone; press 1 when you hear it." : "We call your phone; answer it.";
  const at = new Date(test.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  switch (test.state) {
    case "calling": return `Calling ${to}… ${keypad ? "Press 1 when you hear it." : "Answer it."}`;
    case "pressed": return `You pressed 1 at ${at}. Calls work.`;
    case "answered": return keypad ? `You answered at ${at}, but calls now ask for 1. Call again?` : `You answered at ${at}. Calls work.`;
    case "not-pressed": return "You picked up, but 1 wasn't pressed. Call again?";
    case "no-answer": return "Nobody answered. Call again?";
    case "busy": return "The line was busy. Call again?";
    default: return `The call didn't go through${test.error ? `: ${sentence(test.error)}` : "."} Call again?`;
  }
}

/** Minutes after an alert at which each call comes, if nobody presses Got it. */
export function alertsCallMinutes(waitMinutes: number): number[] {
  const retry = Math.round(URGENT_ALERT_CALL_RETRY_MS / 60_000);
  return Array.from({ length: URGENT_ALERT_CALL_ATTEMPTS }, (_, index) => waitMinutes + index * retry);
}

/** The wait choices, with the saved one among them whatever it is. */
export function alertsWaitChoices(current: number): number[] {
  const choices = new Set([1, 2, 3, 5, 10, 15, 20, 30, 45, 60, current]);
  return [...choices].sort((left, right) => left - right);
}

/** "today 14:02", "yesterday 09:10" or "12 Nov, 14:02". */
export function alertsWhen(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  return `${at.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

export function alertsTelegramTestLine(view: Pick<UrgentAlertSettingsView, "telegram">, now?: Date): string | undefined {
  const test = view.telegram?.connected ? view.telegram.lastTest : undefined;
  if (!test) return undefined;
  const when = alertsWhen(test.at, now);
  return test.gotIt ? `Tested ${when} · you pressed Got it` : `Test message sent ${when} · press Got it on it`;
}

/** A test call still under way (not one whose answer never came). */
export function alertsPhoneTesting(view: Pick<UrgentAlertSettingsView, "phone">, now: Date = new Date()): boolean {
  const test = view.phone?.lastTest;
  return test?.state === "calling" && now.getTime() - Date.parse(test.at) < URGENT_ALERT_TEST_STALE_MS;
}

export function alertsPhoneTestLine(view: Pick<UrgentAlertSettingsView, "phone" | "callMode">, now?: Date): string | undefined {
  const test = view.phone?.lastTest;
  if (!test) return view.phone && !view.phone.error ? "Not tested yet" : undefined;
  const when = alertsWhen(test.at, now);
  switch (test.state) {
    case "calling": return alertsPhoneTesting(view, now) ? "Calling you now…" : `Test ${when}: its result never came. Call again`;
    case "pressed": return `Tested ${when} · you pressed 1`;
    case "answered": return view.callMode === "keypad" ? `Tested ${when} by answering · calls now ask for 1, so test again` : `Tested ${when} · you answered`;
    case "not-pressed": return `Test ${when}: you picked up, but 1 wasn't pressed`;
    case "no-answer": return `Test ${when}: no answer`;
    case "busy": return `Test ${when}: the line was busy`;
    default: return `Test ${when} failed${test.error ? `: ${test.error}` : ""}`;
  }
}

/** A server's sentence, ending in one full stop. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
