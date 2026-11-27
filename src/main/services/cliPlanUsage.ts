import { createHash } from "node:crypto";
import type {
  ParticipantConfig, PlanUsageFact, PlanUsageGroup, PlanUsageSnapshot, PlanUsageTone, PlanUsageWindow
} from "../../shared/types";

/**
 * How much of a member's plan limits its CLI reports used, read the way the
 * CLI itself reads it: one explicit shape per CLI, as cliContextUsage.ts does
 * for the context.
 *
 * Claude Code (verified on 2.1.329): `get_usage` (a control request, no model
 * call) answers what `/usage` shows. Its rows are built exactly as `/usage`
 * builds them: "Current session" (`five_hour`), "Current week (all models)"
 * (`seven_day`), "Current week (Sonnet only)" (`seven_day_sonnet`, Max and
 * Team plans), "Current week (<model>)" (`model_scoped`); utilization is a
 * percent there, and `limits[]` carries the server's severity and headline
 * pick. `rate_limit_event` is pushed after a response when a window moves:
 * utilization is a fraction there, `resetsAt` epoch seconds, and each window
 * says `allowed`, `allowed_warning` or `rejected`.
 *
 * Codex (0.155): `account/rateLimits/read` answers the account's windows
 * (`primary`, `secondary`: usedPercent, windowDurationMins, resetsAt in epoch
 * seconds), credits and plan; `account/rateLimits/updated` is a sparse update
 * merged into the last read.
 *
 * Antigravity (agy 1.5): `agy -p "/usage" --output-format json` answers the
 * groups of models and their buckets with the fraction REMAINING; a bucket
 * never used resets at 1970.
 */

type RecordValue = Record<string, unknown>;

/** Claude Code answers `get_usage` beside a running reply (system/init). */
export const CLAUDE_GET_USAGE_CAPABILITY = "get_usage_detached_v1";

/** Whether a member runs on its CLI's own sign-in, whose plan usage is the
 *  account's. A member on an added provider does not: its Codex gets config
 *  overrides, its agy Gemini API settings, its Claude Code a base URL
 *  (cliProviderHostRunConfig); it has no plan, and must not report "none"
 *  for the account the others run on. */
export function runsOnOwnSignIn(participant: Pick<ParticipantConfig, "kind" | "codexConfigOverrides" | "geminiSettings">, env: NodeJS.ProcessEnv | undefined): boolean {
  if (participant.kind === "codex-cli") return !participant.codexConfigOverrides?.length;
  if (participant.kind === "gemini-cli") return Object.keys(participant.geminiSettings ?? {}).length === 0;
  return !env?.ANTHROPIC_BASE_URL?.trim();
}

