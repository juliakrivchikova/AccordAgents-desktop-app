import { randomBytes } from "node:crypto";
import { AlertChannelError, TelegramBot, type TelegramUpdate } from "../alertChannels";
import { delay, messageOf, telegramText } from "./alertText";
import { ACKNOWLEDGEABLE } from "./constants";
import type { AlertRecord, StoredTelegram } from "./types";
import type { HubAlertModules } from "./modules";
import type { HubAlertDependencies } from "./dependencies";

/** Alerts in the User's Telegram. */
export class TelegramAlerts {
  /** When the message whose outcome Telegram's state last took was sent: a
   *  late answer about an older message does not undo a newer one's. */
  private telegramOutcomeAt = 0;
  telegramLoop?: AbortController;
  private telegramToken?: string;

  constructor(
    private readonly alerts: Pick<HubAlertModules, "alertFlow" | "alertRecords" | "alertSettings">,
    private readonly deps: Pick<HubAlertDependencies, "fetchImpl" | "log" | "now" | "options">
  ) {}

  async deliverTelegram(alertId: string): Promise<void> {
    const settings = await this.alerts.alertSettings.settings();
    const telegram = settings.telegram;
    const record = await this.alerts.alertRecords.record(alertId);
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
        sentAt = this.deps.now().toISOString();
        break;
      } catch (failure) {
        const status = failure instanceof AlertChannelError ? failure.status : 0;
        const passing = status === 0 || status === 429 || status >= 500;
        if (passing && attempt < 4 && !this.alerts.alertFlow.closed) {
          this.deps.log("hub.alert.telegram.retry", { alertId, attempt, status });
          await delay((this.deps.options.telegramRetryMs ?? 5_000) * attempt, new AbortController().signal);
          continue;
        }
        error = failure instanceof AlertChannelError ? failure.message : "Telegram could not be reached.";
        this.deps.log("hub.alert.telegram.failed", { alertId, message: messageOf(failure) });
        await this.telegramDelivered(telegram.token, attemptAt, failure);
        break;
      }
    }
    if (sentAt) await this.telegramDelivered(telegram.token, attemptAt);
    await this.alerts.alertRecords.serialize(async () => {
      const current = await this.alerts.alertRecords.record(alertId);
      if (!current) return;
      current.view.telegram = { ...(sentAt ? { sentAt } : {}), ...(error ? { error } : {}) };
      if (messageId !== undefined) {
        current.telegramMessageId = messageId;
        current.telegramChatId = telegram.chatId;
      }
      // Nowhere else to go: the alert stays only in the chat.
      if (error && !current.view.phone && current.view.state === "waiting") current.view.state = "failed";
      await this.alerts.alertRecords.save(current);
      await this.alerts.alertRecords.writeCard(current);
    });
    // Got it may have come from the app while the message was on its way.
    const after = await this.alerts.alertRecords.record(alertId);
    if (after && messageId !== undefined && after.view.state === "acknowledged") void this.editTelegram(after).catch(() => undefined);
  }

  async editTelegram(record: AlertRecord): Promise<void> {
    if (record.telegramMessageId === undefined || record.telegramChatId === undefined) return;
    const settings = await this.alerts.alertSettings.settings();
    if (!settings.telegram) return;
    const text = telegramText(record, settings);
    const bot = this.bot(settings.telegram);
    if (record.view.state === "acknowledged") {
      await bot.editMessageText(record.telegramChatId, record.telegramMessageId, text);
    } else {
      await bot.editMessageText(record.telegramChatId, record.telegramMessageId, text, [{ text: "Got it", data: `ack:${record.view.id}` }]);
    }
  }

  // --- Telegram -------------------------------------------------------------------

  bot(telegram: StoredTelegram): TelegramBot {
    return new TelegramBot(telegram.token, this.deps.fetchImpl, this.deps.options.telegramBaseUrl);
  }

  /** Reads the bot's updates while a bot is set: Start, Got it. */
  async restartTelegram(): Promise<void> {
    const settings = await this.alerts.alertSettings.settings();
    const token = settings.telegram && !settings.telegram.error ? settings.telegram.token : undefined;
    if (token === this.telegramToken && this.telegramLoop && !this.telegramLoop.signal.aborted) return;
    this.telegramLoop?.abort();
    this.telegramLoop = undefined;
    this.telegramToken = token;
    if (!token || this.alerts.alertFlow.closed) return;
    const loop = new AbortController();
    this.telegramLoop = loop;
    void this.readTelegram(token, loop.signal).catch((error: unknown) => {
      this.deps.log("hub.alert.telegram.loop-failed", { message: messageOf(error) });
      // Read again later, unless something else took over meanwhile.
      if (this.telegramLoop === loop) {
        this.telegramLoop = undefined;
        this.telegramToken = undefined;
        setTimeout(() => { void this.restartTelegram().catch(() => undefined); }, 30_000).unref?.();
      }
    });
  }

  private async readTelegram(token: string, signal: AbortSignal): Promise<void> {
    const bot = new TelegramBot(token, this.deps.fetchImpl, this.deps.options.telegramBaseUrl);
    const stored = (await this.alerts.alertSettings.settings()).telegram;
    let offset = stored?.token === token ? stored.offset : undefined;
    while (!signal.aborted && !this.alerts.alertFlow.closed) {
      try {
        const updates = await bot.getUpdates(offset, this.deps.options.telegramWaitSeconds ?? 25, signal);
        for (const update of updates) {
          offset = update.update_id + 1;
          await this.telegramUpdate(bot, update).catch((error: unknown) => this.deps.log("hub.alert.telegram.update-error", { message: messageOf(error) }));
        }
        if (updates.length) {
          await this.alerts.alertSettings.updateSettings((settings) => {
            if (settings.telegram?.token === token) settings.telegram.offset = offset;
          });
        }
      } catch (error) {
        if (signal.aborted || this.alerts.alertFlow.closed) return;
        if (error instanceof AlertChannelError && error.badCredentials) {
          await this.alerts.alertSettings.updateSettings((settings) => {
            if (settings.telegram?.token === token) settings.telegram.error = "Telegram no longer accepts this bot's token. Connect Telegram again.";
          });
          this.deps.log("hub.alert.telegram.revoked", {});
          if (this.telegramToken === token) {
            this.telegramLoop?.abort();
            this.telegramLoop = undefined;
            this.telegramToken = undefined;
          }
          return;
        }
        if (error instanceof AlertChannelError && error.status === 409) await bot.deleteWebhook().catch(() => undefined);
        this.deps.log("hub.alert.telegram.read-failed", { message: messageOf(error) });
        await delay(15_000, signal);
      }
    }
  }

  private async telegramUpdate(bot: TelegramBot, update: TelegramUpdate): Promise<void> {
    const settings = await this.alerts.alertSettings.settings();
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
        await this.alerts.alertSettings.updateSettings((current) => {
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
        await this.alerts.alertSettings.updateSettings((current) => {
          if (current.telegram?.token !== telegram.token) return;
          current.telegram.connected = true;
          delete current.telegram.step;
          delete current.telegram.testNonce;
          current.telegram.lastTest = { at: this.deps.now().toISOString(), gotIt: true };
        });
        if (callback.message) await bot.editMessageText(chatId, callback.message.message_id, "Connected. Urgent alerts from AccordAgents will come to this chat.").catch(() => undefined);
        await bot.answerCallbackQuery(callback.id, "Connected").catch(() => undefined);
      } else {
        await this.alerts.alertSettings.updateSettings((current) => {
          if (current.telegram?.token === telegram.token && current.telegram.connected && nonce === current.telegram.lastTestNonce) {
            current.telegram.lastTest = { at: this.deps.now().toISOString(), gotIt: true };
          }
        });
        if (callback.message) await bot.editMessageText(chatId, callback.message.message_id, "Test alert from AccordAgents: it works.").catch(() => undefined);
        await bot.answerCallbackQuery(callback.id, "It works").catch(() => undefined);
      }
      return;
    }
    if (callback.data.startsWith("ack:")) {
      const alertId = callback.data.slice(4);
      const record = await this.alerts.alertRecords.record(alertId);
      if (!record || (record.telegramChatId ?? telegram.chatId) !== chatId) {
        await bot.answerCallbackQuery(callback.id).catch(() => undefined);
        return;
      }
      const wasOpen = ACKNOWLEDGEABLE.has(record.view.state);
      await this.alerts.alertFlow.acknowledge(alertId, "telegram");
      await bot.answerCallbackQuery(callback.id, wasOpen ? "Got it. No call." : undefined).catch(() => undefined);
    }
  }

  /** How the last message to her chat went: a refusal (her chat, not the
   *  network or Telegram's own trouble) says Telegram needs attention until a
   *  message goes through again. */
  async telegramDelivered(token: string, sentAt: number, failure?: unknown): Promise<void> {
    const status = failure instanceof AlertChannelError ? failure.status : 0;
    const refused = status >= 400 && status < 500 && status !== 429;
    if (failure !== undefined && !refused) return;
    // Decided in the queue, in the order the messages were sent: a late
    // answer about an older message does not undo what a newer one said.
    await this.alerts.alertSettings.updateSettings((current) => {
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
    }).catch((error: unknown) => this.deps.log("hub.alert.telegram.mark-failed", { message: messageOf(error) }));
  }
}
