import { randomBytes, randomUUID } from "node:crypto";
import type { StorageService } from "../main/services/storage";
import type { HubDevice } from "../shared/hubProtocol";
import type { ChatMessage, ChatParticipant, Conversation } from "../shared/types";
import {
  URGENT_ALERT_CALL_ATTEMPTS,
  URGENT_ALERT_CALL_RETRY_MS,
  URGENT_ALERT_DEFAULT_WAIT_MINUTES,
  URGENT_ALERT_MESSAGE_MAX_CHARS,
  URGENT_ALERT_RING_SECONDS,
  URGENT_ALERT_WAIT_MINUTES_MAX,
  URGENT_ALERT_WAIT_MINUTES_MIN,
  HUB_ALERTS_TWILIO_PATH,
  normalizePhoneNumber,
  type HubAlertRequest,
  type HubAlertResult,
  type UrgentAlertAckSource,
  type UrgentAlertCallStatus,
  type UrgentAlertError,
  type UrgentAlertPhoneCheck,
  type UrgentAlertRaised,
  type UrgentAlertSettingsView,
  type UrgentAlertView
} from "../shared/urgentAlerts";
import {
  AlertChannelError,
  TWILIO_FINAL_STATUSES,
  TelegramBot,
  TwilioClient,
  confirmedTwiml,
  keypadTwiml,
  readOutTwiml,
  spokenAlert,
  validTwilioSignature,
  type AlertFetch,
  type TelegramUpdate
} from "./alertChannels";
import { homeDeviceId, type HubOps } from "./hubOps";
import { scopeCovers } from "./hubPhoneState";

/** Where the settings live on the server (hub_documents): the bot token and
 *  the Twilio keys are the server's to use, like the AWS start keys. */
const SETTINGS_DOCUMENT = "urgent-alerts";

const SCHEMA_SQL = `
create table if not exists urgent_alerts (
  id text primary key,
  request_key text not null unique,
  conversation_id text not null,
  state text not null,
  record_json text not null,
  created_at text not null,
  updated_at text not null
);
create index if not exists urgent_alerts_state on urgent_alerts(state);
`;

const OPEN_STATES = ["waiting", "calling"];
/** States Got it still ends: an alert nobody answered can still be seen. */
const ACKNOWLEDGEABLE = new Set(["waiting", "calling", "unanswered"]);

interface StoredTelegram {
  token: string;
  botUsername: string;
  chatId?: number;
  chatName?: string;
  connected: boolean;
  step?: "start" | "test";
  /** The code the owner's Start link carries (`/start <code>`). */
  startCode?: string;
  testNonce?: string;
  testMessageId?: number;
  error?: string;
  /** The next update to read from this bot (so a restart reads nothing
   *  twice); kept with the bot, since another bot numbers its own. */
  offset?: number;
}

interface StoredPhone {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  trial: boolean;
  error?: string;
}

interface StoredSettings {
  version: 1;
  telegram?: StoredTelegram;
  phone?: StoredPhone;
  waitMinutes: number;
  /** Where Twilio reaches this server, as the computer that set it up said. */
  publicUrl?: string;
}

interface AlertRecord {
  view: UrgentAlertView;
  conversationId: string;
  messageId: string;
  participantId: string;
  requester: string;
  chatTitle: string;
  text: string;
  requestKey: string;
  telegramChatId?: number;
  telegramMessageId?: number;
  /** The call ringing or connected now. */
  callSid?: string;
  /** The next call, in ms since the epoch, while one is due. */
  nextCallAt?: number;
  /** In the key-press address Twilio posts to, beside its signature. */
  webhookToken: string;
}

export interface HubAlertsOptions {
  storage: StorageService;
  ops: HubOps;
  log?: (event: string, payload: Record<string, unknown>) => void;
  now?: () => Date;
  fetchImpl?: AlertFetch;
  telegramBaseUrl?: string;
  twilioBaseUrl?: string;
  /** The server inside the app: Twilio can never reach it. */
  embedded?: boolean;
  /** Local QA only: where Twilio reaches this server (a tunnel). */
  publicUrlOverride?: string;
  callPollMs?: number;
  callRetryMs?: number;
  /** Tests: how long a minute of the wait before a call is. */
  minuteMs?: number;
  telegramWaitSeconds?: number;
}

/**
 * Urgent alerts on the User's server (shared/urgentAlerts.ts). A member's
 * device raises one; from then on the server alone carries it: Telegram,
 * the wait, the calls, and the card in the chat, which it writes itself.
 * Every change runs one at a time, so Got it, a key press and a call
 * starting never interleave.
 */
export class HubAlerts {
  private readonly log: (event: string, payload: Record<string, unknown>) => void;
  private readonly now: () => Date;
  private readonly fetchImpl: AlertFetch;
  private ready?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private readonly polls = new Map<string, ReturnType<typeof setTimeout>>();
  private telegramLoop?: AbortController;
  private telegramToken?: string;
  private closed = false;

