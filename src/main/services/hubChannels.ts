import { createHash } from "node:crypto";

/**
 * The name of the channel two of the User's devices share through the hub
 * when neither is the desktop that enrolled the other (two machines, a
 * machine and a phone, a machine and a second desktop): both ends compute it
 * alike from their ids, and so does the hub, which keeps the channel's events
 * until both ends have read them.
 */
export function hubPairChannelId(deviceA: string, deviceB: string): string {
  const [first, second] = [deviceA, deviceB].sort();
  return `pair-${createHash("sha256").update(`${first}\n${second}`).digest("hex").slice(0, 32)}`;
}
