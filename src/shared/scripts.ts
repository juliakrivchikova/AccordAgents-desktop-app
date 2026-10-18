import type { ScriptSchedule } from "./scriptSchedule";

export type { ScriptSchedule } from "./scriptSchedule";

/** v1 runtimes. `node` runs the host's Node.js (on the desktop, `node` from
 *  the User's PATH); `bash` uses /bin/bash. */
export type ScriptRuntime = "node" | "bash";

export const SCRIPT_RUNTIMES: readonly ScriptRuntime[] = ["node", "bash"];
export const SCRIPT_MAX_FILES_BYTES = 64 * 1024;
export const SCRIPT_MAX_FILES = 16;
export const SCRIPT_MIN_TIMEOUT_SECONDS = 10;
export const SCRIPT_DEFAULT_TIMEOUT_SECONDS = 300;
export const SCRIPT_MAX_TIMEOUT_SECONDS = 3600;
export const SCRIPT_MAX_CHATS = 10;
/** Every post counts here, mentions or not: a looping script must not flood
 *  a chat. Posts over a limit are held for the User, up to a held maximum. */
export const SCRIPT_MAX_MESSAGES_PER_RUN = 20;
export const SCRIPT_MAX_MESSAGES_PER_HOUR = 60;
export const SCRIPT_MAX_HELD_MESSAGES = 100;
export const SCRIPT_DEFAULT_MAX_WAKEUPS_PER_HOUR = 6;
export const SCRIPT_MAX_WAKEUPS_PER_HOUR = 60;
export const SCRIPT_OUTPUT_TAIL_CHARS = 4096;
export const SCRIPT_MESSAGE_MAX_CHARS = 8000;
export const SCRIPT_SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED_SECRET_NAMES = new Set(["PATH", "HOME", "LANG", "TZ", "BASH_ENV", "ENV", "BASHOPTS", "SHELLOPTS", "IFS", "PS4", "CDPATH"]);
const RESERVED_SECRET_PREFIXES = ["ACCORD_", "NODE_", "LD_", "DYLD_", "LC_"];

/** Names a key may not take: they would change how the interpreter starts
 *  or what it loads, so the code that runs could differ from the approved
 *  files (NODE_OPTIONS, BASH_ENV, DYLD_INSERT_LIBRARIES, PATH...). */
export function isReservedScriptSecretName(name: string): boolean {
  return RESERVED_SECRET_NAMES.has(name) || RESERVED_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix));
}
/** The host id of the desktop app itself; machines use their machine id. */
export const SCRIPT_DESKTOP_HOST_ID = "desktop";

export interface ScriptFile {
  /** Relative path inside the script's own directory, e.g. "watch.mjs". */
  path: string;
  content: string;
}

/** What a script may do through the script API. Bound to stable ids. */
export interface ScriptPermissions {
  /** Chats the script may post into. v1: existing chats only. */
  chatIds: string[];
  /** Members the script may mention (and so start). */
  participantIds: string[];
  /** Messages that mention anyone, per rolling hour; the rest are held. */
  maxWakeupsPerHour: number;
}

export type ScriptRunStatus =
  | "ok"
  | "failed"
  | "timeout"
  | "skipped"
  | "blocked"
  | "missed"
  | "interrupted"
  | "stopped";

export type ScriptHealth =
  | "needs-approval"
  | "waiting-for-keys"
  | "off"
  | "failing"
  | "blocked"
  | "holding-messages"
  | "ok"
  | "never-run";

/** One history row. Consecutive runs with the same status and no message
 *  sent share a row, so an every-minute script writes a few rows a day. */
export interface ScriptRunRow {
  id: string;
  status: ScriptRunStatus;
  count: number;
  firstAt: string;
  lastAt: string;
  exitCode?: number | null;
  messagesSent: number;
  /** Last output of the latest run in this row, with the script's own key
   *  values replaced by "•••". Kept only for the most recent rows. */
  outputTail?: string;
  detail?: string;
}

export interface ScheduledScriptSummary {
  id: string;
  name: string;
  description: string;
  hostId: string;
  hostLabel: string;
  /** The host inside a sentence: "this Mac", "this computer" or a machine name. */
  hostPhrase: string;
  runtime: ScriptRuntime;
  entry: string;
  schedule: ScriptSchedule;
  scheduleText: string;
  timeoutSeconds: number;
  secretNames: string[];
  /** Names of keys that already have a value. Values never leave the host. */
  savedSecretNames: string[];
  permissions: ScriptPermissions;
  /** Chat titles and member handles for display; ids stay authoritative. */
  chatLabels: Record<string, string>;
  participantLabels: Record<string, string>;
  enabled: boolean;
  approved: boolean;
  approvedAt?: string;
  pendingApprovalId?: string;
  createdByParticipantId: string;
  createdByLabel?: string;
  createdInChatId: string;
  health: ScriptHealth;
  lastRunAt?: string;
  lastRunStatus?: ScriptRunStatus;
  nextRunAt?: string;
  running: boolean;
  heldMessageCount: number;
  lastError?: string;
}

