import { createHash } from "node:crypto";
import {
  URGENT_ALERT_ACKNOWLEDGEABLE_STATES, URGENT_ALERT_MESSAGE_MAX_CHARS, URGENT_ALERT_SERVER_TOO_OLD, URGENT_ALERT_UNSENT_ID_PREFIX,
  type HubAlertRequest, type HubAlertResult, type UrgentAlertError, type UrgentAlertRaised, type UrgentAlertView
} from "../../shared/urgentAlerts";
import { urgentAlertCardMessageId, urgentAlertUnsentId } from "./urgentAlertCardIds";

export { urgentAlertCardMessageId } from "./urgentAlertCardIds";

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
  /** Puts the card up: "answered" when she already pressed Got it on it
   *  (it stays as she left it), "server" when the server's card stands
   *  there already, "gone" when the chat or member is gone. */
  show(card: { conversationId: string; participantId: string; messageId: string; text: string; createdAt: string; alert: UrgentAlertView }): Promise<"shown" | "answered" | "server" | "gone">;
  /** Changes the card while it is still this computer's own. */
  update(conversationId: string, messageId: string, change: (alert: UrgentAlertView) => UrgentAlertView): Promise<UrgentAlertView | undefined>;
  remove(conversationId: string, messageId: string): Promise<void>;
  /** The alert the message carries now, the server's card or this computer's. */
  alertOf(conversationId: string, messageId: string): Promise<UrgentAlertView | undefined>;
}

/** Where the alerts not settled with the server yet are kept (across restarts). */
export interface UrgentAlertOutboxStore {
  read(): Promise<string | undefined>;
  write(value: string): Promise<void>;
}

/**
 * An alert not settled with the server yet. "waiting": to be raised there.
 * "reached": the server took it; its card is on its way through the feed.
 * "closed": she pressed Got it on this computer's card; it is never raised
 * again, and the server's alert (if a raise did reach it after all) is
 * closed there as soon as it is known.
 */
interface PendingAlert {
  /** The card's alert id here (`unsent-…`). */
  alertId: string;
  requestId: string;
  conversationId: string;
  participantId: string;
  messageId: string;
  text: string;
  raisedAt: string;
  stage: "waiting" | "reached" | "closed";
  /** The server's alert, once known. */
  serverAlertId?: string;
  /** Refusals in a row (a chat or member the server does not know yet). */
  refusals: number;
  /** When the stage last changed. */
  since: string;
}

type AlertInput = Pick<PendingAlert, "alertId" | "requestId" | "conversationId" | "participantId" | "messageId" | "text" | "raisedAt">;

const STORE_VERSION = 1;
/** Settled alerts ("reached", "closed") kept at most; the oldest go first.
 *  One still waiting to go out is never dropped. */
const MAX_SETTLED_KEPT = 50;
/** A server that refuses (a chat or member its feed has not brought yet, the
 *  writes of this device still on their way) is asked again this many times
 *  before the alert counts as refused. */
const MAX_REFUSALS = 20;
/** How long the server's card is waited for once the server took the alert. */
const KEEP_REACHED_MS = 60 * 60_000;
/** How long an alert she closed here is kept, in case a raise that seemed
 *  lost did reach the server (its card then comes through the feed). */
const KEEP_CLOSED_MS = 24 * 60 * 60_000;
/** Without a request id, the same message within this window (a retry after
 *  a lost answer) is the same alert; a later one is a new alert. */
const REQUEST_ID_WINDOW_MS = 60_000;
const MAX_REQUEST_ID_CHARS = 200;
const DEFAULT_RAISE_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_MS = 30_000;