function asRecord(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The share shown: rounded, but 100 only once the window is used up (a
 *  rounded 99.6 is not a refusal; Claude Code shows 99 there too). Tones are
 *  decided from the raw share. */
function percent(value: number): number {
  return value >= 100 ? 100 : Math.max(0, Math.min(99, Math.round(value)));
}

function isoFromEpochSeconds(value: unknown): string | undefined {
  const seconds = finiteNumber(value);
  return seconds && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined;
}

function isoFromText(value: unknown): string | undefined {
  const at = Date.parse(text(value) ?? "");
  return Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : undefined;
}

function planLabel(plan: string | undefined): string | undefined {
  if (!plan || plan === "unknown") return undefined;
  const named: Record<string, string> = { prolite: "Pro Lite", promax: "Pro Max", edu_plus: "Edu Plus", edu_pro: "Edu Pro" };
  const words = named[plan] ?? plan.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return `${words} plan`;
}

// --- Claude Code ------------------------------------------------------------

/** What this device last heard from Claude Code: its last `get_usage`
 *  answer, and the windows its `rate_limit_event`s reported since, each as
 *  the latest event about it said (an event about one window leaves the
 *  others as they were), with the window the latest event names. */
export interface ClaudeUsageReading {
  usage?: { value: RecordValue; at: string };
  events?: Record<string, { window: PlanUsageWindow; at: string }>;
  limiting?: { id: string; at: string };
}

const CLAUDE_EVENT_WINDOWS: Record<string, string> = {
  five_hour: "Current session",
  seven_day: "Current week (all models)",
  seven_day_sonnet: "Current week (Sonnet only)",
  seven_day_opus: "Current week (Opus only)"
};

/** The model a window of one model counts (none: the whole account's). */
const CLAUDE_WINDOW_MODELS: Record<string, string> = { seven_day_sonnet: "Sonnet", seven_day_opus: "Opus" };

/** A window an event names, as `/usage` lists it. `seven_day_overage_included`
 *  is the model's own weekly allowance, which Claude Code calls the "Fable
 *  limit": the Fable row `get_usage` lists (`model_scoped`). */
function claudeEventWindowName(type: string, modelRowId: string | undefined): { id: string; label: string; model?: string } | undefined {
  if (type === "seven_day_overage_included") {
    const id = modelRowId ?? "model:Fable";
    const model = id.slice("model:".length);
    return { id, label: `Current week (${model})`, model };
  }
  const label = CLAUDE_EVENT_WINDOWS[type];
  return label ? { id: type, label, ...(CLAUDE_WINDOW_MODELS[type] ? { model: CLAUDE_WINDOW_MODELS[type] } : {}) } : undefined;
}

function claudeTone(status: unknown, refused: boolean): PlanUsageTone {
  if (status === "rejected") return refused ? "reached" : "warning";
  return status === "allowed_warning" ? "warning" : "normal";
}

/** The window `limits[]` names: its kind (and model) mapped to the rows
 *  `/usage` shows. */
function claudeLimitWindowId(limit: RecordValue): string | undefined {
  const kind = text(limit.kind);
  if (kind === "session") return "five_hour";
  if (kind === "weekly_all") return "seven_day";
  const model = text(asRecord(asRecord(limit.scope)?.model)?.display_name);
  return kind === "weekly_scoped" && model ? `model:${model}` : undefined;
}

function claudeUsageWindows(rateLimits: RecordValue, subscription: string | undefined, extraUsageOn: boolean): {
  windows: PlanUsageWindow[];
  headlineId?: string;
} {
  // As `/usage` lists them (Claude Code 2.1.329): the Sonnet row only on
  // Max and Team plans (or an unknown plan), a row with no utilization never.
  const sonnetRow = subscription === "max" || subscription === "team" || subscription === undefined;
  const rows: Array<{ id: string; label: string; model?: string; limit: unknown }> = [
    { id: "five_hour", label: CLAUDE_EVENT_WINDOWS.five_hour, limit: rateLimits.five_hour },
    { id: "seven_day", label: CLAUDE_EVENT_WINDOWS.seven_day, limit: rateLimits.seven_day },
    ...(sonnetRow ? [{ id: "seven_day_sonnet", label: CLAUDE_EVENT_WINDOWS.seven_day_sonnet, model: "Sonnet", limit: rateLimits.seven_day_sonnet }] : []),
    ...(Array.isArray(rateLimits.model_scoped) ? rateLimits.model_scoped : []).flatMap((item) => {
      const name = text(asRecord(item)?.display_name);
      return name ? [{ id: `model:${name}`, label: `Current week (${name})`, model: name, limit: item }] : [];
    })
  ];
  const severity = new Map<string, string>();
  let headlineId: string | undefined;
  for (const item of Array.isArray(rateLimits.limits) ? rateLimits.limits : []) {
    const limit = asRecord(item);
    const id = limit ? claudeLimitWindowId(limit) : undefined;
    if (!limit || !id) continue;
    if (text(limit.severity)) severity.set(id, text(limit.severity)!);
    if (limit.is_active === true) headlineId = id;
  }
  const windows = rows.flatMap(({ id, label, model, limit }) => {
    const record = asRecord(limit);
    const used = finiteNumber(record?.utilization);
    if (!record || used === undefined) return [];
    const usedPercent = percent(used);
    const said = severity.get(id);
    const tone: PlanUsageTone = used >= 100 && !extraUsageOn ? "reached"
      : said === "warning" || said === "critical" || used >= 100 ? "warning" : "normal";
    const resetsAt = isoFromText(record.resets_at);
    return [{ id, label, ...(model ? { model } : {}), usedPercent, ...(resetsAt ? { resetsAt } : {}), tone }];
  });
  return { windows, ...(headlineId && windows.some((window) => window.id === headlineId) ? { headlineId } : {}) };
}

function claudeMoney(minor: number, currency: string | undefined, decimals: number): string {
  const amount = minor / 10 ** decimals;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD", maximumFractionDigits: decimals }).format(amount);
  } catch {
    return amount.toFixed(decimals);
  }
}

