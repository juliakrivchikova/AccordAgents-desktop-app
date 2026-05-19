import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatService } from "./chat";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import type {
  ChatParticipant,
  ChatParticipantSession,
  ChatRoleConfig,
  Conversation
} from "../../shared/types";

const NOW = "2026-05-19T12:00:00.000Z";

const ROLE: ChatRoleConfig = {
  id: "engineer",
  label: "Engineer",
  instructions: "Answer directly.",
  version: 1,
  appToolCapabilities: [],
  updatedAt: NOW
};

test("validateRepoFileMentions keeps safe repo-relative files and rejects unsafe paths", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "ai-consensus-repo-files-"));
  const repoPath = path.join(tempRoot, "repo");
  const outsidePath = path.join(tempRoot, "outside.txt");
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await writeFile(path.join(repoPath, "src/chat.ts"), "export const value = 1;\n", "utf8");
  await writeFile(outsidePath, "secret\n", "utf8");
  await symlink(outsidePath, path.join(repoPath, "src/outside-link"));

  try {
    const service = testService().service as any;
    const conversation = chatConversation([chatParticipant()], repoPath);
    const warnings: string[] = [];

    const mentions = await service.validateRepoFileMentions(conversation, [
      { path: "src/chat.ts" },
      { path: "../outside.txt" },
      { path: "/tmp/outside.txt" },
      { path: "src" },
      { path: "src/outside-link" }
    ], warnings);

    assert.deepEqual(mentions, [{ path: "src/chat.ts" }]);
    assert.equal(warnings.some((warning) => warning.includes("path is invalid")), true);
    assert.equal(warnings.some((warning) => warning.includes("path is a directory")), true);
    assert.equal(warnings.some((warning) => warning.includes("path escapes repository")), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("validateRepoFileMentions extracts manually typed repo file tokens", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "ai-consensus-repo-file-tokens-"));
  const repoPath = path.join(tempRoot, "repo");
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await mkdir(path.join(repoPath, "docs"), { recursive: true });
  await writeFile(path.join(repoPath, "src/chat.ts"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(repoPath, "docs/readme.md"), "# Docs\n", "utf8");

  try {
    const service = testService().service as any;
    const conversation = chatConversation([chatParticipant()], repoPath);
    const warnings: string[] = [];

    const mentions = await service.validateRepoFileMentions(
      conversation,
      [{ path: "src/chat.ts" }],
      warnings,
      [
        "Inspect #src/chat.ts and #docs/readme.md.",
        "Keep list marker #1 as prose.",
        "```",
        "#src/ignored.ts",
        "```"
      ].join("\n")
    );

    assert.deepEqual(mentions, [{ path: "src/chat.ts" }, { path: "docs/readme.md" }]);
    assert.equal(warnings.length, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("buildPrompt adds repo file guidance based on repoRead permission", () => {
  const participant = chatParticipant({ repoRead: false });
  const conversation = chatConversation([participant], "/repo");
  const triggerMessage = {
    id: "message-1",
    role: "user" as const,
    content: "Please inspect #src/chat.ts",
    createdAt: NOW,
    status: "done" as const,
    metadata: {
      threadId: "message-1",
      repoFileMentions: [{ path: "src/chat.ts" }]
    }
  };
  conversation.messages.push(triggerMessage);
  const service = testService({ canRequestPermissions: true }).service as any;
  const session = chatSession(participant);

  const blockedPrompt = service.buildPrompt(conversation, participant, session, triggerMessage, "/workspace", false, {
    includeRoleInstructions: false,
    agentMode: "default",
    permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), repoRead: false })
  });
  const allowedPrompt = service.buildPrompt(conversation, participant, session, triggerMessage, "/workspace", false, {
    includeRoleInstructions: false,
    agentMode: "default",
    permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions())
  });

  assert.match(blockedPrompt, /Referenced repository files/);
  assert.match(blockedPrompt, /src\/chat\.ts/);
  assert.match(blockedPrompt, /permissions: \["repoRead"\]/);
  assert.match(allowedPrompt, /You may read these with your usual tools/);
});

function testService(options: { canRequestPermissions?: boolean } = {}): { service: ChatService } {
  const storage = {
    async getConversation(): Promise<undefined> {
      return undefined;
    },
    async saveConversation(): Promise<void> {
      return undefined;
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
    }
  };
  const debugLogs = {
    async write(): Promise<void> {
      return undefined;
    }
  };
  const appMcp = options.canRequestPermissions
    ? {
        issueToken: () => ({ url: "http://127.0.0.1:1/mcp", token: "token" })
      }
    : undefined;
  return {
    service: new ChatService(storage as never, settings as never, cliRunner as never, debugLogs as never, appMcp as never)
  };
}

function chatParticipant(permissionPatch: Partial<ReturnType<typeof defaultChatAgentPermissions>> = {}): ChatParticipant {
  return {
    id: "participant-1",
    handle: "drew",
    roleConfigId: ROLE.id,
    kind: "codex-cli",
    agentMode: "default",
    permissions: normalizeChatAgentPermissions({
      ...defaultChatAgentPermissions(),
      ...permissionPatch
    })
  };
}

function chatConversation(participants: ChatParticipant[], repoPath: string): Conversation {
  return {
    id: "conversation-1",
    title: "Test chat",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    repoPath,
    messages: [],
    findings: [],
    metadata: {
      participants,
      participantSessions: []
    }
  };
}

function chatSession(participant: ChatParticipant): ChatParticipantSession {
  return {
    participantId: participant.id,
    sessionId: "",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    roleAppToolCapabilities: ["permissions.request"],
    updatedAt: NOW
  };
}
