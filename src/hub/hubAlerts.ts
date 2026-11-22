import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { StorageService } from "../main/services/storage";
import type { HubDevice } from "../shared/hubProtocol";
import type { ChatMessage, ChatParticipant, Conversation } from "../shared/types";
import {
  URGENT_ALERT_CALL_ATTEMPTS,
  URGENT_ALERT_CALL_RETRY_MS,
  URGENT_ALERT_ACKNOWLEDGEABLE_STATES,
  URGENT_ALERT_OPEN_STATES,
  URGENT_ALERT_DEFAULT_WAIT_MINUTES,
  URGENT_ALERT_MESSAGE_MAX_CHARS,
  URGENT_ALERT_RING_SECONDS,
  URGENT_ALERT_TEST_STALE_MS,
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
  type UrgentAlertPhoneTest,
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
import { chatViewFor, isChatViewMode } from "../shared/mainSession";
import { latestTaskByMember, sessionsMemberTitle } from "../shared/mainSessionView";
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

const OPEN_STATES: readonly string[] = URGENT_ALERT_OPEN_STATES;
/** States Got it still ends: an alert nobody answered can still be seen. */
const ACKNOWLEDGEABLE: ReadonlySet<string> = new Set(URGENT_ALERT_ACKNOWLEDGEABLE_STATES);

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
  /** Telegram refused the last message to her chat (she blocked the bot,
   *  deleted the chat): kept apart from `error`, which stops the reader,
   *  since the bot still hears her; cleared by the next message that goes. */
  deliveryError?: string;
  /** The next update to read from this bot (so a restart reads nothing
   *  twice); kept with the bot, since another bot numbers its own. */
  offset?: number;
  /** The last test message (the connect check or Send test message). */
  lastTest?: { at: string; gotIt: boolean };
  /** The Got it of the newest Send test message: an older one's does not
   *  stand for it. */
  lastTestNonce?: string;
}

interface StoredPhone {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  trial: boolean;
  accountName?: string;
  error?: string;
  /** The last test call of exactly this account, number and phone. */
  lastTest?: UrgentAlertPhoneTest;
}

/** A test call under way or just over (kept in memory: a test is for now). */
interface PhoneTestRun {
  id: string;
  /** In the key-press address Twilio posts to, beside its signature. */
  token: string;
  credentials: { accountSid: string; authToken: string };
  from: string;
  to: string;
  mode: "keypad" | "answer";
  sid?: string;
  result: UrgentAlertPhoneTest;
  startedAt: number;
}

/** How long a finished test call is remembered, and how many at most. */
const PHONE_TEST_KEEP_MS = 60 * 60_000;
const PHONE_TEST_KEEP_MAX = 20;
const PHONE_TEST_SPOKEN = "This is a test call from AccordAgents. Urgent alerts will be read out like this.";
const PHONE_KEYS_REFUSED = "Twilio no longer accepts these keys. Connect the phone again.";
/** A number bought for alerts is handed back, not bought again, when the
 *  same account asks within this time (an answer lost on the way, a second
 *  press while the first purchase still runs): each one is billed monthly. */
