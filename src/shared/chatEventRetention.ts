/**
 * How long an emitter keeps an event it has sent, and what it tells the User
 * while it keeps it.
 *
 * The relay buffers briefly and then forgets. That is deliberate: it is the
 * User's dumb pipe, not a store. So retention cannot be "until the relay
 * accepted it" — an event has to be held by its emitter until **every machine
 * in the chat's roster** has acknowledged it, and catch-up beyond the relay's
 * buffer is a resend from the emitter.
 *
 * One policy, used by the desktop outbox and by the phone's IndexedDB outbox,
 * so the two cannot disagree about when it is safe to forget something.
 *
 * The rule is one-sided on purpose: an event is dropped only when every peer
 * that is expected to have it says it has it. A peer that is merely away is
 * not "done"; it is pressure, and the surface says so instead of the emitter
 * quietly discarding history the peer will ask for.
 */

export interface ChatEventRetentionEntry {
  eventId: string;
  /** Bytes this entry occupies where it is held. */
  bytes: number;
  /** Origin-side ordering, used only to report the oldest held item. */
  logicalTs: string;
  createdAt: string;
}

export interface ChatEventAcknowledgement {
  peerId: string;
  /** Every event id this peer has confirmed it holds. */
  eventIds: readonly string[];
}

export interface ChatEventRetentionInput {
  entries: readonly ChatEventRetentionEntry[];
  /** Machines expected to hold these events. A peer absent from the roster
   *  (removed machine) can never hold anything back. */
  roster: readonly string[];
  acknowledgements: readonly ChatEventAcknowledgement[];
  /** Soft budget for what is held. Exceeding it is reported, never enforced by
   *  discarding an unacknowledged event. */
  pressureBytes?: number;
}

export interface ChatEventPeerPressure {
  peerId: string;
  pendingEvents: number;
  pendingBytes: number;
  oldestCreatedAt?: string;
}

export interface ChatEventRetentionDecision {
  /** Safe to forget: acknowledged by every roster peer. */
  releasable: string[];
  /** Must be kept, with who has not acknowledged it. */
  retained: Array<{ eventId: string; awaiting: string[] }>;
  heldBytes: number;
  /** Per peer, so the surface can name the machine that is behind. */
  pressure: ChatEventPeerPressure[];
  /** True when what is held exceeds the soft budget. Still never a licence to
   *  drop an unacknowledged event. */
  overBudget: boolean;
  /** One sentence for the User, or undefined when nothing is behind. */
  warning?: string;
}

export function decideChatEventRetention(input: ChatEventRetentionInput): ChatEventRetentionDecision {
  const roster = [...new Set(input.roster.filter((peer) => peer.trim()))].sort();
  const acknowledged = new Map<string, Set<string>>();
  for (const ack of input.acknowledgements) {
    if (!roster.includes(ack.peerId)) continue;
    const existing = acknowledged.get(ack.peerId) ?? new Set<string>();
    for (const eventId of ack.eventIds) existing.add(eventId);
    acknowledged.set(ack.peerId, existing);
  }

  const releasable: string[] = [];
  const retained: Array<{ eventId: string; awaiting: string[] }> = [];
  const pending = new Map<string, ChatEventPeerPressure>();
  let heldBytes = 0;

  for (const entry of input.entries) {
    const awaiting = roster.filter((peer) => !acknowledged.get(peer)?.has(entry.eventId));
    if (!awaiting.length) {
      releasable.push(entry.eventId);
      continue;
    }
    retained.push({ eventId: entry.eventId, awaiting });
    heldBytes += Math.max(0, entry.bytes);
    for (const peer of awaiting) {
      const current = pending.get(peer) ?? { peerId: peer, pendingEvents: 0, pendingBytes: 0 };
      current.pendingEvents += 1;
      current.pendingBytes += Math.max(0, entry.bytes);
      if (!current.oldestCreatedAt || entry.createdAt < current.oldestCreatedAt) {
        current.oldestCreatedAt = entry.createdAt;
      }
      pending.set(peer, current);
    }
  }

  const pressure = [...pending.values()].sort((left, right) =>
    right.pendingBytes - left.pendingBytes || left.peerId.localeCompare(right.peerId));
  const overBudget = input.pressureBytes !== undefined && heldBytes > input.pressureBytes;
  return {
    releasable,
    retained,
    heldBytes,
    pressure,
    overBudget,
    warning: retentionWarning(pressure, heldBytes, overBudget)
  };
}

function retentionWarning(
  pressure: readonly ChatEventPeerPressure[],
  heldBytes: number,
  overBudget: boolean
): string | undefined {
  if (!pressure.length) return undefined;
  const worst = pressure[0];
  const others = pressure.length > 1 ? ` and ${pressure.length - 1} other` + (pressure.length === 2 ? "" : "s") : "";
  const size = formatBytes(heldBytes);
  const behind = `${worst.peerId}${others} ${pressure.length > 1 ? "have" : "has"} not caught up`;
  return overBudget
    ? `${behind}; ${size} is being kept for them, which is more than this chat's budget. Nothing is discarded — bring them online to release it.`
    : `${behind}; ${size} is being kept for them.`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1 ? `${megabytes.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}
