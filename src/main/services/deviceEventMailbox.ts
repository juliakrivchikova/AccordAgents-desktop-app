import { createHash, randomUUID } from "node:crypto";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import { isDeviceEventPacket, type DeviceEventPacket } from "../../shared/deviceEventChannel";
import { isDeviceEventBlobReference } from "../../shared/deviceEventBlobs";
import type { MobilePairingPackage } from "../../shared/mobilePairing";
import { mailboxAuthHeaders, mailboxEndpointForSealKey, registerMailboxForSealKey } from "./mailboxAccess";
import { openMobileRelayPayload, sealMobileRelayPayload } from "./mobileRelaySealing";
import type { StorageService } from "./storage";
import { DeviceEventProjectionPendingError } from "../../shared/deviceEventDelivery";
import { DevicePacketAuthenticationError } from "./devicePacketAuthentication";

interface DeviceEventMailboxOptions {
  storage: StorageService;
  pairing: MobilePairingPackage;
  localDeviceId: string;
  peerDeviceId: string;
  receive(packet: DeviceEventPacket): Promise<void>;
  authenticate?(packet: DeviceEventPacket): Promise<DeviceEventPacket>;
  onError(error: Error): void;
  fetch?: typeof fetch;
}

/** The existing sealed mailbox is a temporary delivery buffer. The durable
 * source is the local event outbox; only sealed, bounded packets go to it.
 * Initial copies can contain a whole chat across those packets.
 * Its cursor is transport progress only, never event ordering or authority. */
export class DeviceEventMailbox {
  private readonly fetchImpl: typeof fetch;
  private timer?: ReturnType<typeof setTimeout>;
  private flushing?: Promise<void>;
  private polling?: Promise<void>;
  private lifetime = new AbortController();
  private active = false;
  private failures = 0;
  private posts: Promise<void> = Promise.resolve();
  private readonly lastProbed = new Map<string, number>();

  constructor(private readonly options: DeviceEventMailboxOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
    this.schedule(0);
  }

  close(): void {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.lifetime.abort();
  }

  sendPacket(packet: DeviceEventPacket): Promise<void> {
    const next = this.posts.then(() => this.postPacket(packet));
    this.posts = next.catch(() => undefined);
    return next;
  }

