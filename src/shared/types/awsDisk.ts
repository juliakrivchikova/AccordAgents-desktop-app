/** What fills the AWS instance's disk, measured on the instance. */
export type AwsDiskCategoryId =
  | "system" | "other-programs" | "cloud-runs" | "agent-tools" | "program-logs"
  | "project-copies" | "program-data" | "caches" | "program-versions" | "system-logs" | "swap";

export interface AwsDiskCategory {
  id: AwsDiskCategoryId;
  bytes: number;
  /** What "Clean up" frees; absent where nothing can be cleaned. */
  cleanableBytes?: number;
  /** Program versions kept, or other programs on the instance. */
  count?: number;
  /** Program versions the running program uses. */
  inUse?: number;
  /** Other programs that are running. */
  running?: number;
  /** Log files kept. */
  files?: number;
  /** Project copies by folder name. */
  projects?: string[];
}

export interface AwsDiskReport extends AwsDiskSpace {
  categories: AwsDiskCategory[];
  measuredAt: number;
}

export type AwsDiskCleanCategory = "program-logs" | "caches" | "program-versions" | "system-logs";

/** A member's work in a git project, lost when the folder holding it goes. */
export type AwsDiskWorkReason = "worktree" | "changes" | "unpushed";

/** Chosen project copies, each with the kinds of work the User saw on it. */
export type AwsDiskChosenWork = Record<string, AwsDiskWorkReason[]>;

/** Why a file on the instance cannot be removed from Settings. A work
 *  reason locks anything but a whole project copy, and a project copy
 *  whose work changed after the User chose it. */
export type AwsDiskLockReason =
  | "system" | "sign-ins" | "agent-tools" | "program" | "running-version" | "qa-browser"
  | "other-program" | "in-use" | "repository" | "worktree-elsewhere" | "unreadable" | AwsDiskWorkReason;

/** What a folder on the instance is to the User, when its name alone does
 *  not say; decided on the instance, which knows its layout. */
export type AwsDiskEntryRole =
  | "program" | "other-program" | "idle-program" | "program-data" | "cloud-runs" | "project-copies"
  | "versions" | "agent-tools" | "sign-ins" | "logs" | "cache" | "mailbox-runners";

export interface AwsDiskEntry {
  name: string;
  path: string;
  bytes: number;
  dir: boolean;
  /** Why it cannot be removed from Settings. */
  lock: AwsDiskLockReason | null;
  /** A whole project copy only: every kind of work a member would lose
   *  with it, in a fixed order; set only when nothing locks it. */
  work?: AwsDiskWorkReason[];
  role?: AwsDiskEntryRole;
}

export interface AwsDiskListing {
  path: string;
  home: string;
  /** This desktop's program folder on the instance. */
  own: string;
  entries: AwsDiskEntry[];
  /** Entries left out after the largest ones. */
  truncated: number;
  /** The disk as the listing was read. */
  space?: AwsDiskSpace;
}

/** One project copy on the AWS instance, as Settings → AWS → Projects shows it. */
export interface AwsInstanceProject {
  /** The copy's folder on the instance. */
  path: string;
  name: string;
  /** The project on this computer the copy was made from, when known. */
  localPath?: string;
  bytes: number;
  /** Why it cannot be deleted now. */
  lock: AwsDiskLockReason | null;
  /** Members' work that goes with it when it is deleted. */
  work?: AwsDiskWorkReason[];
}

export interface AwsInstanceProjects {
  copies: AwsInstanceProject[];
  /** This computer's projects without a copy on the instance, newest first. */
  available: Array<{ path: string; label: string }>;
  /** Why no project can be added yet, when one cannot. */
  addUnavailable?: string;
  freeBytes?: number;
}

/** A project being copied to the instance from Settings → AWS → Projects. */
export interface AwsInstanceProjectProgress {
  localPath: string;
  message: string;
}

export interface AwsDiskSpace {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
}

export interface AwsDiskChangeResult {
  freedBytes: number;
  removed?: number;
  /** What went, as the instance names it (its home folder resolved). */
  removedPaths?: string[];
  failed: Array<{ path: string; reason: AwsDiskLockReason | "error"; message?: string }>;
  /** The disk right after the change; categories are measured again later. */
  space: AwsDiskSpace;
}
