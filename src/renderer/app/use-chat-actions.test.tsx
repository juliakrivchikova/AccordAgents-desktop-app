import assert from "node:assert/strict";
import test from "node:test";
import type { SetStateAction } from "react";
import { act, create } from "react-test-renderer";

import type { AgentHealth, AppSettings, ChatParticipantInput } from "../../shared/types";
import { defaultChatAgentPermissions } from "../../shared/agentPermissions";
import type { AppState } from "./app-state";
import { useChatActions, type ChatActions } from "./use-chat-actions";
import type { ConversationActions } from "./use-conversation-actions";

test("unavailable saved Assistant provider reports a visible Settings error without creating", async () => {
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
  currentSettings.assistantProviderKind = "claude-code";
  const state = {
    question: "Draft",
    agents: [readyAgent("codex-cli")],
    settings: currentSettings,
    selectedChatParticipantRuntimeOverrides: {},
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
  assert.equal(error, "Claude Code is not ready. Change the Assistant provider in General Settings.");
  renderer.unmount();
});

test("stale readiness refreshes before creating without a per-chat provider override", async () => {
  let createRequest: { assistantProviderKind?: string } | undefined;
  (globalThis as any).window = {
    consensus: {
      createChatConversation: async (request: { assistantProviderKind?: string }) => {
        createRequest = request;
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
    selectedChatParticipantConfigIds: new Set<string>(),
    selectedChatParticipantRunLocations: {},
    selectedChatParticipantRuntimeOverrides: {},
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
  assert.equal(createRequest?.assistantProviderKind, undefined);
  assert.equal(error, "stop after provider selection");
  renderer.unmount();
});

test("New Chat runtime overrides are sent for edited Assistant and selected saved members", async () => {
  let createRequest: { participants: ChatParticipantInput[]; skipDefaultParticipants?: boolean } | undefined;
  (globalThis as any).window = {
    consensus: {
      createChatConversation: async (request: { participants: ChatParticipantInput[]; skipDefaultParticipants?: boolean }) => {
        createRequest = request;
        throw new Error("stop after create request");
      }
    }
  };
  let error: string | undefined;
  const currentSettings = settings();
  currentSettings.providers = [{ kind: "codex-cli", label: "Codex", enabled: true }];
  currentSettings.assistantProviderKind = "codex-cli";
  currentSettings.chatRoleConfigs = [
    ...currentSettings.chatRoleConfigs,
    {
      id: "engineer",
      label: "Engineer",
      instructions: "Implement changes.",
      version: 1,
      appToolCapabilities: [],
      builtIn: false,
      updatedAt: "2026-07-13T00:00:00.000Z"
    }
  ];
  currentSettings.chatParticipantConfigs = [{
    id: "member-codex",
    handle: "codex",
    roleConfigId: "engineer",
    behaviorRuleIds: [],
    kind: "codex-cli",
    model: "saved-model",
    reasoningEffort: "medium",
    agentMode: "plan",
    permissions: defaultChatAgentPermissions(),
    remoteExecution: "local",
    skipToolchainPreflight: false,
    autoWatchEnabled: false,
    updatedAt: "2026-07-13T00:00:00.000Z"
  }];
  const memberPermissions = {
    ...defaultChatAgentPermissions(),
    repoRead: true,
    workspaceWrite: true
  };
  const state = {
    question: "Draft",
    agents: [readyAgent("codex-cli")],
    settings: currentSettings,
    selectedChatParticipantConfigIds: new Set<string>(["member-codex"]),
    selectedChatParticipantRunLocations: {},
    selectedChatParticipantRuntimeOverrides: {
      "__new-chat-assistant__": {
        model: "assistant-model",
        reasoningEffort: "high"
      },
      "member-codex": {
        model: "member-model",
        reasoningEffort: "low",
        agentMode: "auto",
        permissions: memberPermissions,
        remoteExecution: "remote",
        skipToolchainPreflight: true,
        autoWatch: true
      }
    },
    startingChatRef: { current: false },
    repoPath: "",
    setError: (value: string | undefined) => { error = value; },
    setWarnings: () => undefined,
    setCurrentRunId: () => undefined,
    setBusy: () => undefined
  } as unknown as AppState;
  let actions: ChatActions | undefined;

  function Harness(): null {
    actions = useChatActions(state, {} as ConversationActions);
    return null;
  }

  const renderer = create(<Harness />);
  let started: boolean | undefined;
  await act(async () => {
    started = await actions?.startChat();
  });

  assert.equal(started, false);
  assert.equal(error, "stop after create request");
  assert.equal(createRequest?.skipDefaultParticipants, false);
  assert.equal(createRequest?.participants.length, 2);
  const [assistant, member] = createRequest?.participants ?? [];
  assert.equal(assistant?.handle, "assistant");
  assert.equal(assistant?.roleConfigId, "administrator");
  assert.equal(assistant?.model, "assistant-model");
  assert.equal(assistant?.reasoningEffort, "high");
  assert.equal(member?.participantConfigId, "member-codex");
  assert.equal(member?.model, "member-model");
  assert.equal(member?.reasoningEffort, "low");
  assert.equal(member?.agentMode, "auto");
  assert.equal(member?.permissions?.workspaceWrite, true);
  assert.equal(member?.remoteExecution, "remote");
  assert.equal(member?.skipToolchainPreflight, true);
  assert.equal(member?.autoWatch, true);
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
    settings: { ...settings(), assistantProviderKind: "claude-code" },
    selectedChatParticipantConfigIds: new Set<string>(),
    selectedChatParticipantRunLocations: {},
    selectedChatParticipantRuntimeOverrides: {},
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

test("existing chat send clears immediately and restores the composer draft on failure", async () => {
  let rejectSend: ((reason: Error) => void) | undefined;
  (globalThis as any).window = {
    consensus: {
      sendChatMessage: () => new Promise((_, reject) => {
        rejectSend = reject;
      })
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
    setChatMessageDraft: (value: SetStateAction<string>) => {
      draft = typeof value === "function" ? value(draft) : value;
      state.chatMessageDraft = draft;
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
  let sendPromise: Promise<boolean> | undefined;
  let sent: boolean | undefined;
  act(() => {
    sendPromise = actions?.sendChatMessage();
  });

  assert.equal(draft, "", "the sent draft should clear before the send IPC resolves");

  rejectSend?.(new Error("Claude Code was not detected."));
  await act(async () => {
    sent = await sendPromise;
  });

  assert.equal(sent, false);
  assert.equal(draft, "draft must survive unavailable provider");
  assert.equal(error, "Claude Code was not detected.");

  draft = "second draft";
  state.chatMessageDraft = draft;
  act(() => {
    sendPromise = actions?.sendChatMessage();
  });
  state.setChatMessageDraft("new text typed while sending");
  rejectSend?.(new Error("Claude Code was not detected."));
  await act(async () => {
    sent = await sendPromise;
  });

  assert.equal(sent, false);
  assert.equal(draft, "new text typed while sending", "a failed send must not overwrite a newer draft");
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