  private async postPacket(packet: DeviceEventPacket): Promise<void> {
    if (this.options.authenticate) packet = await this.options.authenticate(packet);
    const { pairing } = this.options;
    const packetJson = JSON.stringify(packet);
    const payloadHash = `sha256:${digest(packetJson)}`;
    // Ordinary retransmission reuses the buffer id. A requested repair has a
    // fresh deliveryId so readers already beyond the old arrival can see it;
    // the signed event nested in the sealed packet remains byte-for-byte equal.
    const eventId = `device-packet-${digest(packetJson)}`;
    const envelope = {
      eventId, conversationId: pairing.rendezvousId, logScopeId: "device.channel",
      originId: packet.from, originSeq: 1, logicalTs: eventId,
      kind: "device.channel.packet", payloadHash, eventHash: payloadHash,
      createdAt: new Date().toISOString(),
      payload: JSON.parse(await sealMobileRelayPayload(packet, pairing.relaySealKeyBase64)) as unknown
    };
    const response = await this.request("POST", undefined, JSON.stringify({ events: [envelope] }));
    const result = await response.json() as { ackRole?: unknown; eventIds?: unknown };
    if (result.ackRole !== "mailbox" || !Array.isArray(result.eventIds) || !result.eventIds.includes(eventId)) {
      throw new Error("The relay did not acknowledge the sealed device packet.");
    }
    if (packet.type === "ack") {
      await this.options.storage.deviceEvents().markReceiptDelivered(pairing.rendezvousId, packet.to, packet.receipt);
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const run = Promise.all([this.flushPending(), this.flushReceipts()]).then(() => undefined);
    this.flushing = run;
    try { await run; } finally { if (this.flushing === run) this.flushing = undefined; }
  }

  private async flushPending(): Promise<void> {
    const { storage, pairing, localDeviceId, peerDeviceId } = this.options;
    let cursor = 0;
    const pendingIds = new Set<string>();
    while (!this.lifetime.signal.aborted) {
      const page = await storage.deviceEvents().listPending(pairing.rendezvousId, cursor, peerDeviceId);
      if (!page.length) break;
      const probes: Extract<DeviceEventPacket, { type: "probe" }>["events"] = [];
      for (const item of page) {
        pendingIds.add(item.event.eventId);
        cursor = item.rowId;
        if (item.deliveredAt) {
          const last = this.lastProbed.get(item.event.eventId);
          if (last === undefined || performance.now() - last >= 300_000) {
            const { eventId, eventHash, originId, originSeq, logScopeId } = item.event;
            probes.push({ eventId, eventHash, originId, originSeq, logScopeId });
          }
          continue;
        }
        const base = { protocol: "accord-device-events-v1" as const, from: localDeviceId, to: peerDeviceId };
        if (isDeviceEventBlobReference(item.event.payload)) {
          for (let index = 0; index < item.event.payload.fragments; index += 1) {
            const fragment = await storage.deviceEventBlobs().fragment(item.event.payload, index);
            if (!fragment) throw new Error("A retained device event has a missing fragment.");
            await this.sendPacket({ ...base, type: "fragment", fragment });
          }
        }
        await this.sendPacket({ ...base, type: "event", event: item.event });
        // This is recorded only after the relay has accepted every dependency
        // and the manifest; it still does not release the peer's outbox entry.
        await storage.deviceEvents().markDelivered(item.event.eventId, item.event.eventHash, peerDeviceId, new Date().toISOString());
        this.lastProbed.set(item.event.eventId, performance.now());
      }
      if (probes.length) {
        // The relay may have expired an event or its ACK while the peers
        // never overlapped online. Ask with small headers; the receiver can
        // repeat a stored receipt or request the original bytes if missing.
        await this.sendPacket({ protocol: "accord-device-events-v1", from: localDeviceId, to: peerDeviceId,
          type: "probe", events: probes, deliveryId: randomUUID() });
        for (const header of probes) this.lastProbed.set(header.eventId, performance.now());
      }
    }
    for (const id of this.lastProbed.keys()) if (!pendingIds.has(id)) this.lastProbed.delete(id);
  }

  private async flushReceipts(): Promise<void> {
    const { storage, pairing, localDeviceId, peerDeviceId } = this.options;
    while (!this.lifetime.signal.aborted) {
      const receipts = await storage.deviceEvents().pendingReceipts(pairing.rendezvousId, peerDeviceId);
      if (!receipts.length) return;
      for (const receipt of receipts) await this.sendPacket({ protocol: "accord-device-events-v1", from: localDeviceId, to: peerDeviceId, type: "ack", receipt });
    }
  }

  async poll(): Promise<void> {
    if (this.polling) return this.polling;
    const run = this.pollPages();
    this.polling = run;
    try { await run; } finally { if (this.polling === run) this.polling = undefined; }
  }

  private async pollPages(): Promise<void> {
    const { storage, pairing, localDeviceId, peerDeviceId } = this.options;
    const readerId = `${localDeviceId}:${peerDeviceId}`;
    let cursor = await storage.deviceEvents().mailboxCursor(pairing.rendezvousId, readerId);
    // Bound one turn of catch-up, then yield to the timer/UI. Pages themselves
    // are bounded by the relay's 6 MiB response budget and 100 envelope limit.
    for (let pageIndex = 0; pageIndex < 8 && !this.lifetime.signal.aborted; pageIndex += 1) {
      const response = await this.request("GET", cursor.arrivalSeq);
      const body = await response.json() as { events?: Array<ChatEventEnvelope & { arrivalSeq: number }>; epoch?: string };
      if (!body.epoch || !Array.isArray(body.events)) throw new Error("Invalid sealed mailbox page.");
      if (cursor.epoch && body.epoch !== cursor.epoch) {
        cursor = { epoch: body.epoch, arrivalSeq: 0 };
        await storage.deviceEvents().saveMailboxCursor(pairing.rendezvousId, readerId, cursor);
        continue;
      }
      const previousEpoch = cursor.epoch;
      cursor.epoch = body.epoch;
      let last = cursor.arrivalSeq;
      for (const envelope of body.events) {
        if (!Number.isSafeInteger(envelope.arrivalSeq) || envelope.arrivalSeq <= last) throw new Error("Invalid mailbox arrival cursor.");
        // Other packets in this enrolled room are not meant for this peer.
        // Never accept an unsealed body or advance past an unreadable one.
        if (envelope.kind === "device.channel.packet") {
          const packet = await openMobileRelayPayload(JSON.stringify(envelope.payload), pairing.relaySealKeyBase64);
          if (!isDeviceEventPacket(packet)) throw new Error("Invalid sealed device packet.");
          if (packet.from === peerDeviceId && packet.to === localDeviceId) {
            try { await this.options.receive(packet); }
            catch (error) {
              // Forged/obsolete unsigned controls cannot pin the cursor in
              // front of valid traffic. No domain state or ACK is produced.
              // Disk failures remain retryable and still hold this cursor.
              if (!(error instanceof DeviceEventProjectionPendingError) && !(error instanceof DevicePacketAuthenticationError)) throw error;
              this.options.onError(error);
            }
          }
        }
        last = envelope.arrivalSeq;
      }
      if (last > cursor.arrivalSeq || previousEpoch !== cursor.epoch) {
        cursor.arrivalSeq = last;
        await storage.deviceEvents().saveMailboxCursor(pairing.rendezvousId, readerId, cursor);
      }
      if (!body.events.length) return;
    }
  }

  private async request(method: "GET" | "POST", afterArrival?: number, body?: string): Promise<Response> {
    const { pairing } = this.options;
    if (!pairing.outboxUrl) throw new Error("This enrolled device has no mailbox endpoint.");
    const url = new URL(mailboxEndpointForSealKey(pairing.outboxUrl, pairing.relaySealKeyBase64));
    if (method === "GET") {
      url.searchParams.set("afterArrival", String(afterArrival ?? 0));
      url.searchParams.set("limit", "100");
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.fetchImpl(url.toString(), {
        method, ...(body ? { body } : {}),
        headers: { "content-type": "application/json", ...mailboxAuthHeaders(pairing.relaySealKeyBase64) },
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(8_000)])
      });
      if (response.ok) return response;
      const error = await response.text();
      if (attempt === 0 && response.status === 401 && error.includes("mailbox_unregistered")) {
        const registered = await registerMailboxForSealKey(pairing.outboxUrl, pairing.relaySealKeyBase64, this.fetchImpl);
        if (registered.ok) continue;
      }
      if (error.includes("mailbox_revoked") || error.includes("mailbox_unauthorized")) this.close();
      throw new Error(`Device mailbox ${method} failed (HTTP ${response.status}).`);
    }
    throw new Error("Device mailbox registration did not complete.");
  }

  private schedule(delay: number): void {
    if (!this.active || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void Promise.all([this.flush(), this.poll()]).then(() => { this.failures = 0; }, (error: unknown) => {
        this.failures = Math.min(this.failures + 1, 5);
        if (!this.lifetime.signal.aborted) this.options.onError(error instanceof Error ? error : new Error(String(error)));
      }).finally(() => this.schedule(Math.min(15_000 * 2 ** this.failures, 300_000)));
    }, delay);
    this.timer.unref?.();
  }
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
