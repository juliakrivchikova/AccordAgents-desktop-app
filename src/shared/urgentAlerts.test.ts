import assert from "node:assert/strict";
import test from "node:test";
import {
  URGENT_ALERT_ACKNOWLEDGEABLE_STATES, maskedPhoneNumber, normalizePhoneNumber, urgentAlertAwaitsGotIt, urgentAlertClock, urgentAlertCountdown,
  urgentAlertFailureText, urgentAlertOfMessage, urgentAlertOutcome, urgentAlertStatus, type UrgentAlertState, type UrgentAlertView
} from "./urgentAlerts";

const base: UrgentAlertView = { id: "a1", state: "waiting", createdAt: "2026-11-12T18:52:00.000Z", calls: [], phone: true, callMode: "keypad" };
const now = Date.parse("2026-11-12T18:53:00.000Z");
const sent = { sentAt: "2026-11-12T18:52:01.000Z" };
const at = (iso: string) => urgentAlertClock(iso);
const call = (attempt: number, startedAt: string, status: UrgentAlertView["calls"][number]["status"], extra: Partial<UrgentAlertView["calls"][number]> = {}) =>
  ({ attempt, startedAt, status, endedAt: startedAt, ...extra });
const main = (status: ReturnType<typeof urgentAlertStatus>) => `${status.lead}${status.countdown ? `[${status.countdown.text}]` : ""}${status.tail ?? ""}`;

test("while it waits, the band says when the phone rings and offers Got it", () => {
  const waiting = urgentAlertStatus({ ...base, telegram: sent, callAt: "2026-11-12T18:57:00.000Z" }, "@taylor", now);
  assert.equal(main(waiting), "Calling you in [4:00]");
  assert.equal(waiting.countdown?.to, "2026-11-12T18:57:00.000Z");
  assert.equal(waiting.detail, "Sent to Telegram. Got it here or there stops the call.");
  assert.deepEqual([waiting.tone, waiting.icon, waiting.action], ["now", "clock", "got-it"]);

  // Its moment came and the server has not placed it yet: no "0:00", and no
  // claim that it rings.
  const due = urgentAlertStatus({ ...base, callAt: "2026-11-12T18:52:30.000Z" }, "@taylor", now);
  assert.equal(main(due), "Placing the call (call 1 of 3)");
  assert.equal(due.countdown, undefined);

  const ringing = urgentAlertStatus({ ...base, state: "calling", calls: [{ attempt: 1, startedAt: "2026-11-12T18:57:00.000Z", status: "ringing" }] }, "@taylor", now);
  assert.equal(main(ringing), "Calling you now (call 1 of 3)");
  assert.equal(ringing.detail, "Answer and press 1, or press Got it here.");
  assert.equal(ringing.icon, "ringing");
  const answerMode = urgentAlertStatus({ ...base, state: "calling", callMode: "answer", calls: [{ attempt: 1, startedAt: "x", status: "in-progress" }] }, "@taylor", now);
  assert.equal(answerMode.detail, "Answer it, or press Got it here.");

  const between = urgentAlertStatus({ ...base, state: "calling", telegram: sent, callAt: "2026-11-12T18:55:41.000Z",
    calls: [call(1, "2026-11-12T18:50:00.000Z", "no-answer")] }, "@taylor", now);
  assert.equal(main(between), "Calling again in [2:41] (call 2 of 3)");
  assert.equal(between.detail, `Sent to Telegram. Call 1 at ${at("2026-11-12T18:50:00.000Z")}: no answer.`);

  const telegramOnly = urgentAlertStatus({ ...base, phone: false, telegram: sent }, "@taylor", now);
  assert.equal(main(telegramOnly), "Sent to Telegram");
  assert.equal(telegramOnly.detail, "No phone is connected, so no call will follow.");
  assert.equal(telegramOnly.action, "got-it");
});

