import type {
  ChatProviderKind, PlanUsageGroup, PlanUsageProvider, PlanUsageSnapshot, PlanUsageTone, PlanUsageView, PlanUsageWindow
} from "./types";

/** The CLIs whose accounts have plan limits, by the name each calls itself. */
export const PLAN_USAGE_CLI_NAMES: Record<PlanUsageProvider, string> = {
  "claude-code": "Claude Code",
  "codex-cli": "Codex",
  "gemini-cli": "Antigravity"
};

export function isPlanUsageProvider(kind: ChatProviderKind | string | undefined): kind is PlanUsageProvider {
  return kind === "claude-code" || kind === "codex-cli" || kind === "gemini-cli";
}

export const EMPTY_PLAN_USAGE_VIEW: PlanUsageView = { local: [], machines: {} };

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** The Antigravity group a model belongs to: the one whose models name it
 *  (`gemini-4-neon-high` is "Gemini 4 Neon"), else the one named after its
 *  family ("gemini", "claude"), else the first (agy's default model is in
 *  it). */
export function planUsageGroupForModel(groups: readonly PlanUsageGroup[] | undefined, model: string | undefined): PlanUsageGroup | undefined {
  if (!groups?.length) return undefined;
  const id = slug(model?.split("\t")[0] ?? "");
  if (!id) return groups[0];
  const byModel = groups.find((group) => group.models.some((name) => {
    const named = slug(name);
    return Boolean(named) && (id === named || id.startsWith(`${named}-`) || id.endsWith(`-${named}`) || id.includes(`-${named}-`));
  }));
  if (byModel) return byModel;
  const family = id.split("-")[0];
  return groups.find((group) => slug(group.name).split("-").includes(family)) ?? groups[0];
}

/** What the ring of one member shows. */
export type MemberPlanUsage =
  | { state: "none" }
  | { state: "unread"; provider: PlanUsageProvider }
  | {
    state: "read";
    provider: PlanUsageProvider;
    snapshot: PlanUsageSnapshot;
    /** The window the ring and the hover lead with. */
    headline?: PlanUsageWindow;
    /** The account's other windows the member's model counts against. */
    others: PlanUsageWindow[];
    /** The group the member's model counts against: Antigravity's group of
     *  models, or a named Codex bucket (none: the account's own). */
    group?: string;
    tone: PlanUsageTone;
  };

/** A window as it stands at `now`: one whose reset has passed has reset, so
 *  it refuses nothing and has no reset ahead (the reading is stale until its
 *  CLI says more). */
export function planUsageWindowAt(window: PlanUsageWindow, now: number): PlanUsageWindow {
  const at = Date.parse(window.resetsAt ?? "");
  if (!Number.isFinite(at) || at > now) return window;
  return { id: window.id, label: window.label, ...(window.group ? { group: window.group } : {}), ...(window.model ? { model: window.model } : {}),
    usedPercent: 0, tone: "normal" };
}

/** The Codex bucket a member's model counts against: the named one for its
 *  model (`normalModelSlug`), else the account's own (undefined), which is
 *  also where a member whose model is not known stays. */
function codexBucketForModel(groups: readonly PlanUsageGroup[] | undefined, model: string | undefined): string | undefined {
  const id = model?.trim().toLowerCase();
  return id ? groups?.find((group) => group.models.some((name) => name.toLowerCase() === id))?.name : undefined;
}

/** Whether a member's model is the one a model's own window counts
 *  (`claude-opus-5-5` and `opus` are Opus's): the model's name as a whole
 *  part of its id. */
function windowModelApplies(windowModel: string, memberModel: string | undefined): boolean {
  const model = slug(memberModel ?? "");
  const named = slug(windowModel);
  return Boolean(model && named) && `-${model}-`.includes(`-${named}-`);
}

/** The member's ring: none for a CLI without plan limits (an added provider
 *  is an API key or another host, as is an account that reported none). It
 *  leads with the windows that count for the member: the account's own, its
 *  model's group or bucket, and its model's own window; other models'
 *  windows are left to the detail. `member.model` is the model it runs, the
 *  CLI's default resolved as its model picker resolves it. */
export function memberPlanUsage(
  member: { kind: ChatProviderKind | string; model?: string; hostId?: string },
  snapshots: readonly PlanUsageSnapshot[] | undefined,
  now: number = Date.now()
): MemberPlanUsage {
  if (!isPlanUsageProvider(member.kind) || member.hostId) return { state: "none" };
  const provider = member.kind;
  const read = snapshots?.find((item) => item.provider === provider);
  if (!read) return { state: "unread", provider };
  if (!read.hasPlanLimits) return { state: "none" };
  const snapshot = { ...read, windows: read.windows.map((window) => planUsageWindowAt(window, now)) };
  const group = provider === "gemini-cli" ? planUsageGroupForModel(snapshot.groups, member.model)?.name
    : provider === "codex-cli" ? codexBucketForModel(snapshot.groups, member.model) : undefined;
  const windows = snapshot.windows.filter((window) => window.group === group && (!window.model || windowModelApplies(window.model, member.model)));
  // The CLI's own pick, unless it has reset since: then the live windows decide.
  const preferred = read.windows.find((window) => window.id === read.headlineId);
  const headline = planUsageHeadline(windows, preferred && planUsageWindowAt(preferred, now) === preferred ? preferred.id : undefined);
  return {
    state: "read",
    provider,
    snapshot,
    headline,
    others: windows.filter((window) => window !== headline),
    ...(group ? { group } : {}),
    tone: headline?.tone ?? "normal"
  };
}

/** The window to lead with: one that refuses, else one the CLI warns about,
 *  else any; within that tier the one the CLI puts first, else the one
 *  closest to its limit (the first of equals). */
