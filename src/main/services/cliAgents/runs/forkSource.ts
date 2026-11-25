import type { ParticipantRunResult } from "../../providers";

/** Whether a run failed because the session a fork copies could not be read:
 *  only the CLIs' own words for a missing session (Claude Code "No
 *  conversation found with session ID", Codex "no rollout found for thread
 *  id"), never another "not found" (a model, a file, a tool). */
export function isForkSourceMissingError(text: string | undefined): boolean {
  return /no conversation found|no rollout found for thread id/i.test(text ?? "");
}

/** Whether a fork's run failed with no copy made: the CLI said the source is
 *  gone, or failed while it made the copy (ParticipantRunResult.forkCopyFailed). */
export function forkCopyNotMade(result: Pick<ParticipantRunResult, "error" | "forkCopyFailed">): boolean {
  return isForkSourceMissingError(result.error) || result.forkCopyFailed === true;
}