/**
 * A member's urgent alerts (app_urgent_alert), on the computer and on cloud
 * machines (same code). The User's server carries every alert: its card in
 * the chat, Telegram, the calls. When the server cannot take one, the
 * computer puts the same red card up in the chat itself at once, and keeps
 * raising the alert until the server takes it; the server's card then
 * replaces this one (same message id, same request id, so never twice). Got
 * it on that card before then keeps it from going out, and closes it on the
 * server if a raise reached it after all. A machine has no card of its own
 * to show: it keeps raising the alert until her server takes it.
 */
export class UrgentAlertOutbox {
  private entries?: PendingAlert[];
  private loading?: Promise<PendingAlert[]>;
  private lock: Promise<unknown> = Promise.resolve();
  private readonly inFlight = new Map<string, Promise<{ result: HubAlertResult<UrgentAlertRaised>; timedOut: boolean }>>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private readonly options: {
    access: () => UrgentAlertServerAccess | undefined;
    store: UrgentAlertOutboxStore;
    cards?: UrgentAlertCardHost;
    log: (event: string, payload: Record<string, unknown>) => void;
    raiseTimeoutMs?: number;
    retryMs?: number;
    now?: () => number;
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
      ? args.requestId.slice(0, MAX_REQUEST_ID_CHARS)
      : createHash("sha256").update(`${actor.conversationId}\n${actor.participantId}\n${text}\n${Math.floor(this.now() / REQUEST_ID_WINDOW_MS)}`).digest("hex").slice(0, 32);
    const alert: AlertInput = {
      alertId: urgentAlertUnsentId(actor.conversationId, actor.participantId, requestId),
      requestId,
      conversationId: actor.conversationId,
      participantId: actor.participantId,
      messageId: urgentAlertCardMessageId(actor.conversationId, actor.participantId, requestId),
      text,
      raisedAt: new Date(this.now()).toISOString()
    };
    // The same alert she already answered here is not sent again.
    if ((await this.find(keyOf(alert)))?.stage === "closed") return answeredResult(alert);
    const { result, timedOut } = await this.attempt(alert);
    if (result.ok) {
      await this.reached(alert, result.value);
      return { ok: true, value: result.value, note: sentNote(result.value) };
    }
    // The member's own mistake (the server checks more than this device): it
    // fixes the call; nothing to show her.
    if (result.error.code === "invalid_request") return result;
    const retrying = retryable(result.error, 1);
    const kept = await this.keep(alert, retrying, result.error);
    if (kept === "answered") return answeredResult(alert);
    if (kept === "reached") {
      return { ok: true, value: { alertId: alert.alertId, messageId: alert.messageId, state: "waiting", telegram: false, phone: false } satisfies UrgentAlertRaised,
        note: "User's server already took this alert earlier; it goes on there. Do not call again for the same incident." };
    }
    const why = timedOut ? `it did not answer within ${Math.round(this.raiseTimeoutMs() / 1000)} seconds, so it may have taken it after all` : trimmedReason(result.error.message);
    if (kept === "shown") {
      return {
        ok: true,
        value: { alertId: alert.alertId, messageId: alert.messageId, state: "unsent", telegram: false, phone: false } satisfies UrgentAlertRaised,
        note: retrying
          ? `User's server could not take the alert now (${why}). It reached her as a red card in this chat on her computer; Telegram and calls go out only once her server takes it: the app keeps raising it there (never twice) unless she presses Got it first. Do not call again for the same incident; say in your reply that the alert may not have gone out.`
          : `User's server did not take the alert (${why}), so it reached her only as a red card in this chat on her computer: no Telegram, no call. Say so in your reply.`
      };
    }
    if (retrying) {
      return failure("server_unavailable", `User's server could not take the alert now (${why}), so nothing may have reached her yet. It is raised on her server as soon as it can take it (a red card in this chat, then Telegram and calls), never twice. Do not call again for the same incident; tell User in your reply.`);
    }
    return result;
  }

