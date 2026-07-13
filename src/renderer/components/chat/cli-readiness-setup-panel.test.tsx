import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import type { AgentHealth, AppSettings } from "../../../shared/types";
import { CLI_PROVIDER_SETUP, resolveAssistantProviderKind } from "../../../shared/cliReadiness";
import { CliReadinessSetupPanel } from "./cli-readiness-setup-panel";
import { validateChatCliAgents } from "./chat-cli-readiness";

const SETTINGS: AppSettings = {
  roundLimitDefault: 2,
  cliAgentRunTimeoutMs: 86_400_000,
  chatParticipantRequestMaxDepth: 2,
  chatParticipantRequestPromptMaxChars: 50_000,
  chatAutoWatchWakeLimit: 3,
  chatPromptContext: { thread: { mode: "off" }, timeline: { mode: "off" } },
  cloudRuns: {
    enabled: false,
    mode: "ssh",
    worker: {},
    hasAwsCredentials: false,
    awsInstanceType: "t3.small",
    awsRootVolumeSizeGb: 8,
    maxRuntimeMs: 86_400_000,
    pollIntervalMs: 2_500
  },
  providers: [
    { kind: "gemini-cli", label: "Antigravity", enabled: true },
    { kind: "claude-code", label: "Claude Code", enabled: true },
    { kind: "codex-cli", label: "Codex", enabled: true }
  ],
  chatRoleConfigs: [],
  chatBehaviorRules: [],
  chatSavedPrompts: [],
  chatParticipantConfigs: []
};

const MISSING: AgentHealth[] = [
  missing("gemini-cli", "Antigravity"),
  missing("claude-code", "Claude Code"),
  missing("codex-cli", "Codex")
];

test("zero-ready onboarding shows three equal alphabetical setup cards with no preselection", () => {
  installWindowBridge();
  const renderer = create(
    <CliReadinessSetupPanel
      agents={MISSING}
      settings={SETTINGS}
      checking={false}
      onRefresh={async () => MISSING}
      onProviderReady={() => undefined}
      onOpenSettings={() => undefined}
    />
  );
  const cards = renderer.root.findAll((node) => node.type === "article");
  assert.deepEqual(cards.map((card) => card.props["data-provider-kind"]), ["gemini-cli", "claude-code", "codex-cli"]);
  assert.deepEqual(cards.map((card) => textOf(card).includes("Set up")), [true, true, true]);
  assert.equal(renderer.root.findAll((node) => typeof node.props.className === "string" && node.props.className.includes("is-expanded")).length, 0);
  assert.equal(textOf(renderer.root).toLowerCase().includes("recommend"), false);
  renderer.unmount();
});

test("check again unlocks the provider that became ready", async () => {
  installWindowBridge();
  const ready = MISSING.map((health) => health.kind === "claude-code"
    ? { ...health, installed: true, detection: "detected" as const, runnable: "ready" as const, authentication: "ready" as const }
    : health);
  let selected: string | undefined;
  const renderer = create(
    <CliReadinessSetupPanel
      agents={MISSING}
      settings={SETTINGS}
      checking={false}
      onRefresh={async () => ready}
      onProviderReady={(kind) => { selected = kind; }}
      onOpenSettings={() => undefined}
    />
  );
  const claudeCard = renderer.root.findByProps({ "data-provider-kind": "claude-code" });
  await click(findButton(claudeCard, "Set up"));
  const expandedCard = renderer.root.findByProps({ "data-provider-kind": "claude-code" });
  assert.match(textOf(expandedCard), /Check again/);
  await click(findButton(expandedCard, "Check again"));
  assert.equal(selected, "claude-code");
  renderer.unmount();
});

test("missing, signed-out, unknown, and disabled states show only their safe current actions", async () => {
  installWindowBridge();
  let openedSettings = false;
  const states: AgentHealth[] = [
    { ...missing("gemini-cli", "Antigravity"), platform: "darwin" },
    normalized("claude-code", "required"),
    normalized("codex-cli", "unknown")
  ];
  const settings: AppSettings = {
    ...SETTINGS,
    providers: SETTINGS.providers.map((provider) => provider.kind === "codex-cli" ? { ...provider, enabled: false } : provider)
  };
  const renderer = create(
    <CliReadinessSetupPanel
      agents={states}
      settings={settings}
      checking={false}
      onRefresh={async () => states}
      onProviderReady={() => undefined}
      onOpenSettings={() => { openedSettings = true; }}
    />
  );

  const antigravity = renderer.root.findByProps({ "data-provider-kind": "gemini-cli" });
  await click(findButton(antigravity, "Set up"));
  assert.match(textOf(renderer.root.findByProps({ "data-provider-kind": "gemini-cli" })), /Install/);
  assert.equal(textOf(renderer.root).includes(CLI_PROVIDER_SETUP["gemini-cli"].installCommandByPlatform.darwin ?? ""), true);
  assert.doesNotMatch(textOf(renderer.root.findByProps({ "data-provider-kind": "gemini-cli" })), /Try sign-in|Sign in/);

  await click(findButton(renderer.root.findByProps({ "data-provider-kind": "gemini-cli" }), "Close"));
  const claude = renderer.root.findByProps({ "data-provider-kind": "claude-code" });
  await click(findButton(claude, "Sign in"));
  const claudeText = textOf(renderer.root.findByProps({ "data-provider-kind": "claude-code" }));
  assert.match(claudeText, /claude auth login/);
  assert.doesNotMatch(claudeText, /npm install/);

  await click(findButton(renderer.root.findByProps({ "data-provider-kind": "claude-code" }), "Close"));
  const codex = renderer.root.findByProps({ "data-provider-kind": "codex-cli" });
  await click(findButton(codex, "Enable"));
  await click(findButton(renderer.root.findByProps({ "data-provider-kind": "codex-cli" }), "Enable in Settings"));
  assert.equal(openedSettings, true);
  assert.doesNotMatch(textOf(renderer.root.findByProps({ "data-provider-kind": "codex-cli" })), /codex login|curl /);
  renderer.unmount();
});

