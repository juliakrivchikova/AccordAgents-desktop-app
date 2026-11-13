import assert from "node:assert/strict";
import test from "node:test";
import { maskedPhoneNumber, normalizePhoneNumber, urgentAlertLines, type UrgentAlertView } from "./urgentAlerts";

const base: UrgentAlertView = { id: "a1", state: "waiting", createdAt: "2026-11-12T18:52:00.000Z", calls: [], phone: true, callMode: "keypad" };

test("the card says what happened, in the order it happened", () => {
  const now = Date.parse("2026-11-12T18:53:00.000Z");
  const waiting = urgentAlertLines({ ...base, telegram: { sentAt: "2026-11-12T18:52:01.000Z" }, callAt: "2026-11-12T18:57:00.000Z" }, "@taylor", now);
  assert.deepEqual(waiting.map((line) => [line.key, line.tone]), [["telegram", "ok"], ["next", "wait"]]);
  assert.match(waiting[1].text, /^Calling you at .+ unless you press Got it$/);
  assert.equal(waiting[1].at, "4:00 left");

  const between = urgentAlertLines({ ...base, state: "calling", callAt: "2026-11-12T19:00:00.000Z",
    calls: [{ attempt: 1, startedAt: "2026-11-12T18:57:00.000Z", status: "no-answer", endedAt: "2026-11-12T18:57:30.000Z" }] }, "@taylor", now);
  assert.deepEqual(between.map((line) => line.text.replace(/ at .+ unless/, " at T unless")), ["Called you (call 1 of 3): no answer", "Calling again at T unless you press Got it"]);

  const pressed = urgentAlertLines({ ...base, state: "acknowledged", ackSource: "call", ackedAt: "2026-11-12T18:58:00.000Z",
    calls: [{ attempt: 1, startedAt: "2026-11-12T18:57:00.000Z", status: "completed" }] }, "@taylor", now);
  assert.deepEqual(pressed.map((line) => line.text), ["Called you (call 1 of 3)", "You pressed 1 on the call"]);

  const answered = urgentAlertLines({ ...base, state: "acknowledged", ackSource: "call", callMode: "answer", calls: [{ attempt: 1, startedAt: "x", status: "completed" }] }, "@taylor", now);
  assert.equal(answered[answered.length - 1].text, "You answered the call");

  const seen = urgentAlertLines({ ...base, state: "acknowledged", ackSource: "telegram", telegram: { sentAt: "2026-11-12T18:52:01.000Z" } }, "@taylor", now);
  assert.deepEqual(seen.map((line) => line.text), ["Sent to Telegram", "You pressed Got it", "No call"]);

  const closed = urgentAlertLines({ ...base, state: "acknowledged", ackSource: "app" }, "@taylor", now);
  assert.equal(closed[0].text, "Closed in the app");

  const nobody = urgentAlertLines({ ...base, state: "unanswered", calls: [1, 2, 3].map((attempt) => ({ attempt, startedAt: "x", status: "no-answer" as const })) }, "@taylor", now);
  assert.equal(nobody[nobody.length - 1].text, "Called you 3 times with no answer");

  const unset = urgentAlertLines({ ...base, state: "not_set_up", phone: false }, "@taylor", now);
  assert.deepEqual(unset.map((line) => [line.tone, line.text]), [["bad", "Alerts aren't set up, so @taylor couldn't reach you outside the app."]]);

  const failedCall = urgentAlertLines({ ...base, state: "calling", calls: [{ attempt: 1, startedAt: "x", status: "failed", error: "Twilio: The number is unverified." }] }, "@taylor", now);
  assert.equal(failedCall[0].text, "Couldn't place call 1 of 3: Twilio: The number is unverified.");
});

test("phone numbers are taken with their country code only", () => {
  assert.equal(normalizePhoneNumber("+357 99 123 342"), "+35799123342");
  assert.equal(normalizePhoneNumber("+1 (415) 555-0134"), "+14155550134");
  assert.equal(normalizePhoneNumber("99 123 342"), undefined);
  assert.equal(normalizePhoneNumber("+0123456789"), undefined);
  assert.equal(maskedPhoneNumber("+35799123342"), "+357 ••• 342");
});
