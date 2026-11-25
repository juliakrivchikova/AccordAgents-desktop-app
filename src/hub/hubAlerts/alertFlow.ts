import { randomBytes, randomUUID } from "node:crypto";
import type { HubDevice } from "../../shared/hubProtocol";
import type { ChatParticipant, Conversation } from "../../shared/types";
import {
  URGENT_ALERT_MESSAGE_MAX_CHARS, type HubAlertRequest, type HubAlertResult, type UrgentAlertAckSource, type UrgentAlertError,
  type UrgentAlertRaised, type UrgentAlertView
} from "../../shared/urgentAlerts";
import { AlertChannelError } from "../alertChannels";
import { chatViewFor, isChatViewMode } from "../../shared/mainSession";
import { sessionsMemberTitle, titleTaskByMember } from "../../shared/mainSessionView";
import { homeDeviceId } from "../hubOps";
import { scopeCovers } from "../hubPhoneState";
import { failure, messageOf, quote } from "./alertText";
import { ACKNOWLEDGEABLE } from "./constants";
import type { AlertRecord } from "./types";
import type { HubAlertModules } from "./modules";
import type { HubAlertDependencies } from "./dependencies";

/** An urgent alert from the moment it is raised until it is closed. */
export class AlertFlow {
  private timer?: ReturnType<typeof setTimeout>;
  closed = false;

  constructor(
    private readonly alerts: Pick<HubAlertModules, "alertRecords" | "alertSettings" | "phoneCalls" | "phoneTests" | "telegramAlerts">,
    private readonly deps: Pick<HubAlertDependencies, "log" | "now" | "options">
  ) {}

  /** Picks up what was going on before a restart: waits, calls, Telegram. */
  async start(): Promise<void> {
    await this.alerts.alertRecords.init();
    const undelivered: string[] = [];
    await this.alerts.alertRecords.serialize(async () => {
      for (const record of await this.alerts.alertRecords.openRecords()) {
        if (record.callSid) this.alerts.phoneCalls.pollCall(record.view.id, record.callSid);
        // Raised right before a stop, never sent: sent now rather than never.
        if (!record.view.telegram) undelivered.push(record.view.id);
      }
    });
    for (const alertId of undelivered) {
      void this.alerts.telegramAlerts.deliverTelegram(alertId).catch((error: unknown) => this.deps.log("hub.alert.telegram.error", { alertId, message: messageOf(error) }));
    }
    // A test call ringing when the server stopped: nobody follows it any more,
    // so it must not read "calling" for ever (written only when it does).
    if ((await this.alerts.alertSettings.settings()).phone?.lastTest?.state === "calling") {
      await this.alerts.alertSettings.updateSettings((current) => {
        if (current.phone?.lastTest?.state === "calling" && ![...this.alerts.phoneTests.tests.values()].some((run) => run.result.state === "calling")) {
          current.phone.lastTest = { state: "failed", at: this.deps.now().toISOString(), error: "The server restarted during the test call. Call again.", lost: true };
        }
      }).catch((error: unknown) => this.deps.log("hub.alert.test.reconcile-failed", { message: messageOf(error) }));
    }
    this.reschedule();
    await this.alerts.telegramAlerts.restartTelegram();
  }

