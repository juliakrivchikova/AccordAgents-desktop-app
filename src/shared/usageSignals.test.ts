import assert from "node:assert/strict";
import test from "node:test";
import { crashReportReleaseName, usageLocale, usageOs, usageProviderFamily, usageSignalAttributes } from "./usageSignals";

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
  assert.equal(usageProviderFamily({ kind: "codex-cli", hostId: "h", hostVendor: "custom" }), "custom");
  // A vendor this version does not know, or an older member without one.
  assert.equal(usageProviderFamily({ kind: "codex-cli", hostId: "h", hostVendor: "acme.example" }), "custom");
  assert.equal(usageProviderFamily({ kind: "codex-cli", hostId: "h" }), "custom");
  assert.equal(usageProviderFamily({ kind: "something-else" }), undefined);
});

test("a signal's attributes are the fixed set and nothing else", () => {
  const context = { os: "win" as const, appVersion: "1.11.9", locale: "en-US", cohort: "new" as const };
  assert.deepEqual(usageSignalAttributes("first_chat", context), {
    milestone: "first_chat", install_cohort: "new", os: "win", app_version: "1.11.9", locale: "en-US"
  });
  assert.deepEqual(
    usageSignalAttributes("provider_first_used", context, { provider_family: "acme" as never, codex_ready: "yes" as never }),
    { milestone: "provider_first_used", install_cohort: "new", os: "win", app_version: "1.11.9", locale: "en-US" }
  );
});
