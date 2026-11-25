import assert from "node:assert/strict";
import test from "node:test";
import {
  USAGE_BUILTIN_ROLE_IDS,
  crashReportReleaseName,
  usageCountBucket,
  usageIsoWeek,
  usageLocale,
  usageMultiRoleChat,
  usageOs,
  usageProviderFamily,
  usageRoleChosen,
  usageSignalAttributes,
  usageWeeklySnapshot,
  usageWeeklySnapshotAttributes
} from "./usageSignals";

test("the release name carries the system after the version", () => {
  assert.equal(crashReportReleaseName("1.11.9", "darwin"), "AccordAgents@1.11.9+mac");
  assert.equal(crashReportReleaseName("1.11.9-beta.1", "win32"), "AccordAgents@1.11.9-beta.1+win");
  assert.equal(crashReportReleaseName("1.11.9", "linux"), "AccordAgents@1.11.9+linux");
  assert.equal(usageOs("freebsd"), "other");
});

test("the language is a plain tag or `other`", () => {
  assert.equal(usageLocale(["zh-CN"]), "zh-CN");
  assert.equal(usageLocale(["zh-hans-cn"]), "zh-Hans-CN");
  assert.equal(usageLocale(["en_US"]), "en-US");
  assert.equal(usageLocale(["es-419"]), "es-419");
  assert.equal(usageLocale(["ru"]), "ru");
  // Variants, extensions and anything else are never sent.
  assert.equal(usageLocale(["en-US-u-ca-buddhist", "de-DE"]), "de-DE");
  assert.equal(usageLocale(["x-private", "", undefined, 42]), "other");
  assert.equal(usageLocale(["/Users/julia"]), "other");
});

test("provider families come from the CLI or the added provider's vendor only", () => {
  assert.equal(usageProviderFamily({ kind: "claude-code" }), "claude-code");
  assert.equal(usageProviderFamily({ kind: "codex-cli" }), "codex");
  assert.equal(usageProviderFamily({ kind: "gemini-cli" }), "antigravity");
  assert.equal(usageProviderFamily({ kind: "claude-code", hostId: "h", hostVendor: "zai" }), "glm");
  assert.equal(usageProviderFamily({ kind: "claude-code", hostId: "h", hostVendor: "moonshot" }), "kimi");
  assert.equal(usageProviderFamily({ kind: "claude-code", hostId: "h", hostVendor: "minimax" }), "minimax");
  assert.equal(usageProviderFamily({ kind: "claude-code", hostId: "h", hostVendor: "deepseek" }), "deepseek");
  assert.equal(usageProviderFamily({ kind: "claude-code", hostId: "h", hostVendor: "anthropic" }), "anthropic-api");
  assert.equal(usageProviderFamily({ kind: "codex-cli", hostId: "h", hostVendor: "openai" }), "openai-api");
  assert.equal(usageProviderFamily({ kind: "gemini-cli", hostId: "h", hostVendor: "google" }), "gemini-api");
  assert.equal(usageProviderFamily({ kind: "codex-cli", hostId: "h", hostVendor: "custom" }), "custom");
  // A vendor this version does not know, or an older member without one.
  assert.equal(usageProviderFamily({ kind: "codex-cli", hostId: "h", hostVendor: "acme.example" }), "custom");
  assert.equal(usageProviderFamily({ kind: "codex-cli", hostId: "h" }), "custom");
  assert.equal(usageProviderFamily({ kind: "something-else" }), undefined);
});

test("a signal's attributes are the fixed set and nothing else", () => {
  const context = { os: "win" as const, appVersion: "1.11.9", locale: "en-US", cohort: "new" as const, teamDevice: false };
  assert.deepEqual(usageSignalAttributes("first_chat", context), {
    milestone: "first_chat", install_cohort: "new", os: "win", app_version: "1.11.9", locale: "en-US", team_device: false
  });
  assert.deepEqual(
    usageSignalAttributes("provider_first_used", context, { provider_family: "acme" as never, codex_ready: "yes" as never }),
    { milestone: "provider_first_used", install_cohort: "new", os: "win", app_version: "1.11.9", locale: "en-US", team_device: false }
  );
  // One of our own installations says so on every signal.
  assert.equal(usageSignalAttributes("first_chat", { ...context, teamDevice: true }).team_device, true);
});

