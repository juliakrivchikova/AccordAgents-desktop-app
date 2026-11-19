// The usage signals that go with crash and usage reports: which first steps an
// installation has reached, which provider families it uses, its system and
// its language. Each is a fixed name and a few known values; nothing a member
// or the User wrote, named or chose freely goes into one. Shared because the
// privacy rules in crashReportPrivacy.ts check every signal against these
// very lists before it leaves the computer.

/** The steps an installation reaches once each, in the order growth reads
 *  them as a funnel. `second_model` is a chat with members of two provider
 *  families (two models of one family do not count). */
export const USAGE_MILESTONES = [
  "first_launch",
  "cli_ready",
  "first_chat",
  "first_reply",
  "second_model",
  "first_member_request",
  "first_accord_started",
  "first_accord_signed",
  "first_cloud_machine",
  // Roles and members.
  "custom_role_created",
  "member_role_changed",
  "multi_role_chat",
  "behavior_rule_attached",
  // Other features, the first time each is used.
  "document_created",
  "scheduled_task_created",
  "memory_note_written",
  "phone_paired",
  "terminal_opened",
  "dictation_used",
  "file_preview_opened",
  "connector_signed_in",
  "urgent_alert_set_up",
  "skill_invoked"
] as const;

export type UsageMilestone = typeof USAGE_MILESTONES[number];

/** Sent once by an installation that was already in use before it could
 *  report steps, instead of `first_launch`. */
export const USAGE_EXISTING_INSTALL = "existing_install";
/** Sent the first time an installation has a member on a provider family. */
export const USAGE_PROVIDER_FIRST_USED = "provider_first_used";
/** Sent once per ISO week: how many members and roles the chats have,
 *  as buckets and counts only. */
export const USAGE_WEEKLY_SNAPSHOT = "weekly_snapshot";

export type UsageSignalName = UsageMilestone | typeof USAGE_EXISTING_INSTALL | typeof USAGE_PROVIDER_FIRST_USED | typeof USAGE_WEEKLY_SNAPSHOT;

export const USAGE_SIGNAL_NAMES: ReadonlySet<string> = new Set<string>([...USAGE_MILESTONES, USAGE_EXISTING_INSTALL, USAGE_PROVIDER_FIRST_USED, USAGE_WEEKLY_SNAPSHOT]);

/** The app's own roles. Only these ids are ever sent; a role the person
 *  made is counted and never named (its id may come from its name). Kept
 *  equal to the built-in roles in settings.ts by usageMilestones.test.ts. */
export const USAGE_BUILTIN_ROLE_IDS: ReadonlySet<string> = new Set([
  "administrator",
  "generic-participant",
  "synthesizer",
  "arbiter",
  "software-engineer",
  "product-strategist",
  "brand-strategist",
  "naming-consultant",
  "product-marketer",
  "ux-content-strategist",
  "trademark-attorney",
  "domain-seo-specialist",
  "engineering-manager",
  "product-designer",
  "devex-reviewer",
  "debugger",
  "qa-lead",
  "security-reviewer",
  "release-engineer",
  "code-reviewer",
  "workflow-manager"
]);

/** The Assistant's role: every chat has it without anyone adding it. */
export const USAGE_ASSISTANT_ROLE_ID = "administrator";
/** The role the app gives a member it adds on its own ("Generic Member"). */
export const USAGE_DEFAULT_MEMBER_ROLE_ID = "generic-participant";

/** Whether a member's role is one someone chose, not the app's default. */
export function usageRoleChosen(roleConfigId: unknown): boolean {
  return typeof roleConfigId === "string" && roleConfigId !== "" &&
    roleConfigId !== USAGE_ASSISTANT_ROLE_ID && roleConfigId !== USAGE_DEFAULT_MEMBER_ROLE_ID;
}

/** Whether a chat has two or more members a person added with different
 *  roles (the Assistant not counted). */
export function usageMultiRoleChat(members: ReadonlyArray<{ roleConfigId?: unknown } | null | undefined>): boolean {
  const roles = new Set<string>();
  let added = 0;
  for (const member of members) {
    if (!member || member.roleConfigId === USAGE_ASSISTANT_ROLE_ID) continue;
    added += 1;
    if (typeof member.roleConfigId === "string" && member.roleConfigId) roles.add(member.roleConfigId);
  }
  return added >= 2 && roles.size >= 2;
}

/** How many, in the buckets growth reads: exact up to two, then ranges. */
export const USAGE_COUNT_BUCKETS = ["0", "1", "2", "3-5", "6-10", "11+"] as const;

export type UsageCountBucket = typeof USAGE_COUNT_BUCKETS[number];

export function usageCountBucket(count: number): UsageCountBucket {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count === 1) return "1";
  if (count === 2) return "2";
  if (count <= 5) return "3-5";
  if (count <= 10) return "6-10";
  return "11+";
}

