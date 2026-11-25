import { randomBytes } from "node:crypto";
import {
  URGENT_ALERT_RING_SECONDS, URGENT_ALERT_TEST_STALE_MS, HUB_ALERTS_TWILIO_PATH, type UrgentAlertCallStatus,
  type UrgentAlertPhoneTest
} from "../../shared/urgentAlerts";
import {
  AlertChannelError, TWILIO_FINAL_STATUSES, TwilioClient, confirmedTwiml, keypadTwiml, readOutTwiml, validTwilioSignature
} from "../alertChannels";
import { messageOf } from "./alertText";
import { sameKeys, sameSecret, testKeyOf } from "./twilioKeys";
import type { PhoneTestRun, StoredSettings } from "./types";
import type { HubAlertModules } from "./modules";
import type { HubAlertDependencies } from "./dependencies";

/** How long a finished test call is remembered, and how many at most. */
const PHONE_TEST_KEEP_MS = 60 * 60_000;

const PHONE_TEST_KEEP_MAX = 20;
const PHONE_TEST_SPOKEN = "This is a test call from AccordAgents. Urgent alerts will be read out like this.";

/** Test calls from Settings. */
export class PhoneTests {
  readonly tests = new Map<string, PhoneTestRun>();
  readonly testPolls = new Set<ReturnType<typeof setTimeout>>();
  /** A test call being placed (before it is kept): one at a time. */
  private testStarting = false;
  /** The newest test call of each account, number and phone: only its result
   *  is that phone's last test (an older one that ends late does not
   *  overwrite it; a test of other numbers does not stop it). */
  private readonly latestTests = new Map<string, string>();

  constructor(
    private readonly alerts: Pick<HubAlertModules, "alertFlow" | "alertSettings" | "phoneCalls">,
    private readonly deps: Pick<HubAlertDependencies, "fetchImpl" | "log" | "now" | "options">
  ) {}

  // --- test calls -----------------------------------------------------------------

  /** Calls her with a short test: 1 on it (or, where no key can be heard,
   *  answering) proves calls reach her. Its result lands in the settings when
   *  it is a test of exactly the saved phone. */
  async startTest(credentials: { accountSid: string; authToken: string }, from: string, to: string): Promise<PhoneTestRun | undefined> {
    // One test call at a time: each is billed, and two would ring at once
    // (one whose end never came stops counting once no call could last).
    const now = this.deps.now().getTime();
    if (this.testStarting || [...this.tests.values()].some((run) => run.result.state === "calling" && now - run.startedAt < URGENT_ALERT_TEST_STALE_MS)) return undefined;
    this.testStarting = true;
    try {
      return await this.placeTest(credentials, from, to);
    } finally {
      this.testStarting = false;
    }
  }

  private async placeTest(credentials: { accountSid: string; authToken: string }, from: string, to: string): Promise<PhoneTestRun> {
    const settings = await this.alerts.alertSettings.settings();
    const mode = this.alerts.alertSettings.callMode(settings);
    const run: PhoneTestRun = {
      id: randomBytes(9).toString("base64url"),
      token: randomBytes(18).toString("base64url"),
      credentials,
      from,
      to,
      mode,
      result: { state: "calling", at: this.deps.now().toISOString() },
      startedAt: this.deps.now().getTime()
    };
    this.keepTest(run);
    this.latestTests.set(testKeyOf(run), run.id);
    const twiml = mode === "keypad"
      ? keypadTwiml(PHONE_TEST_SPOKEN, `${this.alerts.phoneCalls.publicBase(settings)}${HUB_ALERTS_TWILIO_PATH}?${new URLSearchParams({ test: run.id, token: run.token }).toString()}`)
      : readOutTwiml(PHONE_TEST_SPOKEN);
    try {
      const call = await new TwilioClient(credentials.accountSid, credentials.authToken, this.deps.fetchImpl, this.deps.options.twilioBaseUrl)
        .createCall({ to, from, twiml, ringSeconds: URGENT_ALERT_RING_SECONDS });
      if (!call.sid) throw new AlertChannelError("Twilio did not say which call it placed.", 0);
      run.sid = call.sid;
    } catch (error) {
      // No answer, Twilio's own trouble, too many requests: the call may have
      // gone out all the same, so how it went is unknown, not failed.
      const status = error instanceof AlertChannelError ? error.status : 0;
      const unknown = status === 0 || status === 429 || status >= 500;
      run.result = {
        state: "failed",
        at: this.deps.now().toISOString(),
        error: error instanceof AlertChannelError ? error.message : "Twilio could not be reached.",
        ...(unknown ? { lost: true } : {})
      };
      await this.alerts.alertSettings.keysRefused(error, credentials);
      await this.recordTest(run);
      return run;
    }
    await this.recordTest(run);
    this.pollTest(run, 0);
    return run;
  }