export function planUsageHeadline(windows: readonly PlanUsageWindow[], preferredId?: string): PlanUsageWindow | undefined {
  const tier = windows.filter((window) => window.tone === "reached");
  const warned = windows.filter((window) => window.tone === "warning");
  const pool = tier.length > 0 ? tier : warned.length > 0 ? warned : windows;
  return pool.find((window) => window.id === preferredId)
    ?? pool.reduce<PlanUsageWindow | undefined>((best, window) => !best || (window.usedPercent ?? -1) > (best.usedPercent ?? -1) ? window : best, undefined);
}

/** A window's title on its own line: Antigravity's carries its group
 *  ("Gemini Models, weekly"). */
export function planUsageWindowTitle(window: PlanUsageWindow): string {
  return window.group ? `${window.group}, ${window.label.charAt(0).toLowerCase()}${window.label.slice(1)}` : window.label;
}

/** A window's share: "23%", "23% used" where it stands alone, "Not used yet". */
export function planUsagePercentText(window: PlanUsageWindow, used = false): string {
  if (window.usedPercent === undefined) return "Not used yet";
  return used ? `${window.usedPercent}% used` : `${window.usedPercent}%`;
}

/** The headline as each CLI words it: Claude Code's ring "Current week (all
 *  models): 87%", Codex's "Weekly limit: 82% used", Antigravity's group
 *  "Gemini Models, weekly: 39% used". */
export function planUsageHeadlineText(provider: PlanUsageProvider, window: PlanUsageWindow): string {
  if (window.usedPercent === undefined) return `${planUsageWindowTitle(window)}: not used yet`;
  return `${planUsageWindowTitle(window)}: ${planUsagePercentText(window, provider !== "claude-code")}`;
}

const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** When a window resets, as the CLIs say it: the time today, the weekday
 *  within a week, the date after that ("Resets Sun 6:00 PM"). */
export function planUsageResetText(resetsAt: string | undefined, now: number = Date.now()): string | undefined {
  const at = Date.parse(resetsAt ?? "");
  // Past: it has reset, and nothing is ahead to say.
  if (!Number.isFinite(at) || at <= now) return undefined;
  const when = new Date(at);
  if (when.toDateString() === new Date(now).toDateString()) return `Resets ${TIME.format(when)}`;
  if (at - now < 6.5 * 24 * 60 * 60_000) return `Resets ${WEEKDAY.format(when)} ${TIME.format(when)}`;
  return `Resets ${DATE.format(when)}, ${TIME.format(when)}`;
}

/** "just now", "3 min ago", "2 h ago", "4 days ago". */
export function planUsageAgeText(observedAt: string, now: number = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(observedAt)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

const TONES: readonly PlanUsageTone[] = ["normal", "warning", "reached"];
const SHORT_TEXT = 120;

function shortText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= SHORT_TEXT && !/[\u0000-\u001f]/.test(value) ? value : undefined;
}

function isoText(value: unknown): string | undefined {
  const text = shortText(value);
  return text && Number.isFinite(Date.parse(text)) ? text : undefined;
}

/** A snapshot read from elsewhere (another device through the User's
 *  server), taken only in the shape this app writes; undefined otherwise. */
export function normalizePlanUsageSnapshot(value: unknown): PlanUsageSnapshot | undefined {
  const item = value && typeof value === "object" ? value as Partial<Record<keyof PlanUsageSnapshot, unknown>> : undefined;
  const observedAt = isoText(item?.observedAt);
  if (!item || !isPlanUsageProvider(item.provider as string) || typeof item.hasPlanLimits !== "boolean" || !observedAt ||
      !Array.isArray(item.windows) || item.windows.length > 12 || !Array.isArray(item.facts) || item.facts.length > 8) return undefined;
  const windows: PlanUsageWindow[] = [];
  for (const raw of item.windows as Array<Partial<Record<keyof PlanUsageWindow, unknown>> | null>) {
    const id = shortText(raw?.id);
    const label = shortText(raw?.label);
    const tone = TONES.find((candidate) => candidate === raw?.tone);
    const used = raw?.usedPercent;
    if (!raw || !id || !label || !tone || (used !== undefined && (typeof used !== "number" || !(used >= 0 && used <= 100)))) return undefined;
    const group = shortText(raw.group);
    const model = shortText(raw.model);
    const resetsAt = isoText(raw.resetsAt);
    windows.push({ id, label, ...(group ? { group } : {}), ...(model ? { model } : {}), ...(used !== undefined ? { usedPercent: used } : {}),
      ...(resetsAt ? { resetsAt } : {}), tone });
  }
  const facts = (item.facts as Array<{ label?: unknown; value?: unknown } | null>).flatMap((fact) => {
    const label = shortText(fact?.label);
    const factValue = shortText(fact?.value);
    return label && factValue ? [{ label, value: factValue }] : [];
  });
  const groups = Array.isArray(item.groups) ? (item.groups as Array<{ name?: unknown; models?: unknown } | null>).slice(0, 6).flatMap((group) => {
    const name = shortText(group?.name);
    const models = Array.isArray(group?.models) ? group.models.slice(0, 24).map(shortText).filter((model): model is string => Boolean(model)) : [];
    return name ? [{ name, models }] : [];
  }) : undefined;
  const plan = shortText(item.plan);
  const accountKey = shortText(item.accountKey);
  const headlineId = shortText(item.headlineId);
  return {
    provider: item.provider as PlanUsageProvider,
    ...(accountKey ? { accountKey } : {}),
    ...(plan ? { plan } : {}),
    hasPlanLimits: item.hasPlanLimits,
    windows,
    ...(headlineId ? { headlineId } : {}),
    ...(item.refused === true ? { refused: true } : {}),
    ...(groups?.length ? { groups } : {}),
    facts,
    observedAt
  };
}
