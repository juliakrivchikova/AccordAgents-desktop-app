import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChatMessage, ChatParticipant, ChatParticipantSession, ChatRoleConfig, ChatSkillMention, Conversation, ParticipantConfig } from "../../shared/types";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { DEFAULT_CHAT_PROMPT_CONTEXT } from "../../shared/chatPromptContext";
import { ChatService } from "./chat";
import { chatParts } from "./chat/test/chatParts";
import { historyMarkdown } from "./chat/store/historyText";
import { selectedSkillInstructions, skillMentionsPromptSection } from "./chat/turns/promptSections";
import { UserSkillsService } from "./userSkills";

const NOW = "2026-01-01T00:00:00.000Z";
const ROLE: ChatRoleConfig = {
  id: "administrator",
  label: "Administrator",
  instructions: "Answer directly.",
  version: 1,
  updatedAt: NOW
};
const GENERIC_ROLE: ChatRoleConfig = {
  id: "generic-participant",
  label: "Generic participant",
  instructions: "Answer directly.",
  version: 1,
  updatedAt: NOW
};
/** The main session's built-in role, which every install has (settings.ts). */
const MAIN_SESSION_ROLE: ChatRoleConfig = {
  id: "main-session",
  label: "Main session",
  instructions: "Work on User's requests.",
  version: 1,
  participantDefaults: { requestParticipants: "allow", manageRolesParticipants: "allow" },
  updatedAt: NOW
};
const WORKFLOW_MANAGER_ROLE: ChatRoleConfig = {
  id: "workflow-manager",
  label: "Workflow Manager",
  instructions: "Use implementation-workflow for implementation requests.",
  version: 1,
  updatedAt: NOW
};

