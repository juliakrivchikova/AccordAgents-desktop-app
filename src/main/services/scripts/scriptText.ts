import { validateScriptSchedule } from "../../../shared/scriptSchedule";
import { SCRIPT_SECRET_NAME_PATTERN, isReservedScriptSecretName, type ScriptSchedule } from "../../../shared/scripts";
import { runCommand } from "../command";
import { MAX_SECRETS } from "./constants";

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function trimmedString(value: unknown, field: string, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${field} must be text.`);
  const text = value.trim();
  if (!text) {
    if (required) throw new Error(`${field} is required.`);
    return undefined;
  }
  if (text.length > max) throw new Error(`${field} is at most ${max} characters.`);
  return text;
}

export function boundedInteger(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

export function normalizeSchedule(value: unknown): ScriptSchedule {
  const candidate = value as Partial<ScriptSchedule> | undefined;
  if (!candidate || typeof candidate !== "object") throw new Error("schedule is required.");
  if (candidate.kind !== "interval" && candidate.kind !== "cron") throw new Error("schedule.kind is \"interval\" or \"cron\".");
  const schedule: ScriptSchedule = candidate.kind === "interval"
    ? { kind: "interval", everySeconds: (candidate as { everySeconds?: number }).everySeconds as number }
    : { kind: "cron", expression: String((candidate as { expression?: string }).expression ?? ""), timeZone: String((candidate as { timeZone?: string }).timeZone ?? "") };
  validateScriptSchedule(schedule);
  return schedule;
}

export function normalizeSecretNames(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("secretNames must be a list of names.");
  const names = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !SCRIPT_SECRET_NAME_PATTERN.test(item)) {
      throw new Error(`Key name "${String(item)}" must be UPPER_SNAKE_CASE, like SLACK_BOT_TOKEN.`);
    }
    if (isReservedScriptSecretName(item)) {
      throw new Error(`Key name ${item} is reserved: it would change how the script starts. Use another name, like MY_${item}.`);
    }
    names.add(item);
  }
  if (names.size > MAX_SECRETS) throw new Error(`A script has at most ${MAX_SECRETS} keys.`);
  return [...names].sort();
}

export function lastMeaningfulLine(text: string): string | undefined {
  const lines = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  return last ? (last.length > 240 ? `${last.slice(0, 239)}…` : last) : undefined;
}

/** Replace every key value the script was given with •••. */
export function redactScriptOutput(text: string, secretValues: readonly string[]): string {
  let result = text;
  for (const value of [...secretValues].filter((item) => item.length >= 4).sort((a, b) => b.length - a.length)) {
    result = result.split(value).join("•••");
  }
  return result;
}

/** Redact, then keep the last `maxChars`; a key cut by the start of the tail
 *  is masked too, so no fragment of a value survives truncation. */
export function redactedTail(text: string, secretValues: readonly string[], maxChars: number): string {
  let tail = redactScriptOutput(text, secretValues);
  if (tail.length > maxChars) tail = tail.slice(-maxChars);
  for (const value of secretValues.filter((item) => item.length >= 4)) {
    for (let length = Math.min(value.length - 1, tail.length); length >= 4; length -= 1) {
      if (tail.startsWith(value.slice(-length))) {
        tail = `•••${tail.slice(length)}`;
        break;
      }
    }
  }
  return tail;
}

export function humanTime(ms: number, timeZone?: string): string {
  try {
    return new Date(ms).toLocaleString("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso(ms);
  }
}

/** Start time of a live process via ps, or undefined when it is gone. */
export async function psStartedAt(pid: number): Promise<number | undefined> {
  try {
    const result = await runCommand("ps", ["-p", String(pid), "-o", "lstart="], { timeoutMs: 5000, primeLoginShellEnv: false, env: { LC_ALL: "C", LANG: "C" } });
    const parsed = Date.parse(result.stdout.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
