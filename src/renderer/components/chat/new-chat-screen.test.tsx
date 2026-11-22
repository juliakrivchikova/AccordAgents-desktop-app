import assert from "node:assert/strict";
import test from "node:test";
import { useState } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import type {
  AgentHealth,
  AppSettings,
  ChatParticipantConfig,
  ChatImageInput,
  ChatSkillMention,
  ProviderModelCatalog,
  RepoFileMention
} from "../../../shared/types";
import { defaultChatAgentPermissions } from "../../../shared/agentPermissions";
import { resetMemberModelCatalogs } from "./chat-member-model-name";
import type { ChatParticipantRuntimeOverride } from "./chat-participant-drafts";
import { NewChatScreen } from "./new-chat-screen";
import { ChatParticipantSelectableRosterRow } from "./chat-participant-roster-row";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DraftPluginMention } from "./chat-composer-draft-utils";
import type { PendingChatImage } from "./use-chat-composer-images";
import { EMPTY_MOBILE_CONTROL_SETTINGS } from "../../../shared/mobilePairing";

const SETTINGS: AppSettings = {
  roundLimitDefault: 2,
  betaUpdates: false,
  crashReports: true,
  cliAgentRunTimeoutMs: 86_400_000,
  chatParticipantRequestMaxDepth: 2,
  chatParticipantRequestPromptMaxChars: 50_000,
  chatAutoWatchWakeLimit: 3,
  chatPromptContext: { thread: { mode: "off" }, timeline: { mode: "off" } },
  mobileControl: EMPTY_MOBILE_CONTROL_SETTINGS,
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
  chatRoleConfigs: [{
    id: "main-session",
    label: "Main session",
    instructions: "Work on the user's requests.",
    version: 1,
    appToolCapabilities: [],
    builtIn: true,
    updatedAt: "2026-11-20T00:00:00.000Z"
  }, {
    id: "administrator",
    label: "Chat Assistant",
    instructions: "Assist the user.",
    version: 1,
    appToolCapabilities: [],
    builtIn: true,
    updatedAt: "2026-07-13T00:00:00.000Z"
  }, {
    id: "main-session",
    label: "Main session",
    instructions: "Work on the User's requests.",
    version: 1,
    appToolCapabilities: ["participants.manage", "participants.delegate", "accord.start"],
    builtIn: true,
    participantDefaults: { requestParticipants: "allow", manageRolesParticipants: "allow" },
    updatedAt: "2026-11-20T00:00:00.000Z"
  }],
  chatBehaviorRules: [],
  chatSavedPrompts: [],
  chatParticipantConfigs: [],
  cliProviderHosts: [],
};

// The classic view's New chat: the members picker, as before the sessions view.
const CLASSIC: AppSettings = { ...SETTINGS, defaultChatView: "classic" };

test("multiple ready providers silently use Codex without rendering a chooser", () => {
  installWindowBridge();
  const renderer = create(<NewChatScreen {...baseProps(readyAgents(), { settings: CLASSIC })} />);

  assert.doesNotMatch(textOf(renderer.root), /Choose the Assistant provider/);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "new-chat-provider-choice" }).length, 0);
  assert.match(textOf(renderer.root), /1 member/);
  assert.equal(renderer.root.findByProps({ "data-testid": "new-chat-prompt" }).props.value, "Draft");
  renderer.unmount();
});

test("saved Assistant provider hides the provider choice", () => {
  installWindowBridge();
  const renderer = create(<NewChatScreen
    {...baseProps(readyAgents(), { settings: { ...SETTINGS, assistantProviderKind: "codex-cli" } })}
  />);

  assert.doesNotMatch(textOf(renderer.root), /Choose the Assistant provider/);
  renderer.unmount();
});

