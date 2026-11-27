import { createHash } from "node:crypto";
import {
  URGENT_ALERT_MESSAGE_MAX_CHARS, URGENT_ALERT_UNSENT_ID_PREFIX,
  type HubAlertRequest, type HubAlertResult, type UrgentAlertError, type UrgentAlertRaised, type UrgentAlertView
} from "../../shared/urgentAlerts";

/** The one way to urgent alerts: the User's server (ServerChatLink.alerts). */
export interface UrgentAlertServerAccess {
  alerts<T>(request: HubAlertRequest, cancel?: AbortSignal): Promise<HubAlertResult<T>>;
}

export interface UrgentAlertToolActor {
  conversationId: string;
  participantId: string;
}

/** Where the computer shows the User an alert's card itself while her server
 *  cannot take the alert (ChatService.unsentAlertCards); none on a machine,
 *  whose chats she sees only through her server. */
export interface UrgentAlertCardHost {
  show(card: { conversationId: string; participantId: string; messageId: string; text: string; createdAt: string; alert: UrgentAlertView }): Promise<boolean>;
  update(conversationId: string, messageId: string, change: (alert: UrgentAlertView) => UrgentAlertView): Promise<UrgentAlertView | undefined>;
  remove(conversationId: string, messageId: string): Promise<void>;
}

/** Where the alerts still to be raised on the server are kept (across restarts). */
export interface UrgentAlertOutboxStore {
  read(): Promise<string | undefined>;
  write(value: string): Promise<void>;
}

/**
 * The id of an alert's card in its chat: the same on the server (which
 * writes the card) and on the device that raised it (which may put the card
 * up itself first), so the server's card replaces that one in place.
 */