function claudeExtraUsageFact(extra: RecordValue | undefined): PlanUsageFact | undefined {
  if (!extra || typeof extra.is_enabled !== "boolean") return undefined;
  if (!extra.is_enabled) return { label: "Extra usage", value: "Off" };
  const used = finiteNumber(extra.used_credits);
  const limit = finiteNumber(extra.monthly_limit);
  const currency = text(extra.currency);
  const decimals = finiteNumber(extra.decimal_places) ?? 2;
  if (used !== undefined && limit !== undefined) {
    return { label: "Extra usage", value: `${claudeMoney(used, currency, decimals)} of ${claudeMoney(limit, currency, decimals)}` };
  }
  return { label: "Extra usage", value: "On" };
}

/** The windows one `rate_limit_event` reports, in `/usage`'s terms: each of
 *  `unifiedWindows`, and the limiting one the event names (a model's own
 *  limit among them) even when it is not one of those, so a refusal by a
 *  model's limit is never hidden behind green general windows. */
function claudeEventWindows(info: RecordValue, refused: boolean, modelRowId: string | undefined): PlanUsageWindow[] {
  const unified = asRecord(info.unifiedWindows);
  const limitingType = text(info.rateLimitType);
  const windows = new Map<string, PlanUsageWindow>();
  const add = (type: string, utilization: unknown, resetsAtSeconds: unknown, status: unknown): void => {
    const name = claudeEventWindowName(type, modelRowId);
    const used = finiteNumber(utilization);
    if (!name || used === undefined) return;
    const resetsAt = isoFromEpochSeconds(resetsAtSeconds);
    const limiting = refused && type === limitingType;
    windows.set(name.id, { ...name, usedPercent: percent(used * 100), ...(resetsAt ? { resetsAt } : {}),
      tone: limiting ? "reached" : claudeTone(status, refused) });
  };
  for (const type of ["five_hour", "seven_day", "seven_day_overage_included"]) {
    const window = asRecord(unified?.[type]);
    if (window) add(type, window.utilization, window.resetsAt, window.status);
  }
  const limitingName = limitingType ? claudeEventWindowName(limitingType, modelRowId) : undefined;
  if (limitingType && limitingName && !windows.has(limitingName.id)) add(limitingType, info.utilization, info.resetsAt, info.status);
  return [...windows.values()];
}

/** Whether requests are refused now: the top-level status, unless paid
 *  extra usage covers the overflow (`overageStatus`). */
function claudeRefused(info: RecordValue): boolean {
  const overage = text(info.overageStatus);
  return info.status === "rejected" && overage !== "allowed" && overage !== "allowed_warning";
}

/** One Claude Code account as its last `get_usage` and its latest
 *  `rate_limit_event` describe it; the newer one wins for the windows both
 *  report. Undefined when neither says anything about plan limits. */
/** The Fable row `get_usage` lists, which a `seven_day_overage_included`
 *  event updates. */
function claudeModelRowId(usage: RecordValue | undefined): string | undefined {
  const scoped = asRecord(usage?.rate_limits)?.model_scoped;
  const name = (Array.isArray(scoped) ? scoped : []).map((item) => text(asRecord(item)?.display_name)).find((item) => item?.startsWith("Fable"));
  return name ? `model:${name}` : undefined;
}

/** One `rate_limit_event` merged into what was heard: the windows it
 *  reports replace their own, the others stay until an event updates them,
 *  they reset, or a full `get_usage` read replaces the stream. An event that
 *  says nothing of plan limits (an API-key session) changes nothing. */
export function mergeClaudeRateLimitEvent(reading: ClaudeUsageReading, event: RecordValue, at: string): ClaudeUsageReading {
  const info = asRecord(event.rate_limit_info) ?? event;
  const refused = claudeRefused(info);
  const modelRowId = claudeModelRowId(reading.usage?.value);
  const windows = claudeEventWindows(info, refused, modelRowId);
  if (windows.length === 0) return reading;
  const events = { ...(reading.events ?? {}) };
  for (const window of windows) events[window.id] = { window, at };
  const type = text(info.rateLimitType);
  const limitingId = type ? claudeEventWindowName(type, modelRowId)?.id : undefined;
  return { ...reading, events, ...(limitingId ? { limiting: { id: limitingId, at } } : {}) };
}

