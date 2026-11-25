export const WORKER_SSH_USER = "ubuntu";
export const WORKER_ROOT = "~/.accordagents/remote-runs";

/** AWS can miss an instance it has just launched for a moment; only an
 *  instance older than this is gone when AWS has no such id. */
export const INSTANCE_VISIBILITY_GRACE_MS = 10 * 60_000;

/** What the AWS page says after the app removed an instance AWS no longer has. */
export const AWS_INSTANCE_GONE_NOTICE = "Your cloud machine no longer exists in AWS, so it was removed.";

/** How the AWS page begins the line about an old machine still here. */
export const OLD_MACHINE_NOT_REMOVED = "Your old cloud machine could not be removed from this computer yet";

export const OLD_MACHINE_UNCONFIRMED = "We couldn't confirm your old cloud machine is gone, so it is still listed on this computer";

export const UNVERIFIED_REASON: Record<"refused" | "unreadable", string> = {
  refused: "AWS refused the keys its instance was made with",
  unreadable: "this computer can no longer read the keys its instance was made with"
};
