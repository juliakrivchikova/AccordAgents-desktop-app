import { createHash, randomUUID } from "node:crypto";
import {
  DEVICE_EVENT_CHANNEL_PROTOCOL, isChatActionDependency, isDeviceEventPacket,
  type ChatActionDependency, type DeviceEventPacket
} from "../../shared/deviceEventChannel";
import { CHAT_ACTION_LOG_SCOPE } from "../../shared/chatActionEvents";
import { DEVICE_EVENT_INLINE_BYTES, isDeviceEventBlobReference } from "../../shared/deviceEventBlobs";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { DeviceEventApplyOutcome, DeviceEventGap, DeviceEventReceipt } from "../../shared/deviceEventDelivery";
import { DeviceEventProjectionPendingError } from "../../shared/deviceEventDelivery";
import type { MobilePairingPackage } from "../../shared/mobilePairing";
import { ChatEventLogService, verifySignedChatEvent } from "./chatEventLog";
import type { StorageService } from "./storage";
import { DeviceEventMailbox } from "./deviceEventMailbox";
import { DeviceEventBlobIncompleteError } from "./deviceEventBlobStorage";

interface DeviceEventChannelOptions {
  storage: StorageService;
  eventLog: ChatEventLogService;
  channelId: string;
  localDeviceId: string;
  peerDeviceId: string;
  peerPublicKeyDerBase64: string;
  pairing?: MobilePairingPackage;
  isPeerConnected?: () => boolean;
  /** Seals before sending over the live room, or the same sealed mailbox. */
  send(packet: DeviceEventPacket): Promise<void>;
  /** Domain owner persists before returning. Native effects must be guarded
   * by durable command receipts; a process crash may replay an unapplied event. */
  apply(event: ChatEventEnvelope, payload: unknown): Promise<DeviceEventApplyOutcome | "deferred" | DeferredWithDependency>;
  /** Serves a state a peer says it is missing, by publishing the action that
   *  carries it to this channel again. False when this peer cannot produce it,
   *  which is answered plainly instead of leaving the asker waiting. */
  serveDependency?(dependency: ChatActionDependency): Promise<boolean>;
  /** The peer cannot produce something a held action needs. Reported, because
   *  a deferred action that can never apply is not a transient state. */
  onDependencyUnavailable?(dependency: ChatActionDependency): void;
  onError(error: Error): void;
}

/** A deferred application that named what it is waiting for. */
export interface DeferredWithDependency {
  deferred: true;
  dependency: ChatActionDependency;
}

/** A durable device channel, independent of desktop/phone/machine roles.
 * Presence is separate. Events retain their signed identity across live, mailbox,
 * reconnect and repair paths; transport writes never delete retained events. */
export class DeviceEventChannel {
  private readonly mailbox?: DeviceEventMailbox;
  private inbound: Promise<void> = Promise.resolve();
  private flushing?: Promise<void>;
  private flushRequested = false;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private receivePending = true;
  private readonly lastSent = new Map<string, { at: number; attempts: number }>();
  private readonly requestedGaps = new Map<string, number>();
  private readonly requestedDependencies = new Map<string, number>();
  // Live-room and mailbox copies commonly overlap. Cache only identities and
  // receipts already committed to SQLite, never uncommitted application state.
  private readonly received = new Map<string, { hash: string; receipt?: DeviceEventReceipt; ackAt?: number }>();
  private readonly acknowledged = new Map<string, string>();

  constructor(private readonly options: DeviceEventChannelOptions) {
    const hash = createHash("sha256").update(Buffer.from(options.peerPublicKeyDerBase64, "base64")).digest("hex");
    if (options.peerDeviceId !== `device-${hash.slice(0, 32)}`) {
      throw new Error("Device event peer identity does not match its enrolled signing key.");
    }
    if (options.pairing?.outboxUrl) {
      this.mailbox = new DeviceEventMailbox({
        storage: options.storage, pairing: options.pairing,
        localDeviceId: options.localDeviceId, peerDeviceId: options.peerDeviceId,
        receive: (packet) => this.receive(packet), onError: options.onError
      });
    }
  }

  async publish(request: {
    conversationId: string; kind: string; payload: unknown; eventId?: string; scope?: string;
    /** A chat action is one event for every peer, not a copy per channel: the
     *  same decision must keep one identity however many machines hold it. */
    sharedScope?: boolean;
  }): Promise<ChatEventEnvelope> {
    if (this.stopped) throw new Error("Device event channel is closed.");
    const payload = await this.options.storage.deviceEventBlobs().prepare(request.payload);
    const result = await this.options.eventLog.appendLocalEvent({
      ...request,
      // Separate streams permit Stop to bypass bulk copy traffic. They still
      // use the same HLC, immutable event log and gap rules.
      logScopeId: request.sharedScope ? CHAT_ACTION_LOG_SCOPE : this.scope(request.conversationId, request.scope ?? "actions"),
      payload,
      recipients: [{ deviceId: this.options.peerDeviceId, channelId: this.options.channelId }]
    });
    this.scheduleFlush();
    return result.event;
  }

