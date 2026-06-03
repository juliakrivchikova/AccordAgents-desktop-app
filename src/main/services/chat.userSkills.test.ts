import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChatParticipant, ChatRoleConfig, Conversation, ParticipantConfig } from "../../shared/types";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { ChatService } from "./chat";
import { UserSkillsService } from "./userSkills";

const NOW = "2026-01-01T00:00:00.000Z";
const ROLE: ChatRoleConfig = {
  id: "administrator",
  label: "Administrator",
  instructions: "Answer directly.",
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
    (service as any).ensureHistoryFiles = async () => tempRoot;

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

    const historyMarkdown = (service as any).historyMarkdown(saved) as string;
    const historyJson = JSON.stringify(saved);
    const toolRead = await service.readChatMessagesForTool({
      conversationId: saved.id,
      participantId: participant.id,
      roleConfigId: participant.roleConfigId,
      roleConfigVersion: ROLE.version,
      capabilities: [],
      snapshotMaxSequence: saved.messages.length - 1
    } as never, {});

    for (const output of [historyMarkdown, historyJson, JSON.stringify(toolRead), capturedPrompt]) {
      assert.equal(output.includes(homeDir), false);
      assert.equal(output.includes(skillFolder), false);
      assert.equal(output.includes(skillBody), false);
    }
    assert.match(capturedPrompt, /skill name: qa/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runtime skill revalidation blocks only affected participants", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-user-skills-"));
  const homeDir = path.join(tempRoot, "home");
  await writeSkill(path.join(homeDir, ".agents/skills/qa"), "qa", "QA", "codex body");
  await writeSkill(path.join(homeDir, ".claude/skills/qa"), "qa", "QA", "claude body");

  try {
    const userSkills = new UserSkillsService({ homeDir });
    const codex = chatParticipant({ id: "codex-participant", handle: "codex", kind: "codex-cli" });
    const claude = chatParticipant({ id: "claude-participant", handle: "claude", kind: "claude-code" });
    const conversation = chatConversation([codex, claude]);
    const selected = await userSkills.search({
      conversationId: conversation.id,
      query: "qa",
      content: "@codex @claude",
      limit: 10
    }, {
      target: {
        hasClearTargets: true,
        participantIds: [codex.id, claude.id],
        providerKinds: ["claude-code", "codex-cli"]
      },
      participantProviderKindById: {
        [codex.id]: "codex-cli",
        [claude.id]: "claude-code"
      },
      runRootByParticipant: {
        [codex.id]: undefined,
        [claude.id]: undefined
      }
    });
    assert.equal(selected.skills[0].capabilityState, "invocable");

    // Delete the Claude variant after selection: revalidation should block only the Claude run
    // (its source no longer exists) while the Codex sibling proceeds.
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
    (service as any).ensureHistoryFiles = async () => tempRoot;

    await service.sendMessage({
      conversationId: conversation.id,
      runId: "partial-skill-run",
      content: "@codex @claude",
      skillMentions: [selected.skills[0]]
    });
    await waitFor(() => runParticipants.length >= 1);

    assert.deepEqual(runParticipants, ["codex-cli"]);
    assert.equal((storage.current as Conversation).messages.some((message) =>
      message.role === "system" &&
      message.content.includes("@claude was not run") &&
      message.content.includes("no longer available")
    ), true);
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
    (service as any).ensureHistoryFiles = async () => tempRoot;

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
    assert.match(capturedPrompt, /@admin \/qa please/);
    assert.match(capturedPrompt, /inline `\/skill-name` text as the native skill invocation/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("selected skill hashes affect the warm runtime key", () => {
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

  assert.notEqual(
    (service as any).skillRuntimeKey(baseMessage, "codex-cli"),
    (service as any).skillRuntimeKey(changedMessage, "codex-cli")
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

  const promptSection = (service as any).skillMentionsPromptSection(message, "codex-cli") as string;
  assert.match(promptSection, /inline `\/skill-name` text as the native skill invocation/);
  assert.match(promptSection, /~\/\.codex\/skills/);
  assert.match(promptSection, /~\/\.agents\/skills/);
  assert.match(promptSection, /do not call `app_permissions_request_change` just to read selected skill files/);
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
    (service as any).ensureHistoryFiles = async () => tempRoot;

    const result = await service.sendMessage({
      conversationId: conversation.id,
      runId: "async-run",
      content: "@admin hello"
    });

    // sendMessage must resolve while the gated participant run is still in flight.
    assert.equal(runCompleted, false);
    assert.ok(result.conversation);

    releaseRun?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(runStarted, true);
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
    (service as any).ensureHistoryFiles = async () => tempRoot;

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

test("shellRulesAreSelectedSkillReads allows read-only skill-dir reads and rejects everything else", async () => {
  const { service } = testService({
    conversation: chatConversation([chatParticipant()]),
    userSkills: new UserSkillsService(),
    run: async (participant) => ({ participant, ok: true, content: "done", durationMs: 1 })
  });
  const skillRoot = await mkdtemp(path.join(tmpdir(), "accord-skill-read-"));
  const dir = path.join(skillRoot, "proof");
  const check = (rules: Array<{ action: string; match: string; pattern: string }>, dirs: string[] = [dir]) =>
    (service as any).shellRulesAreSelectedSkillReads(rules, dirs) as Promise<boolean>;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), "marker\n", "utf8");

    // Allowed: simple read-only commands scoped to the selected skill directory.
    assert.equal(await check([{ action: "allow", match: "exact", pattern: `cat ${dir}/SKILL.md` }]), true);
    assert.equal(await check([{ action: "allow", match: "exact", pattern: `sed -n 1,40p ${dir}/SKILL.md` }]), true);
    assert.equal(await check([{ action: "allow", match: "exact", pattern: `sed -n '1,40p' ${dir}/SKILL.md` }]), true);
    assert.equal(await check([{ action: "allow", match: "exact", pattern: `head -n 20 ${dir}/SKILL.md` }]), true);
    assert.equal(await check([{ action: "allow", match: "exact", pattern: `grep -n marker ${dir}/SKILL.md` }]), true);
    assert.equal(await check([{ action: "allow", match: "exact", pattern: `rg --fixed-strings marker ${dir}` }]), true);

    // Rejected: outside the skill dir, mutation, chaining/redirection, in-place edit, deny, empty.
    assert.equal(await check([{ action: "allow", match: "exact", pattern: "cat /etc/passwd" }]), false);
    assert.equal(await check([{ action: "allow", match: "exact", pattern: `rm ${dir}/SKILL.md` }]), false);
    assert.equal(await check([{ action: "allow", match: "exact", pattern: `cat ${dir}/SKILL.md && rm -rf /` }]), false);
    assert.equal(await check([{ action: "allow", match: "exact", pattern: `sed -i s/a/b/ ${dir}/SKILL.md` }]), false);
    assert.equal(await check([{ action: "allow", match: "exact", pattern: `sed -n e whoami ${dir}/SKILL.md` }]), false);
    assert.equal(await check([{ action: "allow", match: "exact", pattern: `rg --pre sh marker ${dir}` }]), false);
    assert.equal(await check([{ action: "allow", match: "prefix", pattern: `cat ${dir}/SKILL.md` }]), false);
    assert.equal(await check([{ action: "ask", match: "exact", pattern: `cat ${dir}/SKILL.md` }]), false);
    assert.equal(await check([{ action: "deny", match: "exact", pattern: `cat ${dir}/SKILL.md` }]), false);
    assert.equal(await check([]), false);
  } finally {
    await rm(skillRoot, { recursive: true, force: true });
  }

  // Codex commonly spells global skill reads with ~. The matcher expands home-relative paths for
  // validation but still requires the resolved target to stay inside the selected skill dir.
  const oldHome = process.env.HOME;
  const homeRoot = await mkdtemp(path.join(tmpdir(), "accord-skill-home-"));
  try {
    process.env.HOME = homeRoot;
    const skillDir = path.join(homeRoot, ".codex/skills/proof");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), "x", "utf8");
    await writeFile(path.join(homeRoot, ".codex/config.json"), "{}", "utf8");
    const realDir = await realpath(skillDir);
    assert.equal(await check([{ action: "allow", match: "exact", pattern: "sed -n 1,40p ~/.codex/skills/proof/SKILL.md" }], [realDir]), true);
    assert.equal(await check([{ action: "allow", match: "exact", pattern: "cat ~/.codex/config.json" }], [realDir]), false);
  } finally {
    if (oldHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = oldHome;
    }
    await rm(homeRoot, { recursive: true, force: true });
  }

  // Symlinked global skill: selected dir is the realpath target, but the agent reads via the
  // symlink path. The matcher must recognize it by resolving the command path's realpath.
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accord-skill-symlink-"));
  try {
    const target = path.join(tempRoot, "real-skill");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "x", "utf8");
    const linkRoot = path.join(tempRoot, "codex-skills");
    await mkdir(linkRoot, { recursive: true });
    const link = path.join(linkRoot, "proof");
    await symlink(target, link);
    const realDir = await realpath(target);
    assert.equal(await check([{ action: "allow", match: "exact", pattern: `cat ${link}/SKILL.md` }], [realDir]), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

function testService(options: {
  conversation: Conversation;
  userSkills: UserSkillsService;
  run: (participant: ParticipantConfig, prompt: string) => Promise<any>;
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
    async getPublicSettings(): Promise<{ chatRoleConfigs: ChatRoleConfig[] }> {
      return { chatRoleConfigs: [ROLE] };
    }
  };
  const cliRunner = {
    async detectAgents(): Promise<[]> {
      return [];
    },
    run: options.run
  };
  const debugLogs = {
    async write(): Promise<void> {
      return undefined;
    }
  };
  return {
    service: new ChatService(storage as never, settings as never, cliRunner as never, debugLogs as never, undefined, undefined, options.userSkills),
    storage
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
