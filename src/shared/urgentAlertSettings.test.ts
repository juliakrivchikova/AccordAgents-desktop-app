import assert from "node:assert/strict";
import test from "node:test";
import {
  alertsBand, alertsCallMinutes, alertsDialogTestLine, alertsFlowChannels, alertsIntroCall, alertsPhoneStatus, alertsPhoneTesting, alertsPhoneTestLine, alertsTelegramStatus, alertsTelegramTestLine, alertsWaitChoices, alertsWhen
} from "./urgentAlertSettings";
import type { UrgentAlertSettingsView } from "./urgentAlerts";

const base: UrgentAlertSettingsView = { waitMinutes: 5, callMode: "keypad" };
const telegram = { botUsername: "svetlana_accord_bot", chatName: "Svetlana", connected: true };
const phone = { from: "+14155550134", to: "+35799123342", trial: false };
const now = new Date(2026, 10, 15, 14, 30);
const today = new Date(2026, 10, 15, 14, 2).toISOString();

test("the band answers whether an alert reaches her now, the worst first", () => {
  assert.deepEqual(alertsBand(base), { kind: "off", title: "Alerts are off", detail: "An alert stays in the chat; nothing reaches you outside the app." });
  assert.equal(alertsBand({ ...base, telegram, phone }).kind, "ok");
  assert.equal(alertsBand({ ...base, telegram, phone }).title, "Alerts will reach you");

  // A broken channel is never shown as working, and says what still does.
  const broken = alertsBand({ ...base, telegram: { ...telegram, error: "Telegram no longer accepts this bot's token. Connect Telegram again." }, phone });
  assert.deepEqual([broken.kind, broken.title, broken.action], ["bad", "Telegram isn't delivering alerts", "reconnect-telegram"]);
  assert.match(broken.detail, /token\. Connect Telegram again\. Calls still work\.$/);
  const calls = alertsBand({ ...base, telegram, phone: { ...phone, error: "Twilio no longer accepts these keys" } });
  assert.deepEqual([calls.kind, calls.action, calls.detail], ["bad", "reconnect-phone", "Twilio no longer accepts these keys. Telegram still works."]);

  // The server inside the app: the limit is on top, with a way out.
  const inside = alertsBand({ ...base, telegram, phone, callMode: "answer", embedded: true });
  assert.deepEqual([inside.kind, inside.action], ["warn", "set-up-server"]);
  assert.match(inside.detail, /Answering the call counts as Got it, even voicemail\.$/);
  assert.doesNotMatch(alertsBand({ ...base, telegram, embedded: true }).detail, /call/, "no call to speak of without a phone");
  // Her own server that Twilio cannot reach.
  assert.equal(alertsBand({ ...base, telegram, phone, callMode: "answer" }).title, "Answering the call counts as Got it");

  assert.equal(alertsBand({ ...base, telegram }).title, "Alerts reach you in Telegram only");
  assert.equal(alertsBand({ ...base, phone, waitMinutes: 10 }).detail, "The first call comes 10 min after an alert. Connect Telegram to get the message at once.");
  // A bot not finished yet does not count as Telegram.
  assert.equal(alertsBand({ ...base, telegram: { botUsername: "x", connected: false, step: "start" } }).kind, "off");
});

test("each channel's status, never Ready beside an error or before a call reached her", () => {
  assert.equal(alertsTelegramStatus(base), "not-set-up");
  assert.equal(alertsTelegramStatus({ telegram: { botUsername: "x", connected: false, step: "start" } }), "not-finished");
  assert.equal(alertsTelegramStatus({ telegram: { ...telegram, error: "revoked" } }), "attention");
  assert.equal(alertsTelegramStatus({ telegram }), "ready");

  assert.equal(alertsPhoneStatus(base), "not-set-up");
  assert.equal(alertsPhoneStatus({ phone }), "not-tested");
  assert.equal(alertsPhoneStatus({ phone: { ...phone, lastTest: { state: "no-answer", at: today } } }), "not-tested");
  assert.equal(alertsPhoneStatus({ phone: { ...phone, lastTest: { state: "pressed", at: today } } }), "ready");
  assert.equal(alertsPhoneStatus({ phone: { ...phone, lastTest: { state: "answered", at: today } } }), "ready");
  assert.equal(alertsPhoneStatus({ phone: { ...phone, error: "keys", lastTest: { state: "pressed", at: today } } }), "attention");
});