  constructor(private readonly options: HubAlertsOptions) {
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Picks up what was going on before a restart: waits, calls, Telegram. */
  async start(): Promise<void> {
    await this.init();
    const undelivered: string[] = [];
    await this.serialize(async () => {
      for (const record of await this.openRecords()) {
        if (record.callSid) this.pollCall(record.view.id, record.callSid);
        // Raised right before a stop, never sent: sent now rather than never.
        if (!record.view.telegram) undelivered.push(record.view.id);
      }
    });
    for (const alertId of undelivered) {
      void this.deliverTelegram(alertId).catch((error: unknown) => this.log("hub.alert.telegram.error", { alertId, message: messageOf(error) }));
    }
    this.reschedule();
    await this.restartTelegram();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const poll of this.polls.values()) clearTimeout(poll);
    this.polls.clear();
    this.telegramLoop?.abort();
  }

  private init(): Promise<void> {
    this.ready ??= this.storage().runSql(SCHEMA_SQL).catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private storage(): ReturnType<StorageService["sqlExecutor"]> {
    return this.options.storage.sqlExecutor();
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // --- requests from devices ----------------------------------------------------

  async handle(device: HubDevice, raw: unknown): Promise<HubAlertResult<unknown>> {
    await this.init();
    const request = raw as HubAlertRequest | undefined;
    if (!request || typeof request !== "object" || typeof (request as { action?: unknown }).action !== "string") {
      return failure("invalid_request", "The alert request has no action.");
    }
    try {
      switch (request.action) {
        case "raise":
          if (device.role === "phone") return failure("access_denied", "A phone does not raise alerts.");
          return await this.raise(device, request);
        case "close":
          if (device.role === "machine") return failure("access_denied", "Only the User closes an alert.");
          return await this.closeAlert(device, request.alertId);
        default:
          if (device.role !== "owner") return failure("access_denied", "Only the computer that set up this server changes alert settings.");
          return await this.settingsAction(request);
      }
    } catch (error) {
      if (error instanceof AlertChannelError) return failure("channel_failed", error.message);
      throw error;
    }
  }

  private async raise(device: HubDevice, request: Extract<HubAlertRequest, { action: "raise" }>): Promise<HubAlertResult<UrgentAlertRaised>> {
    const text = typeof request.text === "string" ? request.text.trim() : "";
    if (!text) return failure("invalid_request", "An alert needs a message.");
    if (text.length > URGENT_ALERT_MESSAGE_MAX_CHARS) {
      return failure("invalid_request", `An alert message is at most ${URGENT_ALERT_MESSAGE_MAX_CHARS} characters; say what happened and what the User should do.`);
    }
    if (typeof request.requestId !== "string" || !request.requestId) return failure("invalid_request", "An alert request has an id.");
    const member = await this.member(device, request.conversationId, request.participantId);
    if ("code" in member) return { ok: false, error: member };
    const requestKey = `${request.conversationId}:${request.participantId}:${request.requestId}`;
    const raised = await this.serialize(async () => {
      const existing = await this.recordByRequestKey(requestKey);
      if (existing) return { record: existing, fresh: false };
      const settings = await this.settings();
      const telegram = Boolean(settings.telegram?.connected && settings.telegram.chatId !== undefined);
      const phone = Boolean(settings.phone);
      const createdAt = this.now().toISOString();
      const id = randomUUID();
      const record: AlertRecord = {
        view: {
          id,
          state: telegram || phone ? "waiting" : "not_set_up",
          createdAt,
          calls: [],
          phone,
          callMode: this.callMode(settings),
          ...(phone ? { callAt: new Date(this.now().getTime() + settings.waitMinutes * (this.options.minuteMs ?? 60_000)).toISOString() } : {})
        },
        conversationId: request.conversationId,
        messageId: randomUUID(),
        participantId: member.participant.id,
        requester: `@${member.participant.handle}`,
        chatTitle: member.chatTitle,
        text,
        requestKey,
        webhookToken: randomBytes(18).toString("base64url"),
        ...(phone ? { nextCallAt: this.now().getTime() + settings.waitMinutes * (this.options.minuteMs ?? 60_000) } : {})
      };
      await this.storage().runSql(`insert into urgent_alerts(id, request_key, conversation_id, state, record_json, created_at, updated_at) values (
        ${quote(id)}, ${quote(requestKey)}, ${quote(record.conversationId)}, ${quote(record.view.state)}, ${quote(JSON.stringify(record))}, ${quote(createdAt)}, ${quote(createdAt)});`);
      try {
        await this.writeCard(record, { strict: true });
      } catch (error) {
        // No card, no alert: the member's retry (same request id) raises it again.
        await this.storage().runSql(`delete from urgent_alerts where id = ${quote(id)};`).catch(() => undefined);
        throw error;
      }
      this.log("hub.alert.raised", { alertId: id, conversationId: record.conversationId, participantId: record.participantId, telegram, phone });
      return { record, fresh: true };
    });
    if (raised.fresh) {
      void this.deliverTelegram(raised.record.view.id).catch((error: unknown) => this.log("hub.alert.telegram.error", { alertId: raised.record.view.id, message: messageOf(error) }));
      this.reschedule();
    }
    const settings = await this.settings();
    return {
      ok: true,
      value: {
        alertId: raised.record.view.id,
        messageId: raised.record.messageId,
        state: raised.record.view.state,
        telegram: Boolean(settings.telegram?.connected),
        phone: raised.record.view.phone
      }
    };
  }

  private async member(device: HubDevice, conversationId: unknown, participantId: unknown): Promise<{ participant: ChatParticipant; chatTitle: string } | UrgentAlertError> {
    if (typeof conversationId !== "string" || typeof participantId !== "string" || !conversationId || !participantId) {
      return { code: "invalid_request", message: "An alert names the chat and the member that raises it." };
    }
    const chat = await this.options.storage.conversationAccess(conversationId);
    if (!chat || chat.kind !== "chat") return { code: "access_denied", message: "The server has no such chat (yet)." };
    const participants = chat.participants as ChatParticipant[];
    const participant = participants.find((item) => item?.id === participantId);
    if (!participant) return { code: "access_denied", message: "This member is not in the chat." };
    const devices = await this.options.storage.hub().devices();
    if (homeDeviceId({ metadata: { participants } } as unknown as Conversation, participant.id, devices) !== device.deviceId) {
      return { code: "access_denied", message: `@${participant.handle} runs on another device; only that device raises its alerts.` };
    }
    const titles = await this.options.storage.conversationTitles([conversationId]).catch(() => ({} as Record<string, string>));
    return { participant, chatTitle: titles[conversationId] ?? "" };
  }

  /** The User closes the card in the app: an alert still waiting counts as
   *  seen (no call); any alert folds away on every device. */
  private async closeAlert(device: HubDevice, alertId: unknown): Promise<HubAlertResult<UrgentAlertView>> {
    if (typeof alertId !== "string" || !alertId) return failure("invalid_request", "Which alert?");
    const record = await this.record(alertId);
    if (!record) return failure("invalid_request", "There is no such alert.");
    if (device.role === "phone" && !scopeCovers(device.scope, record.conversationId)) return failure("access_denied", "This phone does not show that chat.");
    const view = await this.acknowledge(alertId, "app", { close: true });
    return view ? { ok: true, value: view } : failure("invalid_request", "There is no such alert.");
  }

  // --- the alert's course -------------------------------------------------------

  /** Got it from anywhere. The first reaction is the one; later ones change
   *  nothing but, from the app, fold the card. */
  private async acknowledge(alertId: string, source: UrgentAlertAckSource, options: { close?: boolean } = {}): Promise<UrgentAlertView | undefined> {
    const outcome = await this.serialize(async () => {
      const record = await this.record(alertId);
      if (!record) return undefined;
      const view = record.view;
      const acknowledgedNow = ACKNOWLEDGEABLE.has(view.state);
      const ringing = record.callSid;
      if (acknowledgedNow) {
        view.state = "acknowledged";
        view.ackedAt = this.now().toISOString();
        view.ackSource = source;
        delete view.callAt;
        delete record.nextCallAt;
        if (record.callSid) {
          this.stopPolling(alertId);
          const call = view.calls[view.calls.length - 1];
          if (call && !call.endedAt) {
            call.status = "completed";
            call.endedAt = view.ackedAt;
          }
        }
        delete record.callSid;
      }
      if (options.close && !view.closedAt) view.closedAt = this.now().toISOString();
      if (!acknowledgedNow && !options.close) return { record, changed: false, ringing: undefined };
      await this.save(record);
      await this.writeCard(record);
      this.log("hub.alert.acknowledged", { alertId, source, acknowledgedNow, closed: options.close === true });
      return { record, changed: acknowledgedNow, ringing: acknowledgedNow ? ringing : undefined };
    });
    if (!outcome) return undefined;
    if (outcome.changed) {
      this.reschedule();
      // A call still ringing when she reacted elsewhere stops ringing.
      if (outcome.ringing && source !== "call") void this.endCall(outcome.ringing);
      void this.editTelegram(outcome.record).catch(() => undefined);
    }
    return outcome.record.view;
  }

  private async deliverTelegram(alertId: string): Promise<void> {
    const settings = await this.settings();
    const telegram = settings.telegram;
    const record = await this.record(alertId);
    if (!record || !telegram?.connected || telegram.chatId === undefined) return;
    let sentAt: string | undefined;
    let error: string | undefined;
    let messageId: number | undefined;
    try {
      messageId = await this.bot(telegram).sendMessage(telegram.chatId, telegramText(record, settings), [{ text: "Got it", data: `ack:${alertId}` }]);
      sentAt = this.now().toISOString();
    } catch (failure) {
      error = failure instanceof AlertChannelError ? failure.message : "Telegram could not be reached.";
      this.log("hub.alert.telegram.failed", { alertId, message: messageOf(failure) });
    }
    await this.serialize(async () => {
      const current = await this.record(alertId);
      if (!current) return;
      current.view.telegram = { ...(sentAt ? { sentAt } : {}), ...(error ? { error } : {}) };
      if (messageId !== undefined) {
        current.telegramMessageId = messageId;
        current.telegramChatId = telegram.chatId;
      }
      // Nowhere else to go: the alert stays only in the chat.
      if (error && !current.view.phone && current.view.state === "waiting") current.view.state = "failed";
      await this.save(current);
      await this.writeCard(current);
    });
    // Got it may have come from the app while the message was on its way.
    const after = await this.record(alertId);
    if (after && messageId !== undefined && after.view.state === "acknowledged") void this.editTelegram(after).catch(() => undefined);
  }

  private async editTelegram(record: AlertRecord): Promise<void> {
    if (record.telegramMessageId === undefined || record.telegramChatId === undefined) return;
    const settings = await this.settings();
    if (!settings.telegram) return;
    const text = telegramText(record, settings);
    const bot = this.bot(settings.telegram);
    if (record.view.state === "acknowledged") {
      await bot.editMessageText(record.telegramChatId, record.telegramMessageId, text);
    } else {
      await bot.editMessageText(record.telegramChatId, record.telegramMessageId, text, [{ text: "Got it", data: `ack:${record.view.id}` }]);
    }
  }

  /** Places the calls that are due, then waits for the next one. */
  private reschedule(): void {
    if (this.closed) return;
    void this.serialize(async () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      const due = (await this.openRecords()).filter((record) => record.nextCallAt !== undefined && !record.callSid);
      if (!due.length) return;
      const next = Math.min(...due.map((record) => record.nextCallAt as number));
      const wait = Math.max(0, Math.min(next - this.now().getTime(), 2 ** 31 - 1));
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.callDue().catch((error: unknown) => this.log("hub.alert.call.error", { message: messageOf(error) }));
      }, wait);
      this.timer.unref?.();
    }).catch((error: unknown) => this.log("hub.alert.schedule.error", { message: messageOf(error) }));
  }

  private async callDue(): Promise<void> {
    const nowMs = this.now().getTime();
    const due = (await this.openRecords()).filter((record) => record.nextCallAt !== undefined && record.nextCallAt <= nowMs && !record.callSid);
    for (const record of due) await this.placeCall(record.view.id);
    this.reschedule();
  }

  private async placeCall(alertId: string): Promise<void> {
    const settings = await this.settings();
    const placed = await this.serialize(async () => {
      const record = await this.record(alertId);
      if (!record || !OPEN_STATES.includes(record.view.state) || record.callSid || record.nextCallAt === undefined) return undefined;
      if (await this.options.storage.conversationTombstones().isDeleted(record.conversationId)) {
        // Its chat is gone: nobody can close it any more, so nothing rings.
        delete record.nextCallAt;
        delete record.view.callAt;
        record.view.state = "unanswered";
        await this.save(record);
        this.log("hub.alert.chat-deleted", { alertId });
        return undefined;
      }
      const attempt = record.view.calls.length + 1;
      const startedAt = this.now().toISOString();
      delete record.nextCallAt;
      delete record.view.callAt;
      if (!settings.phone) {
        // The phone was disconnected while it waited: Telegram is all there is.
        record.view.phone = false;
        record.view.state = "waiting";
        await this.save(record);
        await this.writeCard(record);
        return undefined;
      }
      const mode = this.callMode(settings);
      record.view.callMode = mode;
      const twiml = callTwiml(mode, spokenAlert(record.requester, record.chatTitle, record.text), this.keypadUrl(settings, record));
      try {
        const call = await this.twilio(settings.phone).createCall({ to: settings.phone.to, from: settings.phone.from, twiml, ringSeconds: URGENT_ALERT_RING_SECONDS });
        record.callSid = call.sid;
        record.view.calls.push({ attempt, startedAt, status: call.status as UrgentAlertCallStatus });
        record.view.state = "calling";
      } catch (error) {
        const reason = error instanceof AlertChannelError ? error.message : "Twilio could not be reached.";
        record.view.calls.push({ attempt, startedAt, status: "failed", endedAt: startedAt, error: reason });
        this.log("hub.alert.call.failed", { alertId, attempt, message: messageOf(error) });
        this.afterCallEnded(record);
      }
      await this.save(record);
      await this.writeCard(record);
      return record;
    });
    if (!placed) return;
    void this.editTelegram(placed).catch(() => undefined);
    if (placed.callSid) this.pollCall(alertId, placed.callSid);
  }

  /** A call that ended without Got it: another in a few minutes, or none left. */
  private afterCallEnded(record: AlertRecord): void {
    delete record.callSid;
    if (record.view.calls.length < URGENT_ALERT_CALL_ATTEMPTS) {
      const retryMs = this.options.callRetryMs ?? URGENT_ALERT_CALL_RETRY_MS;
      record.nextCallAt = this.now().getTime() + retryMs;
      record.view.callAt = new Date(record.nextCallAt).toISOString();
      record.view.state = "calling";
    } else {
      record.view.state = "unanswered";
      delete record.view.callAt;
    }
  }

  private pollCall(alertId: string, sid: string): void {
    if (this.closed) return;
    this.stopPolling(alertId);
    const startedAt = this.now().getTime();
    const tick = (): void => {
      this.polls.delete(alertId);
      void this.checkCall(alertId, sid, startedAt).then((again) => {
        if (again && !this.closed) {
          const poll = setTimeout(tick, this.options.callPollMs ?? 4_000);
          poll.unref?.();
          this.polls.set(alertId, poll);
        }
      }, (error: unknown) => {
        this.log("hub.alert.poll.error", { alertId, message: messageOf(error) });
        if (!this.closed) {
          const poll = setTimeout(tick, (this.options.callPollMs ?? 4_000) * 3);
          poll.unref?.();
          this.polls.set(alertId, poll);
        }
      });
    };
    const poll = setTimeout(tick, this.options.callPollMs ?? 4_000);
    poll.unref?.();
    this.polls.set(alertId, poll);
  }

  private stopPolling(alertId: string): void {
    const poll = this.polls.get(alertId);
    if (poll) clearTimeout(poll);
    this.polls.delete(alertId);
  }

  /** One look at a call; true while it still rings or talks. */
  private async checkCall(alertId: string, sid: string, pollingSince: number): Promise<boolean> {
    const settings = await this.settings();
    let status: UrgentAlertCallStatus;
    if (!settings.phone) {
      // Disconnected while it rang: nothing can ask Twilio any more.
      status = "canceled";
    } else {
      try {
        status = (await this.twilio(settings.phone).call(sid)).status;
      } catch (error) {
        // Lost for minutes: counted as a call that ended unanswered.
        if (this.now().getTime() - pollingSince < 10 * 60_000) throw error;
        status = "failed";
      }
    }
    const final = TWILIO_FINAL_STATUSES.has(status);
    const ended = await this.serialize(async () => {
      const record = await this.record(alertId);
      if (!record || record.callSid !== sid) return { stop: true, record: undefined };
      const call = record.view.calls[record.view.calls.length - 1];
      const changed = call && call.status !== status;
      if (call) call.status = status;
      if (!final) {
        if (changed) {
          await this.save(record);
          await this.writeCard(record);
        }
        return { stop: false, record: undefined };
      }
      if (call) call.endedAt = this.now().toISOString();
      if (record.view.callMode === "answer" && status === "completed") {
        // No key can be heard without a server Twilio reaches: answering is it.
        record.view.state = "acknowledged";
        record.view.ackedAt = this.now().toISOString();
        record.view.ackSource = "call";
        delete record.callSid;
      } else {
        this.afterCallEnded(record);
      }
      await this.save(record);
      await this.writeCard(record);
      return { stop: true, record };
    });
    if (ended.record) {
      this.reschedule();
      void this.editTelegram(ended.record).catch(() => undefined);
    }
    return !ended.stop;
  }

  private async endCall(sid: string): Promise<void> {
    const settings = await this.settings();
    if (!settings.phone) return;
    try {
      const call = await this.twilio(settings.phone).call(sid);
      if (TWILIO_FINAL_STATUSES.has(call.status)) return;
      await this.twilio(settings.phone).endCall(sid, call.status === "queued" || call.status === "ringing" || call.status === "initiated");
    } catch (error) {
      this.log("hub.alert.call.end-failed", { message: messageOf(error) });
    }
  }

  // --- Twilio's key presses -----------------------------------------------------

  /** The address Twilio posts a key to, with the alert and its token. */
  private keypadUrl(settings: StoredSettings, record: AlertRecord): string {
    const base = (this.options.publicUrlOverride ?? settings.publicUrl ?? "").replace(/\/+$/, "");
    return `${base}${HUB_ALERTS_TWILIO_PATH}?${new URLSearchParams({ alert: record.view.id, token: record.webhookToken }).toString()}`;
  }

  /** A key pressed on an alert's call (POST from Twilio, signed by it). */
  async twilioKey(url: URL, body: Buffer, signature: string | undefined): Promise<{ status: number; twiml: string }> {
    await this.init();
    const settings = await this.settings();
    const alertId = url.searchParams.get("alert") ?? "";
    const record = alertId ? await this.record(alertId) : undefined;
    const params = Object.fromEntries(new URLSearchParams(body.toString("utf8")).entries());
    const base = (this.options.publicUrlOverride ?? settings.publicUrl ?? "").replace(/\/+$/, "");
    if (!settings.phone || !record || url.searchParams.get("token") !== record.webhookToken ||
      !validTwilioSignature(settings.phone.authToken, `${base}${url.pathname}${url.search}`, params, signature)) {
      this.log("hub.alert.twilio.refused", { alertId, hasRecord: Boolean(record) });
      return { status: 403, twiml: "" };
    }
    const digits = params.Digits ?? "";
    if (digits === "1") {
      await this.acknowledge(alertId, "call");
      return { status: 200, twiml: confirmedTwiml() };
    }
    return { status: 200, twiml: callTwiml("keypad", spokenAlert(record.requester, record.chatTitle, record.text), this.keypadUrl(settings, record)) };
  }

  // --- Telegram -------------------------------------------------------------------

  private bot(telegram: StoredTelegram): TelegramBot {
    return new TelegramBot(telegram.token, this.fetchImpl, this.options.telegramBaseUrl);
  }

  private twilio(phone: StoredPhone): TwilioClient {
    return new TwilioClient(phone.accountSid, phone.authToken, this.fetchImpl, this.options.twilioBaseUrl);
  }

  /** Reads the bot's updates while a bot is set: Start, Got it. */
  private async restartTelegram(): Promise<void> {
    const settings = await this.settings();
    const token = settings.telegram && !settings.telegram.error ? settings.telegram.token : undefined;
    if (token === this.telegramToken && this.telegramLoop && !this.telegramLoop.signal.aborted) return;
    this.telegramLoop?.abort();
    this.telegramLoop = undefined;
    this.telegramToken = token;
    if (!token || this.closed) return;
    const loop = new AbortController();
    this.telegramLoop = loop;
    void this.readTelegram(token, loop.signal);
  }

  private async readTelegram(token: string, signal: AbortSignal): Promise<void> {
    const bot = new TelegramBot(token, this.fetchImpl, this.options.telegramBaseUrl);
    const stored = (await this.settings()).telegram;
    let offset = stored?.token === token ? stored.offset : undefined;
    while (!signal.aborted && !this.closed) {
      try {
        const updates = await bot.getUpdates(offset, this.options.telegramWaitSeconds ?? 25, signal);
        for (const update of updates) {
          offset = update.update_id + 1;
          await this.telegramUpdate(bot, update).catch((error: unknown) => this.log("hub.alert.telegram.update-error", { message: messageOf(error) }));
        }
        if (updates.length) {
          await this.updateSettings((settings) => {
            if (settings.telegram?.token === token) settings.telegram.offset = offset;
          });
        }
      } catch (error) {
        if (signal.aborted || this.closed) return;
        if (error instanceof AlertChannelError && error.badCredentials) {
          await this.updateSettings((settings) => {
            if (settings.telegram?.token === token) settings.telegram.error = "Telegram no longer accepts this bot's token. Connect Telegram again.";
          });
          this.log("hub.alert.telegram.revoked", {});
          return;
        }
        if (error instanceof AlertChannelError && error.status === 409) await bot.deleteWebhook().catch(() => undefined);
        this.log("hub.alert.telegram.read-failed", { message: messageOf(error) });
        await delay(15_000, signal);
      }
    }
  }

  private async telegramUpdate(bot: TelegramBot, update: TelegramUpdate): Promise<void> {
    const settings = await this.settings();
    const telegram = settings.telegram;
    if (!telegram) return;
    const message = update.message;
    if (message?.text?.trim().startsWith("/start")) {
      const code = message.text.trim().slice("/start".length).trim();
      if (telegram.step === "start" && !telegram.connected && telegram.startCode && code !== telegram.startCode) {
        // Someone opened the bot without the owner's link: it connects nobody.
        await bot.sendMessage(message.chat.id, "To connect, open this bot with the button in AccordAgents: Settings → Alerts → Connect Telegram.");
        return;
      }
      if (telegram.step === "start" && !telegram.connected) {
        const nonce = randomBytes(9).toString("base64url");
        const chatName = message.from?.first_name ?? message.chat.first_name ?? message.from?.username ?? "";
        const testMessageId = await bot.sendMessage(message.chat.id,
          "AccordAgents alerts will come to this chat. Press Got it to finish connecting.",
          [{ text: "Got it", data: `test:${nonce}` }]);
        await this.updateSettings((current) => {
          if (current.telegram?.token !== telegram.token) return;
          current.telegram.chatId = message.chat.id;
          current.telegram.chatName = chatName;
          current.telegram.step = "test";
          delete current.telegram.startCode;
          current.telegram.testNonce = nonce;
          current.telegram.testMessageId = testMessageId;
        });
      } else if (telegram.chatId === message.chat.id) {
        await bot.sendMessage(message.chat.id, "This chat is connected: urgent alerts from AccordAgents come here.");
      }
      return;
    }
    const callback = update.callback_query;
    if (!callback?.data) return;
    const chatId = callback.message?.chat.id;
    if (chatId === undefined || chatId !== telegram.chatId) {
      await bot.answerCallbackQuery(callback.id).catch(() => undefined);
      return;
    }
    if (callback.data.startsWith("test:")) {
      const nonce = callback.data.slice(5);
      if (telegram.step === "test" && nonce === telegram.testNonce) {
        await this.updateSettings((current) => {
          if (current.telegram?.token !== telegram.token) return;
          current.telegram.connected = true;
          delete current.telegram.step;
          delete current.telegram.testNonce;
        });
        if (callback.message) await bot.editMessageText(chatId, callback.message.message_id, "Connected. Urgent alerts from AccordAgents will come to this chat.").catch(() => undefined);
        await bot.answerCallbackQuery(callback.id, "Connected").catch(() => undefined);
      } else {
        if (callback.message) await bot.editMessageText(chatId, callback.message.message_id, "Test alert from AccordAgents: it works.").catch(() => undefined);
        await bot.answerCallbackQuery(callback.id, "It works").catch(() => undefined);
      }
      return;
    }
    if (callback.data.startsWith("ack:")) {
      const alertId = callback.data.slice(4);
      const record = await this.record(alertId);
      if (!record || record.telegramChatId !== chatId) {
        await bot.answerCallbackQuery(callback.id).catch(() => undefined);
        return;
      }
      const wasOpen = ACKNOWLEDGEABLE.has(record.view.state);
      await this.acknowledge(alertId, "telegram");
      await bot.answerCallbackQuery(callback.id, wasOpen ? "Got it. No call." : undefined).catch(() => undefined);
    }
  }

  // --- settings -------------------------------------------------------------------

  private async settingsAction(request: HubAlertRequest): Promise<HubAlertResult<unknown>> {
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
        const bot = new TelegramBot(token, this.fetchImpl, this.options.telegramBaseUrl);
        const me = await bot.getMe();
        await bot.deleteWebhook().catch(() => undefined);
        const settings = await this.updateSettings((current) => {
          current.telegram = { token, botUsername: me.username ?? "", connected: false, step: "start", startCode: randomBytes(12).toString("base64url") };
        });
        await this.restartTelegram();
        return { ok: true, value: this.settingsView(settings) };
      }
      case "telegram.disconnect": {
        const settings = await this.updateSettings((current) => {
          delete current.telegram;
        });
        await this.restartTelegram();
        return { ok: true, value: this.settingsView(settings) };
      }
      case "telegram.test": {
        const settings = await this.settings();
        const telegram = settings.telegram;
        if (!telegram?.connected || telegram.chatId === undefined) return failure("not_set_up", "Telegram is not connected.");
        await this.bot(telegram).sendMessage(telegram.chatId, "Test alert from AccordAgents. Press Got it to check the button.",
          [{ text: "Got it", data: `test:${randomBytes(9).toString("base64url")}` }]);
        return { ok: true, value: this.settingsView(settings) };
      }
      case "phone.check": {
        const credentials = twilioCredentials(request.accountSid, request.authToken);
        if (!credentials) return failure("invalid_request", "Paste the Account SID (starts with AC) and the Auth Token from the Twilio Console.");
        const client = new TwilioClient(credentials.accountSid, credentials.authToken, this.fetchImpl, this.options.twilioBaseUrl);
        const account = await client.account();
        const numbers = await client.incomingNumbers();
        const value: UrgentAlertPhoneCheck = { accountName: account.friendlyName, trial: account.type === "Trial", numbers: numbers.map((number) => number.phoneNumber) };
        return { ok: true, value };
      }
      case "phone.buy": {
        const credentials = twilioCredentials(request.accountSid, request.authToken);
        if (!credentials) return failure("invalid_request", "Paste the Account SID and the Auth Token first.");
        const client = new TwilioClient(credentials.accountSid, credentials.authToken, this.fetchImpl, this.options.twilioBaseUrl);
        const available = await client.availableNumber("US");
        if (!available) return failure("channel_failed", "Twilio has no US number to offer right now. Try again later, or buy one in the Twilio Console.");
        const bought = await client.buyNumber(available);
        return { ok: true, value: { number: bought.phoneNumber } };
      }
      case "phone.save": {
        const credentials = twilioCredentials(request.accountSid, request.authToken);
        if (!credentials) return failure("invalid_request", "Paste the Account SID and the Auth Token first.");
        const from = normalizePhoneNumber(String(request.from ?? ""));
        const to = normalizePhoneNumber(String(request.to ?? ""));
        if (!from) return failure("invalid_request", "Choose the number to call from.");
        if (!to) return failure("invalid_request", "Enter your phone with the country code, like +357 99 123456.");
        const account = await new TwilioClient(credentials.accountSid, credentials.authToken, this.fetchImpl, this.options.twilioBaseUrl).account();
        const settings = await this.updateSettings((current) => {
          current.phone = { ...credentials, from, to, trial: account.type === "Trial" };
        });
        return { ok: true, value: this.settingsView(settings) };
      }
      case "phone.test": {
        const settings = await this.settings();
        if (!settings.phone) return failure("not_set_up", "No phone is connected.");
        await this.twilio(settings.phone).createCall({
          to: settings.phone.to,
          from: settings.phone.from,
          twiml: readOutTwiml("This is a test call from AccordAgents. Urgent alerts will be read out like this."),
          ringSeconds: URGENT_ALERT_RING_SECONDS
        });
        return { ok: true, value: this.settingsView(settings) };
      }
      case "phone.disconnect":
        return { ok: true, value: this.settingsView(await this.updateSettings((current) => { delete current.phone; })) };
      default:
        return failure("invalid_request", `Unknown alert action: ${String((request as { action?: unknown }).action).slice(0, 40)}.`);
    }
  }

  private callMode(settings: StoredSettings): "keypad" | "answer" {
    return !this.options.embedded && (this.options.publicUrlOverride ?? settings.publicUrl) ? "keypad" : "answer";
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
          ...(settings.telegram.error ? { error: settings.telegram.error } : {})
        }
      } : {}),
      ...(settings.phone ? {
        phone: {
          from: settings.phone.from,
          to: settings.phone.to,
          trial: settings.phone.trial,
          ...(settings.phone.error ? { error: settings.phone.error } : {})
        }
      } : {}),
      waitMinutes: settings.waitMinutes,
      callMode: this.callMode(settings)
    };
  }

  private async settings(): Promise<StoredSettings> {
    const stored = (await this.options.storage.hub().document(SETTINGS_DOCUMENT))?.value as Partial<StoredSettings> | undefined;
    const waitMinutes = typeof stored?.waitMinutes === "number" ? stored.waitMinutes : URGENT_ALERT_DEFAULT_WAIT_MINUTES;
    return { ...(stored ?? {}), version: 1, waitMinutes } as StoredSettings;
  }

  private settingsQueue: Promise<unknown> = Promise.resolve();

  /** Settings change one at a time (the Telegram reader writes them too). */
  private updateSettings(change: (settings: StoredSettings) => void): Promise<StoredSettings> {
    const run = this.settingsQueue.then(async () => {
      const settings = await this.settings();
      change(settings);
      await this.options.storage.hub().setDocument(SETTINGS_DOCUMENT, settings, this.now().toISOString());
      return settings;
    });
    this.settingsQueue = run.catch(() => undefined);
    return run;
  }

  // --- records and the card -----------------------------------------------------

  private async record(alertId: string): Promise<AlertRecord | undefined> {
    const rows = await this.storage().queryJson<{ record: string }>(`select record_json as record from urgent_alerts where id = ${quote(alertId)};`);
    return rows[0] ? JSON.parse(rows[0].record) as AlertRecord : undefined;
  }

  private async recordByRequestKey(requestKey: string): Promise<AlertRecord | undefined> {
    const rows = await this.storage().queryJson<{ record: string }>(`select record_json as record from urgent_alerts where request_key = ${quote(requestKey)};`);
    return rows[0] ? JSON.parse(rows[0].record) as AlertRecord : undefined;
  }

  private async openRecords(): Promise<AlertRecord[]> {
    const rows = await this.storage().queryJson<{ record: string }>(
      `select record_json as record from urgent_alerts where state in (${OPEN_STATES.map(quote).join(", ")}) order by created_at;`);
    return rows.map((row) => JSON.parse(row.record) as AlertRecord);
  }

  private async save(record: AlertRecord): Promise<void> {
    await this.storage().runSql(`update urgent_alerts set state = ${quote(record.view.state)}, record_json = ${quote(JSON.stringify(record))},
      updated_at = ${quote(this.now().toISOString())} where id = ${quote(record.view.id)};`);
  }

  /** The alert's card in its chat, as the server writes it. `strict`: a
   *  refusal fails (raising an alert in a chat the server cannot write to). */
  private async writeCard(record: AlertRecord, options: { strict?: boolean } = {}): Promise<void> {
    const message: ChatMessage = {
      id: record.messageId,
      role: "participant",
      participantId: record.participantId,
      participantLabel: record.requester,
      content: record.text,
      createdAt: record.view.createdAt,
      status: "done",
      metadata: { urgentAlert: record.view }
    };
    const outcome = await this.options.ops.writeServerMessage(record.conversationId, message);
    if ("refused" in outcome) {
      this.log("hub.alert.card.refused", { alertId: record.view.id, reason: outcome.refused });
      if (options.strict) throw new Error(outcome.refused);
    }
  }
}

/** What Telegram shows for an alert as it stands. */
export function telegramText(record: Pick<AlertRecord, "view" | "requester" | "chatTitle" | "text">, settings: Pick<StoredSettings, "waitMinutes">): string {
  const view = record.view;
  const done = view.state === "acknowledged";
  const head = `${done ? "✅" : "🔴"} Urgent alert · ${record.requester}${record.chatTitle ? ` · ${record.chatTitle}` : ""}`;
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

function twilioCredentials(accountSid: unknown, authToken: unknown): { accountSid: string; authToken: string } | undefined {
  const sid = typeof accountSid === "string" ? accountSid.trim() : "";
  const token = typeof authToken === "string" ? authToken.trim() : "";
  return /^AC[0-9a-fA-F]{32}$/.test(sid) && /^[0-9a-zA-Z]{32}$/.test(token) ? { accountSid: sid, authToken: token } : undefined;
}

function failure(code: UrgentAlertError["code"], message: string): { ok: false; error: UrgentAlertError } {
  return { ok: false, error: { code, message } };
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function quote(value: string): string {
  if (value.includes("\u0000")) throw new Error("A value with a NUL character cannot be stored.");
  return `'${value.replace(/'/g, "''")}'`;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
