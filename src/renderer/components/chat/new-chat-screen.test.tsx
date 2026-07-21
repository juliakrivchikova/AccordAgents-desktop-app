import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import type {
  AgentHealth,
  AppSettings,
  ChatImageInput,
  ChatSkillMention,
  RepoFileMention
} from "../../../shared/types";
import { NewChatScreen } from "./new-chat-screen";
import type { DraftPluginMention } from "./chat-composer-draft-utils";
import type { PendingChatImage } from "./use-chat-composer-images";

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
  chatRoleConfigs: [{
    id: "administrator",
    label: "Chat Assistant",
    instructions: "Assist the user.",
    version: 1,
    appToolCapabilities: [],
    builtIn: true,
    updatedAt: "2026-07-13T00:00:00.000Z"
  }],
  chatBehaviorRules: [],
  chatSavedPrompts: [],
  chatParticipantConfigs: []
};

test("multiple ready providers silently use Codex without rendering a chooser", () => {
  installWindowBridge();
  const renderer = create(<NewChatScreen {...baseProps(readyAgents())} />);

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

test("unavailable saved Assistant provider blocks send and opens General Settings without changing the draft", async () => {
  installWindowBridge();
  let openedSettings = false;
  const renderer = create(<NewChatScreen
    {...baseProps([readyAgent("codex-cli")], {
      settings: { ...SETTINGS, assistantProviderKind: "claude-code" },
      onOpenProviderSettings: () => { openedSettings = true; }
    })}
  />);

  const warning = renderer.root.findByProps({ "data-testid": "new-chat-provider-unavailable" });
  assert.match(textOf(warning), /Claude Code is unavailable/);
  assert.equal(renderer.root.findByProps({ "data-testid": "new-chat-start" }).props.disabled, true);
  await click(warning.findByType("button"));
  assert.equal(openedSettings, true);
  assert.equal(renderer.root.findByProps({ "data-testid": "new-chat-prompt" }).props.value, "Draft");
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

function installWindowBridge(): void {
  (globalThis as any).window = {
    consensus: {
      searchRepoFiles: async () => [],
      searchUserSkills: async () => ({ target: { participantIds: [], providerKinds: [], hasClearTargets: false }, skills: [] }),
      listPlugins: async () => ({ plugins: [], diagnostics: { checkedSources: [], errors: [], updatedAt: "" } }),
      openTerminal: async () => undefined,
      openExternal: async () => undefined
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
