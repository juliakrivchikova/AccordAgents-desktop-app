/**
 * The roster a machine keeps on disk.
 *
 * It has to survive a restart: a machine that came back while the owner's
 * desktop was closed would otherwise trust nobody, and the phone or the other
 * machine that is still running could not reach it — which is the whole
 * dependency this replaces. Written atomically, read once at start.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  isMachineTrustRoster,
  normalizeMachineTrustRoster,
  type MachineTrustRoster,
  type TrustedPeerAccess
} from "../../shared/machineTrust";

export class MachineTrustStore {
  private roster?: MachineTrustRoster;
  private write: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string, private readonly selfDeviceId: string) {}

  async load(): Promise<MachineTrustRoster | undefined> {
    if (this.roster) return this.roster;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (isMachineTrustRoster(parsed)) {
        this.roster = normalizeMachineTrustRoster(parsed, this.selfDeviceId);
      }
    } catch {
      // No roster yet, or an unreadable one: the enrolled desktop is still
      // trusted through the enrollment itself and will send a fresh roster.
    }
    return this.roster;
  }

  current(): MachineTrustRoster | undefined {
    return this.roster;
  }

  peers(): TrustedPeerAccess[] {
    return this.roster?.peers ?? [];
  }

  peer(deviceId: string): TrustedPeerAccess | undefined {
    return this.roster?.peers.find((peer) => peer.deviceId === deviceId);
  }

  /**
   * Accepts a roster from the issuer. An older one is ignored, so a delayed
   * redelivery cannot take a device's access away again.
   */
  async accept(roster: MachineTrustRoster): Promise<{ changed: boolean; roster: MachineTrustRoster }> {
    const next = normalizeMachineTrustRoster(roster, this.selfDeviceId);
    const current = this.roster;
    if (current && Date.parse(current.updatedAt) > Date.parse(next.updatedAt)) {
      return { changed: false, roster: current };
    }
    const changed = !current || JSON.stringify(current.peers) !== JSON.stringify(next.peers);
    this.roster = next;
    if (changed) await this.persist(next);
    return { changed, roster: next };
  }

  private async persist(roster: MachineTrustRoster): Promise<void> {
    const step = this.write.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(temp, `${JSON.stringify(roster, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, this.filePath);
    });
    this.write = step.then(() => undefined, () => undefined);
    await step;
  }
}