/** The form `usageIsoWeek` writes. */
export const USAGE_ISO_WEEK_PATTERN = /^\d{4}-W\d{2}$/;

/** "2026-W47": the ISO week of a moment, in UTC. */
export function usageIsoWeek(at: Date): string {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The attributes only a weekly snapshot carries. */
export const USAGE_WEEKLY_SNAPSHOT_KEYS = [
  "week",
  "members_total",
  "max_members_in_chat",
  "chats_with_2plus_members",
  "distinct_roles_in_use",
  "custom_roles_count",
  "builtin_roles_in_use"
] as const;

/** The numbers a weekly snapshot carries. */
export interface UsageWeeklySnapshot {
  week: string;
  members_total: UsageCountBucket;
  max_members_in_chat: UsageCountBucket;
  chats_with_2plus_members: UsageCountBucket;
  distinct_roles_in_use: number;
  custom_roles_count: number;
  /** Built-in role ids members have, sorted and comma-separated; "none". */
  builtin_roles_in_use: string;
}

/** Roles the person made that are still in use (not deleted). */
export function usageCustomRoleCount(roles: ReadonlyArray<{ id: string; builtIn?: boolean; archivedAt?: string }>): number {
  return roles.filter((role) => !role.builtIn && !role.archivedAt && !USAGE_BUILTIN_ROLE_IDS.has(role.id)).length;
}

/** The weekly numbers from each chat's members and the roles the person
 *  made. Members are counted once across chats (the same saved member in
 *  three chats is one member); the Assistant is never counted. */
export function usageWeeklySnapshot(
  week: string,
  chats: ReadonlyArray<ReadonlyArray<{ roleConfigId?: unknown; participantConfigId?: unknown; handle?: unknown }>>,
  customRolesCount: number
): UsageWeeklySnapshot {
  const members = new Set<string>();
  const roles = new Set<string>();
  let maxInChat = 0;
  let chatsWithTwoPlus = 0;
  for (const chat of chats) {
    const added = chat.filter((member) => member && member.roleConfigId !== USAGE_ASSISTANT_ROLE_ID);
    maxInChat = Math.max(maxInChat, added.length);
    if (added.length >= 2) chatsWithTwoPlus += 1;
    for (const member of added) {
      const key = typeof member.participantConfigId === "string" && member.participantConfigId
        ? `config:${member.participantConfigId}`
        : `handle:${typeof member.handle === "string" ? member.handle.toLowerCase() : ""}:${String(member.roleConfigId ?? "")}`;
      members.add(key);
      if (typeof member.roleConfigId === "string" && member.roleConfigId) roles.add(member.roleConfigId);
    }
  }
  const builtIn = [...roles].filter((role) => USAGE_BUILTIN_ROLE_IDS.has(role)).sort();
  return {
    week,
    members_total: usageCountBucket(members.size),
    max_members_in_chat: usageCountBucket(maxInChat),
    chats_with_2plus_members: usageCountBucket(chatsWithTwoPlus),
    distinct_roles_in_use: roles.size,
    custom_roles_count: Math.max(0, Math.floor(customRolesCount)),
    builtin_roles_in_use: builtIn.length > 0 ? builtIn.join(",") : "none"
  };
}

export const USAGE_PROVIDER_FAMILIES = [
  "claude-code",
  "codex",
  "antigravity",
  "glm",
  "kimi",
  "minimax",
  "deepseek",
  "anthropic-api",
  "openai-api",
  "gemini-api",
  "custom"
] as const;

export type UsageProviderFamily = typeof USAGE_PROVIDER_FAMILIES[number];

export const USAGE_INSTALL_COHORTS = ["new", "existing"] as const;

export type UsageInstallCohort = typeof USAGE_INSTALL_COHORTS[number];

export const USAGE_OS_VALUES = ["mac", "win", "linux", "other"] as const;

export type UsageOs = typeof USAGE_OS_VALUES[number];

/** The flags `cli_ready` carries: which CLIs are ready. */
export const USAGE_READY_ATTRIBUTES = ["claude_code_ready", "codex_ready", "antigravity_ready"] as const;

export type UsageReadyAttribute = typeof USAGE_READY_ATTRIBUTES[number];

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function isUsageProviderFamily(value: unknown): value is UsageProviderFamily {
  return isOneOf(USAGE_PROVIDER_FAMILIES, value);
}

export function isUsageInstallCohort(value: unknown): value is UsageInstallCohort {
  return isOneOf(USAGE_INSTALL_COHORTS, value);
}

export function isUsageOs(value: unknown): value is UsageOs {
  return isOneOf(USAGE_OS_VALUES, value);
}

export function isUsageReadyAttribute(value: unknown): value is UsageReadyAttribute {
  return isOneOf(USAGE_READY_ATTRIBUTES, value);
}

/** The release every report from this app carries. The system is in it
 *  because Sentry counts active installs only by release and environment. */
const CRASH_REPORT_RELEASE_PREFIX = "AccordAgents@";

export function usageOs(platform: string): UsageOs {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "win";
  if (platform === "linux") return "linux";
  return "other";
}

/** "AccordAgents@1.11.9+mac", "AccordAgents@1.11.9-beta.1+win". */
export function crashReportReleaseName(version: string, platform: string): string {
  return `${CRASH_REPORT_RELEASE_PREFIX}${version}+${usageOs(platform)}`;
}

// A language tag and nothing else: "en", "zh-CN", "zh-Hans-CN", "es-419".
const LOCALE_PATTERN = /^([a-z]{2,3})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?$/i;

/** The form `usageLocale` writes, which is all a signal may carry. */
export const USAGE_LOCALE_PATTERN = /^(?:other|[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?)$/;

/** The first candidate that is a plain language tag, written the usual way
 *  ("zh-Hans-CN"); "other" when none is. Variants, extensions and private
 *  parts are never kept. */
export function usageLocale(candidates: ReadonlyArray<unknown>): string {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const match = LOCALE_PATTERN.exec(candidate.trim().replace(/_/g, "-"));
    if (!match) continue;
    const [, language, script, region] = match;
    return [
      language.toLowerCase(),
      ...(script ? [script[0].toUpperCase() + script.slice(1).toLowerCase()] : []),
      ...(region ? [region.toUpperCase()] : [])
    ].join("-");
  }
  return "other";
}

const HOST_VENDOR_FAMILIES: Readonly<Record<string, UsageProviderFamily>> = {
  anthropic: "anthropic-api",
  openai: "openai-api",
  google: "gemini-api",
  zai: "glm",
  moonshot: "kimi",
  minimax: "minimax",
  deepseek: "deepseek",
  custom: "custom"
};

const CLI_FAMILIES: Readonly<Record<string, UsageProviderFamily>> = {
  "claude-code": "claude-code",
  "codex-cli": "codex",
  "gemini-cli": "antigravity"
};

/** A member's provider family: an added provider by its vendor (any endpoint
 *  of the User's own is just "custom"), otherwise the CLI it runs. */
export function usageProviderFamily(member: { kind?: unknown; hostId?: unknown; hostVendor?: unknown }): UsageProviderFamily | undefined {
  if (typeof member.hostVendor === "string" && member.hostVendor) {
    return HOST_VENDOR_FAMILIES[member.hostVendor] ?? "custom";
  }
  if (typeof member.hostId === "string" && member.hostId.trim()) {
    return "custom";
  }
  return typeof member.kind === "string" ? CLI_FAMILIES[member.kind] : undefined;
}

/** The provider families of one chat's members. */
export function usageMemberFamilies(members: ReadonlyArray<{ kind?: unknown; hostId?: unknown; hostVendor?: unknown } | null | undefined>): Set<UsageProviderFamily> {
  const families = new Set<UsageProviderFamily>();
  for (const member of members) {
    const family = usageProviderFamily(member ?? {});
    if (family) families.add(family);
  }
  return families;
}

/** What every signal says about the installation. */
export interface UsageSignalContext {
  os: UsageOs;
  appVersion: string;
  locale: string;
  cohort: UsageInstallCohort;
}

/** What a signal may add: which CLIs are ready, or a provider family. */
export type UsageSignalExtra = Partial<Record<UsageReadyAttribute, boolean>> & {
  provider_family?: UsageProviderFamily;
};

export type UsageSignalAttributes = Record<string, string | boolean | number>;

/** The attributes a signal is sent with, and the only ones a usage record
 *  may leave the computer with besides what Sentry adds itself. */
export const USAGE_SIGNAL_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "milestone",
  "install_cohort",
  "os",
  "app_version",
  "locale",
  ...USAGE_READY_ATTRIBUTES,
  "provider_family",
  ...USAGE_WEEKLY_SNAPSHOT_KEYS
]);

export function usageSignalAttributes(name: UsageSignalName, context: UsageSignalContext, extra: UsageSignalExtra = {}): UsageSignalAttributes {
  const attributes: UsageSignalAttributes = {
    milestone: name,
    install_cohort: context.cohort,
    os: context.os,
    app_version: context.appVersion,
    locale: context.locale
  };
  for (const key of USAGE_READY_ATTRIBUTES) {
    const value = extra[key];
    if (typeof value === "boolean") attributes[key] = value;
  }
  if (isUsageProviderFamily(extra.provider_family)) {
    attributes.provider_family = extra.provider_family;
  }
  return attributes;
}

/** A weekly snapshot's attributes: the usual ones and its numbers. */
export function usageWeeklySnapshotAttributes(context: UsageSignalContext, snapshot: UsageWeeklySnapshot): UsageSignalAttributes {
  return { ...usageSignalAttributes(USAGE_WEEKLY_SNAPSHOT, context), ...snapshot };
}
