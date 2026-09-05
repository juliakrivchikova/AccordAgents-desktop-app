/**
 * Hybrid logical clock keys for chat events (machines transport, contract §2).
 *
 * Key format: `hlc:<wallMs 13 digits>:<counter 6 digits>:<originId>`.
 * Fixed-width digits make plain string comparison the clock comparison.
 *
 * Legacy `logicalTs` values (`<originSeq 16 digits>:<originId>:<logScopeId>`,
 * produced by the chat event mirror and the mobile mailbox runner) are mapped
 * to a derived key from the event's `createdAt` and `originSeq`, so old and new
 * events interleave by time identically on every machine.
 */

export const HLC_PREFIX = "hlc:";
const WALL_DIGITS = 13;
const COUNTER_DIGITS = 6;
const COUNTER_LIMIT = 10 ** COUNTER_DIGITS;
const LEGACY_PATTERN = /^(\d{16}):([^:]+):(.+)$/;
const HLC_PATTERN = /^hlc:(\d{13}):(\d{6}):(.+)$/;

export interface HlcParts {
  wallMs: number;
  counter: number;
  originId: string;
}

export interface HlcEventLike {
  logicalTs: string;
  originId: string;
  originSeq: number;
  createdAt?: string;
}

export function formatHlcKey(parts: HlcParts): string {
  if (!Number.isSafeInteger(parts.wallMs) || parts.wallMs < 0) {
    throw new Error("HLC wallMs must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(parts.counter) || parts.counter < 0 || parts.counter >= COUNTER_LIMIT) {
    throw new Error(`HLC counter must be in [0, ${COUNTER_LIMIT}).`);
  }
  if (!parts.originId) {
    throw new Error("HLC originId is required.");
  }
  return `${HLC_PREFIX}${String(parts.wallMs).padStart(WALL_DIGITS, "0")}:${String(parts.counter).padStart(COUNTER_DIGITS, "0")}:${parts.originId}`;
}

export function parseHlcKey(value: string): HlcParts | undefined {
  const match = HLC_PATTERN.exec(value);
  if (!match) {
    return undefined;
  }
  return { wallMs: Number(match[1]), counter: Number(match[2]), originId: match[3] };
}

export function isLegacyLogicalTs(value: string): boolean {
  return LEGACY_PATTERN.test(value);
}

/**
 * The comparison key of an event: its own HLC key, or a derived key for a
 * legacy timestamp (createdAt + originSeq), or the raw string when neither
 * format applies (test fixtures and foreign producers). Deterministic for the
 * same event on every machine because it depends only on the event's fields.
 */
export function logicalOrderKey(event: HlcEventLike): string {
  if (event.logicalTs.startsWith(HLC_PREFIX) && HLC_PATTERN.test(event.logicalTs)) {
    return event.logicalTs;
  }
  if (isLegacyLogicalTs(event.logicalTs)) {
    const wallMs = event.createdAt ? Date.parse(event.createdAt) : NaN;
    const safeWall = Number.isFinite(wallMs) && wallMs >= 0 ? Math.min(wallMs, 10 ** WALL_DIGITS - 1) : 0;
    const counter = Number.isSafeInteger(event.originSeq) && event.originSeq >= 0 ? event.originSeq % COUNTER_LIMIT : 0;
    return formatHlcKey({ wallMs: safeWall, counter, originId: event.originId });
  }
  return event.logicalTs;
}

/**
 * Compares two bare logicalTs strings (no event context, e.g. a revocation
 * threshold against an event's timestamp). Values of the same family compare
 * as strings; an HLC key always sorts after a legacy or unknown value, because
 * the HLC era starts after every legacy timestamp a machine could have written.
 */
export function compareLogicalTsValues(left: string, right: string): number {
  const leftHlc = HLC_PATTERN.test(left);
  const rightHlc = HLC_PATTERN.test(right);
  if (leftHlc !== rightHlc) {
    return leftHlc ? 1 : -1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareLogicalOrder(left: HlcEventLike, right: HlcEventLike): number {
  const leftKey = logicalOrderKey(left);
  const rightKey = logicalOrderKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

/**
 * One clock per machine. `tick()` mints the key for an event this machine
 * emits; `observe()` advances the clock past every event it receives so a
 * machine that was offline cannot emit an event that sorts before what it has
 * already seen.
 */
export class HybridLogicalClock {
  private wallMs = 0;
  private counter = 0;

  constructor(
    private readonly originId: string,
    private readonly now: () => number = () => Date.now()
  ) {
    if (!originId) {
      throw new Error("HybridLogicalClock requires an originId.");
    }
  }

  current(): HlcParts {
    return { wallMs: this.wallMs, counter: this.counter, originId: this.originId };
  }

  restore(parts: Pick<HlcParts, "wallMs" | "counter">): void {
    if (parts.wallMs > this.wallMs || (parts.wallMs === this.wallMs && parts.counter > this.counter)) {
      this.wallMs = parts.wallMs;
      this.counter = parts.counter;
    }
  }

  tick(): string {
    const now = Math.max(0, Math.floor(this.now()));
    if (now > this.wallMs) {
      this.wallMs = now;
      this.counter = 0;
    } else {
      this.advanceCounter();
    }
    return formatHlcKey(this.current());
  }

  observe(event: HlcEventLike): void {
    const observed = parseHlcKey(logicalOrderKey(event));
    if (!observed) {
      return;
    }
    const now = Math.max(0, Math.floor(this.now()));
    const wall = Math.max(now, this.wallMs, observed.wallMs);
    if (wall === this.wallMs && wall === observed.wallMs) {
      this.counter = Math.max(this.counter, observed.counter);
      this.advanceCounter();
    } else if (wall === observed.wallMs) {
      this.wallMs = wall;
      this.counter = observed.counter;
      this.advanceCounter();
    } else if (wall === this.wallMs) {
      this.advanceCounter();
    } else {
      this.wallMs = wall;
      this.counter = 0;
    }
  }

  private advanceCounter(): void {
    if (this.counter + 1 >= COUNTER_LIMIT) {
      this.wallMs += 1;
      this.counter = 0;
      return;
    }
    this.counter += 1;
  }
}