test("skill-only send stores explicit content and keeps skill metadata path/content safe", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-user-skills-"));
  const homeDir = path.join(tempRoot, "home");
  const skillFolder = path.join(homeDir, ".agents/skills/qa");
  const skillBody = "PRIVATE_SKILL_BODY_SHOULD_NOT_LEAK";
  await writeSkill(skillFolder, "qa", "QA", skillBody);

  try {
    const userSkills = new UserSkillsService({ homeDir });
    const participant = chatParticipant();
    const conversation = chatConversation([participant]);
    const skillSearch = await userSkills.search({
      conversationId: conversation.id,
      query: "qa",
      content: "",
      limit: 10
    }, {
      target: {
        hasClearTargets: true,
        participantIds: [participant.id],
        providerKinds: ["codex-cli"]
      },
      participantProviderKindById: {
        [participant.id]: "codex-cli"
      },
      runRootByParticipant: {
        [participant.id]: undefined
      }
    });
    assert.equal(skillSearch.skills[0].capabilityState, "invocable");

    let capturedPrompt = "";
    const { service, storage } = testService({
      conversation,
      userSkills,
      run: async (runParticipant, prompt) => {
        capturedPrompt = prompt;
        return {
          participant: runParticipant,
          ok: true,
          content: "done",
          durationMs: 1
        };
      }
    });
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

    await service.sendMessage({
      conversationId: conversation.id,
      runId: "skill-only-run",
      content: "",
      skillMentions: [skillSearch.skills[0]]
    });
    await waitFor(() => capturedPrompt !== "");

    const saved = storage.current as Conversation;
    const userMessage = saved.messages.find((message) => message.role === "user");
    assert.equal(userMessage?.content, "Use the selected skill(s).");
    assert.equal(userMessage?.metadata?.skillMentions?.[0]?.frontmatterName, "qa");

    const historyText = historyMarkdown(saved);
    const historyJson = JSON.stringify(saved);
    const toolRead = await service.readChatMessagesForTool({
      conversationId: saved.id,
      participantId: participant.id,
      roleConfigId: participant.roleConfigId,
      roleConfigVersion: ROLE.version,
      capabilities: [],
      snapshotMaxSequence: saved.messages.length - 1
    } as never, {});

    for (const output of [historyText, historyJson, JSON.stringify(toolRead), capturedPrompt]) {
      assert.equal(output.includes(homeDir), false);
      assert.equal(output.includes(skillFolder), false);
      assert.equal(output.includes(skillBody), false);
    }
    assert.match(capturedPrompt, /skill name: qa/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runtime skill dispatch leaves a disappeared selected variant to the native provider", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-user-skills-"));
  const homeDir = path.join(tempRoot, "home");
  await writeSkill(path.join(homeDir, ".claude/skills/qa"), "qa", "QA", "claude body");

  try {
    const userSkills = new UserSkillsService({ homeDir });
    const claude = chatParticipant({ id: "claude-participant", handle: "claude", kind: "claude-code" });
    const conversation = chatConversation([claude]);
    const selected = await userSkills.search({
      conversationId: conversation.id,
      query: "qa",
      content: "@claude",
      limit: 10
    }, {
      target: {
        hasClearTargets: true,
        participantIds: [claude.id],
        providerKinds: ["claude-code"]
      },
      participantProviderKindById: {
        [claude.id]: "claude-code"
      },
      runRootByParticipant: {
        [claude.id]: undefined
      }
    });
    assert.equal(selected.skills[0].capabilityState, "invocable");

    // Delete the Claude variant after selection: AccordAgents still dispatches the inline
    // token and lets the native provider decide current availability.
    await rm(path.join(homeDir, ".claude/skills/qa"), { recursive: true, force: true });
    const runParticipants: string[] = [];
    const { service, storage } = testService({
      conversation,
      userSkills,
      run: async (runParticipant) => {
        runParticipants.push(runParticipant.kind);
        return {
          participant: runParticipant,
          ok: true,
          content: "done",
          durationMs: 1
        };
      }
    });
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

    await service.sendMessage({
      conversationId: conversation.id,
      runId: "native-skill-run",
      content: "@claude",
      skillMentions: [selected.skills[0]]
    });

    await waitFor(() => runParticipants.length === 1);
    assert.deepEqual(runParticipants, ["claude-code"]);
    assert.equal((storage.current as Conversation).messages.some((message) =>
      message.role === "system" && message.content.includes("@claude was not run")
    ), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("inline selected skill text is preserved in storage and prompt", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-user-skills-"));
  const homeDir = path.join(tempRoot, "home");
  const skillFolder = path.join(homeDir, ".agents/skills/qa");
  await writeSkill(skillFolder, "qa", "QA", "codex body");

  try {
    const userSkills = new UserSkillsService({ homeDir });
    const participant = chatParticipant();
    const conversation = chatConversation([participant]);
    const skillSearch = await userSkills.search({
      conversationId: conversation.id,
      query: "qa",
      content: "@admin /qa please",
      limit: 10
    }, {
      target: {
        hasClearTargets: true,
        participantIds: [participant.id],
        providerKinds: ["codex-cli"]
      },
      participantProviderKindById: {
        [participant.id]: "codex-cli"
      },
      runRootByParticipant: {
        [participant.id]: undefined
      }
    });
    assert.equal(skillSearch.skills[0].capabilityState, "invocable");

    let capturedPrompt = "";
    const { service, storage } = testService({
      conversation,
      userSkills,
      run: async (runParticipant, prompt) => {
        capturedPrompt = prompt;
        return {
          participant: runParticipant,
          ok: true,
          content: "done",
          durationMs: 1
        };
      }
    });
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

    await service.sendMessage({
      conversationId: conversation.id,
      runId: "inline-skill-run",
      content: "@admin /qa please",
      skillMentions: [skillSearch.skills[0]]
    });
    await waitFor(() => capturedPrompt !== "");

    const saved = storage.current as Conversation;
    const userMessage = saved.messages.find((message) => message.role === "user");
    assert.equal(userMessage?.content, "@admin /qa please");
    // Her words as typed, the inline `/qa` kept where she wrote it, then the selected skill.
    assert.match(capturedPrompt, /\n\n@admin \/qa please\n\n<<<APP ([0-9a-f]{8})>>>\nSelected skill: \/qa \(skill name: qa; [^\n]*\n<<<END APP \1>>>$/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Workflow Manager implementation requests do not auto-select implementation-workflow", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-user-skills-"));
  const repoPath = path.join(tempRoot, "repo");
  await mkdir(repoPath, { recursive: true });
  await writeSkill(
    path.join(repoPath, ".agents", "skills", "implementation-workflow"),
    "implementation-workflow",
    "Coordinate implementation workflow",
    "Confirm requirements, choose the final step, then ask Drew and Taylor for independent plans."
  );

  try {
    const userSkills = new UserSkillsService({ homeDir: path.join(tempRoot, "home") });
    const manager = chatParticipant({
      id: "workflow-manager-participant",
      handle: "nikita",
      roleConfigId: WORKFLOW_MANAGER_ROLE.id,
      permissions: normalizeChatAgentPermissions({
        ...defaultChatAgentPermissions(),
        repoRead: true
      })
    });
    const conversation = chatConversation([manager]);
    conversation.repoPath = repoPath;

    const { service, storage } = testService({
      conversation,
      roles: [ROLE, GENERIC_ROLE, WORKFLOW_MANAGER_ROLE],
      userSkills,
      run: async (runParticipant) => {
        return {
          participant: runParticipant,
          ok: true,
          content: "Skill paused at required user gate: Confirm scope.",
          durationMs: 1
        };
      }
    });
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

    await service.sendMessage({
      conversationId: conversation.id,
      runId: "workflow-manager-skill-run",
      content: "@nikita we need to exclude assistant from accord modal window and polish accord modal design."
    });

    const saved = storage.current as Conversation;
    const userMessage = saved.messages.find((message) => message.role === "user");
    assert.equal(userMessage?.metadata?.skillMentions, undefined);
    assert.equal(saved.messages.some((message) =>
      message.role === "system" &&
      message.content.includes("@nikita was not run")
    ), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("prospective skill context defaults to the main session instead of all participants", async () => {
  const { service } = testService({
    conversation: chatConversation([chatParticipant()]),
    userSkills: new UserSkillsService(),
    run: async (participant) => ({ participant, ok: true, content: "done", durationMs: 1 })
  });

  const context = await service.prospectiveUserSkillRunContext({
    repoPath: "/tmp/repo",
    participants: [{
      handle: "worker",
      roleConfigId: GENERIC_ROLE.id,
      kind: "claude-code",
      agentMode: "default",
      permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions())
    }],
    content: "/qa"
  });

  assert.equal(context.target.hasClearTargets, true);
  assert.deepEqual(context.target.providerKinds, ["codex-cli"]);
  assert.equal(context.target.participantIds.length, 1);
  assert.equal(context.participantProviderKindById?.[context.target.participantIds[0]], "codex-cli");
});

test("prospective skill context honors explicit mentioned participant", async () => {
  const { service } = testService({
    conversation: chatConversation([chatParticipant()]),
    userSkills: new UserSkillsService(),
    run: async (participant) => ({ participant, ok: true, content: "done", durationMs: 1 })
  });

  const context = await service.prospectiveUserSkillRunContext({
    repoPath: "/tmp/repo",
    participants: [{
      handle: "worker",
      roleConfigId: GENERIC_ROLE.id,
      kind: "claude-code",
      agentMode: "default",
      permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions())
    }],
    content: "@worker /qa"
  });

  assert.equal(context.target.hasClearTargets, true);
  assert.deepEqual(context.target.providerKinds, ["claude-code"]);
  assert.equal(context.target.participantIds.length, 1);
  assert.equal(context.participantProviderKindById?.[context.target.participantIds[0]], "claude-code");
});

test("selected skill hashes do not change provider runtime configuration", () => {
  const { service } = testService({
    conversation: chatConversation([chatParticipant()]),
    userSkills: new UserSkillsService(),
    run: async (participant) => ({ participant, ok: true, content: "done", durationMs: 1 })
  });
  const baseMessage = {
    id: "user-message",
    role: "user",
    content: "Use the selected skill(s).",
    createdAt: NOW,
    status: "done",
    metadata: {
      skillMentions: [{
        skillId: "skill-1",
        displayName: "/qa",
        frontmatterName: "qa",
        contentHash: "hash-a",
        capabilityState: "invocable",
        variants: [{
          providerKind: "codex-cli",
          scope: "personal",
          rootKind: "personal",
          sourceKey: "source",
          frontmatterName: "qa",
          contentHash: "hash-a",
          capabilityState: "invocable"
        }]
      }]
    }
  };
  const changedMessage = clone(baseMessage);
  changedMessage.metadata.skillMentions[0].contentHash = "hash-b";
  changedMessage.metadata.skillMentions[0].variants[0].contentHash = "hash-b";

  assert.equal((service as any).skillRuntimeKey, undefined);
  assert.equal(
    skillMentionsPromptSection(baseMessage as never, "codex-cli"),
    skillMentionsPromptSection(changedMessage as never, "codex-cli")
  );
});

test("skill prompt tells Codex to use inline slash invocation and direct selected-skill reads", () => {
  const { service } = testService({
    conversation: chatConversation([chatParticipant()]),
    userSkills: new UserSkillsService(),
    run: async (participant) => ({ participant, ok: true, content: "done", durationMs: 1 })
  });
  const message = {
    id: "user-message",
    role: "user",
    content: "@codex /qa",
    createdAt: NOW,
    status: "done",
    metadata: {
      skillMentions: [{
        skillId: "skill-1",
        displayName: "/qa",
        frontmatterName: "qa",
        contentHash: "hash-a",
        capabilityState: "invocable",
        variants: [{
          providerKind: "codex-cli",
          scope: "personal",
          rootKind: "personal",
          sourceKey: "source",
          frontmatterName: "qa",
          contentHash: "hash-a",
          capabilityState: "invocable"
        }]
      }]
    }
  };

  // The message names the skill; how a selected skill runs is said once, in
  // the session's instructions.
  const promptSection = skillMentionsPromptSection(message as never, "codex-cli") as string;
  assert.equal(promptSection, "Selected skill: /qa (skill name: qa; codex-cli personal)");
  const instructions = selectedSkillInstructions({ participantKind: "codex-cli" } as never).join("\n");
  assert.match(instructions, /makes that skill a mandatory workflow for the turn, not advisory context/);
  assert.match(instructions, /overrides role brevity or style preferences/);
  assert.match(instructions, /Read the skill file fully, run its workflow from its first step, and do not answer from general expertise instead/);
  assert.match(instructions, /The `\/skill-name` in her message is the skill's invocation/);
  assert.match(instructions, /If a selected skill uses AskUserQuestion, ask with a `User choice:` block instead/);
  assert.match(instructions, /Use `Skill blocked` only when there is no way to continue/);
  assert.match(instructions, /`Skill complete: <what was produced>`/);
  assert.match(instructions, /`Skill paused at required user gate: <what user must answer>`/);
  assert.match(instructions, /`Skill blocked: <exact missing file\/tool\/context>`/);
  assert.match(instructions, /~\/\.codex\/skills/);
  assert.match(instructions, /~\/\.agents\/skills/);
  assert.match(instructions, /do not call `app_permissions_request_change` just to read them/);
  assert.doesNotMatch(selectedSkillInstructions({ participantKind: "claude-code" } as never).join("\n"), /~\/\.codex\/skills/);
});

test("a skill message is User's text and its selected skill, with no request line; a plain one is her text alone", () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant]);
  const { service } = testService({
    conversation,
    userSkills: new UserSkillsService(),
    run: async (runParticipant) => ({ participant: runParticipant, ok: true, content: "done", durationMs: 1 })
  });
  const session = chatSession(participant);
  const options = {
    includeRoleInstructions: false,
    agentMode: "default",
    permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions())
  };
  const skillMessage = chatMessage({
    content: "@admin /qa",
    metadata: {
      skillMentions: [skillMention()]
    }
  });
  const normalMessage = chatMessage({ content: "@admin hello" });
  const build = (message: ChatMessage, continuation: boolean) => chatParts(service).turnPrompt.buildPromptParts(
    conversation,
    participant,
    session,
    message,
    "/tmp/accordagents-history",
    continuation,
    options
  ).prompt as string;

  const skillPrompt = build(skillMessage, false);
  assert.match(skillPrompt, /^@admin \/qa\n\n<<<APP ([0-9a-f]{8})>>>\nSelected skill: [^\n]*\n<<<END APP \1>>>$/, "her words outside, the app's note in its block");
  assert.doesNotMatch(skillPrompt, /Current request/);
  assert.equal(build(normalMessage, false), "@admin hello");
  assert.doesNotMatch(build(skillMessage, true), /Current request/);
});

test("selected skill replies missing final status only write a debug log", () => {
  const debugEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const participant = chatParticipant();
  const { service } = testService({
    conversation: chatConversation([participant]),
    userSkills: new UserSkillsService(),
    run: async (runParticipant) => ({ participant: runParticipant, ok: true, content: "done", durationMs: 1 }),
    debugWrite: async (event, payload) => {
      debugEvents.push({ event, payload });
    }
  });
  const triggerMessage = chatMessage({
    metadata: {
      skillMentions: [skillMention()]
    }
  });
  const pendingMessage = chatMessage({
    id: "participant-message",
    role: "participant",
    content: "done without required marker"
  });

  assert.doesNotThrow(() => {
    chatParts(service).pendingReplies.logMissingSelectedSkillStatus(triggerMessage, participant, pendingMessage, "run-1");
  });
  assert.equal(debugEvents.length, 1);
  assert.equal(debugEvents[0].event, "chat.skill.status_missing");
  assert.equal(debugEvents[0].payload.runId, "run-1");

  pendingMessage.content = "Skill complete: implemented";
  chatParts(service).pendingReplies.logMissingSelectedSkillStatus(triggerMessage, participant, pendingMessage, "run-2");
  assert.equal(debugEvents.length, 1);
});

test("chat:send returns after ingest without awaiting the participant batch", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-async-"));
  try {
    let runStarted = false;
    let runCompleted = false;
    let releaseRun: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const conversation = chatConversation([chatParticipant()]);
    const { service } = testService({
      conversation,
      userSkills: new UserSkillsService(),
      run: async (participant) => {
        runStarted = true;
        await runGate;
        runCompleted = true;
        return { participant, ok: true, content: "done", durationMs: 1 };
      }
    });
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

    const result = await service.sendMessage({
      conversationId: conversation.id,
      runId: "async-run",
      content: "@admin hello"
    });

    // sendMessage must resolve while the gated participant run is still in flight.
    await waitFor(() => runStarted);
    assert.equal(runCompleted, false);
    assert.ok(result.conversation);

    releaseRun?.();
    await waitFor(() => runCompleted);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("chat:send does not reject when a single participant run fails", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-async-"));
  try {
    const conversation = chatConversation([chatParticipant()]);
    const { service } = testService({
      conversation,
      userSkills: new UserSkillsService(),
      run: async () => {
        throw new Error("participant boom");
      }
    });
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

    const result = await service.sendMessage({
      conversationId: conversation.id,
      runId: "failing-run",
      content: "@admin hello"
    });

    // The background failure surfaces via progress/snapshots, not by rejecting the IPC call.
    assert.ok(result.conversation);
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

function testService(options: {
  conversation: Conversation;
  userSkills: UserSkillsService;
  roles?: ChatRoleConfig[];
  run: (participant: ParticipantConfig, prompt: string) => Promise<any>;
  debugWrite?: (event: string, payload: Record<string, unknown>) => Promise<void>;
}): { service: ChatService; storage: any } {
  const storage = {
    current: clone(options.conversation),
    async getConversation(id: string): Promise<Conversation | undefined> {
      return this.current?.id === id ? clone(this.current) : undefined;
    },
    async saveConversation(conversation: Conversation): Promise<void> {
      this.current = clone(conversation);
    }
  };
  const settings = {
    async getPublicSettings(): Promise<{
      chatRoleConfigs: ChatRoleConfig[];
      chatBehaviorRules: [];
      providers: Array<{ kind: string; enabled: boolean }>;
      chatPromptContext: typeof DEFAULT_CHAT_PROMPT_CONTEXT;
    }> {
      return {
        chatRoleConfigs: options.roles ?? [ROLE, GENERIC_ROLE, MAIN_SESSION_ROLE],
        chatBehaviorRules: [],
        providers: [
          { kind: "codex-cli", enabled: true },
          { kind: "claude-code", enabled: true }
        ],
        chatPromptContext: DEFAULT_CHAT_PROMPT_CONTEXT
      };
    },
    async ensureAssistantProviderDefault(): Promise<{
      chatRoleConfigs: ChatRoleConfig[];
      chatBehaviorRules: [];
      providers: Array<{ kind: string; enabled: boolean }>;
      chatPromptContext: typeof DEFAULT_CHAT_PROMPT_CONTEXT;
      assistantProviderKind: "codex-cli";
    }> {
      return {
        chatRoleConfigs: options.roles ?? [ROLE, GENERIC_ROLE, MAIN_SESSION_ROLE],
        chatBehaviorRules: [],
        providers: [
          { kind: "codex-cli", enabled: true },
          { kind: "claude-code", enabled: true }
        ],
        chatPromptContext: DEFAULT_CHAT_PROMPT_CONTEXT,
        assistantProviderKind: "codex-cli"
      };
    }
  };
  const cliRunner = {
    async detectAgents(): Promise<Array<{ kind: string; label: string; installed: boolean }>> {
      return [
        { kind: "codex-cli", label: "Codex CLI", installed: true },
        { kind: "claude-code", label: "Claude Code", installed: true }
      ];
    },
    run: options.run
  };
  const debugLogs = {
    async write(event: string, payload: Record<string, unknown>): Promise<void> {
      if (options.debugWrite) {
        await options.debugWrite(event, payload);
        return;
      }
      return undefined;
    }
  };
  return {
    service: new ChatService(storage as never, settings as never, cliRunner as never, debugLogs as never, undefined, undefined, options.userSkills),
    storage
  };
}

function chatSession(participant: ChatParticipant): ChatParticipantSession {
  return {
    participantId: participant.id,
    sessionId: "",
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: ROLE.version,
    roleRuntime: "prompt-fallback",
    participantKind: participant.kind,
    participantAgentMode: participant.agentMode,
    participantPermissions: participant.permissions,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    updatedAt: NOW
  };
}

function chatMessage(patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: patch.id ?? "user-message",
    role: patch.role ?? "user",
    content: patch.content ?? "@admin /qa",
    createdAt: patch.createdAt ?? NOW,
    status: patch.status ?? "done",
    metadata: patch.metadata,
    ...patch
  };
}

function skillMention(): ChatSkillMention {
  return {
    skillId: "skill-1",
    displayName: "/qa",
    frontmatterName: "qa",
    contentHash: "hash-a",
    capabilityState: "invocable",
    variants: [{
      providerKind: "codex-cli",
      scope: "personal",
      rootKind: "personal",
      sourceKey: "source",
      frontmatterName: "qa",
      contentHash: "hash-a",
      capabilityState: "invocable"
    }]
  };
}

function chatParticipant(patch: Partial<ChatParticipant> = {}): ChatParticipant {
  return {
    id: patch.id ?? "codex-admin",
    handle: patch.handle ?? "admin",
    roleConfigId: ROLE.id,
    kind: patch.kind ?? "codex-cli",
    agentMode: "default",
    permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions()),
    ...patch
  };
}

function chatConversation(participants: ChatParticipant[]): Conversation {
  return {
    id: "chat-user-skills",
    title: "Test chat",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    messages: [],
    findings: [],
    metadata: {
      participants,
      participantSessions: []
    }
  };
}

async function writeSkill(folder: string, name: string, description: string, body: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    body,
    ""
  ].join("\n"), "utf8");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