test("a saved CLI that is not ready gives way to a ready one, says so under the composer naming the main session, and send stays open", async () => {
  installWindowBridge();
  let startCalls = 0;
  const renderer = create(<NewChatScreen
    {...baseProps([readyAgent("codex-cli"), { ...readyAgent("claude-code"), authentication: "required" }], {
      settings: { ...SETTINGS, assistantProviderKind: "claude-code" },
      onStart: async () => { startCalls += 1; return false; }
    })}
  />);

  assert.equal(renderer.root.findAllByProps({ "data-testid": "new-chat-provider-unavailable" }).length, 0);
  assert.equal(
    textOf(renderer.root.findByProps({ "data-testid": "new-chat-assistant-note" })),
    "The main session uses Codex in this chat: Claude Code, your saved choice, needs sign-in."
  );
  const start = renderer.root.findByProps({ "data-testid": "new-chat-start" });
  assert.equal(start.props.disabled, false);
  await click(start);
  assert.equal(startCalls, 1);
  assert.equal(renderer.root.findByProps({ "data-testid": "new-chat-prompt" }).props.value, "Draft");
  renderer.unmount();
});

test("settings made for the main session on one CLI are dropped when it moves to another", async () => {
  installWindowBridge();
  let overrides: Record<string, unknown> = { "__new-chat-main-session__": { model: "opus" }, "saved-member": { model: "keep" } };
  const onSelectedParticipantRuntimeOverridesChange = (next: unknown) => {
    overrides = typeof next === "function" ? (next as (current: typeof overrides) => typeof overrides)(overrides) : next as typeof overrides;
  };
  const settings = { ...SETTINGS, assistantProviderKind: "claude-code" as const };
  const renderer = create(<NewChatScreen {...baseProps(readyAgents(), { settings, onSelectedParticipantRuntimeOverridesChange })} />);
  assert.deepEqual(Object.keys(overrides), ["__new-chat-main-session__", "saved-member"], "nothing dropped while the CLI stays");
  await act(async () => {
    renderer.update(<NewChatScreen {...baseProps([readyAgent("codex-cli"), { ...readyAgent("claude-code"), authentication: "required" }], { settings, onSelectedParticipantRuntimeOverridesChange })} />);
  });
  assert.deepEqual(overrides, { "saved-member": { model: "keep" } });
  renderer.unmount();
});

test("the saved Assistant CLI, when ready, is used with no note", () => {
  installWindowBridge();
  const renderer = create(<NewChatScreen
    {...baseProps(readyAgents(), { settings: { ...SETTINGS, assistantProviderKind: "claude-code" } })}
  />);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "new-chat-assistant-note" }).length, 0);
  renderer.unmount();
});

test("send without a stored Assistant provider uses the priority preview", async () => {
  installWindowBridge();
  let startCalls = 0;
  const renderer = create(<NewChatScreen {...baseProps(readyAgents(), {
    onStart: async () => {
      startCalls += 1;
      return false;
    }
  })} />);

  const start = renderer.root.findByProps({ "data-testid": "new-chat-start" });
  assert.equal(start.props.disabled, false);
  await click(start);
  assert.equal(startCalls, 1);
  renderer.unmount();
});

test("plain project folders do not render as repository errors", () => {
  installWindowBridge();
  const renderer = create(<NewChatScreen {...baseProps(readyAgents(), {
    repoPath: "/tmp/plain-project",
    repoInfo: {
      repoPath: "/tmp/plain-project",
      isRepo: false,
      branches: [],
      statusLines: []
    }
  })} />);

  assert.doesNotMatch(textOf(renderer.root), /Not a git repository/);
  assert.doesNotMatch(textOf(renderer.root), /fatal:/);
  renderer.unmount();
});

test("folder inspection failures still render as repository errors", () => {
  installWindowBridge();
  const renderer = create(<NewChatScreen {...baseProps(readyAgents(), {
    repoPath: "/tmp/missing-project",
    repoInfo: {
      repoPath: "/tmp/missing-project",
      isRepo: false,
      branches: [],
      statusLines: [],
      error: "Folder does not exist."
    }
  })} />);

  assert.match(textOf(renderer.root), /Folder does not exist/);
  renderer.unmount();
});

