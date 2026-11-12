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
  "first_cloud_machine"
] as const;

export type UsageMilestone = typeof USAGE_MILESTONES[number];

/** Sent once by an installation that was already in use before it could
 *  report steps, instead of `first_launch`. */
export const USAGE_EXISTING_INSTALL = "existing_install";
/** Sent the first time an installation has a member on a provider family. */
export const USAGE_PROVIDER_FIRST_USED = "provider_first_used";

export type UsageSignalName = UsageMilestone | typeof USAGE_EXISTING_INSTALL | typeof USAGE_PROVIDER_FIRST_USED;

export const USAGE_SIGNAL_NAMES: ReadonlySet<string> = new Set<string>([...USAGE_MILESTONES, USAGE_EXISTING_INSTALL, USAGE_PROVIDER_FIRST_USED]);

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

export type UsageSignalAttributes = Record<string, string | boolean>;

/** The attributes a signal is sent with, and the only ones a usage record
 *  may leave the computer with besides what Sentry adds itself. */
export const USAGE_SIGNAL_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "milestone",
  "install_cohort",
  "os",
  "app_version",
  "locale",
  ...USAGE_READY_ATTRIBUTES,
  "provider_family"
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
