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
// "PASSWORD=hunter2", "api_key: abcd1234…", "Authorization: Bearer …": a
// value with a digit, or a long one. "Token: the per-run one" stays.
const ASSIGNED_TEST = new RegExp(`\\b(?:${SECRET_KEY_WORDS})\\s*[:=]\\s*(?:bearer\\s+)?["']?(?=[^\\s"',;]*\\d|[^\\s"',;]{16,})[^\\s"',;]{6,}`, "i");
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)[A-Z0-9 ]*-----/;
const PEM_END = /-----END [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)[A-Z0-9 ]*-----/;

/** Whether one line holds what looks like a secret. */
export function lineHoldsSecret(line: string): boolean {
  return ASSIGNED_TEST.test(line) || TOKEN_TESTS.some((pattern) => pattern.test(line));
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
