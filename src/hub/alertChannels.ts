import { createHmac, timingSafeEqual } from "node:crypto";

/** What both outside services are reached with; tests pass a stand-in. */
export type AlertFetch = (input: string, init?: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 15_000;

/** A failure the User can act on, with the service's own words kept short. */
export class AlertChannelError extends Error {
  constructor(
    message: string,
    /** HTTP status of the answer, 0 when the service could not be reached. */
    readonly status: number,
    /** True when the stored key itself is wrong (revoked bot, bad Twilio token). */
    readonly badCredentials = false
  ) {
    super(message);
    this.name = "AlertChannelError";
  }
}

function withTimeout(init: RequestInit | undefined, timeoutMs: number, signal?: AbortSignal): RequestInit {
  const timeout = AbortSignal.timeout(timeoutMs);
  return { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
}

// ---------------------------------------------------------------------------
// Telegram

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type?: string; first_name?: string; username?: string };
    from?: TelegramUser;
    text?: string;
  };
  callback_query?: {
    id: string;
    from: TelegramUser;
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

export interface TelegramButton {
  text: string;
  data: string;
}

/** The Bot API calls an alert needs, against one bot token. */
export class TelegramBot {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: AlertFetch = fetch,
    private readonly baseUrl = "https://api.telegram.org"
  ) {}

  private async call<T>(method: string, body: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/${method}`, withTimeout({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }, timeoutMs, signal));
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new AlertChannelError("Telegram could not be reached.", 0);
    }
    const parsed = await response.json().catch(() => undefined) as { ok?: boolean; result?: T; description?: string; error_code?: number } | undefined;
    if (!parsed?.ok) {
      const status = parsed?.error_code ?? response.status;
      const description = typeof parsed?.description === "string" ? parsed.description : `HTTP ${response.status}`;
      // 401: the token is wrong or the bot was deleted; 404 is what an unknown token answers too.
      throw new AlertChannelError(`Telegram: ${description}`, status, status === 401 || status === 404);
    }
    return parsed.result as T;
  }

  getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>("getMe", {});
  }

  /** Long polling and a webhook exclude each other; alerts use polling. */
  async deleteWebhook(): Promise<void> {
    await this.call<boolean>("deleteWebhook", { drop_pending_updates: false });
  }

  getUpdates(offset: number | undefined, waitSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>("getUpdates", {
      ...(offset !== undefined ? { offset } : {}),
      timeout: waitSeconds,
      allowed_updates: ["message", "callback_query"]
    }, (waitSeconds + 15) * 1000, signal);
  }

  async sendMessage(chatId: number, text: string, buttons?: TelegramButton[]): Promise<number> {
    const result = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: text.slice(0, 4096),
      link_preview_options: { is_disabled: true },
      ...(buttons?.length ? { reply_markup: { inline_keyboard: [buttons.map((button) => ({ text: button.text, callback_data: button.data }))] } } : {})
    });
    return result.message_id;
  }

  /** Replaces the text; the buttons go unless given again. An unchanged
   *  text is not a failure. */
  async editMessageText(chatId: number, messageId: number, text: string, buttons?: TelegramButton[]): Promise<void> {
    try {
      await this.call<unknown>("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: text.slice(0, 4096),
        link_preview_options: { is_disabled: true },
        ...(buttons?.length ? { reply_markup: { inline_keyboard: [buttons.map((button) => ({ text: button.text, callback_data: button.data }))] } } : {})
      });
    } catch (error) {
      if (error instanceof AlertChannelError && /message is not modified/i.test(error.message)) return;
      throw error;
    }
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    await this.call<boolean>("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
  }
}

// ---------------------------------------------------------------------------
// Twilio

export type TwilioCallStatus = "queued" | "initiated" | "ringing" | "in-progress" | "completed" | "busy" | "no-answer" | "failed" | "canceled";

export const TWILIO_FINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

export interface TwilioAccount {
  sid: string;
  friendlyName: string;
  /** "Trial" accounts only call verified numbers and play Twilio's notice first. */
  type: string;
  status: string;
}

export interface TwilioNumber {
  phoneNumber: string;
  friendlyName: string;
}

export interface TwilioCall {
  sid: string;
  status: TwilioCallStatus;
  /** Seconds the call was connected; "0" or empty when it never was. */
  duration?: number;
}

/** The REST calls an alert needs, against one Twilio account. */
export class TwilioClient {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fetchImpl: AlertFetch = fetch,
    private readonly baseUrl = "https://api.twilio.com"
  ) {}

  private async request<T>(method: "GET" | "POST", path: string, form?: Record<string, string>): Promise<T> {
    const url = `${this.baseUrl}/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, withTimeout({
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
          ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {})
        },
        ...(form ? { body: new URLSearchParams(form).toString() } : {})
      }, REQUEST_TIMEOUT_MS));
    } catch {
      throw new AlertChannelError("Twilio could not be reached.", 0);
    }
    const parsed = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!response.ok) {
      const detail = typeof parsed?.message === "string" ? parsed.message : `HTTP ${response.status}`;
      throw new AlertChannelError(`Twilio: ${detail}`, response.status, response.status === 401 || response.status === 403 && /auth/i.test(detail));
    }
    return (parsed ?? {}) as T;
  }

  async account(): Promise<TwilioAccount> {
    const raw = await this.request<Record<string, unknown>>("GET", ".json");
    return {
      sid: String(raw.sid ?? this.accountSid),
      friendlyName: String(raw.friendly_name ?? ""),
      type: String(raw.type ?? ""),
      status: String(raw.status ?? "")
    };
  }

  async incomingNumbers(): Promise<TwilioNumber[]> {
    const raw = await this.request<{ incoming_phone_numbers?: Array<Record<string, unknown>> }>("GET", "/IncomingPhoneNumbers.json?PageSize=50");
    return (raw.incoming_phone_numbers ?? [])
      .filter((entry) => {
        const capabilities = entry.capabilities as Record<string, unknown> | undefined;
        return capabilities?.voice !== false;
      })
      .map((entry) => ({ phoneNumber: String(entry.phone_number ?? ""), friendlyName: String(entry.friendly_name ?? "") }))
      .filter((entry) => entry.phoneNumber);
  }

  /** The first local US number that can make calls, or undefined. */
  async availableNumber(country = "US"): Promise<string | undefined> {
    const raw = await this.request<{ available_phone_numbers?: Array<Record<string, unknown>> }>(
      "GET", `/AvailablePhoneNumbers/${encodeURIComponent(country)}/Local.json?VoiceEnabled=true&PageSize=1`);
    const first = raw.available_phone_numbers?.[0]?.phone_number;
    return typeof first === "string" ? first : undefined;
  }

  async buyNumber(phoneNumber: string): Promise<TwilioNumber> {
    const raw = await this.request<Record<string, unknown>>("POST", "/IncomingPhoneNumbers.json", { PhoneNumber: phoneNumber });
    return { phoneNumber: String(raw.phone_number ?? phoneNumber), friendlyName: String(raw.friendly_name ?? phoneNumber) };
  }

  async createCall(options: { to: string; from: string; twiml: string; ringSeconds: number }): Promise<TwilioCall> {
    const raw = await this.request<Record<string, unknown>>("POST", "/Calls.json", {
      To: options.to,
      From: options.from,
      Twiml: options.twiml,
      Timeout: String(options.ringSeconds)
    });
    return parseCall(raw);
  }

  async call(sid: string): Promise<TwilioCall> {
    return parseCall(await this.request<Record<string, unknown>>("GET", `/Calls/${encodeURIComponent(sid)}.json`));
  }

  /** Hangs up a call in progress, or cancels one still ringing. */
  async endCall(sid: string, ringing: boolean): Promise<void> {
    await this.request<unknown>("POST", `/Calls/${encodeURIComponent(sid)}.json`, { Status: ringing ? "canceled" : "completed" });
  }
}