test("complete controlled New Chat draft survives unmount and is submitted intact", async () => {
  installWindowBridge();
  const fileMentions: RepoFileMention[] = [{ path: "src/main.ts" }];
  const skillMentions: ChatSkillMention[] = [{
    skillId: "skill-1",
    displayName: "Office Hours",
    frontmatterName: "office-hours",
    contentHash: "hash",
    capabilityState: "invocable",
    variants: [{
      providerKind: "claude-code",
      scope: "personal",
      rootKind: "personal",
      sourceKey: "fixture",
      frontmatterName: "office-hours",
      contentHash: "hash",
      capabilityState: "invocable"
    }]
  }];
  const pluginMentions: DraftPluginMention[] = [{ name: "fixture-plugin", displayName: "Fixture Plugin" }];
  const pendingImages: PendingChatImage[] = [{
    id: "image-1",
    filename: "qa.png",
    mimeType: "image/png",
    sizeBytes: 3,
    dataBase64: "YWJj",
    status: "ready"
  }];
  let submitted: {
    files?: RepoFileMention[];
    images?: ChatImageInput[];
    skills?: ChatSkillMention[];
  } | undefined;
  const props = baseProps([readyAgent("claude-code")], {
    prompt: "/fixture-plugin /office-hours #src/main.ts Draft",
    pendingImages,
    selectedFileMentions: fileMentions,
    selectedPluginMentions: pluginMentions,
    selectedSkillMentions: skillMentions,
    onStart: async (files: RepoFileMention[] | undefined, images: ChatImageInput[] | undefined, skills: ChatSkillMention[] | undefined) => {
      submitted = { files, images, skills };
      return true;
    }
  });

  const first = create(<NewChatScreen {...props} />);
  assert.match(textOf(first.root), /Office Hours/);
  assert.match(textOf(first.root), /main.ts/);
  assert.match(textOf(first.root), /qa.png/);
  first.unmount();

  const restored = create(<NewChatScreen {...props} />);
  await click(restored.root.findByProps({ "aria-label": "Start chat" }));

  assert.deepEqual(submitted?.files, fileMentions);
  assert.deepEqual(submitted?.skills, skillMentions);
  assert.deepEqual(submitted?.images, [{ filename: "qa.png", mimeType: "image/png", dataBase64: "YWJj" }]);
  restored.unmount();
});

test("New Chat suggests /goal for one clear target and selection inserts /goal space", async () => {
  let searchCalls = 0;
  installWindowBridge({
    searchUserSkills: async () => {
      searchCalls += 1;
      return {
        target: {
          participantIds: ["assistant-preview"],
          providerKinds: ["codex-cli"],
          hasClearTargets: true
        },
        skills: []
      };
    }
  });
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<GoalCommandHarness />);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  const textarea = renderer.root.findByProps({ "data-testid": "new-chat-prompt" });
  await act(async () => {
    textarea.props.onChange({ target: { value: "/go" } });
    await new Promise((resolve) => setTimeout(resolve, 450));
  });
  assert.equal(searchCalls, 1);
  const goalOption = renderer.root.findAllByType("button").find((button) => textOf(button).includes("/goal"));
  assert.ok(goalOption, textOf(renderer.root));
  await act(async () => {
    goalOption.props.onMouseDown({ preventDefault: () => undefined });
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  assert.equal(renderer.root.findByProps({ "data-testid": "new-chat-prompt" }).props.value, "/goal ");
  renderer.unmount();
});

test("a member that cannot run where it is set to cannot be added, and once added can still be taken out", async () => {
  const member = { id: "member-claude", handle: "claude", roleConfigId: "engineer", kind: "claude-code" } as ChatParticipantConfig;
  const toggled: string[] = [];
  const check = (selected: boolean) => create(<TooltipProvider><ChatParticipantSelectableRosterRow
    participant={member}
    selected={selected}
    disabledReason="Claude Code requires sign-in."
    controlsDisabled={false}
    roleLabel="Engineer"
    renderParticipantAvatar={() => null}
    onToggleSelected={(id) => toggled.push(id)}
    onRuntimeChange={() => undefined}
  /></TooltipProvider>).root.findByProps({ role: "checkbox" });

  assert.equal(check(false).props.disabled, true);
  const selected = check(true);
  assert.equal(selected.props.disabled, false, "a member set back to run here after it was added would be stuck in the chat");
  await click(selected);
  assert.deepEqual(toggled, [member.id]);
});

const CATALOGS: Record<string, ProviderModelCatalog> = {
  "codex-cli": {
    kind: "codex-cli", authoritative: true, fetchedAt: "2026-11-21T00:00:00.000Z",
    models: [
      { id: "gpt-5.5", label: "GPT-5.5 (gpt-5.5)", recommended: true, source: "cli",
        supportedReasoningEfforts: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }] },
      { id: "gpt-5.5-mini", label: "GPT-5.5 mini", source: "cli" }
    ]
  },
  "claude-code": {
    kind: "claude-code", authoritative: true, fetchedAt: "2026-11-21T00:00:00.000Z",
    models: [
      { id: "opus", label: "Opus 5.5", recommended: true, source: "cli" },
      { id: "haiku", label: "Haiku 5.5", source: "cli" }
    ]
  },
  "gemini-cli": { kind: "gemini-cli", authoritative: true, fetchedAt: "2026-11-21T00:00:00.000Z", models: [{ id: "gemini-3.5-pro", label: "Gemini 3.5 Pro", recommended: true, source: "cli" }] }
};

