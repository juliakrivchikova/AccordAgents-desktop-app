import { CommandError } from "./command";

// Shared SSH connection-retry helpers. Some networks (e.g. a client behind a
// lossy VPN to a distant region) drop packets during SSH's multi-round-trip key
// exchange, so a single attempt fails at "banner exchange" ~half the time even
// though a fresh attempt usually succeeds. Retry transient CONNECTION failures
// only — never auth/command errors or aborts.

const TRANSIENT_SSH_PATTERNS: readonly RegExp[] = [
  /banner exchange/i,
  /kex_exchange_identification/i,
  /connection timed out/i,
  /connection reset/i,
  /connection refused/i,
  /connection closed by remote host/i,
  /operation timed out/i,
  /timed out waiting/i,
  /broken pipe/i,
  /port 22: /i
];

// True only for connection-level failures worth retrying (a lost KEX packet, a
// TCP/banner timeout, a reset). Deliberately does NOT match permanent failures
// like "Permission denied (publickey)" or a missing identity file, and does not
// blanket-retry every ssh exit 255, so real command/auth errors surface fast.
export function isTransientSshError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const chunks = [error.message];
  if (error instanceof CommandError) {
    if (error.result.timedOut) {
      return true;
    }
    chunks.push(error.result.stderr, error.result.stdout);
  }
  const text = chunks.join("\n");
  return TRANSIENT_SSH_PATTERNS.some((pattern) => pattern.test(text));
}

export const SSH_CONNECT_ATTEMPTS = 5;

// Worst-case wall-clock for a single runWithSshRetries schedule: every attempt
// times out and the full linear backoff runs between them. Used to size outer
// timeouts that must be able to contain a whole retry schedule rather than cut
// it off mid-flight (see REMOTE_WARM_SESSION_PREPARE_TIMEOUT_MS). Defaults mirror
// runWithSshRetries so the two stay in step.
export function sshRetryWorstCaseMs(
  attempts: number,
  perAttemptTimeoutMs: number,
  baseDelayMs = 800,
  maxDelayMs = 4_000
): number {
  const total = Math.max(1, attempts);
  let worstCase = total * Math.max(0, perAttemptTimeoutMs);
  for (let attempt = 1; attempt < total; attempt += 1) {
    worstCase += Math.min(maxDelayMs, baseDelayMs * attempt);
  }
  return worstCase;
}

export interface SshRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  isTransient?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown) => void;
}

// Retry an SSH operation on transient connection failures with linear backoff.
// Non-transient errors (auth, command failures) and aborts rethrow immediately.
export async function runWithSshRetries<T>(fn: () => Promise<T>, options: SshRetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? SSH_CONNECT_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? 800;
  const maxDelayMs = options.maxDelayMs ?? 4_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isTransient = options.isTransient ?? isTransientSshError;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error("SSH operation aborted.");
    }
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransient(error) || options.signal?.aborted) {
        throw error;
      }
      options.onRetry?.(attempt, error);
      await sleep(Math.min(maxDelayMs, baseDelayMs * attempt));
    }
  }
  throw lastError;
}