export type ScriptChangeOperation = "create" | "update" | "delete" | "enable" | "disable";

/** What the agent sends to `app_scripts_request_change`. */
export interface ScriptChangeToolRequest {
  op: ScriptChangeOperation | "run_now";
  scriptId?: string;
  name?: string;
  description?: string;
  runtime?: ScriptRuntime;
  entry?: string;
  files?: ScriptFile[];
  schedule?: ScriptSchedule;
  timeoutSeconds?: number;
  secretNames?: string[];
  /** Chat ids; the current chat is used when omitted. */
  chatIds?: string[];
  /** Member handles or ids the script may mention. */
  members?: string[];
  maxWakeupsPerHour?: number;
  reason?: string;
}

/** The approval record's request: everything the card shows except the
 *  code, which the card fetches from the host by revision id (the files can
 *  be 64 KB and must stay out of conversation metadata). */
export interface ChatScriptChangeRequest {
  kind: "script-change";
  op: ScriptChangeOperation;
  scriptId: string;
  revisionId?: string;
  contentHash?: string;
  name: string;
  description: string;
  hostId: string;
  hostLabel: string;
  hostPhrase: string;
  runtime: ScriptRuntime;
  entry: string;
  schedule: ScriptSchedule;
  scheduleText: string;
  timeoutSeconds: number;
  secretNames: string[];
  permissions: ScriptPermissions;
  chatLabels: Record<string, string>;
  participantLabels: Record<string, string>;
  fileCount: number;
  totalBytes: number;
  reason?: string;
}

/** The one shape check for a script approval's request, shared by the main
 *  process and the renderer so they cannot disagree about a stored card. */
export function isChatScriptChangeRequest(value: unknown): value is ChatScriptChangeRequest {
  const candidate = value as Partial<ChatScriptChangeRequest> | undefined;
  return Boolean(
    candidate &&
    typeof candidate === "object" &&
    candidate.kind === "script-change" &&
    (candidate.op === "create" || candidate.op === "update" || candidate.op === "delete" || candidate.op === "enable" || candidate.op === "disable") &&
    typeof candidate.scriptId === "string" &&
    typeof candidate.name === "string" &&
    Array.isArray(candidate.secretNames) &&
    candidate.schedule && typeof candidate.schedule === "object" &&
    candidate.permissions && typeof candidate.permissions === "object" &&
    Array.isArray(candidate.permissions.chatIds) &&
    Array.isArray(candidate.permissions.participantIds)
  );
}

/** True for proposals whose approval installs code: those need the code on
 *  screen, so the phone (which cannot show it yet) may only decline them. */
export function scriptChangeInstallsCode(request: ChatScriptChangeRequest): boolean {
  return request.op === "create" || request.op === "update";
}

export interface ScriptRevisionContent {
  scriptId: string;
  revisionId?: string;
  runtime: ScriptRuntime;
  entry: string;
  files: ScriptFile[];
  contentHash: string;
}

export interface ScriptIdRequest {
  scriptId: string;
}

export interface GetScriptRevisionRequest {
  scriptId: string;
  /** Omit for the approved (installed) files. */
  revisionId?: string;
}

export interface SetScriptSecretRequest {
  scriptId: string;
  name: string;
  value: string;
}

export interface DeleteScriptSecretRequest {
  scriptId: string;
  name: string;
}

export interface SetScriptEnabledRequest {
  scriptId: string;
  enabled: boolean;
}

export interface ScriptsUpdatedEvent {
  scripts: ScheduledScriptSummary[];
}

/** Body of `POST /script-api/messages`. */
export interface ScriptApiPostMessageRequest {
  chatId: string;
  text: string;
  /** Member handles ("@taylor" or "taylor") or ids to start. */
  mentions?: string[];
  /** Same key within 24 h posts once. */
  idempotencyKey?: string;
}

export interface ScriptApiPostMessageResult {
  ok: true;
  status: "posted" | "duplicate" | "held";
  messageId?: string;
  heldCount?: number;
}

export function scriptHealthLabel(health: ScriptHealth): string {
  switch (health) {
    case "needs-approval": return "Needs approval";
    case "waiting-for-keys": return "Waiting for keys";
    case "off": return "Off";
    case "failing": return "Failing";
    case "blocked": return "Blocked";
    case "holding-messages": return "Holding messages";
    case "ok": return "OK";
    case "never-run": return "Not run yet";
  }
}