test("could-not-verify offers recovery without claiming sign-in is required", async () => {
  installWindowBridge();
  const agents = MISSING.map((health) => health.kind === "codex-cli" ? normalized("codex-cli", "unknown") : health);
  const renderer = create(
    <CliReadinessSetupPanel
      agents={agents}
      settings={SETTINGS}
      checking={false}
      onRefresh={async () => agents}
      onProviderReady={() => undefined}
      onOpenSettings={() => undefined}
    />
  );
  const card = renderer.root.findByProps({ "data-provider-kind": "codex-cli" });
  assert.match(textOf(card), /Could not verify/);
  await click(findButton(card, "Troubleshoot"));
  const expanded = textOf(renderer.root.findByProps({ "data-provider-kind": "codex-cli" }));
  assert.match(expanded, /Try sign-in.*codex login/);
  assert.match(expanded, /Open Terminal/);
  assert.doesNotMatch(expanded, /Sign-in required/);
  renderer.unmount();
});

test("a stable ready state stays visible with a checking indicator", () => {
  installWindowBridge();
  const agents = MISSING.map((health) => health.kind === "claude-code"
    ? { ...normalized("claude-code", "ready"), checking: true }
    : health);
  const renderer = create(
    <CliReadinessSetupPanel
      agents={agents}
      settings={SETTINGS}
      checking={true}
      onRefresh={async () => agents}
      onProviderReady={() => undefined}
      onOpenSettings={() => undefined}
    />
  );
  assert.match(textOf(renderer.root.findByProps({ "data-provider-kind": "claude-code" })), /Ready · Checking/);
  assert.equal(findButton(renderer.root, "Check again").props.disabled, true);
  renderer.unmount();
});

test("unsupported platforms show guide-only installation without a macOS copy action", async () => {
  installWindowBridge();
  const agents = MISSING.map((health) => health.kind === "gemini-cli" ? { ...health, platform: "linux" as const } : health);
  const renderer = create(
    <CliReadinessSetupPanel
      agents={agents}
      settings={SETTINGS}
      checking={false}
      onRefresh={async () => agents}
      onProviderReady={() => undefined}
      onOpenSettings={() => undefined}
    />
  );
  const card = renderer.root.findByProps({ "data-provider-kind": "gemini-cli" });
  await click(findButton(card, "Set up"));
  const expanded = renderer.root.findByProps({ "data-provider-kind": "gemini-cli" });
  assert.match(textOf(expanded), /official guide/i);
  assert.equal(expanded.findAll((node) => node.type === "button" && /Copy/.test(textOf(node))).length, 0);
  assert.doesNotMatch(textOf(expanded), /curl /);
  renderer.unmount();
});

test("renderer readiness validation blocks an explicitly selected unready member with an actionable reason", () => {
  assert.match(
    validateChatCliAgents([{ kind: "claude-code" }], MISSING, SETTINGS.providers) ?? "",
    /Claude Code was not detected/
  );
});

test("renderer provider selection stays neutral with multiple ready providers and no valid preference", () => {
  const agents = MISSING.map((health) => normalized(health.kind, "ready"));
  assert.equal(resolveAssistantProviderKind({ agents, providers: SETTINGS.providers }), undefined);
  assert.equal(resolveAssistantProviderKind({
    agents,
    providers: SETTINGS.providers,
    explicitKind: "claude-code"
  }), "claude-code");
  const disabledProviders = SETTINGS.providers.map((provider) => provider.kind === "claude-code"
    ? { ...provider, enabled: false }
    : provider);
  assert.equal(resolveAssistantProviderKind({
    agents,
    providers: disabledProviders,
    explicitKind: "claude-code"
  }), undefined);
});

function missing(kind: AgentHealth["kind"], label: string): AgentHealth {
  return {
    kind,
    label,
    installed: false,
    detection: "not-detected",
    runnable: "unknown",
    authentication: "unknown",
    platform: "darwin"
  };
}

function normalized(kind: AgentHealth["kind"], authentication: "ready" | "required" | "unknown"): AgentHealth {
  return {
    kind,
    label: kind,
    installed: true,
    detection: "detected",
    runnable: "ready",
    authentication,
    platform: "darwin"
  };
}

function installWindowBridge(): void {
  (globalThis as any).window = {
    consensus: {
      openTerminal: async () => undefined,
      openExternal: async () => undefined
    },
    setTimeout
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async () => undefined } }
  });
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find((node) => node.type === "button" && textOf(node).trim() === label);
}

async function click(node: ReactTestInstance): Promise<void> {
  await act(async () => {
    await node.props.onClick();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
}

function textOf(node: ReactTestInstance | string): string {
  return typeof node === "string"
    ? node
    : node.children.map((child) => textOf(child as ReactTestInstance | string)).join("");
}