export function urgentAlertCardMessageId(conversationId: string, participantId: string, requestId: string): string {
  const hex = alertKeyHash(conversationId, participantId, requestId);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function alertKeyHash(conversationId: string, participantId: string, requestId: string): string {
  return createHash("sha256").update(`urgent-alert-card\n${conversationId}\n${participantId}\n${requestId}`).digest("hex");
}

/** An alert the server has not taken yet. */
interface UnsentAlert {
  /** The card's alert id here (`unsent-…`). */
  alertId: string;
  requestId: string;
  conversationId: string;
  participantId: string;
  messageId: string;
  text: string;
  raisedAt: string;
  /** Still raised on the server; false once it refused the alert (kept so
   *  that Got it on the card is answered here). */
  retrying: boolean;
  attempts: number;
}

const STORE_VERSION = 1;
/** Alerts kept at most; the oldest the server refused go first. */
const MAX_KEPT = 50;
const DEFAULT_RAISE_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_MS = 30_000;

/**
 * A member's urgent alerts (app_urgent_alert), on the computer and on cloud
 * machines (same code). The User's server carries every alert: its card in
 * the chat, Telegram, the calls. When the server cannot take one (not
 * reached, or it refused), the computer puts the same red card up in the
 * chat itself at once, and keeps raising the alert on the server until it
 * gets through; the server's card then replaces it (same message id, the
 * same request id so never twice). Got it on that card before then keeps it
 * from going out. A machine has no card of its own to show: it keeps
 * raising the alert until her server takes it.
 */
export class UrgentAlertOutbox {
  private entries?: UnsentAlert[];
  private loading?: Promise<UnsentAlert[]>;
  private lock: Promise<unknown> = Promise.resolve();
  private readonly inFlight = new Map<string, Promise<HubAlertResult<UrgentAlertRaised>>>();
  /** Got it pressed on a card while its alert was on its way to the server:
   *  closed there too once it arrives. */
  private readonly closedWhileRaising = new Set<string>();
  /** Cards the server took meanwhile: Got it on one still waiting for the
   *  server's card goes to the server's alert. */
  private readonly reachedServer = new Map<string, string>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private readonly options: {
    access: () => UrgentAlertServerAccess | undefined;
    store: UrgentAlertOutboxStore;
    cards?: UrgentAlertCardHost;
    log: (event: string, payload: Record<string, unknown>) => void;
    raiseTimeoutMs?: number;
    retryMs?: number;
  }) {}

  /** Takes up the alerts left from before (a restart). */
  start(): void {
    this.stopped = false;
    void this.load().catch((error: unknown) => this.options.log("urgent-alert.outbox.load-failed", { message: messageOf(error) }))
      .finally(() => this.schedule());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** A member's app_urgent_alert call. */
  async raise(actor: UrgentAlertToolActor, raw: unknown): Promise<unknown> {
    const args = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const text = typeof args.message === "string" ? args.message.trim() : "";
    // What the server would refuse is said at once, whether or not it can be reached.
    if (!text) return failure("invalid_request", "An alert needs a message.");
    if (text.length > URGENT_ALERT_MESSAGE_MAX_CHARS) {
      return failure("invalid_request", `An alert message is at most ${URGENT_ALERT_MESSAGE_MAX_CHARS} characters; say what happened and what the User should do.`);
    }
    const requestId = typeof args.requestId === "string" && args.requestId
      ? args.requestId
      // Without one: the same message within a minute (a retry after a lost
      // answer) is the same alert; a later one is a new alert.
      : createHash("sha256").update(`${actor.conversationId}\n${actor.participantId}\n${text}\n${Math.floor(Date.now() / 60_000)}`).digest("hex").slice(0, 32);
    const alert: Omit<UnsentAlert, "retrying" | "attempts"> = {
      alertId: `${URGENT_ALERT_UNSENT_ID_PREFIX}${alertKeyHash(actor.conversationId, actor.participantId, requestId).slice(0, 32)}`,
      requestId,
      conversationId: actor.conversationId,
      participantId: actor.participantId,
      messageId: urgentAlertCardMessageId(actor.conversationId, actor.participantId, requestId),
      text,
      raisedAt: new Date().toISOString()
    };
    const result = await this.attempt(alert);
    if (result.ok) {
      await this.reached(alert, result.value);
      return { ok: true, value: result.value, note: sentNote(result.value) };
    }
    // The member's own mistake (the server checks more than this device): it
    // fixes the call; nothing to show her.
    if (result.error.code === "invalid_request") return result;
    const retrying = result.error.code === "server_unavailable";
    const shown = await this.keep(alert, retrying, result.error);
    if (shown) {
      return {
        ok: true,
        value: { alertId: alert.alertId, messageId: alert.messageId, state: "unsent", telegram: false, phone: false } satisfies UrgentAlertRaised,
        note: retrying
          ? `User's server could not be reached (${result.error.message.replace(/[.\s]+$/, "")}), so the alert reached her only as a red card in this chat on her computer: no Telegram and no call yet. The app keeps raising it on her server and sends it on once it gets through (never twice), unless she presses Got it first. Do not call again for the same incident; say in your reply that the alert could not go out.`
          : `User's server did not take the alert (${result.error.message.replace(/[.\s]+$/, "")}), so it reached her only as a red card in this chat on her computer: no Telegram, no call. Say so in your reply.`
      };
    }
    if (retrying) {
      return failure("server_unavailable", `User's server could not be reached from here (${result.error.message.replace(/[.\s]+$/, "")}), so nothing reached her yet. It is raised on her server as soon as it can be reached (a red card in this chat, then Telegram and calls), never twice. Do not call again for the same incident; tell User in your reply.`);
    }
    return result;
  }

  /**
   * Got it (or the cross) on a card. Undefined when the card is the
   * server's: the request goes there. A card of this computer is answered
   * here, and its alert is not raised on the server any more.
   */
  async close(alertId: string): Promise<{ handled: HubAlertResult<UrgentAlertView> } | { forwardTo: string } | undefined> {
    if (!alertId.startsWith(URGENT_ALERT_UNSENT_ID_PREFIX)) return undefined;
    const reached = this.reachedServer.get(alertId);
    if (reached) return { forwardTo: reached };
    const entry = await this.serialize(async () => {
      const entries = await this.load();
      const found = entries.find((item) => item.alertId === alertId);
      if (!found) return undefined;
      await this.save(entries.filter((item) => item !== found));
      if (this.inFlight.has(keyOf(found))) this.closedWhileRaising.add(keyOf(found));
      return found;
    });
    const nowIso = new Date().toISOString();
    const view = entry && this.options.cards
      ? await this.options.cards.update(entry.conversationId, entry.messageId, (alert) => ({
        ...alert, state: "acknowledged", ackedAt: alert.ackedAt ?? nowIso, ackSource: alert.ackSource ?? "app", closedAt: alert.closedAt ?? nowIso,
        ...(alert.unsent ? { unsent: { ...alert.unsent, retrying: false } } : {})
      })).catch((error: unknown) => {
        this.options.log("urgent-alert.outbox.card-failed", { alertId, message: messageOf(error) });
        return undefined;
      })
      : undefined;
    if (entry) this.options.log("urgent-alert.outbox.closed-here", { alertId, conversationId: entry.conversationId, raising: this.closedWhileRaising.has(keyOf(entry)) });
    const forward = this.reachedServer.get(alertId);
    if (forward) return { forwardTo: forward };
    if (view) return { handled: { ok: true, value: view } };
    return { handled: failure("invalid_request", entry
      ? "This alert's card is no longer here."
      : "This alert is no longer kept on this computer; it may have reached your server, whose card takes this one's place.") };
  }

  // --- the way to the server ------------------------------------------------------

  /** One raise on the server (one at a time per alert), bounded in time. */
  private attempt(alert: Omit<UnsentAlert, "retrying" | "attempts">): Promise<HubAlertResult<UrgentAlertRaised>> {
    const key = keyOf(alert);
    const running = this.inFlight.get(key);
    if (running) return running;
    const run = (async (): Promise<HubAlertResult<UrgentAlertRaised>> => {
      let access: UrgentAlertServerAccess | undefined;
      try { access = this.options.access(); } catch { access = undefined; }
      if (!access) return failure("server_unavailable", "This device is not linked to User's server yet.");
      const timeoutMs = this.options.raiseTimeoutMs ?? DEFAULT_RAISE_TIMEOUT_MS;
      try {
        return await access.alerts<UrgentAlertRaised>({
          action: "raise", conversationId: alert.conversationId, participantId: alert.participantId, text: alert.text, requestId: alert.requestId
        }, AbortSignal.timeout(timeoutMs));
      } catch (error) {
        return failure("server_unavailable", messageOf(error));
      }
    })().finally(() => {
      if (this.inFlight.get(key) === run) this.inFlight.delete(key);
    });
    this.inFlight.set(key, run);
    return run;
  }

  /** The server took the alert: its card stands for this one. */
  private async reached(alert: Omit<UnsentAlert, "retrying" | "attempts">, raised: UrgentAlertRaised): Promise<void> {
    const key = keyOf(alert);
    this.reachedServer.set(alert.alertId, raised.alertId);
    while (this.reachedServer.size > MAX_KEPT) this.reachedServer.delete(this.reachedServer.keys().next().value as string);
    const had = await this.serialize(async () => {
      const entries = await this.load();
      const found = entries.find((item) => keyOf(item) === key);
      if (found) await this.save(entries.filter((item) => item !== found));
      return Boolean(found);
    });
    // A server older than this app wrote its card under another id: this
    // one comes down (the same id is replaced by the server's card itself).
    if (this.options.cards && raised.messageId !== alert.messageId) {
      await this.options.cards.remove(alert.conversationId, alert.messageId).catch((error: unknown) => this.options.log("urgent-alert.outbox.card-failed", { alertId: alert.alertId, message: messageOf(error) }));
    }
    if (this.closedWhileRaising.delete(key)) {
      // She pressed Got it here while it was on its way: it is Got it there too.
      let access: UrgentAlertServerAccess | undefined;
      try { access = this.options.access(); } catch { access = undefined; }
      const closed = access ? await access.alerts({ action: "close", alertId: raised.alertId }).catch((error: unknown) => failure("server_unavailable", messageOf(error))) : undefined;
      this.options.log("urgent-alert.outbox.closed-on-server", { alertId: raised.alertId, ok: closed?.ok === true });
    }
    if (had) this.options.log("urgent-alert.outbox.reached-server", { alertId: alert.alertId, serverAlertId: raised.alertId, state: raised.state });
  }

  /** Keeps an alert the server did not take, and puts its card up here.
   *  True when the User sees the card. */
  private async keep(alert: Omit<UnsentAlert, "retrying" | "attempts">, retrying: boolean, error: UrgentAlertError): Promise<boolean> {
    const key = keyOf(alert);
    // She pressed Got it on its card while this try was on its way: it stays
    // as she left it.
    if (this.closedWhileRaising.delete(key)) return Boolean(this.options.cards);
    const known = await this.serialize(async () => {
      const entries = await this.load();
      const existing = entries.find((item) => keyOf(item) === key);
      const entry: UnsentAlert = existing
        ? { ...existing, retrying: existing.retrying && retrying, attempts: existing.attempts + 1 }
        : { ...alert, retrying, attempts: 1 };
      // Only what the User can still see or what still goes out is kept.
      if (!entry.retrying && !this.options.cards) {
        await this.save(entries.filter((item) => keyOf(item) !== key));
        return undefined;
      }
      await this.save([...entries.filter((item) => keyOf(item) !== key), entry]);
      return entry;
    });
    if (known?.retrying) this.schedule();
    if (!known || !this.options.cards) return false;
    const view: UrgentAlertView = {
      id: known.alertId, state: "unsent", createdAt: known.raisedAt, calls: [], phone: false, callMode: "answer",
      unsent: { reason: retrying ? "unreachable" : "refused", ...(retrying ? {} : { message: error.message }), retrying: known.retrying }
    };
    const shown = await this.options.cards.show({
      conversationId: known.conversationId, participantId: known.participantId, messageId: known.messageId,
      text: known.text, createdAt: known.raisedAt, alert: view
    }).catch((failed: unknown) => {
      this.options.log("urgent-alert.outbox.card-failed", { alertId: known.alertId, message: messageOf(failed) });
      return false;
    });
    this.options.log("urgent-alert.outbox.kept", { alertId: known.alertId, conversationId: known.conversationId, retrying: known.retrying, shown, code: error.code });
    if (!shown && !known.retrying) await this.forget(key);
    return shown;
  }

  private async forget(key: string): Promise<void> {
    await this.serialize(async () => {
      const entries = await this.load();
      if (entries.some((item) => keyOf(item) === key)) await this.save(entries.filter((item) => keyOf(item) !== key));
    });
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.retryDue().catch((error: unknown) => this.options.log("urgent-alert.outbox.retry-failed", { message: messageOf(error) }))
        .finally(() => {
          // Until what was kept is read (storage still starting), and while
          // something still waits for the server.
          if (!this.entries || this.entries.some((item) => item.retrying)) this.schedule();
        });
    }, this.options.retryMs ?? DEFAULT_RETRY_MS);
    this.timer.unref?.();
  }

  /** Raises again what the server has not taken yet. */
  async retryDue(): Promise<void> {
    const due = (await this.load()).filter((item) => item.retrying);
    for (const entry of due) {
      if (this.stopped) return;
      const result = await this.attempt(entry);
      if (result.ok) {
        await this.reached(entry, result.value);
        continue;
      }
      if (result.error.code === "server_unavailable") {
        await this.serialize(async () => {
          const entries = await this.load();
          const found = entries.find((item) => keyOf(item) === keyOf(entry));
          if (found) await this.save(entries.map((item) => item === found ? { ...found, attempts: found.attempts + 1 } : item));
          else this.closedWhileRaising.delete(keyOf(entry));
        });
        continue;
      }
      // Refused now (the chat or the member is gone, say): it never goes
      // out; the card says why, and is answered here.
      this.options.log("urgent-alert.outbox.refused", { alertId: entry.alertId, code: result.error.code });
      const stillHere = await this.serialize(async () => {
        const entries = await this.load();
        const found = entries.find((item) => keyOf(item) === keyOf(entry));
        if (!found) return false;
        await this.save(this.options.cards ? entries.map((item) => item === found ? { ...found, retrying: false } : item) : entries.filter((item) => item !== found));
        return Boolean(this.options.cards);
      });
      if (stillHere && this.options.cards) {
        const updated = await this.options.cards.update(entry.conversationId, entry.messageId, (alert) => alert.state === "unsent"
          ? { ...alert, unsent: { reason: "refused", message: result.error.message, retrying: false } }
          : alert).catch(() => undefined);
        if (!updated) await this.forget(keyOf(entry));
      }
    }
  }

  // --- what is kept -----------------------------------------------------------------

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.lock.then(work);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private load(): Promise<UnsentAlert[]> {
    if (this.entries) return Promise.resolve(this.entries);
    this.loading ??= this.options.store.read().then((raw) => {
      this.entries = parseEntries(raw);
      return this.entries;
    }).finally(() => { this.loading = undefined; });
    return this.loading;
  }

  private async save(entries: UnsentAlert[]): Promise<void> {
    // The oldest refused ones go first when there are too many.
    let kept = entries;
    while (kept.length > MAX_KEPT) {
      const oldestRefused = kept.findIndex((item) => !item.retrying);
      kept = kept.filter((_, index) => index !== (oldestRefused >= 0 ? oldestRefused : 0));
    }
    await this.options.store.write(JSON.stringify({ version: STORE_VERSION, alerts: kept }));
    this.entries = kept;
  }
}