  start(): void {
    this.stopped = false;
    this.mailbox?.start();
    this.scheduleFlush();
    void this.enqueue(() => this.drain()).catch((error) => this.report(error));
  }

  close(): void {
    this.stopped = true;
    this.mailbox?.close();
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
  }

  receive(value: unknown): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return;
      if (!isDeviceEventPacket(value) || value.from !== this.options.peerDeviceId || value.to !== this.options.localDeviceId) {
        throw new Error("Device event packet is not addressed to this enrolled channel.");
      }
      switch (value.type) {
        case "fragment":
          this.receivePending = true;
          await this.options.storage.deviceEventBlobs().store(value.fragment);
          break;
        case "event": {
          this.receivePending = true;
          const event = value.event;
          if (!event || Buffer.byteLength(JSON.stringify(event), "utf8") > DEVICE_EVENT_INLINE_BYTES * 2 || event.originId !== value.from ||
              !this.inScope(event.logScopeId) ||
              !verifySignedChatEvent(event, this.options.peerPublicKeyDerBase64)) {
            throw new Error("Device event signature or channel scope is invalid.");
          }
          const remembered = this.received.get(event.eventId);
          if (remembered && remembered.hash !== event.eventHash) throw new Error(`Conflicting device event ${event.eventId}.`);
          if (remembered?.receipt) {
            // Explicit repair bypasses the short duplicate-ACK debounce. The
            // durable receipt remains available after any process restart.
            if (value.deliveryId || remembered.ackAt === undefined || performance.now() - remembered.ackAt >= 1000) {
              await this.repeatReceipt(remembered.receipt);
            }
            return;
          }
          if (remembered) break; // Stored but unapplied: retry the domain below.
          const stored = await this.options.storage.appendChatEvent(event, {
            ingress: { deviceId: value.from, channelId: this.options.channelId }
          });
          if (stored.status === "conflict") throw new Error(`Conflicting device event ${event.eventId}.`);
          const receipt = await this.options.storage.deviceEvents().receipt(event.eventId);
          remember(this.received, event.eventId, { hash: event.eventHash, receipt });
          if (receipt) await this.repeatReceipt(receipt);
          break;
        }
        case "ack": {
          const fingerprint = JSON.stringify(value.receipt);
          if (this.acknowledged.get(value.receipt.eventId) === fingerprint) return;
          if (await this.options.storage.deviceEvents().acknowledge(value.from, value.receipt)) {
            this.lastSent.delete(value.receipt.eventId);
            remember(this.acknowledged, value.receipt.eventId, fingerprint);
          }
          return;
        }
        case "resend":
          for (const event of await this.options.storage.deviceEvents().repair(this.options.channelId, value.from, value.gap)) {
            await this.sendEvent(event, value.requestId);
          }
          return;
        case "need": {
          if (!isChatActionDependency(value.dependency) || typeof value.requestId !== "string") {
            throw new Error("Invalid device event dependency request.");
          }
          const served = await this.options.serveDependency?.(value.dependency);
          if (!served) {
            await this.sendControl(this.packet({ type: "unavailable", dependency: value.dependency, requestId: value.requestId }));
          }
          return;
        }
        case "unavailable":
          if (!isChatActionDependency(value.dependency)) throw new Error("Invalid device event dependency answer.");
          this.requestedDependencies.delete(JSON.stringify(value.dependency));
          this.options.onDependencyUnavailable?.(value.dependency);
          return;
        case "probe":
          if (!Array.isArray(value.events) || value.events.length > 100) throw new Error("Invalid device event receipt probe.");
          for (const header of value.events) {
            if (!header || header.originId !== value.from || typeof header.eventId !== "string" ||
                typeof header.eventHash !== "string" || typeof header.logScopeId !== "string" ||
                !header.logScopeId.startsWith(`device:${this.options.channelId}:`) || !Number.isSafeInteger(header.originSeq) || header.originSeq < 1) {
              throw new Error("Invalid device event receipt probe identity.");
            }
            const receipt = await this.options.storage.deviceEvents().receipt(header.eventId);
            if (receipt) {
              if (receipt.eventHash !== header.eventHash) throw new Error("Conflicting device receipt probe.");
              await this.repeatReceipt(receipt);
            } else if (!await this.options.storage.getChatEvent(header.eventId)) {
              await this.sendControl(this.packet({ type: "resend", requestId: randomUUID(), gap: {
                originId: header.originId, logScopeId: header.logScopeId, fromSeq: header.originSeq, toSeq: header.originSeq
              } }));
            }
          }
          this.receivePending = true;
          break;
      }
      // The event/fragment is on disk already. Domain failure is retried
      // independently, so one bad chat cannot pin a mailbox cursor forever.
      try { await this.drain(); }
      catch (error) { throw new DeviceEventProjectionPendingError(error); }
    });
  }

  /** A domain owner can finish asynchronously (for example ChatService saves
   * a live terminal after its dispatch promise resolves). Unrelated ingress
   * must remain runnable while that save is pending or failing. */
  confirmApplied(event: ChatEventEnvelope, outcome: DeviceEventApplyOutcome = "applied"): Promise<void> {
    return this.enqueue(async () => {
      const receipt = await this.options.storage.deviceEvents().markApplied(event, outcome, new Date().toISOString());
      remember(this.received, event.eventId, { hash: event.eventHash, receipt });
      await this.sendControl(this.packet({ type: "ack", receipt }));
      this.received.get(event.eventId)!.ackAt = performance.now();
      this.receivePending = true;
      this.scheduleFlush();
    });
  }

  async flush(): Promise<void> {
    this.flushRequested = true;
    if (this.flushing) return this.flushing;
    const run = (async () => {
      do {
        this.flushRequested = false;
        await this.flushPending();
      } while (this.flushRequested && !this.stopped);
    })();
    this.flushing = run;
    try { await run; } finally { if (this.flushing === run) this.flushing = undefined; }
  }

  private async flushPending(): Promise<void> {
    if (this.options.isPeerConnected?.() === false) return;
    let cursor = 0;
    while (!this.stopped) {
      const page = await this.options.storage.deviceEvents().listPending(this.options.channelId, cursor, this.options.peerDeviceId);
      if (!page.length) return;
      for (const entry of page) {
        if (this.stopped) return;
        const previous = this.lastSent.get(entry.event.eventId);
        const delay = previous ? Math.min(5_000 * 2 ** previous.attempts, 300_000) : 0;
        if (!previous || performance.now() - previous.at >= delay) {
          await this.sendEvent(entry.event);
          this.lastSent.set(entry.event.eventId, { at: performance.now(), attempts: Math.min((previous?.attempts ?? -1) + 1, 6) });
        }
        cursor = entry.rowId;
      }
    }
  }

  private async sendEvent(event: ChatEventEnvelope, deliveryId?: string): Promise<void> {
    if (isDeviceEventBlobReference(event.payload)) {
      for (let index = 0; index < event.payload.fragments; index += 1) {
        if (this.stopped) return;
        const fragment = await this.options.storage.deviceEventBlobs().fragment(event.payload, index);
        if (!fragment) throw new Error(`Missing retained device event fragment ${index}.`);
        const packet = this.packet({ type: "fragment", fragment, ...(deliveryId ? { deliveryId } : {}) });
        if (deliveryId) await this.sendControl(packet); else await this.options.send(packet);
      }
    }
    if (!this.stopped) {
      const packet = this.packet({ type: "event", event, ...(deliveryId ? { deliveryId } : {}) });
      if (deliveryId) await this.sendControl(packet); else await this.options.send(packet);
    }
  }

  private async drain(): Promise<void> {
    const missingBodies = new Map<string, DeviceEventGap>();
    const held = new Set<string>();
    const dependencies = new Map<string, ChatActionDependency>();
    let applyError: unknown;
    let deferred = false;
    // A held event is retried as soon as something else applies: the action it
    // was waiting for usually arrives in the same delivery, and waiting for the
    // next timer would make an answered dependency look like a stuck one.
    let appliedSinceHold = false;
    while (!this.stopped) {
      const ready = await this.options.storage.deviceEvents().ready(this.options.channelId, this.options.peerDeviceId, [...held]);
      if (!ready.length) {
        if (!appliedSinceHold || !held.size) break;
        appliedSinceHold = false;
        held.clear();
        deferred = false;
        continue;
      }
      for (const event of ready) {
        try {
          let payload: unknown;
          try { payload = await this.options.storage.deviceEventBlobs().hydrate(event.payload); }
          catch (error) {
            if (error instanceof DeviceEventBlobIncompleteError) {
              // A manifest may outlive its fragments in the temporary mailbox.
              // Request this exact event (and dependencies) from retained origin
              // history even though its sequence number itself is not missing.
              missingBodies.set(event.eventId, { originId: event.originId, logScopeId: event.logScopeId, fromSeq: event.originSeq, toSeq: event.originSeq });
              held.add(event.eventId);
              continue;
            }
            throw error;
          }
          const outcome = await this.options.apply(event, payload);
          if (outcome === "deferred" || (typeof outcome === "object" && outcome.deferred)) {
            deferred = true;
            held.add(event.eventId);
            if (typeof outcome === "object") dependencies.set(JSON.stringify(outcome.dependency), outcome.dependency);
            continue;
          }
          const receipt = await this.options.storage.deviceEvents()
            .markApplied(event, outcome as DeviceEventApplyOutcome, new Date().toISOString());
          remember(this.received, event.eventId, { hash: event.eventHash, receipt });
          await this.sendControl(this.packet({ type: "ack", receipt }));
          this.received.get(event.eventId)!.ackAt = performance.now();
          appliedSinceHold = true;
        } catch (error) {
          // A missing chat, full disk, or pending domain owner holds this
          // stream; other conversations on the same device can still apply.
          held.add(event.eventId);
          applyError ??= error;
        }
      }
    }
    const gaps = [...missingBodies.values(), ...await this.options.storage.deviceEvents().gaps(this.options.channelId, this.options.peerDeviceId)];
    this.receivePending = deferred || applyError !== undefined || gaps.length > 0;
    const activeRequests = new Set(gaps.map((gap) => JSON.stringify(gap)));
    for (const key of this.requestedGaps.keys()) if (!activeRequests.has(key)) this.requestedGaps.delete(key);
    for (const gap of gaps) {
      const key = JSON.stringify(gap);
      const previous = this.requestedGaps.get(key);
      if (previous !== undefined && performance.now() - previous < 5_000) continue;
      await this.sendControl(this.packet({ type: "resend", gap, requestId: randomUUID() }));
      this.requestedGaps.set(key, performance.now());
    }
    for (const [key, dependency] of dependencies) {
      const previous = this.requestedDependencies.get(key);
      if (previous !== undefined && performance.now() - previous < 5_000) continue;
      await this.sendControl(this.packet({ type: "need", dependency, requestId: randomUUID() }));
      this.requestedDependencies.set(key, performance.now());
    }
    if (applyError !== undefined) throw applyError;
  }

  /** Chat actions share one log across every machine, so one decision is one
   *  event with many recipients rather than a separate copy per channel. */
  private inScope(logScopeId: string): boolean {
    return logScopeId === CHAT_ACTION_LOG_SCOPE || logScopeId.startsWith(`device:${this.options.channelId}:`);
  }

  private scope(conversationId: string, scope: string): string {
    return `device:${this.options.channelId}:${JSON.stringify([conversationId, scope])}`;
  }

  private packet(body: DistributeBody<DeviceEventPacket>): DeviceEventPacket {
    return { protocol: DEVICE_EVENT_CHANNEL_PROTOCOL, from: this.options.localDeviceId, to: this.options.peerDeviceId, ...body };
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.inbound.then(task);
    this.inbound = next.catch(() => undefined);
    return next;
  }

  private scheduleFlush(): void {
    if (this.stopped) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void Promise.allSettled([this.flush(), this.mailbox?.flush(), this.receivePending ? this.enqueue(() => this.drain()) : undefined]).then((results) => {
        for (const result of results) if (result.status === "rejected") this.report(result.reason);
      }).finally(() => {
        if (!this.stopped && !this.retry) {
          this.retry = setTimeout(() => { this.retry = undefined; this.scheduleFlush(); }, 5_000);
          this.retry.unref?.();
        }
      });
    }, 0);
    this.retry.unref?.();
  }

  private report(error: unknown): void {
    this.options.onError(error instanceof Error ? error : new Error(String(error)));
  }

  private async sendControl(packet: DeviceEventPacket): Promise<void> {
    const writes: Promise<void>[] = this.options.isPeerConnected?.() === false ? [] : [this.options.send(packet)];
    if (this.mailbox) writes.push(this.mailbox.sendPacket(packet));
    if (!writes.length) throw new Error("The enrolled peer is unreachable.");
    // A slow HTTP mailbox cannot stall the live-room apply queue. Promise.any
    // observes failures in both paths while resolving on the first success.
    await Promise.any(writes);
  }

  private async repeatReceipt(receipt: DeviceEventReceipt): Promise<void> {
    // The previous ACK can have expired in the relay. Keep this new attempt
    // before posting it, so a failed POST plus receiver restart cannot lose it.
    await this.options.storage.deviceEvents().retainReceiptForRedelivery(receipt.eventId);
    try {
      await this.sendControl(this.packet({ type: "ack", receipt, deliveryId: randomUUID() }));
      const remembered = this.received.get(receipt.eventId);
      if (remembered) remembered.ackAt = performance.now();
    }
    catch (error) { this.report(error); } // The receipt outbox retries independently.
  }
}

type DistributeBody<T> = T extends DeviceEventPacket ? Omit<T, "protocol" | "from" | "to"> : never;

function remember<T>(entries: Map<string, T>, key: string, value: T): void {
  entries.delete(key);
  entries.set(key, value);
  if (entries.size > 2048) entries.delete(entries.keys().next().value!);
}