  /**
   * Got it (or the cross) on a card. Undefined when the card is the
   * server's: the request goes there. A card of this computer is answered
   * here, and its alert is never raised again; one the server took meanwhile
   * is closed there too.
   */
  async close(request: { alertId: string; conversationId?: string; messageId?: string }): Promise<{ handled: HubAlertResult<UrgentAlertView> } | { forwardTo: string } | undefined> {
    if (!request.alertId.startsWith(URGENT_ALERT_UNSENT_ID_PREFIX)) return undefined;
    const at = new Date(this.now()).toISOString();
    const entry = await this.serialize(async () => {
      const entries = await this.load();
      const found = entries.find((item) => item.alertId === request.alertId);
      if (!found) return undefined;
      const closed: PendingAlert = found.stage === "closed" ? found : { ...found, stage: "closed", since: at };
      if (closed !== found) await this.save(entries.map((item) => item === found ? closed : item));
      return closed;
    });
    const conversationId = entry?.conversationId ?? request.conversationId;
    const messageId = entry?.messageId ?? request.messageId;
    if (entry?.serverAlertId) await this.closeOnServer(keyOf(entry));
    this.options.log("urgent-alert.outbox.closed-here", { alertId: request.alertId, kept: Boolean(entry), server: Boolean(entry?.serverAlertId) });
    if (!conversationId || !messageId || !this.options.cards) return { handled: failure("invalid_request", "Which alert's card?") };
    const view = await this.options.cards.update(conversationId, messageId, (alert) => ({
      ...alert, state: "acknowledged", ackedAt: alert.ackedAt ?? at, ackSource: alert.ackSource ?? "app", closedAt: alert.closedAt ?? at,
      ...(alert.unsent ? { unsent: { ...alert.unsent, retrying: false } } : {})
    })).catch((error: unknown) => {
      this.options.log("urgent-alert.outbox.card-failed", { alertId: request.alertId, message: messageOf(error) });
      return undefined;
    });
    if (view) return { handled: { ok: true, value: view } };
    // The server's card took this one's place meanwhile: Got it goes there.
    const now = await this.options.cards.alertOf(conversationId, messageId).catch(() => undefined);
    if (now && !now.id.startsWith(URGENT_ALERT_UNSENT_ID_PREFIX)) return { forwardTo: now.id };
    return { handled: failure("invalid_request", "This alert's card is no longer here.") };
  }

  /** The server's card of an alert arrived (the feed, or a whole read of
   *  the chat): whatever this device kept for it is settled. */
  async serverCardArrived(conversationId: string, messageId: string, alert: UrgentAlertView): Promise<void> {
    const entries = this.entries ?? await this.load().catch(() => [] as PendingAlert[]);
    if (!entries.some((item) => item.conversationId === conversationId && item.messageId === messageId)) return;
    const settled = await this.serialize(async () => {
      const current = await this.load();
      const found = current.find((item) => item.conversationId === conversationId && item.messageId === messageId);
      if (!found) return undefined;
      // She pressed Got it here first: the server's alert is closed too.
      if (found.stage === "closed" && URGENT_ALERT_ACKNOWLEDGEABLE_STATES.includes(alert.state) && !alert.closedAt) {
        const next: PendingAlert = { ...found, serverAlertId: alert.id };
        await this.save(current.map((item) => item === found ? next : item));
        return next;
      }
      await this.save(current.filter((item) => item !== found));
      return undefined;
    });
    if (settled) await this.closeOnServer(keyOf(settled));
  }