function installModelBridge(): void {
  resetMemberModelCatalogs();
  installWindowBridge({
    listProviderModels: async (kind: string) => CATALOGS[kind],
    listMachines: async () => ({ machines: [] })
  });
  // The chip's menu closes on a press outside it (the document's).
  (globalThis as any).document = { addEventListener: () => undefined, removeEventListener: () => undefined, querySelector: () => null };
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

/** One of the New chat composer's controls (model, effort, mode, plan). */
const control = (root: ReactTestInstance, part: string): ReactTestInstance => root.findByProps({ "data-testid": `new-chat-controls-${part}` });
const rowsOf = (root: ReactTestInstance, testId: string): ReactTestInstance[] => root.findAllByProps({ "data-testid": testId }).filter((node) => typeof node.type === "string");
const rowLabel = (row: ReactTestInstance): string => textOf(row.findByProps({ className: "composer-menu-item-label" }));

test("a new chat that opens in the sessions view has no members picker: the composer shows the provider glyph and the model, the effort and the mode as controls of their own", async () => {
  installModelBridge();
  const settings = { ...SETTINGS, assistantProviderKind: "codex-cli" as const, chatParticipantConfigs: [savedMember()] };
  const renderer = create(<NewChatScreen {...baseProps(readyAgents(), {
    settings,
    selectedParticipantRuntimeOverrides: { "__new-chat-main-session__": { reasoningEffort: "high" } }
  })} />);
  await settle();
  assert.equal(renderer.root.findAll(hasClass("new-chat-participant-trigger")).length, 0, "no members picker");
  assert.doesNotMatch(textOf(renderer.root), /members?/i, "no member wording");
  assert.doesNotMatch(textOf(renderer.root), /@drew/, "no saved member, handle or avatar");
  const chip = control(renderer.root, "model");
  assert.equal(textOf(chip), "GPT-5.5", "the CLI's default model by name");
  assert.equal(textOf(control(renderer.root, "effort")), "High", "the effort, a control of its own");
  assert.equal(textOf(control(renderer.root, "mode")), "Ask for approval", "Codex's permission preset by its own name");
  assert.equal(textOf(control(renderer.root, "plan")), "Plan mode", "Codex's Plan mode beside it");
  const mark = chip.find(hasClass("chat-provider-icon"));
  assert.equal(mark.props["data-provider-kind"], "codex-cli", "Settings → General's provider");
  assert.ok(mark.props.className.split(" ").includes("is-bare"), "a bare glyph, no tile");
  renderer.unmount();
});

test("the chip's picker chooses this chat's provider, model and effort, with access in the CLI's own terms and nothing about members", async () => {
  installModelBridge();
  const settings = { ...SETTINGS, assistantProviderKind: "codex-cli" as const };
  const seen: { provider?: unknown; overrides: Record<string, unknown> } = { overrides: {} };
  function Harness(): JSX.Element {
    const [provider, setProvider] = useState<{ kind: AgentHealth["kind"]; hostId?: string } | undefined>();
    const [overrides, setOverrides] = useState<Record<string, ChatParticipantRuntimeOverride>>({});
    seen.provider = provider;
    seen.overrides = overrides;
    return <NewChatScreen {...baseProps(readyAgents(), {
      settings,
      mainSessionProvider: provider,
      onMainSessionProviderChange: setProvider,
      selectedParticipantRuntimeOverrides: overrides,
      onSelectedParticipantRuntimeOverridesChange: setOverrides
    })} />;
  }
  const renderer = create(<Harness />);
  await settle();
  await click(control(renderer.root, "model"));
  await settle();
  assert.deepEqual(rowsOf(renderer.root, "chat-model-provider").map(textOf), ["Antigravity", "Claude Code", "Codex"], "every ready CLI, in the model's menu");
  assert.doesNotMatch(textOf(renderer.root.findByProps({ "data-testid": "new-chat-controls" })), /Request other members|Manage members|Auto-watch|Main session/);

  await click(rowsOf(renderer.root, "chat-model-provider").find((row) => textOf(row) === "Claude Code")!);
  await settle();
  assert.deepEqual(seen.provider, { kind: "claude-code" }, "this chat's provider, not the setting");
  assert.equal(settings.assistantProviderKind, "codex-cli", "Settings → General keeps its own");
  assert.equal(rowsOf(renderer.root, "chat-model-option").length, 0, "a choice closes its menu");
  await click(control(renderer.root, "model"));
  assert.deepEqual(rowsOf(renderer.root, "chat-model-option").map(textOf), ["Opus 5.5Default", "Haiku 5.5"], "its default first");
  await click(rowsOf(renderer.root, "chat-model-option").find((row) => textOf(row) === "Haiku 5.5")!);
  await click(control(renderer.root, "effort"));
  await click(rowsOf(renderer.root, "chat-effort-option").find((row) => textOf(row) === "Low")!);
  await click(control(renderer.root, "mode"));
  assert.deepEqual(rowsOf(renderer.root, "chat-access-option").map(rowLabel), ["Manual", "Accept edits", "Plan", "Auto"], "Claude Code's own permission modes");
  await click(rowsOf(renderer.root, "chat-access-option").find((row) => rowLabel(row) === "Accept edits")!);
  await settle();
  const main = seen.overrides["__new-chat-main-session__"] as ChatParticipantRuntimeOverride;
  assert.equal(main.model, "haiku");
  assert.equal(main.reasoningEffort, "low");
  assert.equal(main.agentMode, "default");
  assert.equal(main.permissions?.workspaceWrite, true);
  assert.equal(textOf(control(renderer.root, "model")), "Haiku 5.5");
  assert.equal(textOf(control(renderer.root, "effort")), "Low");
  assert.equal(textOf(control(renderer.root, "mode")), "Accept edits");
  assert.equal(control(renderer.root, "model").find(hasClass("chat-provider-icon")).props["data-provider-kind"], "claude-code");
  renderer.unmount();
});

test("a new chat that opens in the classic view keeps its members picker, and has no model chip", async () => {
  installModelBridge();
  const renderer = create(<NewChatScreen {...baseProps(readyAgents(), { settings: { ...CLASSIC, chatParticipantConfigs: [savedMember()] } })} />);
  await settle();
  assert.match(textOf(renderer.root), /1 member/);
  assert.equal(renderer.root.findAll(hasClass("new-chat-participant-trigger")).length, 1);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "new-chat-controls-model" }).length, 0);
  renderer.unmount();
});

