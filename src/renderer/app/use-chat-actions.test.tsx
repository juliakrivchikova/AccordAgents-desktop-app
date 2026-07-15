import assert from "node:assert/strict";
import test from "node:test";
import { act, create } from "react-test-renderer";

import type { AgentHealth, AppSettings } from "../../shared/types";
import type { AppState } from "./app-state";
import { useChatActions, type ChatActions } from "./use-chat-actions";
import type { ConversationActions } from "./use-conversation-actions";

test("send without a configured Assistant provider reports a visible error", async () => {
  let createCalls = 0;
  let refreshCalls = 0;
  (globalThis as any).window = {
    consensus: {
      createChatConversation: async () => {
        createCalls += 1;
        throw new Error("must not create");
      }
    }
  };
  let error: string | undefined;
  const currentSettings = settings();
  currentSettings.providers = [
    { kind: "claude-code", label: "Claude Code", enabled: true },
    { kind: "codex-cli", label: "Codex", enabled: true }
  ];
  const state = {
    question: "Draft",
    agents: [readyAgent("claude-code"), readyAgent("codex-cli")],
    settings: currentSettings,
    selectedAssistantProviderKind: undefined,
    setupCompletedProviderKind: undefined,
    setError: (value: string | undefined) => { error = value; },
    setWarnings: () => undefined
  } as unknown as AppState;
  let actions: ChatActions | undefined;

  function Harness(): null {
    actions = useChatActions(state, {
      refreshAgents: async () => {
        refreshCalls += 1;
        return [];
      }
    } as ConversationActions);
    return null;
  }

  const renderer = create(<Harness />);
  let started: boolean | undefined;
  await act(async () => {
    started = await actions?.startChat();
  });

  assert.equal(started, false);
  assert.equal(createCalls, 0);
  assert.equal(refreshCalls, 0);
  assert.equal(error, "Choose an Assistant provider above or in General Settings, then try again.");
  renderer.unmount();
});

test("stale ambiguous readiness refreshes before selecting the sole ready provider", async () => {
  let selectedProvider: string | undefined;
  (globalThis as any).window = {
    consensus: {
      createChatConversation: async (request: { assistantProviderKind?: string }) => {
        selectedProvider = request.assistantProviderKind;
        throw new Error("stop after provider selection");
      }
    }
  };
  let refreshCalls = 0;
  let error: string | undefined;
  const currentSettings = settings();
  currentSettings.providers = [
    { kind: "claude-code", label: "Claude Code", enabled: true },
    { kind: "codex-cli", label: "Codex", enabled: true }
  ];
  const state = {
    question: "Draft",
    agents: [staleReadyAgent("claude-code"), staleReadyAgent("codex-cli")],
    settings: currentSettings,
    selectedAssistantProviderKind: undefined,
    setupCompletedProviderKind: undefined,
    selectedChatParticipantConfigIds: new Set<string>(),
    selectedChatParticipantRunLocations: {},
    startingChatRef: { current: false },
    repoPath: "",
    setError: (value: string | undefined) => { error = value; },
    setWarnings: () => undefined,
    setCurrentRunId: () => undefined,
    setBusy: () => undefined
  } as unknown as AppState;
  let actions: ChatActions | undefined;

  function Harness(): null {
    actions = useChatActions(state, {
      refreshAgents: async () => {
        refreshCalls += 1;
        return [readyAgent("codex-cli")];
      }
    } as ConversationActions);
    return null;
  }

  const renderer = create(<Harness />);
  let started: boolean | undefined;
  await act(async () => {
    started = await actions?.startChat();
  });

  assert.equal(started, false);
  assert.equal(refreshCalls, 1);
  assert.equal(selectedProvider, "codex-cli");
  assert.equal(error, "stop after provider selection");
  renderer.unmount();
});

