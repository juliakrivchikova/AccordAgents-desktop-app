/** Schedules for scheduled scripts: a fixed interval, or a five-field cron
 *  expression evaluated in the User's IANA time zone (never the host's, so a
 *  machine running in UTC fires "weekdays at 17:00" at the User's 17:00).
 *  Pure and dependency-free: the renderer uses it for wording, the hosts for
 *  due times. */

export type ScriptSchedule =
  | { kind: "interval"; everySeconds: number }
  | { kind: "cron"; expression: string; timeZone: string };

export const SCRIPT_MIN_INTERVAL_SECONDS = 60;
export const SCRIPT_MAX_INTERVAL_SECONDS = 7 * 24 * 60 * 60;
/** How late a due run may still start after the host was asleep or closed.
 *  Later than this, the run is recorded as missed and not run at all. */
export const SCRIPT_MAX_LATE_GRACE_MS = 10 * 60_000;

interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
  /** A fixed hour list ("17", "9-17"): DST-repeated wall-clock times run
   *  once and DST-skipped ones run after the gap. With "*" the job follows
   *  real time, as cron does. */
  hoursRestricted: boolean;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const FIELD_RANGES: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Throws a person-readable error when the schedule cannot run. */
export function validateScriptSchedule(schedule: ScriptSchedule): void {
  if (schedule.kind === "interval") {
    const seconds = schedule.everySeconds;
    if (!Number.isInteger(seconds) || seconds < SCRIPT_MIN_INTERVAL_SECONDS || seconds > SCRIPT_MAX_INTERVAL_SECONDS) {
      throw new Error(`An interval must be a whole number of seconds from ${SCRIPT_MIN_INTERVAL_SECONDS} to ${SCRIPT_MAX_INTERVAL_SECONDS}.`);
    }
    return;
  }
  if (schedule.kind !== "cron") {
    throw new Error("A schedule is either an interval or a cron expression.");
  }
  if (!isValidTimeZone(schedule.timeZone)) {
    throw new Error(`Unknown time zone "${schedule.timeZone}".`);
  }
  // Throws "never fires" for an expression such as February 30.
  nextCronRun(schedule.expression, schedule.timeZone, Date.now());
}

export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("A cron expression has five fields: minute hour day-of-month month day-of-week.");
  }
  const sets = fields.map((field, index) => parseCronField(field, FIELD_RANGES[index]!, index));
  const daysOfWeek = new Set<number>([...sets[4]!].map((day) => (day === 7 ? 0 : day)));
  return {
    minutes: sets[0]!,
    hours: sets[1]!,
    daysOfMonth: sets[2]!,
    months: sets[3]!,
    daysOfWeek,
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
    hoursRestricted: fields[1] !== "*"
  };
}

