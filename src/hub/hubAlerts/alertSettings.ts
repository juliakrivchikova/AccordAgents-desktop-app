import { randomBytes } from "node:crypto";
import {
  URGENT_ALERT_DEFAULT_WAIT_MINUTES, URGENT_ALERT_WAIT_MINUTES_MAX, URGENT_ALERT_WAIT_MINUTES_MIN, normalizePhoneNumber,
  type HubAlertRequest, type HubAlertResult, type UrgentAlertCallFrom, type UrgentAlertPhoneCheck, type UrgentAlertSettingsView
} from "../../shared/urgentAlerts";
import { AlertChannelError, TelegramBot, TwilioClient } from "../alertChannels";
import { failure, messageOf } from "./alertText";
import { PHONE_KEYS_REFUSED } from "./constants";
import { sameKeys, sameSecret, twilioCredentials } from "./twilioKeys";
import type { StoredSettings } from "./types";
import type { HubAlertModules } from "./modules";
import type { HubAlertDependencies } from "./dependencies";

/** Where the settings live on the server (hub_documents): the bot token and
 *  the Twilio keys are the server's to use, like the AWS start keys. */
const SETTINGS_DOCUMENT = "urgent-alerts";

/** A number bought for alerts is handed back, not bought again, when the
 *  same account asks within this time (an answer lost on the way, a second
 *  press while the first purchase still runs): each one is billed monthly. */
const PURCHASE_REUSE_MS = 10 * 60_000;