/** One Claude Code account as its last `get_usage` and the events since
 *  describe it; an event newer than the read wins for its window. Undefined
 *  when neither says anything about plan limits. */
export function claudePlanUsage(reading: ClaudeUsageReading): PlanUsageSnapshot | undefined {
  const usage = reading.usage?.value;
  if (usage?.rate_limits_available === false) {
    return { provider: "claude-code", hasPlanLimits: false, windows: [], facts: [], observedAt: reading.usage!.at };
  }
  const rateLimits = asRecord(usage?.rate_limits);
  const subscription = text(usage?.subscription_type);
  const extraUsage = asRecord(rateLimits?.extra_usage);
  const extraFact = claudeExtraUsageFact(extraUsage);
  const fromUsage = rateLimits ? claudeUsageWindows(rateLimits, subscription, extraUsage?.is_enabled === true) : undefined;
  const newer = (at: string): boolean => !reading.usage || at >= reading.usage.at;
  const fromEvents = Object.values(reading.events ?? {}).filter((item) => newer(item.at));
  if (!fromUsage && fromEvents.length === 0) return undefined;
  const byId = new Map((fromUsage?.windows ?? []).map((window) => [window.id, window]));
  for (const item of fromEvents) byId.set(item.window.id, item.window);
  const order = ["five_hour", "seven_day", "seven_day_sonnet", "seven_day_opus"];
  const windows = [...byId.values()].sort((a, b) => {
    const rank = (id: string): number => order.includes(id) ? order.indexOf(id) : order.length;
    return rank(a.id) - rank(b.id);
  });
  const limiting = reading.limiting && newer(reading.limiting.at) && byId.has(reading.limiting.id) ? reading.limiting.id : undefined;
  const headlineId = limiting ?? fromUsage?.headlineId;
  const observedAt = [reading.usage?.at, ...fromEvents.map((item) => item.at)].filter((at): at is string => Boolean(at)).sort().pop()!;
  return {
    provider: "claude-code",
    ...(planLabel(subscription) ? { plan: planLabel(subscription) } : {}),
    hasPlanLimits: true,
    windows,
    ...(headlineId ? { headlineId } : {}),
    ...(windows.some((window) => window.tone === "reached") ? { refused: true } : {}),
    facts: extraFact ? [extraFact] : [],
    observedAt
  };
}

// --- Codex -------------------------------------------------------------------

/** Codex's own name for a window by its length: "5h limit", "Weekly limit". */
export function codexWindowLabel(minutes: number | undefined): string {
  if (!minutes || minutes <= 0) return "Limit";
  if (minutes <= 24 * 60 + 3) return minutes >= 24 * 60 ? "Daily limit" : `${Math.max(1, Math.round(minutes / 60))}h limit`;
  if (minutes <= 7 * 24 * 60 + 3) return "Weekly limit";
  if (minutes <= 31 * 24 * 60 + 3) return "Monthly limit";
  return "Annual limit";
}

/** Codex states no warning of its own: from this share the ring warns. */
export const CODEX_WARNING_PERCENT = 75;

function codexWindow(id: string, value: unknown, group: string | undefined): PlanUsageWindow | undefined {
  const window = asRecord(value);
  const used = finiteNumber(window?.usedPercent);
  if (!window || used === undefined) return undefined;
  const resetsAt = isoFromEpochSeconds(window.resetsAt);
  const tone: PlanUsageTone = used >= 100 ? "reached" : used >= CODEX_WARNING_PERCENT ? "warning" : "normal";
  return {
    id, label: codexWindowLabel(finiteNumber(window.windowDurationMins)), ...(group ? { group } : {}), usedPercent: percent(used),
    ...(resetsAt ? { resetsAt } : {}), tone
  };
}

/** One bucket's windows, shorter first; refused with none at 100% (credits
 *  spent), its fullest says so. */