function parseCronField(field: string, [min, max]: [number, number], index: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) {
      throw new Error(`Cron field ${index + 1} ("${field}") is not supported.`);
    }
    const [, range, stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Cron field ${index + 1} has an invalid step.`);
    }
    let start = min;
    let end = max;
    if (range !== "*") {
      const [from, to] = range!.split("-").map(Number);
      start = from!;
      end = to ?? (stepText === undefined ? from! : max);
    }
    if (start < min || end > max || start > end) {
      throw new Error(`Cron field ${index + 1} must stay within ${min}-${max}.`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }
  return values;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short"
    });
    formatterCache.set(timeZone, cached);
  }
  return cached;
}

function localParts(instantMs: number, timeZone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(instantMs)) {
    parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday ?? ""] ?? 0
  };
}

/** Minutes since an arbitrary epoch of the local wall clock, for ordering. */
function wallKey(parts: LocalParts): number {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) / 60_000);
}

function dayMatches(spec: CronSpec, parts: LocalParts): boolean {
  if (!spec.months.has(parts.month)) {
    return false;
  }
  const domOk = spec.daysOfMonth.has(parts.day);
  const dowOk = spec.daysOfWeek.has(parts.weekday);
  if (spec.domRestricted && spec.dowRestricted) {
    return domOk || dowOk;
  }
  if (spec.domRestricted) {
    return domOk;
  }
  if (spec.dowRestricted) {
    return dowOk;
  }
  return true;
}

function wallMinuteMatches(spec: CronSpec, wall: number): boolean {
  const date = new Date(wall * 60_000);
  const parts: LocalParts = {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    weekday: date.getUTCDay()
  };
  return dayMatches(spec, parts) && spec.hours.has(parts.hour) && spec.minutes.has(parts.minute);
}

/** The first instant strictly after `afterMs` at which the cron expression
 *  fires in `timeZone`. For a fixed hour, a wall-clock time that a DST change
 *  skips fires at the first minute after the gap and one that it repeats
 *  fires once, at its first occurrence; with an hour of "*" the expression
 *  follows real time, as cron does. */
export function nextCronRun(expression: string, timeZone: string, afterMs: number): number {
  const spec = parseCron(expression);
  const startMinute = Math.floor(afterMs / 60_000) + 1;
  const afterWall = wallKey(localParts(afterMs, timeZone));
  const limitMinute = startMinute + 5 * 366 * 24 * 60;
  let minute = startMinute;
  let expectedWall: number | undefined;
  let previousMinute = startMinute - 1;
  let previousWall = afterWall;
  let lastStep = 1;
  while (minute < limitMinute) {
    const instant = minute * 60_000;
    const parts = localParts(instant, timeZone);
    const wall = wallKey(parts);
    if (expectedWall !== undefined && wall !== expectedWall) {
      if (lastStep > 1) {
        // A big step crossed a DST change somewhere inside it: walk the
        // stretch again one minute at a time, so the change is seen where it is.
        minute = previousMinute + 1;
        expectedWall = previousWall + 1;
        lastStep = 1;
        continue;
      }
      if (spec.hoursRestricted && wall > expectedWall) {
        // Clocks jumped forward right here. Any wall-clock minute inside the
        // gap that the expression names fires now, at the first minute after it.
        for (let skipped = expectedWall; skipped < wall; skipped += 1) {
          if (skipped > afterWall && wallMinuteMatches(spec, skipped)) {
            return instant;
          }
        }
      }
    }
    // A repeated wall-clock minute (clocks went back) is never "after" the
    // run that already happened at its first occurrence, for a fixed hour.
    const afterPrevious = spec.hoursRestricted ? wall > afterWall : true;
    if (afterPrevious && dayMatches(spec, parts) && spec.hours.has(parts.hour) && spec.minutes.has(parts.minute)) {
      return instant;
    }
    let step = 1;
    if (!dayMatches(spec, parts)) {
      step = Math.max(1, (23 - parts.hour) * 60 + (60 - parts.minute));
    } else if (!spec.hours.has(parts.hour)) {
      step = Math.max(1, 60 - parts.minute);
    } else {
      const nextMinute = [...spec.minutes].filter((value) => value > parts.minute).sort((a, b) => a - b)[0];
      step = nextMinute === undefined ? Math.max(1, 60 - parts.minute) : nextMinute - parts.minute;
    }
    // Where the wall clock should land if no DST change happens on the way.
    previousMinute = minute;
    previousWall = wall;
    lastStep = step;
    expectedWall = wall + step;
    minute += step;
  }
  throw new Error(`The cron expression "${expression}" never fires.`);
}

/** The next due time for a schedule, given the previous scheduled time (the
 *  anchor) and now. Intervals stay anchored to their first run; a cron
 *  schedule continues from the later of the two. */
export function nextScriptDueAt(schedule: ScriptSchedule, previousDueMs: number, nowMs: number): number {
  if (schedule.kind === "interval") {
    const everyMs = schedule.everySeconds * 1000;
    if (previousDueMs > nowMs) {
      return previousDueMs;
    }
    const elapsedPeriods = Math.floor((nowMs - previousDueMs) / everyMs) + 1;
    return previousDueMs + elapsedPeriods * everyMs;
  }
  return nextCronRun(schedule.expression, schedule.timeZone, Math.max(previousDueMs, nowMs));
}

/** How late a run may still start: a run missed by more is skipped. */
export function scriptLateGraceMs(schedule: ScriptSchedule): number {
  if (schedule.kind === "interval") {
    return Math.min(schedule.everySeconds * 1000, SCRIPT_MAX_LATE_GRACE_MS);
  }
  return SCRIPT_MAX_LATE_GRACE_MS;
}

/** The schedule in words, for cards and Settings. */
export function describeScriptSchedule(schedule: ScriptSchedule): string {
  if (schedule.kind === "interval") {
    return describeInterval(schedule.everySeconds);
  }
  return `${describeCron(schedule.expression)} (${schedule.timeZone})`;
}

function describeInterval(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return days === 1 ? "Every day" : `Every ${days} days`;
  }
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? "Every hour" : `Every ${hours} hours`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
  }
  return `Every ${seconds} seconds`;
}

function describeCron(expression: string): string {
  let spec: CronSpec;
  try {
    spec = parseCron(expression);
  } catch {
    return `Cron "${expression}"`;
  }
  const fields = expression.trim().split(/\s+/);
  const single = (values: Set<number>) => (values.size === 1 ? [...values][0]! : undefined);
  const minute = single(spec.minutes);
  const hour = single(spec.hours);
  if (minute === undefined || hour === undefined || fields[2] !== "*" || fields[3] !== "*") {
    return `Cron "${expression}"`;
  }
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (fields[4] === "*") {
    return `Every day at ${time}`;
  }
  const days = [...spec.daysOfWeek].sort((a, b) => a - b);
  if (days.join(",") === "1,2,3,4,5") {
    return `Weekdays at ${time}`;
  }
  if (days.join(",") === "0,6") {
    return `Weekends at ${time}`;
  }
  return `${days.map((day) => WEEKDAY_NAMES[day]).join(", ")} at ${time}`;
}
