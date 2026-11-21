import { newChatMemberPermissions } from "../../shared/agentPermissions";
import assert from "node:assert/strict";
import test from "node:test";
import type { SetStateAction } from "react";
import { act, create } from "react-test-renderer";

import type { AgentHealth, AppSettings, ChatParticipantInput } from "../../shared/types";
import { defaultChatAgentPermissions } from "../../shared/agentPermissions";
import type { AppState } from "./app-state";
import { newChatProviderChangedRefusal, useChatActions, type ChatActions } from "./use-chat-actions";
import type { ConversationActions } from "./use-conversation-actions";

test("a saved CLI that is not ready gives way to a ready one; with none ready the chat is not created", async () => {
  let createCalls = 0;
  (globalThis as any).window = {
    consensus: {
      createChatConversation: async () => {
        createCalls += 1;
        throw new Error("stop after create request");
      }
    }
  };
  const currentSettings = settings();
  currentSettings.providers = [
    { kind: "claude-code", label: "Claude Code", enabled: true },
    { kind: "codex-cli", label: "Codex", enabled: true }
  ];
  currentSettings.assistantProviderKind = "claude-code";
  for (const [agents, expected] of [
    [[readyAgent("codex-cli")], "stop after create request"],
    [[], "Set up and sign in to at least one CLI provider to start a chat."],
    [[{ ...readyAgent("codex-cli"), authentication: "required" as const }], "Set up and sign in to at least one CLI provider to start a chat."]
  ] as const) {
    let error: string | undefined;
    let refreshed = false;
    const state = {
      question: "Draft",
      agents,
      settings: currentSettings,
      selectedChatParticipantConfigIds: new Set<string>(),
      selectedChatParticipantRuntimeOverrides: {},
      startingChatRef: { current: false },
      chatCreationRef: { current: undefined },
      chatBeforeActivityRef: { current: undefined }, openConversationRequestRef: { current: 0 }, railViewRef: { current: "chats" },
      repoPath: "",
      setError: (value: string | undefined) => { error = value; },
      setWarnings: () => undefined,
      setCurrentRunId: () => undefined,
      setBusy: () => undefined
    } as unknown as AppState;
    let actions: ChatActions | undefined;
    function Harness(): null {
      actions = useChatActions(state, { refreshAgents: async () => { refreshed = true; return [...agents]; } } as unknown as ConversationActions);
      return null;
    }
    const renderer = create(<Harness />);
    let started: boolean | undefined;
    await act(async () => { started = await actions?.startChat(); });
    assert.equal(started, false);
    assert.equal(error, expected);
    assert.equal(refreshed, agents.length === 0, "a fresh check is used as it is");
    renderer.unmount();
  }
  assert.equal(createCalls, 1, "created only when a CLI is ready");
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
    selectedChatParticipantRuntimeOverrides: {},
    startingChatRef: { current: false },
    chatCreationRef: { current: undefined },
    chatBeforeActivityRef: { current: undefined }, openConversationRequestRef: { current: 0 }, railViewRef: { current: "chats" },
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

test("a new chat is made with its main session first (ordinary member rights, its New Chat settings) and the selected saved members", async () => {
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
  // The classic view's New chat: the members picker adds saved members.
  currentSettings.defaultChatView = "classic";
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
    selectedChatParticipantRuntimeOverrides: {
      "__new-chat-main-session__": {
        model: "main-model",
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
    chatCreationRef: { current: undefined },
    chatBeforeActivityRef: { current: undefined }, openConversationRequestRef: { current: 0 }, railViewRef: { current: "chats" },
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
  const [main, member] = createRequest?.participants ?? [];
  assert.equal(main?.handle, "main");
  assert.equal(main?.roleConfigId, "main-session");
  assert.equal(main?.model, "main-model");
  assert.equal(main?.reasoningEffort, "high");
  assert.equal(main?.participantConfigId, undefined, "no saved member is behind it");
  assert.equal(main?.permissions?.requestParticipants, "allow", "its role's rights, not the Assistant's");
  assert.equal(main?.permissions?.manageRolesParticipants, "allow");
  // An ordinary member's rights for a chat without a project: no repo read.
  assert.equal(main?.permissions?.shell.enabled, newChatMemberPermissions(false).shell.enabled);
  assert.equal(main?.permissions?.repoRead, newChatMemberPermissions(false).repoRead);
  assert.equal(member?.participantConfigId, "member-codex");
  assert.equal(member?.model, "member-model");
  assert.equal(member?.reasoningEffort, "low");
  assert.equal(member?.agentMode, "auto");
  assert.equal(member?.permissions?.workspaceWrite, true);
  // A member still carrying the old cloud-worker flag keeps it: it is what
  // marks the member as one that needs a machine, and nothing rewrites it.
  assert.equal(member?.remoteExecution, "remote");
  assert.equal(member?.skipToolchainPreflight, true);
  assert.equal(member?.autoWatch, true);
  renderer.unmount();
});

for (const scenario of [
  { name: "Claude Code's own sign-in", choice: { kind: "claude-code" as const }, hostId: undefined },
  { name: "an added provider (Z.ai GLM on Claude Code)", choice: { kind: "claude-code" as const, hostId: "zai-host" }, hostId: "zai-host" }
]) {
  test(`in the sessions view a new chat is made with its main session alone, on the provider the chip chose: ${scenario.name}`, async () => {
    let createRequest: { participants: ChatParticipantInput[] } | undefined;
    (globalThis as any).window = {
      consensus: {
        createChatConversation: async (request: { participants: ChatParticipantInput[] }) => {
          createRequest = request;
          throw new Error("stop after create request");
        }
      }
    };
    const currentSettings = settings();
    currentSettings.providers = [
      { kind: "claude-code", label: "Claude Code", enabled: true },
      { kind: "codex-cli", label: "Codex", enabled: true }
    ];
    currentSettings.assistantProviderKind = "codex-cli";
    currentSettings.cliProviderHosts = [{ id: "zai-host", label: "Z.ai GLM", cli: "claude-code", vendor: "zai", baseUrl: "https://api.z.ai/api/anthropic", hasApiKey: true, updatedAt: "2026-11-21T00:00:00.000Z" }];
    currentSettings.chatParticipantConfigs = [{
      id: "member-codex", handle: "codex", roleConfigId: "engineer", behaviorRuleIds: [], kind: "codex-cli",
      agentMode: "default", permissions: defaultChatAgentPermissions(), remoteExecution: "local", skipToolchainPreflight: false,
      autoWatchEnabled: false, updatedAt: "2026-07-13T00:00:00.000Z"
    }];
    let error: string | undefined;
    let providerReset = false;
    const state = {
      question: "@codex please look at the login",
      agents: [readyAgent("claude-code"), readyAgent("codex-cli")],
      settings: currentSettings,
      selectedChatParticipantConfigIds: new Set<string>(["member-codex"]),
      selectedChatParticipantRuntimeOverrides: { "__new-chat-main-session__": { model: "haiku", reasoningEffort: "low" } },
      newChatMainSessionProvider: scenario.choice,
      setNewChatMainSessionProvider: () => { providerReset = true; },
      startingChatRef: { current: false },
      chatCreationRef: { current: undefined },
      chatBeforeActivityRef: { current: undefined }, openConversationRequestRef: { current: 0 }, railViewRef: { current: "chats" },
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
    await act(async () => { await actions?.startChat(); });
    assert.equal(error, "stop after create request");
    assert.equal(createRequest?.participants.length, 1, "only the main session: no saved member chosen or named with @");
    const [main] = createRequest?.participants ?? [];
    assert.equal(main?.roleConfigId, "main-session");
    assert.equal(main?.kind, "claude-code", "the chip's provider, not Settings → General's Codex");
    assert.equal(main?.hostId, scenario.hostId);
    assert.equal(main?.model, "haiku");
    assert.equal(main?.reasoningEffort, "low");
    assert.equal(main?.agentMode, "default");
    assert.equal(main?.permissions?.cliApprovals, true, "Claude Code's own Default mode: it asks before edits, commands and web");
    assert.equal(main?.permissions?.workspaceWrite, false);
    assert.equal(currentSettings.assistantProviderKind, "codex-cli", "the setting is not changed");
    assert.equal(providerReset, false, "kept while the chat was not made");
    renderer.unmount();
  });
}

test("a sessions-view New chat whose chip provider stopped being ready refuses the send and says so, instead of starting on another CLI", async () => {
  let createCalls = 0;
  (globalThis as any).window = { consensus: { createChatConversation: async () => { createCalls += 1; throw new Error("must not be called"); } } };
  const currentSettings = settings();
  currentSettings.providers = [{ kind: "claude-code", label: "Claude Code", enabled: true }, { kind: "codex-cli", label: "Codex", enabled: true }];
  currentSettings.assistantProviderKind = "codex-cli";
  let error: string | undefined;
  let chosen: unknown = { kind: "claude-code" };
  const state = {
    question: "Look at the login",
    agents: [{ ...readyAgent("claude-code"), authentication: "required" }, readyAgent("codex-cli")],
    settings: currentSettings,
    selectedChatParticipantConfigIds: new Set<string>(),
    selectedChatParticipantRuntimeOverrides: { "__new-chat-main-session__": { model: "haiku" } },
    newChatMainSessionProvider: chosen,
    setNewChatMainSessionProvider: (value: unknown) => { chosen = value; },
    startingChatRef: { current: false },
    chatCreationRef: { current: undefined },
    chatBeforeActivityRef: { current: undefined }, openConversationRequestRef: { current: 0 }, railViewRef: { current: "chats" },
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
  await act(async () => { started = await actions?.startChat(); });
  assert.equal(started, false);
  assert.equal(createCalls, 0, "no chat is made on Codex behind the User's back");
  assert.match(error ?? "", /Claude Code is not ready any more\. The chat would start on Codex: check the model chip and send again\./);
  assert.equal(chosen, undefined, "the chip now shows the provider it would take");
  renderer.unmount();
});

test("the refusal rule: only a chosen provider that is gone, or a shown one that gave way", () => {
  const codex = { kind: "codex-cli" as const, label: "Codex" };
  const claude = { kind: "claude-code" as const, label: "Claude Code" };
  assert.equal(newChatProviderChangedRefusal(undefined, codex, codex, [codex]), undefined);
  assert.equal(newChatProviderChangedRefusal({ kind: "claude-code" }, claude, claude, [claude, codex]), undefined);
  assert.match(newChatProviderChangedRefusal(undefined, claude, codex, [codex]) ?? "", /^Claude Code is not ready any more/);
  assert.match(newChatProviderChangedRefusal({ kind: "claude-code", hostId: "zai" }, undefined, codex, [codex]) ?? "", /The chat would start on Codex/);
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
    selectedChatParticipantRuntimeOverrides: {},
    newChatPendingImages: [{ id: "image", filename: "qa.png", mimeType: "image/png", sizeBytes: 3, dataBase64: "YWJj", status: "ready" }],
    newChatRepoFileMentions: [{ path: "src/main.ts" }],
    newChatSkillMentions: [{ frontmatterName: "office-hours" }],
    newChatPluginMentions: [{ name: "fixture-plugin", displayName: "Fixture" }],
    startingChatRef: { current: false },
    chatCreationRef: { current: undefined },
    chatBeforeActivityRef: { current: undefined }, openConversationRequestRef: { current: 0 }, railViewRef: { current: "chats" },
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
    setChatMessageDraftForConversation: (conversationId: string, value: SetStateAction<string>) => {
      assert.equal(conversationId, "conversation-1");
      state.setChatMessageDraft(value);
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
    betaUpdates: false,
    crashReports: true,
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
}