  /** Stops timers and readers, and waits for the change under way (so the
   *  storage is not taken away under it). */
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.alerts.alertRecords.cardRetries.values()) clearTimeout(timer);
    this.alerts.alertRecords.cardRetries.clear();
    if (this.timer) clearTimeout(this.timer);
    for (const poll of this.alerts.phoneCalls.polls.values()) clearTimeout(poll);
    this.alerts.phoneCalls.polls.clear();
    for (const poll of this.alerts.phoneTests.testPolls) clearTimeout(poll);
    this.alerts.alertSettings.purchases.clear();
    this.alerts.phoneTests.testPolls.clear();
    this.alerts.telegramAlerts.telegramLoop?.abort();
    await Promise.race([
      Promise.all([this.alerts.alertRecords.queue, this.alerts.alertSettings.settingsQueue]).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 5_000).unref?.())
    ]);
  }

  // --- requests from devices ----------------------------------------------------

  async handle(device: HubDevice, raw: unknown): Promise<HubAlertResult<unknown>> {
    await this.alerts.alertRecords.init();
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
          return await this.alerts.alertSettings.settingsAction(request);
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
    const raised = await this.alerts.alertRecords.serialize(async () => {
      const existing = await this.alerts.alertRecords.recordByRequestKey(requestKey);
      if (existing) return { record: existing, fresh: false };
      const settings = await this.alerts.alertSettings.settings();
      const telegram = Boolean(settings.telegram?.connected && settings.telegram.chatId !== undefined);
      const phone = Boolean(settings.phone);
      const createdAt = this.deps.now().toISOString();
      const dueAt = phone ? this.deps.now().getTime() + settings.waitMinutes * (this.deps.options.minuteMs ?? 60_000) : undefined;
      const id = randomUUID();
      const record: AlertRecord = {
        view: {
          id,
          state: telegram || phone ? "waiting" : "not_set_up",
          createdAt,
          calls: [],
          phone,
          callMode: this.alerts.alertSettings.callMode(settings),
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
      await this.alerts.alertRecords.storage().runSql(`insert into urgent_alerts(id, request_key, conversation_id, state, record_json, created_at, updated_at) values (
        ${quote(id)}, ${quote(requestKey)}, ${quote(record.conversationId)}, ${quote(record.view.state)}, ${quote(JSON.stringify(record))}, ${quote(createdAt)}, ${quote(createdAt)});`);
      try {
        await this.alerts.alertRecords.writeCard(record, { strict: true });
      } catch (error) {
        // No card, no alert: the member's retry (same request id) raises it again.
        await this.alerts.alertRecords.storage().runSql(`delete from urgent_alerts where id = ${quote(id)};`).catch(() => undefined);
        throw error;
      }
      this.deps.log("hub.alert.raised", { alertId: id, conversationId: record.conversationId, participantId: record.participantId, telegram, phone });
      return { record, fresh: true };
    });
    if (raised.fresh) {
      void this.alerts.telegramAlerts.deliverTelegram(raised.record.view.id).catch((error: unknown) => this.deps.log("hub.alert.telegram.error", { alertId: raised.record.view.id, message: messageOf(error) }));
      this.reschedule();
    }
    const settings = await this.alerts.alertSettings.settings();
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
    const chat = await this.deps.options.storage.conversationAccess(conversationId);
    if (!chat || chat.kind !== "chat") return { code: "access_denied", message: "The server has no such chat (yet)." };
    const participants = chat.participants as ChatParticipant[];
    const participant = participants.find((item) => item?.id === participantId);
    if (!participant) return { code: "access_denied", message: "This member is not in the chat." };
    const devices = await this.deps.options.storage.hub().devices();
    if (homeDeviceId({ metadata: { participants } } as unknown as Conversation, participant.id, devices) !== device.deviceId) {
      return { code: "access_denied", message: `@${participant.handle} runs on another device; only that device raises its alerts.` };
    }
    const titles = await this.deps.options.storage.conversationTitles([conversationId]).catch(() => ({} as Record<string, string>));
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
    const messages = await this.deps.options.storage.memberTaskMessages(conversationId, participant.id);
    return sessionsMemberTitle(participant, titleTaskByMember(messages).get(participant.id)?.item);
  }

  /** The User closes the card in the app: an alert still waiting counts as
   *  seen (no call); any alert folds away on every device. */
  private async closeAlert(device: HubDevice, alertId: unknown): Promise<HubAlertResult<UrgentAlertView>> {
    if (typeof alertId !== "string" || !alertId) return failure("invalid_request", "Which alert?");
    const record = await this.alerts.alertRecords.record(alertId);
    if (!record) return failure("invalid_request", "There is no such alert.");
    if (device.role === "phone" && !scopeCovers(device.scope, record.conversationId)) return failure("access_denied", "This phone does not show that chat.");
    const view = await this.acknowledge(alertId, "app", { close: true });
    return view ? { ok: true, value: view } : failure("invalid_request", "There is no such alert.");
  }

  // --- the alert's course -------------------------------------------------------

  /** Got it from anywhere. The first reaction is the one; later ones change
   *  nothing but, from the app, fold the card. */
  async acknowledge(alertId: string, source: UrgentAlertAckSource, options: { close?: boolean } = {}): Promise<UrgentAlertView | undefined> {
    const outcome = await this.alerts.alertRecords.serialize(async () => {
      const record = await this.alerts.alertRecords.record(alertId);
      if (!record) return undefined;
      const view = record.view;
      const acknowledgedNow = ACKNOWLEDGEABLE.has(view.state);
      const ringing = record.callSid;
      if (acknowledgedNow) {
        view.state = "acknowledged";
        view.ackedAt = this.deps.now().toISOString();
        view.ackSource = source;
        delete view.callAt;
        delete record.nextCallAt;
        if (record.callSid) {
          this.alerts.phoneCalls.stopPolling(alertId);
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
      if (closingNow) view.closedAt = this.deps.now().toISOString();
      if (!acknowledgedNow && !closingNow) return { record, changed: false, ringing: undefined };
      await this.alerts.alertRecords.save(record);
      await this.alerts.alertRecords.writeCard(record);
      this.deps.log("hub.alert.acknowledged", { alertId, source, acknowledgedNow, closed: options.close === true });
      return { record, changed: acknowledgedNow, ringing: acknowledgedNow ? ringing : undefined };
    });
    if (!outcome) return undefined;
    if (outcome.changed) {
      this.reschedule();
      // A call still ringing when she reacted elsewhere stops ringing.
      if (outcome.ringing && source !== "call") void this.alerts.phoneCalls.endCall(outcome.ringing).catch((error: unknown) => this.deps.log("hub.alert.call.end-failed", { message: messageOf(error) }));
      void this.alerts.telegramAlerts.editTelegram(outcome.record).catch(() => undefined);
    }
    return outcome.record.view;
  }

  /** Places the calls that are due, then waits for the next one. */
  reschedule(): void {
    if (this.closed) return;
    void this.alerts.alertRecords.serialize(async () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      const due = (await this.alerts.alertRecords.openRecords()).filter((record) => record.nextCallAt !== undefined && !record.callSid);
      if (!due.length) return;
      const next = Math.min(...due.map((record) => record.nextCallAt as number));
      const wait = Math.max(0, Math.min(next - this.deps.now().getTime(), 2 ** 31 - 1));
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.callDue().catch((error: unknown) => this.deps.log("hub.alert.call.error", { message: messageOf(error) }));
      }, wait);
      this.timer.unref?.();
    }).catch((error: unknown) => this.deps.log("hub.alert.schedule.error", { message: messageOf(error) }));
  }

  private async callDue(): Promise<void> {
    const nowMs = this.deps.now().getTime();
    const due = (await this.alerts.alertRecords.openRecords()).filter((record) => record.nextCallAt !== undefined && record.nextCallAt <= nowMs && !record.callSid);
    try {
      for (const record of due) {
        await this.alerts.phoneCalls.placeCall(record.view.id).catch((error: unknown) => this.deps.log("hub.alert.call.error", { alertId: record.view.id, message: messageOf(error) }));
      }
    } finally {
      this.reschedule();
    }
  }
}