function keyOf(alert: Pick<UnsentAlert, "conversationId" | "participantId" | "requestId">): string {
  return `${alert.conversationId}\n${alert.participantId}\n${alert.requestId}`;
}

function parseEntries(raw: string | undefined): UnsentAlert[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; alerts?: unknown };
    if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.alerts)) return [];
    return parsed.alerts.filter((item): item is UnsentAlert => Boolean(item) && typeof item === "object"
      && ["alertId", "requestId", "conversationId", "participantId", "messageId", "text", "raisedAt"].every((field) => typeof (item as Record<string, unknown>)[field] === "string")
      && typeof (item as UnsentAlert).retrying === "boolean")
      .map((item) => ({ ...item, attempts: typeof item.attempts === "number" ? item.attempts : 0 }));
  } catch {
    return [];
  }
}

function sentNote(raised: UrgentAlertRaised): string {
  return raised.state === "not_set_up"
    ? "User has not connected Telegram or a phone (Settings → Alerts), so the alert reached her only as a red card in this chat. Say so in your reply."
    : `Sent${raised.telegram ? " to User's Telegram with a Got it button" : ""}${raised.phone ? `${raised.telegram ? ";" : ""} her phone rings and the message is read out if she does not react in time` : ""}. It goes on by itself on the server; do not send the same alert again unless something new happens.`;
}

function failure<T>(code: UrgentAlertError["code"], message: string): HubAlertResult<T> {
  return { ok: false, error: { code, message } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