test("counts go out in buckets: exact up to two, then ranges", () => {
  assert.deepEqual([0, 1, 2, 3, 5, 6, 10, 11, 500, -1, Number.NaN].map(usageCountBucket),
    ["0", "1", "2", "3-5", "3-5", "6-10", "6-10", "11+", "11+", "0", "0"]);
});

test("the ISO week, across year ends", () => {
  assert.equal(usageIsoWeek(new Date("2026-11-19T18:00:00Z")), "2026-W47");
  assert.equal(usageIsoWeek(new Date("2026-11-16T00:00:00Z")), "2026-W47", "Monday starts the week");
  assert.equal(usageIsoWeek(new Date("2026-11-15T23:59:59Z")), "2026-W46");
  assert.equal(usageIsoWeek(new Date("2027-01-01T12:00:00Z")), "2026-W53");
  assert.equal(usageIsoWeek(new Date("2024-12-30T12:00:00Z")), "2025-W01");
});

test("the weekly snapshot: members once across chats, no Assistant, custom roles counted and never named", () => {
  const assistant = { roleConfigId: "administrator", handle: "assistant" };
  const drew = { roleConfigId: "software-engineer", participantConfigId: "cfg-drew", handle: "drew" };
  const mia = { roleConfigId: "custom-acme-sales-closer", participantConfigId: "cfg-mia", handle: "mia" };
  const leo = { roleConfigId: "product-designer", handle: "leo" };
  const snapshot = usageWeeklySnapshot("2026-W47", [[assistant, drew, mia], [assistant, drew], [assistant, leo, { ...leo }], [assistant]], 3);
  assert.deepEqual(snapshot, {
    week: "2026-W47",
    members_total: "3-5",
    max_members_in_chat: "2",
    chats_with_2plus_members: "2",
    distinct_roles_in_use: 3,
    custom_roles_count: 3,
    builtin_roles_in_use: "product-designer,software-engineer",
    chats_sessions_view_active: "0",
    chats_classic_view_active: "0"
  });
  assert.equal(JSON.stringify(snapshot).includes("acme"), false, "a role the person made is never named");
  const byView = usageWeeklySnapshot("2026-W47", [], 0, ["sessions", "classic", "sessions", "sessions", "sessions"]);
  assert.deepEqual([byView.chats_sessions_view_active, byView.chats_classic_view_active], ["3-5", "1"], "bucketed as the other counts");
  assert.equal(usageWeeklySnapshot("2026-W47", [], 0).builtin_roles_in_use, "none");
  const attributes = usageWeeklySnapshotAttributes({ os: "mac", appVersion: "1.11.9", locale: "en-US", cohort: "existing", teamDevice: true }, snapshot);
  assert.equal(attributes.milestone, "weekly_snapshot");
  assert.equal(attributes.install_cohort, "existing");
  assert.equal(attributes.custom_roles_count, 3);
  assert.equal(attributes.team_device, true, "the weekly record carries the same mark");
});

test("the main session is the app's own member, as the Assistant was: its role is nobody's choice", () => {
  assert.equal(usageRoleChosen("main-session"), false);
  assert.equal(usageMultiRoleChat([{ roleConfigId: "main-session" }, { roleConfigId: "generic-participant" }]), false, "a new chat with one member");
  assert.equal(usageMultiRoleChat([{ roleConfigId: "main-session" }, { roleConfigId: "generic-participant" }, { roleConfigId: "debugger" }]), true);
});

test("every built-in role id is a plain app id", () => {
  for (const id of USAGE_BUILTIN_ROLE_IDS) assert.match(id, /^[a-z]+(?:-[a-z]+)*$/);
});