  /** Raises again what the server has not taken yet; closes there what she
   *  answered here; lets go of what waited too long. */
  async retryDue(): Promise<void> {
    const now = this.now();
    for (const entry of [...await this.load()]) {
      if (this.stopped) return;
      const key = keyOf(entry);
      if (entry.stage === "closed") {
        if (entry.serverAlertId) await this.closeOnServer(key);
        else if (now - Date.parse(entry.since) > KEEP_CLOSED_MS) await this.forget(key);
        continue;
      }
      if (entry.stage === "reached") {
        if (now - Date.parse(entry.since) > KEEP_REACHED_MS) await this.forget(key);
        continue;
      }
      // Raised only while it still waits: never once she answered it.
      const claimed = await this.serialize(async () => (await this.load()).find((item) => keyOf(item) === key && item.stage === "waiting"));
      if (!claimed) continue;
      const { result } = await this.attempt(claimed);
      if (result.ok) {
        await this.reached(claimed, result.value);
        continue;
      }
      if (result.error.code === "server_unavailable") continue;
      const refusals = claimed.refusals + 1;
      if (retryable(result.error, refusals)) {
        await this.serialize(async () => {
          const entries = await this.load();
          const found = entries.find((item) => keyOf(item) === key && item.stage === "waiting");
          if (found) await this.save(entries.map((item) => item === found ? { ...found, refusals } : item));
        });
        continue;
      }
      // Refused for good (the chat or the member is gone, say): it never
      // goes out; the card says why, and is answered here.
      this.options.log("urgent-alert.outbox.refused", { alertId: claimed.alertId, code: result.error.code, refusals });
      await this.serialize(async () => {
        const entries = await this.load();
        if (entries.some((item) => keyOf(item) === key && item.stage === "waiting")) await this.save(entries.filter((item) => !(keyOf(item) === key && item.stage === "waiting")));
      });
      await this.options.cards?.update(claimed.conversationId, claimed.messageId, (alert) => alert.state === "unsent"
        ? { ...alert, unsent: { reason: "refused", message: result.error.message, retrying: false } }
        : alert).catch(() => undefined);
    }
  }

  // --- the way to the server ------------------------------------------------------

  /** One raise on the server (one at a time per alert), bounded in time. */
  private attempt(alert: AlertInput): Promise<{ result: HubAlertResult<UrgentAlertRaised>; timedOut: boolean }> {
    const key = keyOf(alert);
    const running = this.inFlight.get(key);
    if (running) return running;
    const run = (async () => {
      const access = this.currentAccess();
      if (!access) return { result: failure<UrgentAlertRaised>("server_unavailable", "This device is not linked to User's server yet."), timedOut: false };
      const signal = AbortSignal.timeout(this.raiseTimeoutMs());
      try {
        const result = await access.alerts<UrgentAlertRaised>({
          action: "raise", conversationId: alert.conversationId, participantId: alert.participantId, text: alert.text, requestId: alert.requestId
        }, signal);
        return { result, timedOut: !result.ok && signal.aborted };
      } catch (error) {
        return { result: failure<UrgentAlertRaised>("server_unavailable", messageOf(error)), timedOut: signal.aborted };
      }
    })().finally(() => {
      if (this.inFlight.get(key) === run) this.inFlight.delete(key);
    });
    this.inFlight.set(key, run);
    return run;
  }

  /** The server took the alert. Its card takes this one's place through the
   *  feed (same id); a server older than this app wrote it under another id,
   *  so this one comes down. Answered here meanwhile, it is closed there. */
  private async reached(alert: AlertInput, raised: UrgentAlertRaised): Promise<void> {
    const key = keyOf(alert);
    const sameCard = raised.messageId === alert.messageId;
    const at = new Date(this.now()).toISOString();
    const outcome = await this.serialize(async () => {
      const entries = await this.load();
      const found = entries.find((item) => keyOf(item) === key);
      if (found?.stage === "closed") {
        const next: PendingAlert = { ...found, serverAlertId: raised.alertId };
        await this.save(entries.map((item) => item === found ? next : item));
        return "close" as const;
      }
      if (!found) return "none" as const;
      // Waited for until its card arrives (the feed), so that Got it on
      // this card meanwhile reaches the server's alert, after a restart too.
      await this.save(sameCard
        ? entries.map((item) => item === found ? { ...found, stage: "reached" as const, serverAlertId: raised.alertId, since: at } : item)
        : entries.filter((item) => item !== found));
      return "kept" as const;
    });
    if (!sameCard && this.options.cards) {
      await this.options.cards.remove(alert.conversationId, alert.messageId).catch((error: unknown) => this.options.log("urgent-alert.outbox.card-failed", { alertId: alert.alertId, message: messageOf(error) }));
    }
    if (outcome === "close") await this.closeOnServer(key);
    if (outcome !== "none") this.options.log("urgent-alert.outbox.reached-server", { alertId: alert.alertId, serverAlertId: raised.alertId, state: raised.state, closedHere: outcome === "close" });
  }