function parseCall(raw: Record<string, unknown>): TwilioCall {
  const duration = Number(raw.duration);
  return {
    sid: String(raw.sid ?? ""),
    status: String(raw.status ?? "queued") as TwilioCallStatus,
    ...(Number.isFinite(duration) ? { duration } : {})
  };
}

/** X-Twilio-Signature for a POST webhook: HMAC-SHA1 over the URL and the
 *  form fields sorted by name, keyed with the auth token. */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((text, key) => text + key + params[key], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function validTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ---------------------------------------------------------------------------
// What the call says

function xmlEscape(text: string): string {
  return text.replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&apos;" })[char] as string);
}

/** A voice that can read the message: Russian text gets a Russian voice. */
export function voiceFor(text: string): { voice: string; language: string } {
  return /[А-Яа-яЁё]/.test(text)
    ? { voice: "Polly.Tatyana", language: "ru-RU" }
    : { voice: "Polly.Joanna", language: "en-US" };
}

function say(text: string): string {
  const { voice, language } = voiceFor(text);
  return `<Say voice="${voice}" language="${language}">${xmlEscape(text)}</Say>`;
}

/** The spoken text of an alert: who and where, then the member's message. */
export function spokenAlert(requester: string, chatTitle: string | undefined, message: string): string {
  const where = chatTitle ? ` in the chat ${chatTitle}` : "";
  // "@taylor" would be read out as "at taylor".
  return `Urgent alert from ${requester.replace(/^@/, "")}${where}. ${message}`;
}

/** With a server Twilio can reach: 1 confirms, 2 repeats. */
export function keypadTwiml(spoken: string, actionUrl: string): string {
  const prompt = "Press 1 if you got it. Press 2 to hear it again.";
  return `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Gather numDigits="1" timeout="8" method="POST" action="${xmlEscape(actionUrl)}">${say(spoken)}<Say voice="Polly.Joanna" language="en-US">${prompt}</Say></Gather>` +
    `<Gather numDigits="1" timeout="8" method="POST" action="${xmlEscape(actionUrl)}"><Say voice="Polly.Joanna" language="en-US">${prompt}</Say></Gather>` +
    `<Say voice="Polly.Joanna" language="en-US">Goodbye.</Say></Response>`;
}

/** Without such a server: the message twice, and answering counts. */
export function readOutTwiml(spoken: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say(spoken)}<Pause length="1"/>${say(spoken)}</Response>`;
}

export function confirmedTwiml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna" language="en-US">Got it. Goodbye.</Say></Response>`;
}