function codexBucketWindows(limits: RecordValue, prefix: string, group: string | undefined, refused: boolean): PlanUsageWindow[] {
  const windows = [codexWindow(`${prefix}primary`, limits.primary, group), codexWindow(`${prefix}secondary`, limits.secondary, group)]
    .filter((window): window is PlanUsageWindow => Boolean(window))
    .sort((a, b) => windowMinutes(limits, a.id.slice(prefix.length)) - windowMinutes(limits, b.id.slice(prefix.length)));
  if (refused && windows.length > 0 && !windows.some((window) => window.tone === "reached")) {
    const fullest = windows.reduce((a, b) => (b.usedPercent ?? 0) > (a.usedPercent ?? 0) ? b : a);
    fullest.tone = "reached";
  }
  return windows;
}

function codexCredits(value: unknown): PlanUsageFact | undefined {
  const credits = asRecord(value);
  if (!credits) return undefined;
  if (credits.unlimited === true) return { label: "Credits", value: "Unlimited" };
  if (credits.hasCredits !== true) return { label: "Credits", value: "0" };
  const balance = finiteNumber(credits.balance);
  return { label: "Credits", value: balance === undefined ? "Available" : Math.floor(balance).toLocaleString("en-US") };
}

/** A short, stable name for an account id that keeps the id itself on the device. */
export function planUsageAccountKey(accountId: string | undefined): string | undefined {
  return accountId ? createHash("sha256").update(accountId).digest("hex").slice(0, 12) : undefined;
}

/** The account as `account/read` and `account/rateLimits/read` (merged with
 *  later updates) describe it: the account's own bucket (`rateLimits`), and
 *  each named bucket of `rateLimitsByLimitId` as a group named by its
 *  `limitName`, with the model it is for (`normalModelSlug`). Undefined when
 *  Codex is not signed in or reported nothing. */
export function codexPlanUsage(read: unknown, account: unknown, observedAt: string): PlanUsageSnapshot | undefined {
  const accountType = text(asRecord(asRecord(account)?.account)?.type);
  if (accountType && accountType !== "chatgpt") {
    return { provider: "codex-cli", hasPlanLimits: false, windows: [], facts: [], observedAt };
  }
  const answer = asRecord(read);
  const limits = asRecord(answer?.rateLimits);
  if (!limits) return undefined;
  const ownId = text(limits.limitId) ?? "codex";
  const ownRefused = Boolean(text(limits.rateLimitReachedType)) || answer?.ordinaryUsageAllowed === false;
  const windows = codexBucketWindows(limits, "", undefined, ownRefused);
  const groups: PlanUsageGroup[] = [];
  for (const [limitId, value] of Object.entries(asRecord(answer?.rateLimitsByLimitId) ?? {})) {
    const bucket = asRecord(value);
    if (!bucket || limitId === ownId) continue;
    const name = text(bucket.limitName) ?? limitId;
    const model = text(bucket.normalModelSlug);
    const bucketWindows = codexBucketWindows(bucket, `${limitId}:`, name, Boolean(text(bucket.rateLimitReachedType)));
    if (bucketWindows.length === 0) continue;
    groups.push({ name, models: model ? [model] : [] });
    windows.push(...bucketWindows);
  }
  const credits = codexCredits(limits.credits);
  const resets = finiteNumber(asRecord(answer?.rateLimitResetCredits)?.availableCount);
  const plan = planLabel(text(limits.planType) ?? text(asRecord(asRecord(account)?.account)?.planType));
  const accountKey = planUsageAccountKey(text(answer?.accountId));
  return {
    provider: "codex-cli",
    ...(accountKey ? { accountKey } : {}),
    ...(plan ? { plan } : {}),
    hasPlanLimits: true,
    windows,
    ...(windows.some((window) => window.tone === "reached") ? { refused: true } : {}),
    ...(groups.length ? { groups } : {}),
    facts: [...(credits ? [credits] : []), ...(resets !== undefined ? [{ label: "Limit resets available", value: String(resets) }] : [])],
    observedAt
  };
}

function windowMinutes(limits: RecordValue, id: string): number {
  return finiteNumber(asRecord(limits[id])?.windowDurationMins) ?? Number.MAX_SAFE_INTEGER;
}

/** `account/rateLimits/updated` merged into the last read, into the bucket
 *  its `limitId` names (the account's own when it names none): a value it
 *  carries replaces the read's, a missing one (null) keeps it, and whether
 *  the bucket is refused is taken as the update says. An update to the
 *  account's own bucket that is not refused also ends a read's
 *  `ordinaryUsageAllowed: false`: it comes with a response the model gave. */