test("the last test of each channel, in words", () => {
  assert.equal(alertsTelegramTestLine({ telegram: { ...telegram, lastTest: { at: today, gotIt: true } } }, now), `Tested ${alertsWhen(today, now)} · you pressed Got it`);
  assert.match(alertsTelegramTestLine({ telegram: { ...telegram, lastTest: { at: today, gotIt: false } } }, now) ?? "", /^Test message sent today .* · press Got it on it$/);
  assert.equal(alertsTelegramTestLine({ telegram: { ...telegram, connected: false, lastTest: { at: today, gotIt: true } } }, now), undefined);

  const line = (state: "calling" | "pressed" | "not-pressed" | "failed", error?: string) =>
    alertsPhoneTestLine({ callMode: "keypad", phone: { ...phone, lastTest: { state, at: today, ...(error ? { error } : {}) } } }, now);
  assert.equal(alertsPhoneTestLine({ callMode: "keypad", phone }, now), "Not tested yet");
  const ringingNow = new Date(2026, 10, 15, 14, 29).toISOString();
  assert.equal(alertsPhoneTestLine({ callMode: "keypad", phone: { ...phone, lastTest: { state: "calling", at: ringingNow } } }, now), "Calling you now…");
  // A "calling" nobody finished (the server stopped mid-call) ends on its own.
  const old = new Date(2026, 10, 15, 14, 20).toISOString();
  const stuck = { callMode: "keypad" as const, phone: { ...phone, lastTest: { state: "calling" as const, at: old } } };
  assert.equal(alertsPhoneTesting(stuck, now), false);
  assert.match(alertsPhoneTestLine(stuck, now) ?? "", /its result never came\. Call again$/);
  assert.equal(alertsPhoneTesting({ phone: { ...phone, lastTest: { state: "calling", at: new Date(2026, 10, 15, 14, 29).toISOString() } } }, now), true);
  assert.match(line("pressed") ?? "", /^Tested today .* · you pressed 1$/);
  assert.match(line("not-pressed") ?? "", /you picked up, but 1 wasn't pressed$/);
  assert.match(line("failed", "Twilio: The number is unverified.") ?? "", /failed: Twilio: The number is unverified\.$/);
});

test("call times and wait choices", () => {
  assert.deepEqual(alertsCallMinutes(5), [5, 8, 11]);
  assert.deepEqual(alertsCallMinutes(1), [1, 4, 7]);
  assert.deepEqual(alertsWaitChoices(5), [1, 2, 3, 5, 10, 15, 20, 30, 45, 60]);
  assert.deepEqual(alertsWaitChoices(7).slice(0, 5), [1, 2, 3, 5, 7], "a saved wait outside the list is still offered");
  assert.match(alertsWhen(new Date(2026, 10, 14, 9, 10).toISOString(), now), /^yesterday /);
  assert.equal(alertsWhen("nope", now), "");
});

test("the flow, the first sentence and the dialog's test line say what is true now", () => {
  assert.deepEqual(alertsFlowChannels({ telegram, phone }), { telegram: "ready", phone: "ready" });
  assert.deepEqual(alertsFlowChannels({ telegram: { ...telegram, error: "revoked" }, phone: { ...phone, error: "keys" } }), { telegram: "broken", phone: "broken" });
  assert.deepEqual(alertsFlowChannels({ telegram: { botUsername: "x", connected: false, step: "start" } }), { telegram: "not-finished", phone: "none" });
  assert.equal(alertsIntroCall({ callMode: "keypad" }), "press 1 on the call for Got it.");
  assert.equal(alertsIntroCall({ callMode: "answer" }), "answering the call counts as Got it.");
  assert.equal(alertsDialogTestLine(undefined, "+35799123342", true), "We call your phone; press 1 when you hear it.");
  assert.equal(alertsDialogTestLine({ state: "calling", at: today }, "+35799123342", false), "Calling +35799123342… Answer it.");
  assert.match(alertsDialogTestLine({ state: "pressed", at: today }, "x", true), /^You pressed 1 at .*\. Calls work\.$/);
  assert.equal(alertsDialogTestLine({ state: "failed", at: today, error: "Twilio: The number is unverified." }, "x", true), "The call didn't go through: Twilio: The number is unverified. Call again?");
  assert.equal(alertsDialogTestLine({ state: "no-answer", at: today }, "x", true), "Nobody answered. Call again?");
});
