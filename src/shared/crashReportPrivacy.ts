// What leaves the User's machine in a crash or error report. Shared because
// the renderer drops its own breadcrumbs before they reach the main process,
// and the main process scrubs every event (its own and the renderer's) before
// it is sent.

/** Longest piece of free text kept in a report; error messages can quote a
 *  prompt, a command line or a file, and the start is enough to group them. */
export const CRASH_REPORT_MAX_TEXT = 300;

/** Integrations that would send what the User typed or ran: the local
 *  variables of a failing frame (prompts, keys) under either of the names the
 *  SDK uses, console output, and native crash dumps, which upload raw process
 *  memory that no scrubber can see into (and which also replace the system's
 *  own crash dialog). A crashed window or helper process is still reported,
 *  without its memory. */
export const CRASH_REPORT_EXCLUDED_INTEGRATIONS: ReadonlySet<string> = new Set([
  "LocalVariables",
  "LocalVariablesAsync",
  "Console",
  "SentryMinidump"
]);

// Stops for a path that may contain spaces: a quote, a line end, or the
// punctuation that usually follows a path in an error message. A path that
// may contain spaces runs to the next stop, so the words after it can go too;
// losing them is better than sending the rest of the path.
const PATH_BODY = "[^'\"`\\n<>|:;,()]*";
// Node quotes the paths in fs and spawn errors; a quoted path is one path.
const QUOTED_PATH_PATTERN = /(['"`])(?:(?:~|\.{1,2})?[\/\\]|[a-z]:[\\/]|\\\\)[^'"`\n]*\1/gi;
// Both start only where a run starts, so a long unbroken token is not
// rescanned from every character.
const URL_PATTERN = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/gi;
const IP_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g;
// A bare host name ("ec2-52-29-1-2.eu-central-1.compute.amazonaws.com",
// "github.com/…"): only real top-level domains, so "error.message" stays.
const HOST_PATTERN = /(?<![\w@.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|dev|ai|app|cloud|co|sh|me|so|xyz|info|biz|tech|site|online|us|uk|eu|de|fr|nl|ru|ua|cy|cn|jp|in|ca|au|ch|se|no|fi|pl|es|it|il|br|kz)(?::\d+)?\b/gi;
const EMAIL_PATTERN = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const SECRET_KEYS = "authorization|bearer|token|api[_-]?key|apikey|secret|password|passwd|pwd|access[_-]?key|client[_-]?secret|cookie";
// "PASSWORD=hunter2", "Authorization: Bearer …": whatever is assigned goes.
const SECRET_ASSIGNMENT_PATTERN = new RegExp(`\\b(${SECRET_KEYS})(\\s*[:=]\\s*)(?:bearer\\s+)?["']?[^\\s"',;]+`, "gi");
// "relay token 0123…": a long word after the key goes; "Unexpected token <" stays.
const SECRET_FOLLOWING_PATTERN = new RegExp(`\\b(${SECRET_KEYS})(\\s+)(?:bearer\\s+)?["']?[^\\s"',;]{8,}`, "gi");
const WINDOWS_PATH_PATTERN = new RegExp(`(?:\\b[a-z]:[\\\\/]|\\\\\\\\[^\\\\\\s]+\\\\)${PATH_BODY}`, "gi");
const HOME_PATH_PATTERN = new RegExp(`~[\\/\\\\]${PATH_BODY}`, "g");
// An absolute path of two or more segments, spaces and all.
const ABSOLUTE_PATH_PATTERN = new RegExp(`(?<![\\w.~/-])(?:\\.{1,2})?/[^\\s'"\`<>()[\\]{}|,;:/]+/${PATH_BODY}`, "g");
// A relative path: three or more segments, or two ending in a file name.
const RELATIVE_PATH_PATTERN = /(?<![\w.~\/:@-])[\w.-]+(?:\/[\w.-]+){2,}|(?<![\w.~\/:@-])[\w.-]+\/[\w-]+\.[a-z0-9]{1,6}\b/gi;
const TOKEN_PATTERNS = [
  /\b(?:sk|pk|rk|hf|xai|glpat)[-_][A-Za-z0-9_-]{12,}/g,
  /\b(?:ghp|gho|ghs|ghu|ghr|github_pat)_[A-Za-z0-9_]{12,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}/g,
  /\b[0-9a-f]{32,}(?:\.[A-Za-z0-9_-]+)?/gi
];
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_OPAQUE_PATTERN = /[A-Za-z0-9+/_=-]{40,}/g;

/** How much of a text is scrubbed at all: enough to fill the kept part after
 *  paths shrink, small enough that scrubbing an error that quotes megabytes of
 *  output cannot stall the main process. */
const CRASH_REPORT_SCRUB_WINDOW = 2000;

/** Free text with paths, URLs, addresses and secrets removed, then shortened. */
export function scrubCrashReportText(text: string, homeDir = ""): string {
  // A cut can split a path or a secret; the partial run at the cut is dropped
  // rather than sent.
  let out = text.length > CRASH_REPORT_SCRUB_WINDOW ? text.slice(0, CRASH_REPORT_SCRUB_WINDOW).replace(/\S*$/, "") : text;
  if (homeDir.length > 1) {
    out = out.split(homeDir).join("~");
  }
  out = out
    .replace(QUOTED_PATH_PATTERN, (_match, quote: string) => `${quote}[path]${quote}`)
    .replace(URL_PATTERN, "[link]")
    .replace(EMAIL_PATTERN, "[email]")
    .replace(IP_PATTERN, "[ip]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1$2[secret]")
    .replace(SECRET_FOLLOWING_PATTERN, "$1$2[secret]")
    .replace(WINDOWS_PATH_PATTERN, "[path]")
    .replace(HOME_PATH_PATTERN, "[path]")
    .replace(ABSOLUTE_PATH_PATTERN, "[path]")
    .replace(RELATIVE_PATH_PATTERN, "[path]")
    .replace(HOST_PATTERN, "[host]");
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, "[secret]");
  }
  out = out.replace(UUID_PATTERN, "[id]").replace(LONG_OPAQUE_PATTERN, "[secret]");
  return out.length > CRASH_REPORT_MAX_TEXT ? `${out.slice(0, CRASH_REPORT_MAX_TEXT)}…` : out;
}

export interface CrashReportBreadcrumb {
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
}

/** Console output can carry prompts and replies, and the click trail names
 *  chats and members; neither is sent. Network breadcrumbs keep the method
 *  and status, not the address. */
export function scrubCrashReportBreadcrumb<T extends CrashReportBreadcrumb>(breadcrumb: T, homeDir = ""): T | null {
  const category = breadcrumb.category ?? "";
  if (category === "console" || category.startsWith("ui.")) {
    return null;
  }
  const scrubbed: CrashReportBreadcrumb = { ...breadcrumb };
  if (typeof scrubbed.message === "string") {
    scrubbed.message = scrubCrashReportText(scrubbed.message, homeDir);
  }
  if (scrubbed.data && typeof scrubbed.data === "object") {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(scrubbed.data)) {
      if (typeof value === "string") {
        // Fetch breadcrumbs carry the query string and fragment apart from
        // the URL ("http.query": "?mailboxId=…").
        if (key === "http.query" || key === "http.fragment" || /^[?#]/.test(value)) continue;
        data[key] = scrubCrashReportText(value, homeDir);
      } else if (typeof value === "number" || typeof value === "boolean") {
        data[key] = value;
      }
    }
    scrubbed.data = data;
  }
  return scrubbed as T;
}

export interface CrashReportEvent {
  message?: string;
  transaction?: string;
  logentry?: { message?: string; formatted?: string; params?: unknown[] };
  exception?: { values?: Array<{ value?: string; mechanism?: { data?: Record<string, unknown> } }> };
  tags?: Record<string, unknown>;
  contexts?: Record<string, Record<string, unknown> | undefined>;
  breadcrumbs?: CrashReportBreadcrumb[];
  request?: unknown;
  extra?: Record<string, unknown>;
  user?: { id?: string | number };
}

/** String values scrubbed, numbers and flags kept, objects passed through. */
function scrubStringValues(record: Record<string, unknown>, homeDir: string): Record<string, unknown> {
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    scrubbed[key] = typeof value === "string" ? scrubCrashReportText(value, homeDir) : value;
  }
  return scrubbed;
}

/** Applied to every event right before it is sent. */
export function scrubCrashReportEvent<T extends CrashReportEvent>(event: T, homeDir = ""): T {
  const scrubbed: CrashReportEvent = { ...event };
  if (typeof scrubbed.message === "string") {
    scrubbed.message = scrubCrashReportText(scrubbed.message, homeDir);
  }
  if (typeof scrubbed.transaction === "string") {
    scrubbed.transaction = scrubCrashReportText(scrubbed.transaction, homeDir);
  }
  if (scrubbed.tags) {
    scrubbed.tags = scrubStringValues(scrubbed.tags, homeDir);
  }
  if (scrubbed.contexts) {
    const contexts: Record<string, Record<string, unknown> | undefined> = {};
    for (const [name, context] of Object.entries(scrubbed.contexts)) {
      // The trace context is ids the SDK made up; the rest can carry text.
      contexts[name] = context && name !== "trace" ? scrubStringValues(context, homeDir) : context;
    }
    scrubbed.contexts = contexts;
  }
  if (scrubbed.logentry) {
    scrubbed.logentry = {
      ...(typeof scrubbed.logentry.message === "string" ? { message: scrubCrashReportText(scrubbed.logentry.message, homeDir) } : {}),
      ...(typeof scrubbed.logentry.formatted === "string" ? { formatted: scrubCrashReportText(scrubbed.logentry.formatted, homeDir) } : {})
    };
  }
  if (scrubbed.exception?.values) {
    scrubbed.exception = {
      ...scrubbed.exception,
      values: scrubbed.exception.values.map((value) => ({
        ...value,
        ...(typeof value.value === "string" ? { value: scrubCrashReportText(value.value, homeDir) } : {}),
        ...(value.mechanism?.data ? { mechanism: { ...value.mechanism, data: scrubStringValues(value.mechanism.data, homeDir) } } : {})
      }))
    };
  }
  if (scrubbed.breadcrumbs) {
    scrubbed.breadcrumbs = scrubbed.breadcrumbs
      .map((breadcrumb) => scrubCrashReportBreadcrumb(breadcrumb, homeDir))
      .filter((breadcrumb): breadcrumb is CrashReportBreadcrumb => breadcrumb !== null);
  }
  if (scrubbed.extra) {
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(scrubbed.extra)) {
      if (typeof value === "string") {
        extra[key] = scrubCrashReportText(value, homeDir);
      } else if (typeof value === "number" || typeof value === "boolean") {
        extra[key] = value;
      }
    }
    scrubbed.extra = extra;
  }
  delete scrubbed.request;
  if (scrubbed.user) {
    // Only the random install id identifies a user; nothing the SDK or a
    // renderer adds (IP, name, email) goes with it.
    scrubbed.user = scrubbed.user.id === undefined ? undefined : { id: scrubbed.user.id };
  }
  return scrubbed as T;
}