  private keepTest(run: PhoneTestRun): void {
    const now = this.deps.now().getTime();
    for (const [id, kept] of this.tests) {
      // A call still "calling" after an hour never ended for us: gone too.
      if (now - kept.startedAt > PHONE_TEST_KEEP_MS) this.tests.delete(id);
    }
    // Over the limit: the oldest finished ones go (one at a time rings, so
    // there is always a finished one to drop).
    for (const [id, kept] of this.tests) {
      if (this.tests.size < PHONE_TEST_KEEP_MAX) break;
      if (kept.result.state !== "calling") this.tests.delete(id);
    }
    this.tests.set(run.id, run);
  }

  private pollTest(run: PhoneTestRun, failures: number): void {
    if (this.alerts.alertFlow.closed || !run.sid) return;
    const timer = setTimeout(() => {
      this.testPolls.delete(timer);
      void new TwilioClient(run.credentials.accountSid, run.credentials.authToken, this.deps.fetchImpl, this.deps.options.twilioBaseUrl).call(run.sid as string)
        .then(async (call) => {
          if (!TWILIO_FINAL_STATUSES.has(call.status)) return this.pollTest(run, 0);
          await this.finishTest(run, call.status);
        }, async (error: unknown) => {
          this.deps.log("hub.alert.test.poll-error", { message: messageOf(error) });
          // The keys were refused mid-call: that is known, and says the phone
          // needs attention. Lost for a few minutes: unknown, not "calling" for ever.
          if (error instanceof AlertChannelError && error.badCredentials) {
            await this.alerts.alertSettings.keysRefused(error, run.credentials);
            if (run.result.state === "calling") run.result = { state: "failed", at: this.deps.now().toISOString(), error: error.message };
            await this.recordTest(run);
          } else if (failures >= 30) await this.finishTest(run, "failed", true);
          else this.pollTest(run, failures + 1);
        })
        .catch((error: unknown) => this.deps.log("hub.alert.test.error", { message: messageOf(error) }));
    }, this.deps.options.callPollMs ?? 4_000);
    timer.unref?.();
    this.testPolls.add(timer);
  }

  /** `lost`: Twilio stopped answering about it, so how it went is unknown. */
  private async finishTest(run: PhoneTestRun, status: UrgentAlertCallStatus, lost = false): Promise<void> {
    if (run.result.state === "calling") {
      const state: UrgentAlertPhoneTest["state"] = status === "completed" ? (run.mode === "answer" ? "answered" : "not-pressed")
        : status === "busy" ? "busy"
        : status === "failed" ? "failed"
        : "no-answer";
      run.result = { state, at: this.deps.now().toISOString(), ...(lost ? { lost: true } : {}) };
    }
    await this.recordTest(run);
  }

  /** A test of exactly the saved account, number and phone is its last test. */
  private async recordTest(run: PhoneTestRun): Promise<void> {
    if (this.latestTests.get(testKeyOf(run)) !== run.id) return;
    await this.alerts.alertSettings.updateSettings((current) => {
      const phone = current.phone;
      if (phone && sameKeys(phone, run.credentials) && phone.from === run.from && phone.to === run.to) phone.lastTest = { ...run.result };
    }).catch((error: unknown) => this.deps.log("hub.alert.test.record-failed", { message: messageOf(error) }));
  }

  /** A key pressed on a test call (POST from Twilio, signed with the keys the
   *  test was placed with: before Save they are not the saved ones). */
  async testKey(url: URL, body: Buffer, signature: string | undefined, settings: StoredSettings): Promise<{ status: number; twiml: string }> {
    const run = this.tests.get(url.searchParams.get("test") ?? "");
    const params = Object.fromEntries(new URLSearchParams(body.toString("utf8")).entries());
    if (!run || !sameSecret(url.searchParams.get("token") ?? "", run.token) ||
      !validTwilioSignature(run.credentials.authToken, `${this.alerts.phoneCalls.publicBase(settings)}${url.pathname}${url.search}`, params, signature)) {
      this.deps.log("hub.alert.twilio.refused", { test: true, hasRun: Boolean(run) });
      return { status: 403, twiml: "" };
    }
    if ((params.Digits ?? "") === "1") {
      // 1 proves calls reach her, also on a call whose placing went unanswered.
      if (run.result.state === "calling" || run.result.lost) run.result = { state: "pressed", at: this.deps.now().toISOString() };
      await Promise.race([this.recordTest(run), new Promise((resolve) => setTimeout(resolve, 4_000).unref?.())]);
      return { status: 200, twiml: confirmedTwiml() };
    }
    return { status: 200, twiml: keypadTwiml(PHONE_TEST_SPOKEN, `${this.alerts.phoneCalls.publicBase(settings)}${url.pathname}${url.search}`) };
  }
}