  /** Closes on the server an alert she answered here; kept and tried again
   *  until the server says so (or says there is no such alert). */
  private async closeOnServer(key: string): Promise<void> {
    const entry = await this.find(key);
    if (!entry?.serverAlertId) return;
    const access = this.currentAccess();
    if (!access) return;
    const result = await access.alerts({ action: "close", alertId: entry.serverAlertId }, AbortSignal.timeout(this.raiseTimeoutMs()))
      .catch((error: unknown) => failure("server_unavailable", messageOf(error)));
    this.options.log("urgent-alert.outbox.closed-on-server", { alertId: entry.serverAlertId, ok: result.ok, ...(result.ok ? {} : { code: result.error.code }) });
    if (result.ok || result.error.code !== "server_unavailable") await this.forget(key);
  }

  /** Keeps an alert the server did not take, and puts its card up here. */
  private async keep(alert: AlertInput, retrying: boolean, error: UrgentAlertError): Promise<"shown" | "answered" | "reached" | "queued" | "dropped"> {
    const key = keyOf(alert);
    const at = new Date(this.now()).toISOString();
    const stage = await this.serialize(async () => {
      const entries = await this.load();
      const existing = entries.find((item) => keyOf(item) === key);
      if (existing?.stage === "closed") return "closed" as const;
      if (existing && existing.stage !== "waiting") return existing.stage;
      if (retrying) {
        if (!existing) await this.save([...entries, { ...alert, stage: "waiting", refusals: error.code === "server_unavailable" ? 0 : 1, since: at }]);
      } else if (existing) {
        await this.save(entries.filter((item) => item !== existing));
      }
      return undefined;
    });
    if (stage === "closed") return "answered";
    if (stage === "reached") return "reached";
    if (retrying) this.schedule();
    if (!this.options.cards) return retrying ? "queued" : "dropped";
    const reason: "unreachable" | "outdated" | "refused" = error.code === "server_unavailable"
      ? (error.message === URGENT_ALERT_SERVER_TOO_OLD ? "outdated" : "unreachable")
      : "refused";
    const view: UrgentAlertView = {
      id: alert.alertId, state: "unsent", createdAt: alert.raisedAt, calls: [], phone: false, callMode: "answer",
      unsent: { reason, ...(reason === "refused" ? { message: error.message } : {}), retrying }
    };
    const shown = await this.options.cards.show({
      conversationId: alert.conversationId, participantId: alert.participantId, messageId: alert.messageId,
      text: alert.text, createdAt: alert.raisedAt, alert: view
    }).catch((failed: unknown): "gone" => {
      this.options.log("urgent-alert.outbox.card-failed", { alertId: alert.alertId, message: messageOf(failed) });
      return "gone";
    });
    this.options.log("urgent-alert.outbox.kept", { alertId: alert.alertId, conversationId: alert.conversationId, retrying, shown, code: error.code });
    if (shown === "answered") {
      // Its card says she pressed Got it on it already (what was kept for
      // it was lost): it stays answered and is never raised.
      await this.serialize(async () => {
        const entries = await this.load();
        const found = entries.find((item) => keyOf(item) === key);
        if (found) await this.save(entries.map((item) => item === found ? { ...found, stage: "closed" as const, since: at } : item));
      });
      return "answered";
    }
    if (shown === "gone" || shown === "server") {
      await this.forget(key);
      return shown === "server" ? "reached" : "dropped";
    }
    return "shown";
  }