/** The New chat screen as App keeps it: its chip's provider, the main
 *  session's settings and which provider they were made for live outside it. */
function trackedHarness(settingsFor: () => AppSettings, agentsFor: () => AgentHealth[] = readyAgents) {
  const state: {
    provider?: { kind: AgentHealth["kind"]; hostId?: string };
    overrides: Record<string, ChatParticipantRuntimeOverride>;
    madeFor?: string;
  } = { overrides: {} };
  // The state outlives the screen (App keeps it), so a write made as the
  // screen goes away still lands.
  function setter<K extends keyof typeof state>(key: K, force: () => void) {
    return (value: unknown) => {
      state[key] = (typeof value === "function" ? (value as (current: unknown) => unknown)(state[key]) : value) as (typeof state)[K];
      force();
    };
  }
  function Harness(): JSX.Element {
    const [, setTick] = useState(0);
    const force = (): void => setTick((tick) => tick + 1);
    return <NewChatScreen {...baseProps(agentsFor(), {
      settings: settingsFor(),
      mainSessionProvider: state.provider,
      onMainSessionProviderChange: setter("provider", force),
      selectedParticipantRuntimeOverrides: state.overrides,
      onSelectedParticipantRuntimeOverridesChange: setter("overrides", force),
      mainSessionOverrideFor: state.madeFor,
      onMainSessionOverrideForChange: setter("madeFor", force)
    })} />;
  }
  return { state, Harness };
}