const PURCHASE_REUSE_MS = 10 * 60_000;

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
  /** How Telegram and the call name who raised it, when that is not its
   *  handle: a chat in the sessions view names a member by its task and the
   *  main session by nothing (""). */
  announcedAs?: string;
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
  telegramRetryMs?: number;
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
  private readonly tests = new Map<string, PhoneTestRun>();
  private readonly testPolls = new Set<ReturnType<typeof setTimeout>>();
  /** A test call being placed (before it is kept): one at a time. */
  private testStarting = false;
  /** The newest test call of each account, number and phone: only its result
   *  is that phone's last test (an older one that ends late does not
   *  overwrite it; a test of other numbers does not stop it). */
  private readonly latestTests = new Map<string, string>();
  /** Numbers bought per Twilio account, kept for PURCHASE_REUSE_MS. */
  private readonly purchases = new Map<string, { at: number; authToken: string; number: Promise<string> }>();
  /** When the message whose outcome Telegram's state last took was sent: a
   *  late answer about an older message does not undo a newer one's. */
  private telegramOutcomeAt = 0;
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
    // A test call ringing when the server stopped: nobody follows it any more,
    // so it must not read "calling" for ever (written only when it does).
    if ((await this.settings()).phone?.lastTest?.state === "calling") {
      await this.updateSettings((current) => {
        if (current.phone?.lastTest?.state === "calling" && ![...this.tests.values()].some((run) => run.result.state === "calling")) {
          current.phone.lastTest = { state: "failed", at: this.now().toISOString(), error: "The server restarted during the test call. Call again.", lost: true };
        }
      }).catch((error: unknown) => this.log("hub.alert.test.reconcile-failed", { message: messageOf(error) }));
    }
    this.reschedule();
    await this.restartTelegram();
  }

  /** Stops timers and readers, and waits for the change under way (so the
   *  storage is not taken away under it). */
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.cardRetries.values()) clearTimeout(timer);
    this.cardRetries.clear();
    if (this.timer) clearTimeout(this.timer);
    for (const poll of this.polls.values()) clearTimeout(poll);
    this.polls.clear();
    for (const poll of this.testPolls) clearTimeout(poll);
    this.purchases.clear();
    this.testPolls.clear();
    this.telegramLoop?.abort();
    await Promise.race([
      Promise.all([this.queue, this.settingsQueue]).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 5_000).unref?.())
    ]);
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
    // Nothing new starts once closing: the storage is going away.
    const run = this.queue.then(() => this.closed ? Promise.reject(new Error("Urgent alerts are closing.")) : work());
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
      const dueAt = phone ? this.now().getTime() + settings.waitMinutes * (this.options.minuteMs ?? 60_000) : undefined;
      const id = randomUUID();
      const record: AlertRecord = {
        view: {
          id,
          state: telegram || phone ? "waiting" : "not_set_up",
          createdAt,
          calls: [],
          phone,
          callMode: this.callMode(settings),
          ...(dueAt !== undefined ? { callAt: new Date(dueAt).toISOString() } : {})
        },
        conversationId: request.conversationId,
        messageId: randomUUID(),
        participantId: member.participant.id,
        requester: `@${member.participant.handle}`,
        ...(member.announcedAs !== undefined ? { announcedAs: member.announcedAs } : {}),
        chatTitle: member.chatTitle,
        text,
        requestKey,
        webhookToken: randomBytes(18).toString("base64url"),
        ...(dueAt !== undefined ? { nextCallAt: dueAt } : {})
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

  private async member(device: HubDevice, conversationId: unknown, participantId: unknown): Promise<{ participant: ChatParticipant; chatTitle: string; announcedAs?: string } | UrgentAlertError> {
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
    const announcedAs = await this.announcedAs(conversationId, chat, participant).catch(() => undefined);
    return { participant, chatTitle: titles[conversationId] ?? "", ...(announcedAs !== undefined ? { announcedAs } : {}) };
  }

  /** How the alert's outside channels name the member: undefined (its
   *  handle) in the classic view; in the sessions view (docs/main-session.md)
   *  the main session by nothing and a member by its task's title. */
  private async announcedAs(
    conversationId: string,
    chat: { participants: unknown[]; mainSessionParticipantId?: string; chatView?: string },
    participant: ChatParticipant
  ): Promise<string | undefined> {
    const metadata = { participants: chat.participants as ChatParticipant[], mainSessionParticipantId: chat.mainSessionParticipantId,
      chatView: isChatViewMode(chat.chatView) ? chat.chatView : undefined };
    if (chatViewFor(metadata) !== "sessions") return undefined;
    if (participant.id === metadata.mainSessionParticipantId) return "";
    const messages = await this.options.storage.memberTaskMessages(conversationId, participant.id);
    return sessionsMemberTitle(participant, latestTaskByMember(messages).get(participant.id)?.item);
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
            // Pressed 1 on it: it was answered; reacted elsewhere: it is stopped.
            call.status = source === "call" ? "completed" : "canceled";
            call.endedAt = view.ackedAt;
          }
        }
        delete record.callSid;
      }
      const closingNow = Boolean(options.close && !view.closedAt);
      if (closingNow) view.closedAt = this.now().toISOString();
      if (!acknowledgedNow && !closingNow) return { record, changed: false, ringing: undefined };
      await this.save(record);
      await this.writeCard(record);
      this.log("hub.alert.acknowledged", { alertId, source, acknowledgedNow, closed: options.close === true });
      return { record, changed: acknowledgedNow, ringing: acknowledgedNow ? ringing : undefined };
    });
    if (!outcome) return undefined;
    if (outcome.changed) {
      this.reschedule();
      // A call still ringing when she reacted elsewhere stops ringing.
      if (outcome.ringing && source !== "call") void this.endCall(outcome.ringing).catch((error: unknown) => this.log("hub.alert.call.end-failed", { message: messageOf(error) }));
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
    let attemptAt = Date.now();
    // A failure that may pass (no network, too many requests, Telegram's own
    // trouble) is tried again a few times; a refusal is not.
    for (let attempt = 1; ; attempt += 1) {
      attemptAt = Date.now();
      try {
        messageId = await this.bot(telegram).sendMessage(telegram.chatId, telegramText(record, settings), [{ text: "Got it", data: `ack:${alertId}` }]);
        sentAt = this.now().toISOString();
        break;
      } catch (failure) {
        const status = failure instanceof AlertChannelError ? failure.status : 0;
        const passing = status === 0 || status === 429 || status >= 500;
        if (passing && attempt < 4 && !this.closed) {
          this.log("hub.alert.telegram.retry", { alertId, attempt, status });
          await delay((this.options.telegramRetryMs ?? 5_000) * attempt, new AbortController().signal);
          continue;
        }
        error = failure instanceof AlertChannelError ? failure.message : "Telegram could not be reached.";
        this.log("hub.alert.telegram.failed", { alertId, message: messageOf(failure) });
        await this.telegramDelivered(telegram.token, attemptAt, failure);
        break;
      }
    }
    if (sentAt) await this.telegramDelivered(telegram.token, attemptAt);
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
    try {
      for (const record of due) {
        await this.placeCall(record.view.id).catch((error: unknown) => this.log("hub.alert.call.error", { alertId: record.view.id, message: messageOf(error) }));
      }
    } finally {
      this.reschedule();
    }
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
      const twiml = callTwiml(mode, spokenAlert(record.announcedAs ?? record.requester, record.chatTitle, record.text), this.keypadUrl(settings, record));
      try {
        const call = await this.twilio(settings.phone).createCall({ to: settings.phone.to, from: settings.phone.from, twiml, ringSeconds: URGENT_ALERT_RING_SECONDS });
        record.callSid = call.sid;
        record.view.calls.push({ attempt, startedAt, status: call.status });
        record.view.state = "calling";
      } catch (error) {
        const reason = error instanceof AlertChannelError ? error.message : "Twilio could not be reached.";
        record.view.calls.push({ attempt, startedAt, status: "failed", endedAt: startedAt, error: reason });
        this.log("hub.alert.call.failed", { alertId, attempt, message: messageOf(error) });
        if (error instanceof AlertChannelError && error.badCredentials) {
          void this.updateSettings((current) => {
            if (current.phone) current.phone.error = PHONE_KEYS_REFUSED;
          }).catch(() => undefined);
        }
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
    let failingSince: number | undefined;
    const tick = (): void => {
      this.polls.delete(alertId);
      void this.checkCall(alertId, sid, failingSince).then((again) => {
        failingSince = undefined;
        if (again && !this.closed) {
          const poll = setTimeout(tick, this.options.callPollMs ?? 4_000);
          poll.unref?.();
          this.polls.set(alertId, poll);
        }
      }, (error: unknown) => {
        failingSince ??= this.now().getTime();
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
  private async checkCall(alertId: string, sid: string, failingSince: number | undefined): Promise<boolean> {
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
        if (failingSince === undefined || this.now().getTime() - failingSince < 10 * 60_000) throw error;
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
        // Queued, ringing or talking all read "Calling you now": the card is
        // written again only when the call ends.
        if (changed) await this.save(record);
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

  /** Where Twilio reaches this server: the key-press address is built and
   *  its signature checked from this one place. */
  private publicBase(settings: StoredSettings): string {
    return (this.options.publicUrlOverride || settings.publicUrl || "").replace(/\/+$/, "");
  }

  /** The address Twilio posts a key to, with the alert and its token. */
  private keypadUrl(settings: StoredSettings, record: AlertRecord): string {
    const base = this.publicBase(settings);
    return `${base}${HUB_ALERTS_TWILIO_PATH}?${new URLSearchParams({ alert: record.view.id, token: record.webhookToken }).toString()}`;
  }

  /** A key pressed on an alert's call (POST from Twilio, signed by it). */
  async twilioKey(url: URL, body: Buffer, signature: string | undefined): Promise<{ status: number; twiml: string }> {
    await this.init();
    const settings = await this.settings();
    if (url.searchParams.has("test")) return this.testKey(url, body, signature, settings);
    const alertId = url.searchParams.get("alert") ?? "";
    const record = alertId ? await this.record(alertId) : undefined;
    const params = Object.fromEntries(new URLSearchParams(body.toString("utf8")).entries());
    const base = this.publicBase(settings);
    if (!settings.phone || !record || url.searchParams.get("token") !== record.webhookToken ||
      !validTwilioSignature(settings.phone.authToken, `${base}${url.pathname}${url.search}`, params, signature)) {
      this.log("hub.alert.twilio.refused", { alertId, hasRecord: Boolean(record) });
      return { status: 403, twiml: "" };
    }
    const digits = params.Digits ?? "";
    if (digits === "1") {
      // Twilio waits 15 s at most: answer it soon, let the rest finish after.
      const acknowledged = this.acknowledge(alertId, "call").catch((error: unknown) => {
        this.log("hub.alert.ack.error", { alertId, message: messageOf(error) });
        return undefined;
      });
      await Promise.race([acknowledged, new Promise((resolve) => setTimeout(resolve, 4_000).unref?.())]);
      return { status: 200, twiml: confirmedTwiml() };
    }
    return { status: 200, twiml: callTwiml("keypad", spokenAlert(record.announcedAs ?? record.requester, record.chatTitle, record.text), this.keypadUrl(settings, record)) };
  }

  // --- test calls -----------------------------------------------------------------

  /** Calls her with a short test: 1 on it (or, where no key can be heard,
   *  answering) proves calls reach her. Its result lands in the settings when
   *  it is a test of exactly the saved phone. */
  private async startTest(credentials: { accountSid: string; authToken: string }, from: string, to: string): Promise<PhoneTestRun | undefined> {
    // One test call at a time: each is billed, and two would ring at once
    // (one whose end never came stops counting once no call could last).
    const now = this.now().getTime();
    if (this.testStarting || [...this.tests.values()].some((run) => run.result.state === "calling" && now - run.startedAt < URGENT_ALERT_TEST_STALE_MS)) return undefined;
    this.testStarting = true;
    try {
      return await this.placeTest(credentials, from, to);
    } finally {
      this.testStarting = false;
    }
  }

  private async placeTest(credentials: { accountSid: string; authToken: string }, from: string, to: string): Promise<PhoneTestRun> {
    const settings = await this.settings();
    const mode = this.callMode(settings);
    const run: PhoneTestRun = {
      id: randomBytes(9).toString("base64url"),
      token: randomBytes(18).toString("base64url"),
      credentials,
      from,
      to,
      mode,
      result: { state: "calling", at: this.now().toISOString() },
      startedAt: this.now().getTime()
    };
    this.keepTest(run);
    this.latestTests.set(testKeyOf(run), run.id);
    const twiml = mode === "keypad"
      ? keypadTwiml(PHONE_TEST_SPOKEN, `${this.publicBase(settings)}${HUB_ALERTS_TWILIO_PATH}?${new URLSearchParams({ test: run.id, token: run.token }).toString()}`)
      : readOutTwiml(PHONE_TEST_SPOKEN);
    try {
      const call = await new TwilioClient(credentials.accountSid, credentials.authToken, this.fetchImpl, this.options.twilioBaseUrl)
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
        at: this.now().toISOString(),
        error: error instanceof AlertChannelError ? error.message : "Twilio could not be reached.",
        ...(unknown ? { lost: true } : {})
      };
      await this.keysRefused(error, credentials);
      await this.recordTest(run);
      return run;
    }
    await this.recordTest(run);
    this.pollTest(run, 0);
    return run;
  }

  private keepTest(run: PhoneTestRun): void {
    const now = this.now().getTime();
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
    if (this.closed || !run.sid) return;
    const timer = setTimeout(() => {
      this.testPolls.delete(timer);
      void new TwilioClient(run.credentials.accountSid, run.credentials.authToken, this.fetchImpl, this.options.twilioBaseUrl).call(run.sid as string)
        .then(async (call) => {
          if (!TWILIO_FINAL_STATUSES.has(call.status)) return this.pollTest(run, 0);
          await this.finishTest(run, call.status);
        }, async (error: unknown) => {
          this.log("hub.alert.test.poll-error", { message: messageOf(error) });
          // The keys were refused mid-call: that is known, and says the phone
          // needs attention. Lost for a few minutes: unknown, not "calling" for ever.
          if (error instanceof AlertChannelError && error.badCredentials) {
            await this.keysRefused(error, run.credentials);
            if (run.result.state === "calling") run.result = { state: "failed", at: this.now().toISOString(), error: error.message };
            await this.recordTest(run);
          } else if (failures >= 30) await this.finishTest(run, "failed", true);
          else this.pollTest(run, failures + 1);
        })
        .catch((error: unknown) => this.log("hub.alert.test.error", { message: messageOf(error) }));
    }, this.options.callPollMs ?? 4_000);
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
      run.result = { state, at: this.now().toISOString(), ...(lost ? { lost: true } : {}) };
    }
    await this.recordTest(run);
  }

  /** A test of exactly the saved account, number and phone is its last test. */
  private async recordTest(run: PhoneTestRun): Promise<void> {
    if (this.latestTests.get(testKeyOf(run)) !== run.id) return;
    await this.updateSettings((current) => {
      const phone = current.phone;
      if (phone && sameKeys(phone, run.credentials) && phone.from === run.from && phone.to === run.to) phone.lastTest = { ...run.result };
    }).catch((error: unknown) => this.log("hub.alert.test.record-failed", { message: messageOf(error) }));
  }

  /** A key pressed on a test call (POST from Twilio, signed with the keys the
   *  test was placed with: before Save they are not the saved ones). */
  private async testKey(url: URL, body: Buffer, signature: string | undefined, settings: StoredSettings): Promise<{ status: number; twiml: string }> {
    const run = this.tests.get(url.searchParams.get("test") ?? "");
    const params = Object.fromEntries(new URLSearchParams(body.toString("utf8")).entries());
    if (!run || !sameSecret(url.searchParams.get("token") ?? "", run.token) ||
      !validTwilioSignature(run.credentials.authToken, `${this.publicBase(settings)}${url.pathname}${url.search}`, params, signature)) {
      this.log("hub.alert.twilio.refused", { test: true, hasRun: Boolean(run) });
      return { status: 403, twiml: "" };
    }
    if ((params.Digits ?? "") === "1") {
      // 1 proves calls reach her, also on a call whose placing went unanswered.
      if (run.result.state === "calling" || run.result.lost) run.result = { state: "pressed", at: this.now().toISOString() };
      await Promise.race([this.recordTest(run), new Promise((resolve) => setTimeout(resolve, 4_000).unref?.())]);
      return { status: 200, twiml: confirmedTwiml() };
    }
    return { status: 200, twiml: keypadTwiml(PHONE_TEST_SPOKEN, `${this.publicBase(settings)}${url.pathname}${url.search}`) };
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
    void this.readTelegram(token, loop.signal).catch((error: unknown) => {
      this.log("hub.alert.telegram.loop-failed", { message: messageOf(error) });
      // Read again later, unless something else took over meanwhile.
      if (this.telegramLoop === loop) {
        this.telegramLoop = undefined;
        this.telegramToken = undefined;
        setTimeout(() => { void this.restartTelegram().catch(() => undefined); }, 30_000).unref?.();
      }
    });
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
          if (this.telegramToken === token) {
            this.telegramLoop?.abort();
            this.telegramLoop = undefined;
            this.telegramToken = undefined;
          }
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
        // Start again in her chat (after unblocking the bot, say): a message
        // that goes through ends what a refused one said.
        const sentAt = Date.now();
        try {
          await bot.sendMessage(message.chat.id, "This chat is connected: urgent alerts from AccordAgents come here.");
        } catch (error) {
          await this.telegramDelivered(telegram.token, sentAt, error);
          throw error;
        }
        await this.telegramDelivered(telegram.token, sentAt);
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
          current.telegram.lastTest = { at: this.now().toISOString(), gotIt: true };
        });
        if (callback.message) await bot.editMessageText(chatId, callback.message.message_id, "Connected. Urgent alerts from AccordAgents will come to this chat.").catch(() => undefined);
        await bot.answerCallbackQuery(callback.id, "Connected").catch(() => undefined);
      } else {
        await this.updateSettings((current) => {
          if (current.telegram?.token === telegram.token && current.telegram.connected && nonce === current.telegram.lastTestNonce) {
            current.telegram.lastTest = { at: this.now().toISOString(), gotIt: true };
          }
        });
        if (callback.message) await bot.editMessageText(chatId, callback.message.message_id, "Test alert from AccordAgents: it works.").catch(() => undefined);
        await bot.answerCallbackQuery(callback.id, "It works").catch(() => undefined);
      }
      return;
    }
    if (callback.data.startsWith("ack:")) {
      const alertId = callback.data.slice(4);
      const record = await this.record(alertId);
      if (!record || (record.telegramChatId ?? telegram.chatId) !== chatId) {
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
        const nonce = randomBytes(9).toString("base64url");
        const sentAt = Date.now();
        try {
          await this.bot(telegram).sendMessage(telegram.chatId, "Test alert from AccordAgents. Press Got it to check the button.", [{ text: "Got it", data: `test:${nonce}` }]);
        } catch (error) {
          await this.telegramDelivered(telegram.token, sentAt, error);
          throw error;
        }
        await this.telegramDelivered(telegram.token, sentAt);
        const sent = await this.updateSettings((current) => {
          if (current.telegram?.token !== telegram.token) return;
          current.telegram.lastTest = { at: this.now().toISOString(), gotIt: false };
          current.telegram.lastTestNonce = nonce;
        });
        return { ok: true, value: this.settingsView(sent) };
      }
      case "phone.check": {
        const credentials = await this.phoneCredentials(request);
        if (!credentials) return failure("invalid_request", "Paste the Account SID (starts with AC) and the Auth Token from the Twilio Console.");
        const client = new TwilioClient(credentials.accountSid, credentials.authToken, this.fetchImpl, this.options.twilioBaseUrl);
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
        const account = await new TwilioClient(credentials.accountSid, credentials.authToken, this.fetchImpl, this.options.twilioBaseUrl).account()
          .catch(async (error: unknown) => {
            await this.keysRefused(error, credentials);
            throw error;
          });
        const keys = { accountSid: credentials.accountSid, authToken: credentials.authToken };
        // The test call she just made of exactly this (or the one kept for it).
        const tried = typeof request.testId === "string" ? this.tests.get(request.testId) : undefined;
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
        const run = await this.startTest({ accountSid: credentials.accountSid, authToken: credentials.authToken }, from, to);
        if (!run) return failure("invalid_request", "A test call is still ringing. Wait for it to end.");
        return { ok: true, value: { testId: run.id, test: run.result, callMode: run.mode } };
      }
      case "phone.try-status": {
        const run = typeof request.testId === "string" ? this.tests.get(request.testId) : undefined;
        if (!run) return failure("invalid_request", "That test call is no longer known. Call again.");
        // How calls end now, as the page will judge the saved test by.
        return { ok: true, value: { testId: run.id, test: run.result, callMode: this.callMode(await this.settings()) } };
      }
      case "phone.test": {
        const settings = await this.settings();
        if (!settings.phone) return failure("not_set_up", "No phone is connected.");
        const run = await this.startTest({ accountSid: settings.phone.accountSid, authToken: settings.phone.authToken }, settings.phone.from, settings.phone.to);
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
  private async keysRefused(error: unknown, credentials: { accountSid: string; authToken: string }): Promise<void> {
    if (!(error instanceof AlertChannelError) || !error.badCredentials) return;
    await this.updateSettings((current) => {
      if (current.phone && sameKeys(current.phone, credentials)) current.phone.error = PHONE_KEYS_REFUSED;
    }).catch((failure: unknown) => this.log("hub.alert.phone.mark-failed", { message: messageOf(failure) }));
  }

  /** How the last message to her chat went: a refusal (her chat, not the
   *  network or Telegram's own trouble) says Telegram needs attention until a
   *  message goes through again. */
  private async telegramDelivered(token: string, sentAt: number, failure?: unknown): Promise<void> {
    const status = failure instanceof AlertChannelError ? failure.status : 0;
    const refused = status >= 400 && status < 500 && status !== 429;
    if (failure !== undefined && !refused) return;
    // Decided in the queue, in the order the messages were sent: a late
    // answer about an older message does not undo what a newer one said.
    await this.updateSettings((current) => {
      const telegram = current.telegram;
      if (telegram?.token !== token || sentAt < this.telegramOutcomeAt) return false;
      this.telegramOutcomeAt = sentAt;
      const bot = telegram.botUsername ? `@${telegram.botUsername}` : "your bot";
      const wanted = refused
        ? `Telegram refused the last message (${(failure as AlertChannelError).message.replace(/^Telegram: /, "")}). Open ${bot} in Telegram and press Start, or connect Telegram again.`
        : undefined;
      if (telegram.deliveryError === wanted) return false;
      if (wanted) telegram.deliveryError = wanted; else delete telegram.deliveryError;
      return true;
    }).catch((error: unknown) => this.log("hub.alert.telegram.mark-failed", { message: messageOf(error) }));
  }

  /** Buys a US number, or hands back the one this account bought a moment
   *  ago (or is buying now): a lost answer never costs a second number. */
  private buyOnce(credentials: { accountSid: string; authToken: string }): Promise<string> {
    const now = this.now().getTime();
    const kept = this.purchases.get(credentials.accountSid);
    // Handed back only to the same keys: a wrong token is not let past Twilio.
    if (kept && now - kept.at < PURCHASE_REUSE_MS && sameSecret(credentials.authToken, kept.authToken)) return kept.number;
    const number = (async () => {
      const client = new TwilioClient(credentials.accountSid, credentials.authToken, this.fetchImpl, this.options.twilioBaseUrl);
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

  private callMode(settings: StoredSettings): "keypad" | "answer" {
    return !this.options.embedded && (this.options.publicUrlOverride || settings.publicUrl) ? "keypad" : "answer";
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
      ...(this.options.embedded ? { embedded: true } : {})
    };
  }

  private async settings(): Promise<StoredSettings> {
    const stored = (await this.options.storage.hub().document(SETTINGS_DOCUMENT))?.value as Partial<StoredSettings> | undefined;
    const waitMinutes = typeof stored?.waitMinutes === "number" ? stored.waitMinutes : URGENT_ALERT_DEFAULT_WAIT_MINUTES;
    return { ...(stored ?? {}), version: 1, waitMinutes } as StoredSettings;
  }

  private settingsQueue: Promise<unknown> = Promise.resolve();

  /** Settings change one at a time (the Telegram reader writes them too). */
  /** A change that returns false changed nothing: nothing is written. */
  private updateSettings(change: (settings: StoredSettings) => void | boolean): Promise<StoredSettings> {
    const run = this.settingsQueue.then(async () => {
      if (this.closed) throw new Error("Urgent alerts are closing.");
      const settings = await this.settings();
      if (change(settings) === false) return settings;
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
    let outcome: { seq: number } | { refused: string };
    try {
      outcome = await this.options.ops.writeServerMessage(record.conversationId, message);
    } catch (error) {
      if (options.strict) throw error;
      // The alert goes on (its calls, Telegram); the card catches up shortly.
      this.log("hub.alert.card.write-failed", { alertId: record.view.id, message: messageOf(error) });
      this.retryCard(record.view.id);
      return;
    }
    if ("refused" in outcome) {
      this.log("hub.alert.card.refused", { alertId: record.view.id, reason: outcome.refused });
      if (options.strict) throw new Error(outcome.refused);
    }
  }

  private readonly cardRetries = new Map<string, ReturnType<typeof setTimeout>>();

  /** Writes the card again from the record as it then stands. */
  private retryCard(alertId: string, attempt = 1): void {
    if (this.closed || this.cardRetries.has(alertId) || attempt > 6) return;
    const timer = setTimeout(() => {
      this.cardRetries.delete(alertId);
      void this.serialize(async () => {
        const record = await this.record(alertId);
        if (!record) return;
        await this.options.ops.writeServerMessage(record.conversationId, {
          id: record.messageId, role: "participant", participantId: record.participantId, participantLabel: record.requester,
          content: record.text, createdAt: record.view.createdAt, status: "done", metadata: { urgentAlert: record.view }
        });
      }).catch((error: unknown) => {
        this.log("hub.alert.card.write-failed", { alertId, attempt, message: messageOf(error) });
        this.retryCard(alertId, attempt + 1);
      });
    }, 5_000 * attempt);
    timer.unref?.();
    this.cardRetries.set(alertId, timer);
  }
}

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

/** The same Twilio keys (a pasted pair is the saved one only if both match). */
function sameKeys(left: { accountSid: string; authToken: string }, right: { accountSid: string; authToken: string }): boolean {
  return left.accountSid === right.accountSid && sameSecret(left.authToken, right.authToken);
}

/** Which phone a test call is a test of: its account, number and phone. */
function testKeyOf(run: PhoneTestRun): string {
  return `${run.credentials.accountSid}|${run.from}|${run.to}`;
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
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
