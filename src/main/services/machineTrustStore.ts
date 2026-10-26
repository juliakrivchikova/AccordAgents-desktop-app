import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { createHash, createPublicKey, randomUUID } from "node:crypto";
import path from "node:path";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import { stableJson } from "../../shared/stableJson";
import { isMachineTrustRoster, normalizeMachineTrustRoster, trustedDeviceIdMatchesKey,
  type MachineTrustRoster, type TrustedPeerAccess } from "../../shared/machineTrust";

type RosterOrder = Pick<ChatEventEnvelope, "originId" | "logScopeId" | "originSeq" | "eventId" | "eventHash">;
interface StoredRoster { version: 2; roster: MachineTrustRoster; order: RosterOrder }
const disk = { mkdir, readFile, rename, writeFile, unlink };

/** Grants and revocations become visible only after the roster and its signed
 * event watermark are saved together. Wall clocks never order authority. */
export class MachineTrustStore {
  private roster?: MachineTrustRoster;
  private order?: RosterOrder;
  /** Phones trusted by their certificate (the owner's signed invite) until
   *  a roster settles their invite. */
  private certified = new Map<string, TrustedPeerAccess & { inviteId: string }>();
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string, private readonly selfDeviceId: string,
    private readonly issuerDeviceId: string, private readonly io = disk) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  load(): Promise<MachineTrustRoster | undefined> {
    return this.serialize(async () => { await this.loadOnce(); return this.roster; });
  }

  private certifiedPath(): string {
    return `${this.filePath}.phones.json`;
  }

  private async loadCertified(): Promise<void> {
    let contents: string;
    try { contents = await this.io.readFile(this.certifiedPath(), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    let parsed: { version?: number; phones?: Array<TrustedPeerAccess & { inviteId: string }> };
    try { parsed = JSON.parse(contents) as typeof parsed; }
    catch {
      // An unreadable list of certified phones costs only those phones (they
      // are admitted again from the server's order); the roster still loads.
      return;
    }
    for (const phone of Array.isArray(parsed?.phones) ? parsed.phones : []) {
      if (phone && phone.role === "phone" && typeof phone.inviteId === "string" && trustedDeviceIdMatchesKey(phone, bytes => createHash("sha256").update(bytes).digest("hex"))) {
        this.certified.set(phone.deviceId, phone);
      }
    }
  }

  private async loadOnce(): Promise<void> {
    if (this.loaded) return;
    await this.loadCertified();
    let contents: string;
    try { contents = await this.io.readFile(this.filePath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.loaded = true;
      return;
    }
    const parsed = JSON.parse(contents) as MachineTrustRoster | StoredRoster;
    const roster = parsed.version === 2 ? parsed.roster : parsed;
    this.validate(roster);
    if (parsed.version === 2) {
      this.validateOrder(parsed.order);
      this.order = parsed.order;
    }
    this.roster = normalizeMachineTrustRoster(roster, this.selfDeviceId);
    this.loaded = true;
  }

  current(): MachineTrustRoster | undefined { return this.roster; }
  peers(): TrustedPeerAccess[] {
    const listed = this.roster?.peers ?? [];
    const resolved = new Set(this.roster?.resolvedInviteIds ?? []);
    const extra = [...this.certified.values()].filter((phone) => !resolved.has(phone.inviteId) && !listed.some((peer) => peer.deviceId === phone.deviceId));
    return extra.length ? [...listed, ...extra] : listed;
  }
  peer(deviceId: string): TrustedPeerAccess | undefined { return this.peers().find(peer => peer.deviceId === deviceId); }

  /**
   * A phone that paired with the User's server while the desktop was away:
   * its certificate (already checked against the owner's key) trusts it here
   * until the owner's next roster settles its invite, which then decides.
   */
  admitCertified(phone: TrustedPeerAccess & { inviteId: string }): Promise<boolean> {
    return this.serialize(async () => {
      await this.loadOnce();
      // Before the desktop's roster is here this machine cannot tell a
      // removed phone from a new one: the certificate is tried again later.
      if (!this.roster) return false;
      if (this.roster.peers.some((peer) => peer.deviceId === phone.deviceId)) return true;
      if (this.roster.resolvedInviteIds?.includes(phone.inviteId)) return false;
      if (this.certified.get(phone.deviceId)?.inviteId === phone.inviteId) return true;
      // One invite, one phone: another key presenting the same invite is not
      // admitted (its first holder is).
      if ([...this.certified.values()].some((known) => known.inviteId === phone.inviteId && known.deviceId !== phone.deviceId)) return false;
      this.certified.set(phone.deviceId, phone);
      await this.persistCertified();
      return true;
    });
  }

  private async persistCertified(): Promise<void> {
    await this.io.mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.certifiedPath()}.${randomUUID()}.tmp`;
    try {
      await this.io.writeFile(temp, `${JSON.stringify({ version: 1, phones: [...this.certified.values()] })}\n`, { mode: 0o600 });
      await this.io.rename(temp, this.certifiedPath());
    } finally { await this.io.unlink(temp).catch(() => undefined); }
  }

  accept(roster: MachineTrustRoster, event: RosterOrder): Promise<{ changed: boolean; roster: MachineTrustRoster }> {
    return this.serialize(async () => {
      await this.loadOnce();
      this.validate(roster);
      this.validateOrder(event);
      const next = normalizeMachineTrustRoster(roster, this.selfDeviceId);
      if (this.order) {
        if (event.logScopeId !== this.order.logScopeId) throw new Error("The machine trust stream changed.");
        if (event.originSeq < this.order.originSeq) return { changed: false, roster: this.roster! };
        if (event.originSeq === this.order.originSeq) {
          if (event.eventId !== this.order.eventId || event.eventHash !== this.order.eventHash || stableJson(next) !== stableJson(this.roster)) {
            throw new Error("Conflicting machine trust event.");
          }
          return { changed: false, roster: this.roster! };
        }
      }
      const before = stableJson(this.peers());
      const order: RosterOrder = { originId: event.originId, logScopeId: event.logScopeId,
        originSeq: event.originSeq, eventId: event.eventId, eventHash: event.eventHash };
      await this.persist({ version: 2, roster: next, order });
      this.roster = next;
      this.order = order;
      // A roster that settled a certified phone's invite decides about it now.
      const resolved = new Set(next.resolvedInviteIds ?? []);
      const settled = [...this.certified.values()].filter((phone) => resolved.has(phone.inviteId) || next.peers.some((peer) => peer.deviceId === phone.deviceId));
      if (settled.length) {
        for (const phone of settled) this.certified.delete(phone.deviceId);
        await this.persistCertified();
      }
      const changed = before !== stableJson(this.peers());
      return { changed, roster: next };
    });
  }

  private validateOrder(order: RosterOrder): void {
    if (!order || order.originId !== this.issuerDeviceId || !Number.isSafeInteger(order.originSeq) || order.originSeq < 1 ||
        typeof order.logScopeId !== "string" || !order.logScopeId || typeof order.eventId !== "string" || !order.eventId ||
        typeof order.eventHash !== "string" || !order.eventHash) throw new Error("Invalid machine trust event identity.");
  }

  private validate(roster: unknown): asserts roster is MachineTrustRoster {
    if (!isMachineTrustRoster(roster) || roster.issuerDeviceId !== this.issuerDeviceId) throw new Error("Invalid machine trust issuer or roster.");
    const seen = new Set<string>();
    for (const peer of roster.peers) {
      if (seen.has(peer.deviceId) || !trustedDeviceIdMatchesKey(peer, bytes => createHash("sha256").update(bytes).digest("hex")) ||
          createPublicKey({ key: Buffer.from(peer.publicKeyDerBase64, "base64"), format: "der", type: "spki" }).asymmetricKeyType !== "ed25519" ||
          !["wss:", "ws:"].includes(new URL(peer.relayUrl).protocol)) {
        throw new Error("Invalid machine trust peer identity or room.");
      }
      seen.add(peer.deviceId);
    }
  }

  private async persist(record: StoredRoster): Promise<void> {
    await this.io.mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await this.io.writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      await this.io.rename(temp, this.filePath);
    } finally { await this.io.unlink(temp).catch(() => undefined); }
  }
}