test("a new chat's main session starts in the mode her own CLI config starts it in, as the screen shows it, and is made in what was shown", async () => {
  resetMemberModelCatalogs();
  const withConfig: Record<string, ProviderModelCatalog> = {
    ...CATALOGS,
    "codex-cli": { ...CATALOGS["codex-cli"]!, startDefaults: { access: "auto-review", model: "gpt-5.5", modelLabel: "GPT-5.5", reasoningEffort: "low" } }
  };
  installWindowBridge({ listProviderModels: async (kind: string) => withConfig[kind], listMachines: async () => ({ machines: [] }) });
  (globalThis as any).document = { addEventListener: () => undefined, removeEventListener: () => undefined, querySelector: () => null };
  const shown: Array<{ key: string; access?: string } | undefined> = [];
  const renderer = create(<NewChatScreen {...baseProps(readyAgents(), {
    settings: { ...SETTINGS, assistantProviderKind: "codex-cli" },
    onMainSessionStartAccessChange: (value: { key: string; access?: string } | undefined) => { shown.push(value); }
  })} />);
  await settle();
  await settle();
  await openModes(renderer.root);
  assert.equal(checkedMode(renderer.root), "Approve for me", "her config's Approve for me, not Ask for approval");
  assert.equal(textOf(control(renderer.root, "effort")), "Low", "the effort her config sets");
  assert.equal(shown.at(-1)?.access, "auto-review", "the mode shown is what the chat is made in");
  act(() => renderer.unmount());
});

const modeRows = (root: ReactTestInstance): ReactTestInstance[] => rowsOf(root, "chat-access-option");
const checkedMode = (root: ReactTestInstance): string | undefined => {
  const row = modeRows(root).find((candidate) => candidate.props["aria-checked"] === true);
  return row ? rowLabel(row) : undefined;
};
async function openModes(root: ReactTestInstance): Promise<void> {
  if (modeRows(root).length === 0) await click(control(root, "mode"));
}

