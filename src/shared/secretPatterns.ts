// What looks like a secret in free text. Shared by the crash reports (which
// replace it before a report leaves the computer) and the sync of what the
// CLIs remember on their own into members' memory (which leaves such a line
// out), so both know a secret the same way.

/** Words that name a secret: what follows them is the secret. */
export const SECRET_KEY_WORDS = "authorization|bearer|token|api[_-]?key|apikey|secret|password|passwd|pwd|access[_-]?key|client[_-]?secret|cookie";

/** Secrets by their own shape (provider keys, cloud keys, JWTs, long hex). */
export const SECRET_TOKEN_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk|hf|xai|glpat)[-_][A-Za-z0-9_-]{12,}/g,
  /\b(?:ghp|gho|ghs|ghu|ghr|github_pat)_[A-Za-z0-9_]{12,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}/g,
  /\b[0-9a-f]{32,}(?:\.[A-Za-z0-9_-]+)?/gi
];

// One pattern per shape, without the global flag (`test` keeps no place).
const TOKEN_TESTS = SECRET_TOKEN_PATTERNS.map((pattern) => new RegExp(pattern.source, pattern.flags.replace("g", "")));
// More shapes a line is left out for (crash reports keep their own list).
const MORE_TOKEN_TESTS: readonly RegExp[] = [
  /\bnpm_[A-Za-z0-9]{20,}/,
  /\bsntrys_[A-Za-z0-9_=+/-]{20,}/,
  /\bya29\.[A-Za-z0-9_-]{20,}/,
  /\bhooks\.slack\.com\/services\/[A-Za-z0-9/]+/,
  // A password in an address: postgres://admin:S3cret@host
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i
];
// A key word ending a longer name too ("OPENAI_API_KEY", "PGPASSWORD",
// "MY_SECRET_KEY",
// `"api_key"`), then what is assigned: a value with a digit, or a long one,
// and not a path. "Token: the per-run one", "max_tokens: 4096" and
// "PWD=/Users/me/project" stay.
const KEY_NAME = `(?<![A-Za-z0-9])[A-Za-z0-9_]*?(?:${SECRET_KEY_WORDS}|api\\s+key|[_-]key)`;
const ASSIGNED_TEST = new RegExp(`${KEY_NAME}["']?\\s*[:=]\\s*(?:bearer\\s+)?["']?(?![/~.])(?=[^\\s"',;]*\\d|[^\\s"',;]{16,})[^\\s"',;]{6,}`, "i");
// A full git commit id (40 or 64 hex digits) named as one is not a secret.
const LONG_HEX = /\b[0-9a-f]{32,}\b/gi;
const GIT_WORDS = /\b(?:commit|commits|merged?|sha|sha1|sha256|rev|revision|tag|tagged|cherry-picked|HEAD|branch)\b/i;
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)[A-Z0-9 ]*-----/;
const PEM_END = /-----END [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)[A-Z0-9 ]*-----/;

/** Whether one line holds what looks like a secret. */
export function lineHoldsSecret(line: string): boolean {
  if (ASSIGNED_TEST.test(line) || MORE_TOKEN_TESTS.some((pattern) => pattern.test(line))) return true;
  const shaped = TOKEN_TESTS.filter((pattern) => pattern.test(line));
  if (!shaped.length) return false;
  // Only long hex, every run a commit id, on a line about git: kept.
  const hexOnly = shaped.length === 1 && shaped[0] === TOKEN_TESTS[TOKEN_TESTS.length - 1];
  const runs = line.match(LONG_HEX) ?? [];
  return !(hexOnly && runs.length > 0 && runs.every((run) => run.length === 40 || run.length === 64) && GIT_WORDS.test(line));
}

/**
 * The text without the lines that look like they hold a secret (a key, a
 * token, a password, a private key block), and how many lines were left out.
 */
export function withoutSecretLines(text: string): { text: string; dropped: number } {
  const kept: string[] = [];
  let dropped = 0;
  let inKeyBlock = false;
  for (const line of text.split("\n")) {
    if (inKeyBlock) {
      dropped += 1;
      if (PEM_END.test(line)) inKeyBlock = false;
      continue;
    }
    if (PEM_BEGIN.test(line)) {
      dropped += 1;
      inKeyBlock = !PEM_END.test(line);
      continue;
    }
    if (lineHoldsSecret(line)) {
      dropped += 1;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), dropped };
}