/** How the User is alerted, and what that needs. */
export class AlertSettings {
  /** Numbers bought per Twilio account, kept for PURCHASE_REUSE_MS. */
  readonly purchases = new Map<string, { at: number; authToken: string; number: Promise<string> }>();
  settingsQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly alerts: Pick<HubAlertModules, "alertFlow" | "phoneTests" | "telegramAlerts">,
    private readonly deps: Pick<HubAlertDependencies, "fetchImpl" | "log" | "now" | "options">
  ) {}

  // --- settings -------------------------------------------------------------------

  async settingsAction(request: HubAlertRequest): Promise<HubAlertResult<unknown>> {
    switch (request.action) {
      case "settings":
        return { ok: true, value: this.settingsView(await this.settings()) };
      case "public-url": {
        const url = typeof request.url === "string" && /^https:\/\/[^\s/]+/.test(request.url) ? request.url.replace(/\/+$/, "") : undefined;
        const current = await this.settings();
        if ((current.publicUrl ?? undefined) === url) return { ok: true, value: this.settingsView(current) };
        const settings = await this.updateSettings((stored) => {
          if (url) stored.publicUrl = url; else delete stored.publicUrl;
        });
        return { ok: true, value: this.settingsView(settings) };
      }
      case "wait": {
        const minutes = Math.round(Number(request.minutes));
        if (!Number.isFinite(minutes) || minutes < URGENT_ALERT_WAIT_MINUTES_MIN || minutes > URGENT_ALERT_WAIT_MINUTES_MAX) {
          return failure("invalid_request", `Wait between ${URGENT_ALERT_WAIT_MINUTES_MIN} and ${URGENT_ALERT_WAIT_MINUTES_MAX} minutes.`);
        }
        return { ok: true, value: this.settingsView(await this.updateSettings((current) => { current.waitMinutes = minutes; })) };
      }
      case "telegram.connect": {
        const token = typeof request.token === "string" ? request.token.trim() : "";
        if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) return failure("invalid_request", "That doesn't look like a bot token. Copy the whole line BotFather sent, like 123456:ABC-DEF…");
        const bot = new TelegramBot(token, this.deps.fetchImpl, this.deps.options.telegramBaseUrl);
        const me = await bot.getMe();
        await bot.deleteWebhook().catch(() => undefined);
        const settings = await this.updateSettings((current) => {
          current.telegram = { token, botUsername: me.username ?? "", connected: false, step: "start", startCode: randomBytes(12).toString("base64url") };
        });
        await this.alerts.telegramAlerts.restartTelegram();
        return { ok: true, value: this.settingsView(settings) };
      }
      case "telegram.disconnect": {
        const settings = await this.updateSettings((current) => {
          delete current.telegram;
        });
        await this.alerts.telegramAlerts.restartTelegram();
        return { ok: true, value: this.settingsView(settings) };
      }
      case "telegram.test": {
        const settings = await this.settings();
        const telegram = settings.telegram;
        if (!telegram?.connected || telegram.chatId === undefined) return failure("not_set_up", "Telegram is not connected.");
        const nonce = randomBytes(9).toString("base64url");
        const sentAt = Date.now();
        try {
          await this.alerts.telegramAlerts.bot(telegram).sendMessage(telegram.chatId, "Test alert from AccordAgents. Press Got it to check the button.", [{ text: "Got it", data: `test:${nonce}` }]);
        } catch (error) {
          await this.alerts.telegramAlerts.telegramDelivered(telegram.token, sentAt, error);
          throw error;
        }
        await this.alerts.telegramAlerts.telegramDelivered(telegram.token, sentAt);
        const sent = await this.updateSettings((current) => {
          if (current.telegram?.token !== telegram.token) return;
          current.telegram.lastTest = { at: this.deps.now().toISOString(), gotIt: false };
          current.telegram.lastTestNonce = nonce;
        });
        return { ok: true, value: this.settingsView(sent) };
      }
      case "phone.check": {
        const credentials = await this.phoneCredentials(request);
        if (!credentials) return failure("invalid_request", "Paste the Account SID (starts with AC) and the Auth Token from the Twilio Console.");
        const client = new TwilioClient(credentials.accountSid, credentials.authToken, this.deps.fetchImpl, this.deps.options.twilioBaseUrl);
        const [account, numbers] = await Promise.all([client.account(), client.incomingNumbers()]).catch(async (error: unknown) => {
          await this.keysRefused(error, credentials);
          throw error;
        });
        const trial = account.type === "Trial";
        // A trial calls only verified numbers: the dialog checks hers against them.
        const verified = trial ? await client.verifiedNumbers().catch(() => undefined) : undefined;
        const value: UrgentAlertPhoneCheck = {
          accountName: account.friendlyName,
          trial,
          numbers: numbers.map((number) => number.phoneNumber),
          ...(verified ? { verified } : {}),
          ...(credentials.saved ? { saved: true } : {}),
          callMode: this.callMode(await this.settings())
        };
        return { ok: true, value };
      }
      case "phone.buy": {
        const credentials = await this.phoneCredentials(request);
        if (!credentials) return failure("invalid_request", "Paste the Account SID and the Auth Token first.");
        return { ok: true, value: { number: await this.buyOnce(credentials) } };
      }
      case "phone.save": {
        const credentials = await this.phoneCredentials(request);
        if (!credentials) return failure("invalid_request", "Paste the Account SID and the Auth Token first.");
        const from = normalizePhoneNumber(String(request.from ?? ""));
        const to = normalizePhoneNumber(String(request.to ?? ""));
        if (!from) return failure("invalid_request", "Choose the number to call from.");
        if (!to) return failure("invalid_request", "Enter your phone with the country code, like +357 99 123456.");
        const account = await new TwilioClient(credentials.accountSid, credentials.authToken, this.deps.fetchImpl, this.deps.options.twilioBaseUrl).account()
          .catch(async (error: unknown) => {
            await this.keysRefused(error, credentials);
            throw error;
          });
        const keys = { accountSid: credentials.accountSid, authToken: credentials.authToken };
        // The test call she just made of exactly this (or the one kept for it).
        const tried = typeof request.testId === "string" ? this.alerts.phoneTests.tests.get(request.testId) : undefined;
        const settings = await this.updateSettings((current) => {
          const same = (phone: { accountSid: string; authToken: string; from: string; to: string } | undefined) =>
            phone && sameKeys(phone, keys) && phone.from === from && phone.to === to;
          const lastTest = same(tried ? { ...tried.credentials, from: tried.from, to: tried.to } : undefined) ? tried?.result
            : same(current.phone) ? current.phone?.lastTest : undefined;
          current.phone = {
            ...keys, from, to, trial: account.type === "Trial",
            ...(account.friendlyName ? { accountName: account.friendlyName } : {}),
            ...(lastTest ? { lastTest: { ...lastTest } } : {})
          };
        });
        return { ok: true, value: this.settingsView(settings) };
      }
      case "phone.try": {
        const credentials = await this.phoneCredentials(request);
        if (!credentials) return failure("invalid_request", "Paste the Account SID and the Auth Token first.");
        const from = normalizePhoneNumber(String(request.from ?? ""));
        const to = normalizePhoneNumber(String(request.to ?? ""));
        if (!from) return failure("invalid_request", "Choose the number to call from.");
        if (!to) return failure("invalid_request", "Enter your phone with the country code, like +357 99 123456.");
        const run = await this.alerts.phoneTests.startTest({ accountSid: credentials.accountSid, authToken: credentials.authToken }, from, to);
        if (!run) return failure("invalid_request", "A test call is still ringing. Wait for it to end.");
        return { ok: true, value: { testId: run.id, test: run.result, callMode: run.mode } };
      }
      case "phone.try-status": {
        const run = typeof request.testId === "string" ? this.alerts.phoneTests.tests.get(request.testId) : undefined;
        if (!run) return failure("invalid_request", "That test call is no longer known. Call again.");
        // How calls end now, as the page will judge the saved test by.
        return { ok: true, value: { testId: run.id, test: run.result, callMode: this.callMode(await this.settings()) } };
      }
      case "phone.test": {
        const settings = await this.settings();
        if (!settings.phone) return failure("not_set_up", "No phone is connected.");
        const run = await this.alerts.phoneTests.startTest({ accountSid: settings.phone.accountSid, authToken: settings.phone.authToken }, settings.phone.from, settings.phone.to);
        if (!run) return failure("invalid_request", "A test call is still ringing. Wait for it to end.");
        return { ok: true, value: this.settingsView(await this.settings()) };
      }
      case "phone.disconnect":
        this.purchases.clear();
        return { ok: true, value: this.settingsView(await this.updateSettings((current) => { delete current.phone; })) };
      default:
        return failure("invalid_request", `Unknown alert action: ${String((request as { action?: unknown }).action).slice(0, 40)}.`);
    }
  }

  /** The Twilio keys a request pasted, or the saved ones when it pasted none
   *  (changing the number or the phone keeps the account). */
  private async phoneCredentials(request: { accountSid?: unknown; authToken?: unknown }): Promise<{ accountSid: string; authToken: string; saved: boolean } | undefined> {
    if (request.accountSid !== undefined || request.authToken !== undefined) {
      const pasted = twilioCredentials(request.accountSid, request.authToken);
      return pasted ? { ...pasted, saved: false } : undefined;
    }
    const phone = (await this.settings()).phone;
    return phone ? { accountSid: phone.accountSid, authToken: phone.authToken, saved: true } : undefined;
  }

  /** Twilio refused keys that are the saved ones: the phone needs attention
   *  (as after an alert's call), not only this one request. */
  async keysRefused(error: unknown, credentials: { accountSid: string; authToken: string }): Promise<void> {
    if (!(error instanceof AlertChannelError) || !error.badCredentials) return;
    await this.updateSettings((current) => {
      if (current.phone && sameKeys(current.phone, credentials)) current.phone.error = PHONE_KEYS_REFUSED;
    }).catch((failure: unknown) => this.deps.log("hub.alert.phone.mark-failed", { message: messageOf(failure) }));
  }

  /** Buys a US number, or hands back the one this account bought a moment
   *  ago (or is buying now): a lost answer never costs a second number. */
  private buyOnce(credentials: { accountSid: string; authToken: string }): Promise<string> {
    const now = this.deps.now().getTime();
    const kept = this.purchases.get(credentials.accountSid);
    // Handed back only to the same keys: a wrong token is not let past Twilio.
    if (kept && now - kept.at < PURCHASE_REUSE_MS && sameSecret(credentials.authToken, kept.authToken)) return kept.number;
    const number = (async () => {
      const client = new TwilioClient(credentials.accountSid, credentials.authToken, this.deps.fetchImpl, this.deps.options.twilioBaseUrl);
      const available = await client.availableNumber("US").catch(async (error: unknown) => {
        await this.keysRefused(error, credentials);
        throw error;
      });
      if (!available) throw new AlertChannelError("Twilio has no US number to offer right now. Try again later, or buy one in the Twilio Console.", 0);
      return (await client.buyNumber(available)).phoneNumber;
    })();
    this.purchases.set(credentials.accountSid, { at: now, authToken: credentials.authToken, number });
    const forget = () => {
      if (this.purchases.get(credentials.accountSid)?.number === number) this.purchases.delete(credentials.accountSid);
    };
    // Not bought: the next press tries again. Bought: its keys are not kept
    // in memory past the time a repeat could come.
    number.catch(forget);
    setTimeout(forget, PURCHASE_REUSE_MS).unref?.();
    return number;
  }

  /** Only the Call-from number, never her own number, the account or keys:
   *  a paired phone reads it for Add to contacts. */
  async callFrom(): Promise<UrgentAlertCallFrom> {
    const phone = (await this.settings()).phone;
    return phone?.from ? { from: phone.from } : {};
  }

  callMode(settings: StoredSettings): "keypad" | "answer" {
    return !this.deps.options.embedded && (this.deps.options.publicUrlOverride || settings.publicUrl) ? "keypad" : "answer";
  }

  private settingsView(settings: StoredSettings): UrgentAlertSettingsView {
    return {
      ...(settings.telegram ? {
        telegram: {
          botUsername: settings.telegram.botUsername,
          ...(settings.telegram.chatName ? { chatName: settings.telegram.chatName } : {}),
          connected: settings.telegram.connected,
          ...(settings.telegram.step ? { step: settings.telegram.step } : {}),
          ...(settings.telegram.startCode ? { startCode: settings.telegram.startCode } : {}),
          ...(settings.telegram.error || settings.telegram.deliveryError ? { error: settings.telegram.error ?? settings.telegram.deliveryError } : {}),
          ...(settings.telegram.lastTest ? { lastTest: { ...settings.telegram.lastTest } } : {})
        }
      } : {}),
      ...(settings.phone ? {
        phone: {
          from: settings.phone.from,
          to: settings.phone.to,
          trial: settings.phone.trial,
          ...(settings.phone.accountName ? { accountName: settings.phone.accountName } : {}),
          ...(settings.phone.error ? { error: settings.phone.error } : {}),
          ...(settings.phone.lastTest ? { lastTest: { ...settings.phone.lastTest } } : {})
        }
      } : {}),
      waitMinutes: settings.waitMinutes,
      callMode: this.callMode(settings),
      ...(this.deps.options.embedded ? { embedded: true } : {})
    };
  }

  async settings(): Promise<StoredSettings> {
    const stored = (await this.deps.options.storage.hub().document(SETTINGS_DOCUMENT))?.value as Partial<StoredSettings> | undefined;
    const waitMinutes = typeof stored?.waitMinutes === "number" ? stored.waitMinutes : URGENT_ALERT_DEFAULT_WAIT_MINUTES;
    return { ...(stored ?? {}), version: 1, waitMinutes } as StoredSettings;
  }

  /** Settings change one at a time (the Telegram reader writes them too). */
  /** A change that returns false changed nothing: nothing is written. */
  updateSettings(change: (settings: StoredSettings) => void | boolean): Promise<StoredSettings> {
    const run = this.settingsQueue.then(async () => {
      if (this.alerts.alertFlow.closed) throw new Error("Urgent alerts are closing.");
      const settings = await this.settings();
      if (change(settings) === false) return settings;
      await this.deps.options.storage.hub().setDocument(SETTINGS_DOCUMENT, settings, this.deps.now().toISOString());
      return settings;
    });
    this.settingsQueue = run.catch(() => undefined);
    return run;
  }
}
