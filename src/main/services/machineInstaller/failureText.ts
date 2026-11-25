import { CommandError, commandFailureDetail, isDiskSpaceFailure } from "../command";

/** Replaces base64/base64url/hex runs long enough to be a key. Deliberately
 *  blunt: a redacted log line is recoverable, a leaked key is not. */
export function redactKeyLikeText(value: string): string {
  return value
    .replace(/[A-Za-z0-9_-]{40,}={0,2}/g, "[redacted]")
    .replace(/[0-9a-fA-F]{40,}/g, "[redacted]");
}

/** Said when an install or update stops because the machine ran out of disk. */
export const MACHINE_DISK_FULL_MESSAGE = "the machine's disk is full";

export function errorMessage(error: unknown): string {
  if (isDiskSpaceFailure(error)) return MACHINE_DISK_FULL_MESSAGE;
  const message = error instanceof Error ? error.message : String(error);
  const detail = commandFailureDetail(error);
  return detail && !message.includes(detail) ? `${message}: ${redactKeyLikeText(detail)}` : message;
}

/** A remote command's own last words, when it said any: "ssh exited with
 *  code 1" alone does not tell the User what went wrong on the machine. */
export function remoteCommandFailure(error: unknown): string {
  const stderr = error instanceof CommandError ? redactKeyLikeText(error.result.stderr).trim() : "";
  const last = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3).join(" ");
  return last ? `${errorMessage(error)}: ${last.slice(0, 500)}` : errorMessage(error);
}