test("stale New Chat readiness refresh failure fails closed and preserves the complete draft", async () => {
  let createCalls = 0;
  (globalThis as any).window = {
    consensus: {
      createChatConversation: async () => {
        createCalls += 1;
        throw new Error("must not create");
      }
    }
  };
  let error: string | undefined;
  const state = {
    question: "/office-hours #src/main.ts Draft",
    agents: [staleReadyAgent()],
    settings: settings(),
    selectedAssistantProviderKind: "claude-code",
    setupCompletedProviderKind: undefined,
    selectedChatParticipantConfigIds: new Set<string>(),
    selectedChatParticipantRunLocations: {},
    newChatPendingImages: [{ id: "image", filename: "qa.png", mimeType: "image/png", sizeBytes: 3, dataBase64: "YWJj", status: "ready" }],
    newChatRepoFileMentions: [{ path: "src/main.ts" }],
    newChatSkillMentions: [{ frontmatterName: "office-hours" }],
    newChatPluginMentions: [{ name: "fixture-plugin", displayName: "Fixture" }],
    startingChatRef: { current: false },
    setError: (value: string | undefined) => { error = value; },
    setWarnings: () => undefined
  } as unknown as AppState;
  const conversationActions = {
    refreshAgents: async () => { throw new Error("probe failed"); }
  } as unknown as ConversationActions;
  let actions: ChatActions | undefined;

  function Harness(): null {
    actions = useChatActions(state, conversationActions);
    return null;
  }

  const renderer = create(<Harness />);
  let started: boolean | undefined;
  await act(async () => {
    started = await actions?.startChat({
      repoFileMentions: state.newChatRepoFileMentions,
      imageAttachments: [{ filename: "qa.png", mimeType: "image/png", dataBase64: "YWJj" }],
      skillMentions: []
    });
  });

  assert.equal(started, false);
  assert.equal(createCalls, 0);
  assert.equal(error, "Could not verify CLI readiness. Check again and retry.");
  assert.equal(state.question, "/office-hours #src/main.ts Draft");
  assert.equal(state.newChatPendingImages.length, 1);
  assert.deepEqual(state.newChatRepoFileMentions, [{ path: "src/main.ts" }]);
  assert.deepEqual(state.selectedChatParticipantRunLocations, {});
  renderer.unmount();
});

test("existing chat send failure preserves the composer draft", async () => {
  (globalThis as any).window = {
    consensus: {
      sendChatMessage: async () => {
        throw new Error("Claude Code was not detected.");
      }
    }
  };
  let draft = "draft must survive unavailable provider";
  let error: string | undefined;
  const state = {
    conversation: {
      id: "conversation-1",
      title: "Existing chat",
      kind: "chat",
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
      messages: [],
      findings: [],
      metadata: {}
    },
    chatMessageDraft: draft,
    progressLogRef: { current: [] },
    setChatMessageDraft: (value: string) => {
      draft = value;
      state.chatMessageDraft = value;
    },
    setConversation: () => undefined,
    setError: (value: string | undefined) => { error = value; },
    setWarnings: () => undefined
  } as unknown as AppState;
  const conversationActions = {} as ConversationActions;
  let actions: ChatActions | undefined;

  function Harness(): null {
    actions = useChatActions(state, conversationActions);
    return null;
  }

  const renderer = create(<Harness />);
  let sent: boolean | undefined;
  await act(async () => {
    sent = await actions?.sendChatMessage();
  });

  assert.equal(sent, false);
  assert.equal(draft, "draft must survive unavailable provider");
  assert.equal(error, "Claude Code was not detected.");
  renderer.unmount();
});

function staleReadyAgent(kind: AgentHealth["kind"] = "claude-code"): AgentHealth {
  return {
    kind,
    label: kind,
    installed: true,
    detection: "detected",
    runnable: "ready",
    authentication: "ready",
    lastCheckedAt: "2020-01-01T00:00:00.000Z"
  };
}

function readyAgent(kind: AgentHealth["kind"] = "claude-code"): AgentHealth {
  return {
    ...staleReadyAgent(kind),
    lastCheckedAt: new Date().toISOString()
  };
}

function settings(): AppSettings {
  return {
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
    providers: [{ kind: "claude-code", label: "Claude Code", enabled: true }],
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
}