test("a new chat's main session in the sessions view starts in its CLI's own default mode, and another provider's settings never carry over", async () => {
  installModelBridge();
  let settings: AppSettings = { ...SETTINGS, assistantProviderKind: "claude-code" };
  const { state, Harness } = trackedHarness(() => settings);
  let renderer = create(<Harness />);
  await settle();
  await openModes(renderer.root);
  assert.equal(checkedMode(renderer.root), "Manual", "Claude Code's Manual (its Default before 2.1.330)");
  assert.match(textOf(modeRows(renderer.root)[0]!), /Always ask before making changes/, "in the Claude desktop app's words");

  await click(modeRows(renderer.root).find((row) => rowLabel(row) === "Accept edits")!);
  await click(control(renderer.root, "model"));
  await click(rowsOf(renderer.root, "chat-model-option").find((row) => textOf(row) === "Haiku 5.5")!);
  await settle();
  assert.equal(state.overrides["__new-chat-main-session__"]?.model, "haiku");
  assert.equal(state.madeFor, "claude-code\u0000", "made for Claude Code");

  // Codex chosen on the chip: what was set for Claude Code is dropped,
  // its access included, and Codex starts in its own default mode.
  await click(control(renderer.root, "model"));
  await click(rowsOf(renderer.root, "chat-model-provider").find((row) => textOf(row) === "Codex")!);
  await settle();
  assert.equal(state.overrides["__new-chat-main-session__"], undefined, "no Claude model (or mode) reaches Codex");
  await openModes(renderer.root);
  assert.equal(checkedMode(renderer.root), "Ask for approval", "Codex's own default preset (workspace write, asking to go further)");
  assert.equal(textOf(control(renderer.root, "model")), "GPT-5.5", "Codex's own default model");
  await click(modeRows(renderer.root).find((row) => rowLabel(row) === "Full Access")!);
  // Codex's own question first; only Yes switches.
  assert.equal(state.overrides["__new-chat-main-session__"]?.agentMode, undefined, "not before the question is answered");
  await click(renderer.root.find((node) => typeof node.type === "string" && node.props["data-testid"] === "chat-full-access-confirm-yes"));
  await click(control(renderer.root, "plan"));
  await settle();
  assert.equal(state.overrides["__new-chat-main-session__"]?.agentMode, "full-access", "Codex's Full Access");
  assert.equal(state.overrides["__new-chat-main-session__"]?.permissions?.codexPlanMode, true, "with Plan mode on");
  act(() => renderer.unmount());
  assert.equal(state.provider, undefined, "leaving New chat without sending forgets the chip's provider");
  assert.equal(state.overrides["__new-chat-main-session__"], undefined, "and what was chosen for that chat");

  // A visit made while Settings named another CLI: settings made for the old
  // one (kept from before this rule, say) are not used.
  state.overrides = { "__new-chat-main-session__": { model: "haiku" } };
  state.madeFor = "claude-code\u0000";
  settings = { ...SETTINGS, assistantProviderKind: "codex-cli" };
  renderer = create(<Harness />);
  await settle();
  assert.equal(textOf(control(renderer.root, "model")), "GPT-5.5", "the Claude model is never shown or sent for Codex");
  assert.equal(state.overrides["__new-chat-main-session__"], undefined);
  act(() => renderer.unmount());
});

test("the classic New chat clears the main session's settings, access included, when its CLI changes, and keeps them when you leave", async () => {
  installModelBridge();
  let agents = readyAgents();
  const { state, Harness } = trackedHarness(() => ({ ...CLASSIC, assistantProviderKind: "claude-code" }), () => agents);
  state.overrides = { "__new-chat-main-session__": { agentMode: "plan", permissions: { ...defaultChatAgentPermissions(), workspaceWrite: true } } };
  const renderer = create(<Harness />);
  await settle();
  assert.ok(state.overrides["__new-chat-main-session__"], "kept while its CLI is the same");
  // Claude Code signs out: the main session moves to a ready CLI.
  agents = [readyAgent("gemini-cli"), { ...readyAgent("claude-code"), authentication: "required" }, readyAgent("codex-cli")];
  act(() => renderer.update(<Harness />));
  await settle();
  assert.equal(state.overrides["__new-chat-main-session__"], undefined, "as before the sessions view: its settings were for the other CLI");
  state.overrides = { "__new-chat-main-session__": { agentMode: "plan" } };
  act(() => renderer.update(<Harness />));
  act(() => renderer.unmount());
  assert.ok(state.overrides["__new-chat-main-session__"], "the classic New chat keeps its settings when you leave");
});