test("nobody answering is the worst news and still takes Got it", () => {
  const times = ["2026-11-12T18:57:00.000Z", "2026-11-12T19:00:00.000Z", "2026-11-12T19:03:00.000Z"];
  const nobody = urgentAlertStatus({ ...base, state: "unanswered", telegram: sent, calls: times.map((time, index) => call(index + 1, time, "no-answer")) }, "@taylor", now);
  assert.equal(main(nobody), "Nobody answered 3 calls, no more calls");
  assert.equal(nobody.detail, `Sent to Telegram. Calls at ${times.map(at).join(", ")}: no answer.`);
  assert.deepEqual([nobody.tone, nobody.icon, nobody.action], ["bad", "missed", "got-it"]);
  assert.equal(urgentAlertAwaitsGotIt({ state: "unanswered" }), true);

  const mixed = urgentAlertStatus({ ...base, state: "unanswered", calls: [call(1, times[0], "no-answer"), call(2, times[1], "busy"), call(3, times[2], "completed")] }, "@taylor", now);
  assert.equal(mixed.detail, `Call 1 at ${at(times[0])}: no answer. Call 2 at ${at(times[1])}: busy. Call 3 at ${at(times[2])}: 1 wasn't pressed.`);

  const refused = urgentAlertStatus({ ...base, state: "unanswered", calls: [1, 2, 3].map((attempt) => call(attempt, times[attempt - 1], "failed", { error: "The number is unverified." })) }, "@taylor", now);
  assert.equal(main(refused), "Couldn't call you, no more calls");
  assert.match(refused.detail ?? "", /couldn't place it \(The number is unverified\.\)\.$/);
});

test("after Got it the band says who reacted where, and the folded line says how it ended", () => {
  const acked = "2026-11-12T18:59:00.000Z";
  const telegram = { ...base, state: "acknowledged" as const, ackSource: "telegram" as const, ackedAt: acked, telegram: sent };
  assert.equal(main(urgentAlertStatus(telegram, "@taylor", now)), `Got it, you pressed it in Telegram at ${at(acked)}`);
  assert.equal(urgentAlertStatus(telegram, "@taylor", now).detail, "Sent to Telegram. No call was made.");
  assert.deepEqual(urgentAlertOutcome(telegram), { text: `Got it in Telegram ${at(acked)}`, short: `Got it ${at(acked)}`, done: true });

  const pressed = { ...base, state: "acknowledged" as const, ackSource: "call" as const, ackedAt: acked, telegram: sent,
    calls: [call(1, "2026-11-12T18:55:00.000Z", "no-answer"), call(2, "2026-11-12T18:58:00.000Z", "completed")] };
  const pressedStatus = urgentAlertStatus(pressed, "@taylor", now);
  assert.equal(main(pressedStatus), `Got it, you pressed 1 on call 2 at ${at(acked)}`);
  assert.equal(pressedStatus.detail, `Sent to Telegram. Call 1 at ${at("2026-11-12T18:55:00.000Z")}: no answer.`, "the call she answered is not history");
  assert.deepEqual([pressedStatus.tone, pressedStatus.icon, pressedStatus.action], ["done", "check", undefined]);
  assert.equal(urgentAlertOutcome(pressed).text, `Got it on the call ${at(acked)}`);
  assert.equal(urgentAlertOutcome({ ...pressed, callMode: "answer" }).text, `Answered the call ${at(acked)}`);
  assert.equal(main(urgentAlertStatus({ ...pressed, callMode: "answer" }, "@taylor", now)), `Got it, you answered call 2 at ${at(acked)}`);

  const app = { ...base, state: "acknowledged" as const, ackSource: "app" as const, ackedAt: acked, calls: [call(1, "2026-11-12T18:57:00.000Z", "canceled")] };
  assert.equal(main(urgentAlertStatus(app, "@taylor", now)), `Got it, you pressed it in the app at ${at(acked)}`);
  assert.equal(urgentAlertStatus(app, "@taylor", now).detail, `Call 1 at ${at("2026-11-12T18:57:00.000Z")}: stopped.`);
  assert.equal(urgentAlertOutcome(app).text, `Got it in the app ${at(acked)}`);
  assert.equal(urgentAlertAwaitsGotIt(app), false);
});

test("an alert that never left the app says so and offers to set alerts up", () => {
  const unset = urgentAlertStatus({ ...base, state: "not_set_up", phone: false }, "@taylor", now);
  assert.deepEqual([unset.lead, unset.detail, unset.tone, unset.action], ["Not sent outside the app", "Alerts aren't set up, so @taylor could reach you only here.", "off", "set-up"]);
  assert.deepEqual(urgentAlertOutcome({ ...base, state: "not_set_up" }), { text: "Not sent outside the app", short: "Not sent", done: false });
  const failed = urgentAlertStatus({ ...base, state: "failed", phone: false, telegram: { error: "Forbidden: bot was blocked by the user" } }, "@taylor", now);
  assert.equal(failed.detail, "Telegram didn't take it (Forbidden: bot was blocked by the user) and no phone is connected.");
  assert.equal(failed.action, "set-up");
});

test("only a card the User's server wrote is an alert's card", () => {
  const view = { ...base };
  assert.equal(urgentAlertOfMessage({ role: "participant", metadata: { serverWriter: "server", urgentAlert: view } }), view);
  assert.equal(urgentAlertOfMessage({ role: "participant", metadata: { serverWriter: "device-1", urgentAlert: view } }), undefined);
  assert.equal(urgentAlertOfMessage({ role: "user", metadata: { serverWriter: "server", urgentAlert: view } }), undefined);
  assert.equal(urgentAlertOfMessage({ role: "participant", metadata: { serverWriter: "server", urgentAlert: { state: "waiting" } } }), undefined);
});

test("the edges: no channel at all, one unanswered call, calls that never rang, a state this app does not know", () => {
  const nothing = urgentAlertStatus({ ...base, phone: false }, "@taylor", now);
  assert.deepEqual([nothing.lead, nothing.action], ["Waiting for Got it", "got-it"]);

  const once = urgentAlertStatus({ ...base, state: "unanswered", calls: [call(1, "2026-11-12T18:57:00.000Z", "no-answer")] }, "@taylor", now);
  assert.equal(once.lead, "Nobody answered the call, no more calls");

  // Twilio reported them failed without saying why: they never rang either.
  const failed = urgentAlertStatus({ ...base, state: "unanswered", calls: [1, 2, 3].map((attempt) => call(attempt, "2026-11-12T18:57:00.000Z", "failed")) }, "@taylor", now);
  assert.equal(failed.lead, "Couldn't call you, no more calls");
  assert.match(failed.detail ?? "", /: didn't go through\.$/);
  // Only the calls that got through count as unanswered.
  const some = urgentAlertStatus({ ...base, state: "unanswered", calls: [call(1, "2026-11-12T18:57:00.000Z", "no-answer"), call(2, "2026-11-12T19:00:00.000Z", "failed"), call(3, "2026-11-12T19:03:00.000Z", "no-answer")] }, "@taylor", now);
  assert.equal(some.lead, "Nobody answered 2 calls, no more calls");
  // Telegram refused it while a call is still ahead: the band says so.
  const refusedTelegram = urgentAlertStatus({ ...base, telegram: { error: "Forbidden" }, callAt: "2026-11-12T18:57:00.000Z" }, "@taylor", now);
  assert.equal(refusedTelegram.detail, "Telegram didn't take it. Got it here stops the call.");

  const future = urgentAlertStatus({ ...base, state: "snoozed" as UrgentAlertState }, "@taylor", now);
  assert.equal(future.action, undefined, "no Got it the card cannot stand behind");
  assert.equal(urgentAlertAwaitsGotIt({ state: "snoozed" as UrgentAlertState }), false);
});

test("the card offers Got it in exactly the states the server takes it", () => {
  const all: UrgentAlertState[] = ["waiting", "calling", "acknowledged", "unanswered", "not_set_up", "failed"];
  assert.deepEqual(all.filter((state) => urgentAlertAwaitsGotIt({ state })), [...URGENT_ALERT_ACKNOWLEDGEABLE_STATES]);
  for (const state of all) {
    const status = urgentAlertStatus({ ...base, state, callAt: "2026-11-12T18:57:00.000Z" }, "@taylor", now);
    assert.equal(status.action === "got-it", urgentAlertAwaitsGotIt({ state }), state);
  }
});

test("the countdown and the failure text", () => {
  assert.equal(urgentAlertCountdown(0), "0:00");
  assert.equal(urgentAlertCountdown(-5_000), "0:00");
  assert.equal(urgentAlertCountdown(1), "0:01", "a part of a second still left reads as a second");
  assert.equal(urgentAlertCountdown(61 * 60_000), "61:00");
  assert.equal(urgentAlertFailureText({ state: "waiting" }, "your server did not answer"), "Not confirmed: your server did not answer. A call may still come.");
  // The server's own words end in a full stop: never two of them.
  assert.equal(urgentAlertFailureText({ state: "calling" }, "Your server could not be reached (fetch failed). "), "Not confirmed: Your server could not be reached (fetch failed). A call may still come.");
  // After the last call no call comes, so it does not say one may.
  assert.equal(urgentAlertFailureText({ state: "unanswered" }, "Your server could not be reached."), "Not confirmed: Your server could not be reached.");
  assert.equal(urgentAlertFailureText({ state: "acknowledged" }, "your server did not answer"), "Could not close: your server did not answer.");
});

test("phone numbers are taken with their country code only", () => {
  assert.equal(normalizePhoneNumber("+357 99 123 342"), "+35799123342");
  assert.equal(normalizePhoneNumber("+1 (415) 555-0134"), "+14155550134");
  assert.equal(normalizePhoneNumber("99 123 342"), undefined);
  assert.equal(normalizePhoneNumber("+0123456789"), undefined);
  assert.equal(maskedPhoneNumber("+35799123342"), "+357 ••• 342");
});
