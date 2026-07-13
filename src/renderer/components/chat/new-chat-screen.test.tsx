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

test("multiple ready providers render a neutral New Chat without a hidden Assistant member", () => {
  installWindowBridge();
  const renderer = create(<NewChatScreen {...baseProps(readyAgents())} />);

  assert.match(textOf(renderer.root), /Choose the Assistant provider/);
  assert.match(textOf(renderer.root), /Add members/);
  assert.doesNotMatch(textOf(renderer.root), /1 member|Chat Assistant -/);
  assert.equal(renderer.root.findByProps({ "data-testid": "new-chat-prompt" }).props.value, "Draft");
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
    onSelectedAssistantProviderKindChange: () => undefined,
    onSetupCompletedProviderKindChange: () => undefined,
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