test("a provider chosen on the chip that stops being ready is said on the screen, never taken over silently", async () => {
  installModelBridge();
  const renderer = create(<NewChatScreen {...baseProps([readyAgent("codex-cli"), { ...readyAgent("claude-code"), authentication: "required" }], {
    settings: { ...SETTINGS, assistantProviderKind: "codex-cli" },
    mainSessionProvider: { kind: "claude-code" }
  })} />);
  await settle();
  assert.match(textOf(renderer.root.findByProps({ "data-testid": "new-chat-assistant-note" })), /chosen on the model chip is not ready now: this chat would start on Codex/);
  renderer.unmount();
});

function savedMember(): ChatParticipantConfig {
  return {
    id: "saved-drew", handle: "drew", roleConfigId: "main-session-reviewer", behaviorRuleIds: [], kind: "claude-code",
    agentMode: "default", permissions: defaultChatAgentPermissions(), remoteExecution: "local", updatedAt: "2026-11-20T00:00:00.000Z"
  } as ChatParticipantConfig;
}

function hasClass(name: string) {
  return (node: ReactTestInstance): boolean => typeof node.type === "string" && typeof node.props.className === "string" && node.props.className.split(" ").includes(name);
}

function GoalCommandHarness(): JSX.Element {
  const [prompt, setPrompt] = useState("");
  return <NewChatScreen {...baseProps(readyAgents(), {
    prompt,
    onPromptChange: setPrompt
  })} />;
}

function baseProps(agents: AgentHealth[], patch: Record<string, unknown> = {}) {
  return {
    prompt: "Draft",
    pendingImages: [] as PendingChatImage[],
    selectedFileMentions: [] as RepoFileMention[],
    selectedPluginMentions: [] as DraftPluginMention[],
    selectedSkillMentions: [] as ChatSkillMention[],
    repoPath: "",
    selectedParticipantIds: new Set<string>(),
    selectedParticipantRunLocations: {},
    selectedParticipantRuntimeOverrides: {},
    settings: SETTINGS,
    summaries: [],
    agents,
    busy: false,
    renderParticipantAvatar: () => null,
    participantRoleLabel: () => "Role",
    onPromptChange: () => undefined,
    onPendingImagesChange: () => undefined,
    onSelectedFileMentionsChange: () => undefined,
    onSelectedPluginMentionsChange: () => undefined,
    onSelectedSkillMentionsChange: () => undefined,
    onRepoPathChange: () => undefined,
    onRepoBlur: () => undefined,
    onSelectRepo: () => undefined,
    onSelectedParticipantIdsChange: () => undefined,
    onSelectedParticipantRunLocationsChange: () => undefined,
    onSelectedParticipantRuntimeOverridesChange: () => undefined,
    onOpenParticipantsSettings: () => undefined,
    onOpenProviderSettings: () => undefined,
    onRefreshAgents: async () => agents,
    onStart: async () => true,
    ...patch
  };
}

function readyAgents(): AgentHealth[] {
  return [readyAgent("gemini-cli"), readyAgent("claude-code"), readyAgent("codex-cli")];
}

function readyAgent(kind: AgentHealth["kind"]): AgentHealth {
  return {
    kind,
    label: kind,
    installed: true,
    detection: "detected",
    runnable: "ready",
    authentication: "ready",
    platform: "darwin"
  };
}

function installWindowBridge(consensusPatch: Record<string, unknown> = {}): void {
  (globalThis as any).window = {
    consensus: {
      searchRepoFiles: async () => [],
      searchUserSkills: async () => ({ target: { participantIds: [], providerKinds: [], hasClearTargets: false }, skills: [] }),
      listPlugins: async () => ({ plugins: [], diagnostics: { checkedSources: [], errors: [], updatedAt: "" } }),
      openTerminal: async () => undefined,
      openExternal: async () => undefined,
      ...consensusPatch
    },
    setTimeout,
    clearTimeout,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id)
  };
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
