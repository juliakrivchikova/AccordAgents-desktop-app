import type { StorageService } from "../../main/services/storage";
import type { UrgentAlertPhoneTest, UrgentAlertView } from "../../shared/urgentAlerts";
import type { AlertFetch } from "../alertChannels";
import type { HubOps } from "../hubOps";

export interface StoredTelegram {
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

export interface StoredPhone {
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
export interface PhoneTestRun {
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

export interface StoredSettings {
  version: 1;
  telegram?: StoredTelegram;
  phone?: StoredPhone;
  waitMinutes: number;
  /** Where Twilio reaches this server, as the computer that set it up said. */
  publicUrl?: string;
}

export interface AlertRecord {
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