export function mergeCodexRateLimitsUpdate(lastRead: unknown, params: unknown): RecordValue | undefined {
  const update = asRecord(asRecord(params)?.rateLimits);
  if (!update) return asRecord(lastRead);
  const base: RecordValue = { ...(asRecord(lastRead) ?? {}) };
  const own = asRecord(base.rateLimits);
  const ownId = text(own?.limitId) ?? "codex";
  const limitId = text(update.limitId) ?? ownId;
  const buckets: RecordValue = { ...(asRecord(base.rateLimitsByLimitId) ?? {}) };
  const current = limitId === ownId ? own : asRecord(buckets[limitId]);
  const merged: RecordValue = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(update)) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  if ("rateLimitReachedType" in update) merged.rateLimitReachedType = update.rateLimitReachedType;
  buckets[limitId] = merged;
  if (limitId !== ownId) return { ...base, rateLimitsByLimitId: buckets };
  const cleared = "rateLimitReachedType" in update && !text(update.rateLimitReachedType) && base.ordinaryUsageAllowed === false;
  return { ...base, rateLimits: merged, rateLimitsByLimitId: buckets, ...(cleared ? { ordinaryUsageAllowed: null } : {}) };
}

// --- Antigravity -------------------------------------------------------------

/** agy states no warning of its own: from this share the ring warns. */
export const ANTIGRAVITY_WARNING_PERCENT = 75;

function antigravityWindowLabel(bucket: RecordValue): string {
  const window = text(bucket.window);
  if (window === "weekly") return "Weekly";
  if (window === "5h") return "5 hours";
  return (text(bucket.name) ?? text(bucket.id) ?? "Limit").replace(/\s+Remaining$/i, "");
}

/** The models a group's description names ("Models within this group: A, B"). */
function antigravityGroupModels(description: string | undefined): string[] {
  const list = description?.includes(":") ? description.slice(description.indexOf(":") + 1) : description;
  return (list ?? "").split(",").map((name) => name.trim().replace(/\.$/, "")).filter(Boolean);
}

/** agy's `/usage` answer (`--output-format json`). Undefined when it carried
 *  no groups. */
export function antigravityPlanUsage(output: unknown, observedAt: string): PlanUsageSnapshot | undefined {
  const groups = asRecord(asRecord(asRecord(output)?.command)?.data)?.groups;
  if (!Array.isArray(groups) || groups.length === 0) return undefined;
  const windows: PlanUsageWindow[] = [];
  const named: PlanUsageGroup[] = [];
  for (const item of groups) {
    const group = asRecord(item);
    const name = text(group?.name);
    if (!group || !name) continue;
    named.push({ name, models: antigravityGroupModels(text(group.description)) });
    for (const value of Array.isArray(group.buckets) ? group.buckets : []) {
      const bucket = asRecord(value);
      const remaining = finiteNumber(bucket?.remaining_fraction);
      if (!bucket || remaining === undefined) continue;
      const resetsAt = isoFromText(bucket.reset_time);
      // A bucket never used yet resets at 1970: nothing used, no reset.
      const unused = !resetsAt && remaining >= 1;
      // Decided from the fraction agy gives, rounded only to be shown: a
      // bucket with 0.4% left still takes requests.
      const used = (1 - remaining) * 100;
      const usedPercent = unused ? undefined : percent(used);
      const tone: PlanUsageTone = unused ? "normal"
        : remaining <= 0 ? "reached" : used >= ANTIGRAVITY_WARNING_PERCENT ? "warning" : "normal";
      windows.push({
        id: text(bucket.id) ?? `${name}:${text(bucket.window) ?? windows.length}`,
        label: antigravityWindowLabel(bucket),
        group: name,
        ...(usedPercent !== undefined ? { usedPercent } : {}),
        ...(resetsAt ? { resetsAt } : {}),
        tone
      });
    }
  }
  if (windows.length === 0) return undefined;
  return { provider: "gemini-cli", hasPlanLimits: true, windows, groups: named, facts: [], observedAt };
}

/** agy on a Gemini API key: `/usage` exits with code 2, and there is no plan. */
export const ANTIGRAVITY_NO_PLAN_EXIT_CODE = 2;

export function noPlanLimits(provider: PlanUsageSnapshot["provider"], observedAt: string): PlanUsageSnapshot {
  return { provider, hasPlanLimits: false, windows: [], facts: [], observedAt };
}
