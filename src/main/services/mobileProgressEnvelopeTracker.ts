// W-A: which mailbox envelopes may be deleted early, decided per envelope.
//
// Progress for a run is appended cumulatively, so once a run's terminal
// snapshot is durably appended, the envelopes that carried only that run's
// earlier progress are dead weight and are deleted so no reader can replay
// them. TTL is the backstop; deletion is cleanup, never delivery.
//
// The rule is per envelope rather than per run. A single batch can carry
// pending progress for one run and a terminal snapshot for another, and an
// envelope holding any terminal event must live to TTL: deleting it because
// some *other* run it mentions has since finished destroys the only copy of
// that terminal snapshot. So an envelope is tracked only when every
// run-status event it carries is pending, it remembers the full set of runs
// it is waiting on, and it is deleted only once every one of them has
// terminated.

// Accepted deviation from W-A's literal text, agreed in review: a pending
// envelope that arrives *after* its run's terminal is tracked and never
// deleted, so it lives to TTL. The literal rule would delete it, but that
// sequence needs an out-of-order publish (one publisher per run, appends
// serialized), and retro-deleting an envelope we just appended would race a
// reader mid-poll. TTL is the designed backstop; the cost is one stale tracker
// entry until unpair.

export type MobileProgressAppend = {
  eventId: string;
  pendingRunIds: readonly string[];
  terminalRunIds: readonly string[];
};

type TrackedEnvelope = {
  eventId: string;
  awaiting: Set<string>;
};

export class MobileProgressEnvelopeTracker {
  private readonly byPairing = new Map<string, TrackedEnvelope[]>();

  /**
   * Records one append and returns the envelope ids that are now superseded.
   * The returned ids are already forgotten: a caller that fails to delete them
   * falls back to TTL rather than retrying.
   */
  recordAppend(pairingKey: string, append: MobileProgressAppend): string[] {
    const pending = new Set(append.pendingRunIds.filter((runId) => runId.trim().length > 0));
    const terminal = new Set(append.terminalRunIds.filter((runId) => runId.trim().length > 0));
    const tracked = this.byPairing.get(pairingKey) ?? [];

    const superseded: string[] = [];
    const remaining: TrackedEnvelope[] = [];
    for (const envelope of tracked) {
      for (const runId of terminal) {
        envelope.awaiting.delete(runId);
      }
      if (envelope.awaiting.size === 0 && envelope.eventId !== append.eventId) {
        superseded.push(envelope.eventId);
      } else if (envelope.awaiting.size > 0) {
        remaining.push(envelope);
      }
    }

    // An envelope carrying any terminal event is never tracked — it is the
    // durable record of that run finishing, so it lives to TTL.
    if (terminal.size === 0 && pending.size > 0) {
      remaining.push({ eventId: append.eventId, awaiting: pending });
    }

    if (remaining.length === 0) {
      this.byPairing.delete(pairingKey);
    } else {
      this.byPairing.set(pairingKey, remaining);
    }
    return superseded;
  }

  forgetPairing(pairingKey: string): void {
    this.byPairing.delete(pairingKey);
  }

  /** Test seam: how many envelopes are still waiting on a terminal. */
  trackedCount(pairingKey: string): number {
    return this.byPairing.get(pairingKey)?.length ?? 0;
  }
}
