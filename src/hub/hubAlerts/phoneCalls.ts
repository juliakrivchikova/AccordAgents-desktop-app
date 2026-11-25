import {
  URGENT_ALERT_CALL_ATTEMPTS, URGENT_ALERT_CALL_RETRY_MS, URGENT_ALERT_RING_SECONDS, HUB_ALERTS_TWILIO_PATH,
  type UrgentAlertCallStatus
} from "../../shared/urgentAlerts";
import {
  AlertChannelError, TWILIO_FINAL_STATUSES, TwilioClient, confirmedTwiml, spokenAlert, validTwilioSignature
} from "../alertChannels";
import { callTwiml, messageOf } from "./alertText";
import { OPEN_STATES, PHONE_KEYS_REFUSED } from "./constants";
import type { AlertRecord, StoredPhone, StoredSettings } from "./types";
import type { HubAlertModules } from "./modules";
import type { HubAlertDependencies } from "./dependencies";

/** Alerts as phone calls. */
export class PhoneCalls {
  readonly polls = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly alerts: Pick<HubAlertModules, "alertFlow" | "alertRecords" | "alertSettings" | "phoneTests" | "telegramAlerts">,
    private readonly deps: Pick<HubAlertDependencies, "fetchImpl" | "log" | "now" | "options">
  ) {}

  async placeCall(alertId: string): Promise<void> {
    const settings = await this.alerts.alertSettings.settings();
    const placed = await this.alerts.alertRecords.serialize(async () => {
      const record = await this.alerts.alertRecords.record(alertId);
      if (!record || !OPEN_STATES.includes(record.view.state) || record.callSid || record.nextCallAt === undefined) return undefined;
      if (await this.deps.options.storage.conversationTombstones().isDeleted(record.conversationId)) {
        // Its chat is gone: nobody can close it any more, so nothing rings.
        delete record.nextCallAt;
        delete record.view.callAt;
        record.view.state = "unanswered";
        await this.alerts.alertRecords.save(record);
        this.deps.log("hub.alert.chat-deleted", { alertId });
        return undefined;
      }
      const attempt = record.view.calls.length + 1;
      const startedAt = this.deps.now().toISOString();
      delete record.nextCallAt;
      delete record.view.callAt;
      if (!settings.phone) {
        // The phone was disconnected while it waited: Telegram is all there is.
        record.view.phone = false;
        record.view.state = "waiting";
        await this.alerts.alertRecords.save(record);
        await this.alerts.alertRecords.writeCard(record);
        return undefined;
      }
      const mode = this.alerts.alertSettings.callMode(settings);
      record.view.callMode = mode;
      const twiml = callTwiml(mode, spokenAlert(record.announcedAs ?? record.requester, record.chatTitle, record.text), this.keypadUrl(settings, record));
      try {
        const call = await this.twilio(settings.phone).createCall({ to: settings.phone.to, from: settings.phone.from, twiml, ringSeconds: URGENT_ALERT_RING_SECONDS });
        record.callSid = call.sid;
        record.view.calls.push({ attempt, startedAt, status: call.status });
        record.view.state = "calling";
      } catch (error) {
        const reason = error instanceof AlertChannelError ? error.message : "Twilio could not be reached.";
        record.view.calls.push({ attempt, startedAt, status: "failed", endedAt: startedAt, error: reason });
        this.deps.log("hub.alert.call.failed", { alertId, attempt, message: messageOf(error) });
        if (error instanceof AlertChannelError && error.badCredentials) {
          void this.alerts.alertSettings.updateSettings((current) => {
            if (current.phone) current.phone.error = PHONE_KEYS_REFUSED;
          }).catch(() => undefined);
        }
        this.afterCallEnded(record);
      }
      await this.alerts.alertRecords.save(record);
      await this.alerts.alertRecords.writeCard(record);
      return record;
    });
    if (!placed) return;
    void this.alerts.telegramAlerts.editTelegram(placed).catch(() => undefined);
    if (placed.callSid) this.pollCall(alertId, placed.callSid);
  }

  /** A call that ended without Got it: another in a few minutes, or none left. */
  private afterCallEnded(record: AlertRecord): void {
    delete record.callSid;
    if (record.view.calls.length < URGENT_ALERT_CALL_ATTEMPTS) {
      const retryMs = this.deps.options.callRetryMs ?? URGENT_ALERT_CALL_RETRY_MS;
      record.nextCallAt = this.deps.now().getTime() + retryMs;
      record.view.callAt = new Date(record.nextCallAt).toISOString();
      record.view.state = "calling";
    } else {
      record.view.state = "unanswered";
      delete record.view.callAt;
    }
  }

  pollCall(alertId: string, sid: string): void {
    if (this.alerts.alertFlow.closed) return;
    this.stopPolling(alertId);
    let failingSince: number | undefined;
    const tick = (): void => {
      this.polls.delete(alertId);
      void this.checkCall(alertId, sid, failingSince).then((again) => {
        failingSince = undefined;
        if (again && !this.alerts.alertFlow.closed) {
          const poll = setTimeout(tick, this.deps.options.callPollMs ?? 4_000);
          poll.unref?.();
          this.polls.set(alertId, poll);
        }
      }, (error: unknown) => {
        failingSince ??= this.deps.now().getTime();
        this.deps.log("hub.alert.poll.error", { alertId, message: messageOf(error) });
        if (!this.alerts.alertFlow.closed) {
          const poll = setTimeout(tick, (this.deps.options.callPollMs ?? 4_000) * 3);
          poll.unref?.();
          this.polls.set(alertId, poll);
        }
      });
    };
    const poll = setTimeout(tick, this.deps.options.callPollMs ?? 4_000);
    poll.unref?.();
    this.polls.set(alertId, poll);
  }

  stopPolling(alertId: string): void {
    const poll = this.polls.get(alertId);
    if (poll) clearTimeout(poll);
    this.polls.delete(alertId);
  }

  /** One look at a call; true while it still rings or talks. */
  private async checkCall(alertId: string, sid: string, failingSince: number | undefined): Promise<boolean> {
    const settings = await this.alerts.alertSettings.settings();
    let status: UrgentAlertCallStatus;
    if (!settings.phone) {
      // Disconnected while it rang: nothing can ask Twilio any more.
      status = "canceled";
    } else {
      try {
        status = (await this.twilio(settings.phone).call(sid)).status;
      } catch (error) {
        // Lost for minutes: counted as a call that ended unanswered.
        if (failingSince === undefined || this.deps.now().getTime() - failingSince < 10 * 60_000) throw error;
        status = "failed";
      }
    }
    const final = TWILIO_FINAL_STATUSES.has(status);
    const ended = await this.alerts.alertRecords.serialize(async () => {
      const record = await this.alerts.alertRecords.record(alertId);
      if (!record || record.callSid !== sid) return { stop: true, record: undefined };
      const call = record.view.calls[record.view.calls.length - 1];
      const changed = call && call.status !== status;
      if (call) call.status = status;
      if (!final) {
        // Queued, ringing or talking all read "Calling you now": the card is
        // written again only when the call ends.
        if (changed) await this.alerts.alertRecords.save(record);
        return { stop: false, record: undefined };
      }
      if (call) call.endedAt = this.deps.now().toISOString();
      if (record.view.callMode === "answer" && status === "completed") {
        // No key can be heard without a server Twilio reaches: answering is it.
        record.view.state = "acknowledged";
        record.view.ackedAt = this.deps.now().toISOString();
        record.view.ackSource = "call";
        delete record.callSid;
      } else {
        this.afterCallEnded(record);
      }
      await this.alerts.alertRecords.save(record);
      await this.alerts.alertRecords.writeCard(record);
      return { stop: true, record };
    });
    if (ended.record) {
      this.alerts.alertFlow.reschedule();
      void this.alerts.telegramAlerts.editTelegram(ended.record).catch(() => undefined);
    }
    return !ended.stop;
  }

  async endCall(sid: string): Promise<void> {
    const settings = await this.alerts.alertSettings.settings();
    if (!settings.phone) return;
    try {
      const call = await this.twilio(settings.phone).call(sid);
      if (TWILIO_FINAL_STATUSES.has(call.status)) return;
      await this.twilio(settings.phone).endCall(sid, call.status === "queued" || call.status === "ringing" || call.status === "initiated");
    } catch (error) {
      this.deps.log("hub.alert.call.end-failed", { message: messageOf(error) });
    }
  }

  // --- Twilio's key presses -----------------------------------------------------

  /** Where Twilio reaches this server: the key-press address is built and
   *  its signature checked from this one place. */
  publicBase(settings: StoredSettings): string {
    return (this.deps.options.publicUrlOverride || settings.publicUrl || "").replace(/\/+$/, "");
  }

  /** The address Twilio posts a key to, with the alert and its token. */
  private keypadUrl(settings: StoredSettings, record: AlertRecord): string {
    const base = this.publicBase(settings);
    return `${base}${HUB_ALERTS_TWILIO_PATH}?${new URLSearchParams({ alert: record.view.id, token: record.webhookToken }).toString()}`;
  }

  /** A key pressed on an alert's call (POST from Twilio, signed by it). */
  async twilioKey(url: URL, body: Buffer, signature: string | undefined): Promise<{ status: number; twiml: string }> {
    await this.alerts.alertRecords.init();
    const settings = await this.alerts.alertSettings.settings();
    if (url.searchParams.has("test")) return this.alerts.phoneTests.testKey(url, body, signature, settings);
    const alertId = url.searchParams.get("alert") ?? "";
    const record = alertId ? await this.alerts.alertRecords.record(alertId) : undefined;
    const params = Object.fromEntries(new URLSearchParams(body.toString("utf8")).entries());
    const base = this.publicBase(settings);
    if (!settings.phone || !record || url.searchParams.get("token") !== record.webhookToken ||
      !validTwilioSignature(settings.phone.authToken, `${base}${url.pathname}${url.search}`, params, signature)) {
      this.deps.log("hub.alert.twilio.refused", { alertId, hasRecord: Boolean(record) });
      return { status: 403, twiml: "" };
    }
    const digits = params.Digits ?? "";
    if (digits === "1") {
      // Twilio waits 15 s at most: answer it soon, let the rest finish after.
      const acknowledged = this.alerts.alertFlow.acknowledge(alertId, "call").catch((error: unknown) => {
        this.deps.log("hub.alert.ack.error", { alertId, message: messageOf(error) });
        return undefined;
      });
      await Promise.race([acknowledged, new Promise((resolve) => setTimeout(resolve, 4_000).unref?.())]);
      return { status: 200, twiml: confirmedTwiml() };
    }
    return { status: 200, twiml: callTwiml("keypad", spokenAlert(record.announcedAs ?? record.requester, record.chatTitle, record.text), this.keypadUrl(settings, record)) };
  }

  private twilio(phone: StoredPhone): TwilioClient {
    return new TwilioClient(phone.accountSid, phone.authToken, this.deps.fetchImpl, this.deps.options.twilioBaseUrl);
  }
}
