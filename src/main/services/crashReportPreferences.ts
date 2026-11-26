import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CRASH_REPORTS_ENV_OVERRIDE = "ACCORDAGENTS_CRASH_REPORTS";
export const CRASH_REPORT_INSTALL_ID_FILE = "crash-report-install-id";
/** Present while the User has reports turned off. A file of its own rather
 *  than a settings field: a build without this feature that rewrites
 *  settings.json on the same profile cannot drop the choice. */
export const CRASH_REPORTS_OFF_MARKER = "crash-reports-off";
/** Present once the notice that reports are sent was closed, or the choice was
 *  made in Settings: it is shown until then, also to people who had the app
 *  before the notice. A file of its own for the same reason as the choice. */
export const CRASH_REPORTS_NOTICE_SEEN_MARKER = "crash-reports-notice-seen";
/** Where the SDK keeps its queue, scope and session between launches. */
export const CRASH_REPORT_CACHE_DIR = "sentry";
/** Which privacy rules the SDK's kept data was made under. The offline queue
 *  is sent again as stored, past beforeSend, so what an older build kept
 *  would leave with the fields the current rules remove. Raise the version
 *  whenever the rules in crashReportPrivacy.ts send less. */
export const CRASH_REPORT_RULES_VERSION = "2";
export const CRASH_REPORT_RULES_MARKER = "crash-report-rules-version";

const INSTALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function crashReportsForcedOff(env: NodeJS.ProcessEnv): boolean {
  const override = env[CRASH_REPORTS_ENV_OVERRIDE]?.trim().toLowerCase();
  return override === "0" || override === "off" || override === "false";
}

/**
 * The User's choice. Read synchronously: at launch the SDK must start before
 * the app is ready. Reports are on unless the off marker exists; if the
 * profile cannot be read at all, they stay off rather than on.
 */
export function readCrashReportsChoice(userDataDir: string): boolean {
  try {
    statSync(path.join(userDataDir, CRASH_REPORTS_OFF_MARKER));
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Whether this launch reports: the User's choice, unless the environment
 *  keeps a QA or test instance silent. */
export function readCrashReportsEnabled(userDataDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return !crashReportsForcedOff(env) && readCrashReportsChoice(userDataDir);
}

export function writeCrashReportsChoice(userDataDir: string, enabled: boolean): void {
  const marker = path.join(userDataDir, CRASH_REPORTS_OFF_MARKER);
  if (enabled) {
    rmSync(marker, { force: true });
    return;
  }
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(marker, "Crash and usage reports are turned off in Settings.\n", { encoding: "utf8", mode: 0o600 });
}

/** Whether the notice is to be shown: reports are sent and it was not closed. */
export function crashReportsNoticeDue(userDataDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return readCrashReportsEnabled(userDataDir, env) && !existsSync(path.join(userDataDir, CRASH_REPORTS_NOTICE_SEEN_MARKER));
}

export function markCrashReportsNoticeSeen(userDataDir: string): void {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(path.join(userDataDir, CRASH_REPORTS_NOTICE_SEEN_MARKER), "", { mode: 0o600 });
}

/** Everything the SDK kept for later sending: its offline queue, the scope it
 *  saved and the open session. Removed when the User turns reports off and at
 *  every launch with them off, so nothing collected then is sent later. */
export function discardCrashReportData(userDataDir: string): void {
  rmSync(path.join(userDataDir, CRASH_REPORT_CACHE_DIR), { recursive: true, force: true });
}

/**
 * Discards what the SDK kept under older privacy rules, before it starts and
 * resends its queue. Throws when it cannot be discarded: reports then stay
 * off for this launch rather than send it.
 */
export function discardCrashReportDataOfOlderRules(userDataDir: string): void {
  const marker = path.join(userDataDir, CRASH_REPORT_RULES_MARKER);
  let version = "";
  try {
    version = readFileSync(marker, "utf8").trim();
  } catch {
    // Kept by a build before the marker, or nothing kept yet.
  }
  if (version === CRASH_REPORT_RULES_VERSION) return;
  discardCrashReportData(userDataDir);
  try {
    writeFileSync(marker, `${CRASH_REPORT_RULES_VERSION}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Discarded again next launch: only what was kept in between is lost.
  }
}

/**
 * A random id that lets reports count distinct installations. It is created
 * once per profile and carries nothing about the User or the machine. If it
 * cannot be stored, the launch still reports with a one-off id.
 */
export function loadOrCreateCrashReportInstallId(userDataDir: string): string {
  const file = path.join(userDataDir, CRASH_REPORT_INSTALL_ID_FILE);
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (INSTALL_ID_PATTERN.test(existing)) {
      return existing;
    }
  } catch {
    // Not created yet.
  }
  const created = randomUUID();
  try {
    mkdirSync(userDataDir, { recursive: true });
    const temporary = `${file}.${created}.tmp`;
    writeFileSync(temporary, `${created}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
  } catch {
    // Unwritable profile: this launch is counted with a one-off id.
  }
  return created;
}