  private async forget(key: string): Promise<void> {
    await this.serialize(async () => {
      const entries = await this.load();
      if (entries.some((item) => keyOf(item) === key)) await this.save(entries.filter((item) => keyOf(item) !== key));
    });
  }

  private async find(key: string): Promise<PendingAlert | undefined> {
    return (await this.load()).find((item) => keyOf(item) === key);
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.retryDue().catch((error: unknown) => this.options.log("urgent-alert.outbox.retry-failed", { message: messageOf(error) }))
        .finally(() => {
          // Until what was kept is read (storage still starting), and while
          // anything is kept.
          if (!this.entries || this.entries.length > 0) this.schedule();
        });
    }, this.options.retryMs ?? DEFAULT_RETRY_MS);
    this.timer.unref?.();
  }

  private currentAccess(): UrgentAlertServerAccess | undefined {
    try {
      return this.options.access();
    } catch {
      return undefined;
    }
  }

  private raiseTimeoutMs(): number {
    return this.options.raiseTimeoutMs ?? DEFAULT_RAISE_TIMEOUT_MS;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  // --- what is kept -----------------------------------------------------------------

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.lock.then(work);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private load(): Promise<PendingAlert[]> {
    if (this.entries) return Promise.resolve(this.entries);
    this.loading ??= this.options.store.read().then((raw) => {
      this.entries = parseEntries(raw);
      return this.entries;
    }).finally(() => { this.loading = undefined; });
    return this.loading;
  }

  private async save(entries: PendingAlert[]): Promise<void> {
    // Settled ones beyond the limit go, oldest first; one still waiting to
    // go out is never dropped.
    let kept = entries;
    let settled = kept.filter((item) => item.stage !== "waiting").length;
    while (settled > MAX_SETTLED_KEPT) {
      const oldest = kept.findIndex((item) => item.stage !== "waiting");
      kept = kept.filter((_, index) => index !== oldest);
      settled -= 1;
    }
    await this.options.store.write(JSON.stringify({ version: STORE_VERSION, alerts: kept }));
    this.entries = kept;
  }
}

/** Whether the server may still take the alert later: it was not reached,
 *  or it refused for a while (a chat or member its feed has not brought
 *  yet, this device's writes still on their way). */
function retryable(error: UrgentAlertError, refusals: number): boolean {
  if (error.code === "server_unavailable") return true;
  return error.code === "access_denied" && refusals < MAX_REFUSALS;
}

function answeredResult(alert: AlertInput): unknown {
  return {
    ok: true,
    value: { alertId: alert.alertId, messageId: alert.messageId, state: "acknowledged", telegram: false, phone: false } satisfies UrgentAlertRaised,
    note: "User already pressed Got it on this alert's card, so it was not sent again. Do not call again for the same incident."
  };
}

function trimmedReason(message: string): string {
  return message.trim().replace(/[.\s]+$/, "");
}

function keyOf(alert: Pick<PendingAlert, "conversationId" | "participantId" | "requestId">): string {
  return `${alert.conversationId}\n${alert.participantId}\n${alert.requestId}`;
}

const STAGES: ReadonlySet<string> = new Set(["waiting", "reached", "closed"]);

function parseEntries(raw: string | undefined): PendingAlert[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; alerts?: unknown };
    if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.alerts)) return [];
    return parsed.alerts.filter((item): item is PendingAlert => Boolean(item) && typeof item === "object"
      && ["alertId", "requestId", "conversationId", "participantId", "messageId", "text", "raisedAt", "since"].every((field) => typeof (item as Record<string, unknown>)[field] === "string")
      && STAGES.has((item as PendingAlert).stage))
      .map((item) => ({ ...item, refusals: typeof item.refusals === "number" ? item.refusals : 0 }));
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
