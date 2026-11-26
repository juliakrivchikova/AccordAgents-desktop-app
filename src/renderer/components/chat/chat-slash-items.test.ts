import assert from "node:assert/strict";
import test from "node:test";

import type { PluginCatalogItem, UserSkillSummary } from "../../../shared/types";
import { chatSlashItems, chatSlashProviderKinds, chatSlashUnavailable, slashSearchedSummary } from "./chat-slash-items";
import { buildSlashMenu } from "./slash-menu-model";

test("a plugin row shows, and is found by, the token Enter inserts", () => {
  const skill = summary({ frontmatterName: "remotion-best-practices", displayName: "Remotion best practices" });
  const items = chatSlashItems({
    commands: [],
    prompts: [],
    skills: [],
    plugins: [
      plugin({ name: "remotion", displayName: "Remotion", invocation: { kind: "skill-mention", skill } }),
      plugin({ name: "figma", displayName: "Figma", invocation: { kind: "mcp-passive" }, installedProviderKinds: ["claude-code", "codex-cli"] })
    ]
  });
  assert.deepEqual(items.map((item) => item.name), ["remotion-best-practices", "figma"]);
  assert.deepEqual(buildSlashMenu(items, "remotion", new Set()).nav.map((entry) => entry.type === "item" && entry.item.name), ["remotion-best-practices"]);
  assert.deepEqual(chatSlashProviderKinds(items[1].value), ["claude-code", "codex-cli"]);
});

test("a plugin whose token does not read as its name leads its description with the name", () => {
  const items = chatSlashItems({
    commands: [],
    prompts: [],
    skills: [],
    plugins: [
      plugin({ name: "app-69ef18c674308191a2f952431f91ea61", displayName: "Context7", description: "Fetch Up-to-date Docs", invocation: { kind: "prompt-insert", prompt: "x" } }),
      plugin({ name: "build-ios-apps", displayName: "Build iOS Apps", description: "Build iOS apps", invocation: { kind: "prompt-insert", prompt: "x" } })
    ]
  });
  assert.deepEqual(items.map((item) => item.description), ["Context7: Fetch Up-to-date Docs", "Build iOS apps"]);
});

test("an unavailable skill stays listed, dim, with its own reason or the footer's", () => {
  const cases: Array<{ skill: UserSkillSummary; hasTarget: boolean; expected: ReturnType<typeof chatSlashUnavailable> }> = [
    { skill: summary({}), hasTarget: true, expected: undefined },
    { skill: summary({ ambiguous: true }), hasTarget: true, expected: { short: "Ambiguous", reason: "Duplicate skill variants are ambiguous." } },
    {
      skill: summary({ capabilityState: "discovery-only", statusMessage: "Mention a member before selecting a skill." }),
      hasTarget: false,
      expected: { reason: "Mention a member before selecting a skill." }
    },
    {
      skill: summary({ capabilityState: "discovery-only" }),
      hasTarget: true,
      expected: { short: "Unavailable", reason: "This skill is not selectable for the current target." }
    }
  ];
  for (const { skill, hasTarget, expected } of cases) {
    assert.deepEqual(chatSlashUnavailable(skill, hasTarget), expected);
    const [item] = chatSlashItems({ commands: [], prompts: [], skills: [skill], plugins: [] });
    assert.equal(item.disabled, expected !== undefined);
  }
});

test("an empty search says what it looked through", () => {
  const items = chatSlashItems({
    commands: [{ id: "goal", label: "/goal", description: "" }],
    prompts: [],
    skills: [summary({ frontmatterName: "a" }), summary({ frontmatterName: "b" })],
    plugins: [plugin({ name: "figma", displayName: "Figma", invocation: { kind: "mcp-passive" } })]
  });
  assert.equal(slashSearchedSummary(items), "1 command, 2 skills and 1 plugin");
  assert.equal(slashSearchedSummary([]), "");
});

function summary(overrides: Partial<UserSkillSummary>): UserSkillSummary {
  const name = overrides.frontmatterName ?? "skill";
  return {
    skillId: `id-${name}`,
    displayName: name,
    frontmatterName: name,
    contentHash: "hash",
    capabilityState: "invocable",
    variants: [],
    providerKinds: ["claude-code"],
    scopeKinds: ["personal"],
    ...overrides
  };
}

function plugin(overrides: Partial<PluginCatalogItem> & Pick<PluginCatalogItem, "name" | "displayName" | "invocation">): PluginCatalogItem {
  return {
    id: `plugin-${overrides.name}`,
    providerKind: "claude-code",
    sourceScope: "personal",
    sourceLabel: "test",
    installRecords: [],
    installedProviderKinds: ["claude-code"],
    providerAvailability: [],
    ...overrides
  };
}
