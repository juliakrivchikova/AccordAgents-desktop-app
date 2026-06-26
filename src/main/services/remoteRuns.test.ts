import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import type {
  AppSettings,
  ChatAppToolApproval,
  ChatParticipant,
  ChatRoleConfig,
  Conversation,
  ParticipantConfig
} from "../../shared/types";
import { APP_PERMISSIONS_REQUEST_CHANGE_TOOL } from "./appMcp";
import { ChatService } from "./chat";
import { RemoteRunService } from "./remoteRuns";

const NOW = "2026-06-26T12:00:00.000Z";

const ROLE: ChatRoleConfig = {
  id: "engineer",
  label: "Engineer",
  instructions: "Answer directly.",
  version: 1,
  appToolCapabilities: ["permissions.request"],
  updatedAt: NOW
};

test("remote run spool reads JSONL records by cursor and limit", async () => {
  const { remote, conversation } = await testRemoteRun();
  const participant = (conversation.metadata.participants as ChatParticipant[])[0];
  const runId = await remote.startSimulatedRun({ conversationId: conversation.id, runId: "cursor-run" });

  await remote.appendOutputText({
    conversationId: conversation.id,
    runId,
    participantId: participant.id,
    content: "first"
  });
  await remote.appendOutputText({
    conversationId: conversation.id,
    runId,
    participantId: participant.id,
    content: "second"
  });

  const records = await remote.readRecords(runId, { afterSeq: 1, limit: 1 });

  assert.equal(records.length, 1);
  assert.equal(records[0].seq, 2);
  assert.equal(records[0].kind, "output_text");
});

test("concurrent appends allocate unique monotonic sequence numbers", async () => {
  const { remote, conversation } = await testRemoteRun();
  const participant = (conversation.metadata.participants as ChatParticipant[])[0];
  const runId = await remote.startSimulatedRun({ conversationId: conversation.id, runId: "concurrent-run" });

  await Promise.all(
    Array.from({ length: 10 }, (_unused, index) =>
      remote.appendOutputText({
        conversationId: conversation.id,
        runId,
        participantId: participant.id,
        content: `chunk-${index}`
      })
    )
  );

  const seqs = (await remote.readRecords(runId)).map((record) => record.seq);
  assert.equal(seqs.length, 11);
  assert.deepEqual([...seqs].sort((a, b) => a - b), Array.from({ length: 11 }, (_unused, index) => index + 1));
  assert.equal(new Set(seqs).size, 11);
});

test("remote run spool skips corrupt and partial lines without losing valid records", async () => {
  const { remote, root, conversation } = await testRemoteRun();
  const participant = (conversation.metadata.participants as ChatParticipant[])[0];
  const runId = "corrupt-run";
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "corrupt-run.jsonl"), [
    JSON.stringify({
      id: "record-1",
      conversationId: conversation.id,
      runId,
      seq: 1,
      createdAt: NOW,
      kind: "lifecycle",
      state: "started"
    }),
    "{not-json",
    JSON.stringify({
      id: "record-3",
      conversationId: conversation.id,
      runId,
      seq: 3,
      createdAt: NOW,
      kind: "output_text",
      participantId: participant.id,
      content: "valid after corrupt"
    }),
    "{\"id\":"
  ].join("\n"), "utf8");

  const records = await remote.readRecords(runId);

  assert.deepEqual(records.map((record) => record.seq), [1, 3]);
  assert.equal(records[1].kind, "output_text");
});

test("remote replay buffers output and permission while disconnected, then drains in sequence", async () => {
  const participant = chatParticipant({ webAccess: false });
  const conversation = chatConversation([participant]);
  const { remote, storage } = await testRemoteRun({ conversation });
  const runId = await remote.startSimulatedRun({ conversationId: conversation.id, runId: "offline-run" });

  await remote.appendOutputText({
    conversationId: conversation.id,
    runId,
    participantId: participant.id,
    content: "Remote progress before permission.",
    sourceMessageId: "user-message",
    threadId: "user-message"
  });
  const permission = await remote.requestPermission({
    conversationId: conversation.id,
    runId,
    participantId: participant.id,
    triggerMessageId: "user-message",
    request: {
      kind: "portable",
      permissions: ["webAccess"],
      reason: "Need web lookup."
    },
    runPermissions: defaultChatAgentPermissions()
  });

  assert.equal(storage.current.messages.length, 1);
  assert.equal(storage.current.metadata.pendingAppToolApprovals, undefined);

  await remote.setConnected(runId, true);

  const participantMessageIndex = storage.current.messages.findIndex((message: Conversation["messages"][number]) =>
    message.role === "participant" && message.content === "Remote progress before permission."
  );
  const permissionMessageIndex = storage.current.messages.findIndex((message: Conversation["messages"][number]) =>
    message.role === "system" && message.content.includes("Permission approval needed")
  );
  const approvals = storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[];
  assert.ok(participantMessageIndex > 0);
  assert.ok(permissionMessageIndex > participantMessageIndex);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].id, permission.requestId);
  assert.equal(approvals[0].resumeContext?.remoteRun, true);
});

test("remote replay is idempotent by stable record id across a fresh service cursor", async () => {
  const participant = chatParticipant({ webAccess: false });
  const conversation = chatConversation([participant]);
  const { remote, service, storage, root } = await testRemoteRun({ conversation });
  const runId = await remote.startSimulatedRun({ conversationId: conversation.id, runId: "duplicate-run" });

  await remote.appendOutputText({
    conversationId: conversation.id,
    runId,
    participantId: participant.id,
    content: "Apply once."
  });
  await remote.requestPermission({
    conversationId: conversation.id,
    runId,
    participantId: participant.id,
    triggerMessageId: "user-message",
    request: {
      kind: "portable",
      permissions: ["webAccess"]
    },
    runPermissions: defaultChatAgentPermissions()
  });
  await remote.setConnected(runId, true);

  const replayFromColdCursor = new RemoteRunService(service, { spoolRoot: root });
  await replayFromColdCursor.applyFromCursor(runId);

  assert.equal(storage.current.messages.filter((message: Conversation["messages"][number]) => message.content === "Apply once.").length, 1);
  assert.equal(
    (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[])
      .filter((approval) => approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL).length,
    1
  );
});

test("permission approval appends a decision record and simulated worker can re-query it", async () => {
  const participant = chatParticipant({ webAccess: false });
  const conversation = chatConversation([participant]);
  const { remote, service } = await testRemoteRun({ conversation });
  const runId = await remote.startSimulatedRun({ conversationId: conversation.id, runId: "decision-run" });
  const permission = await remote.requestPermission({
    conversationId: conversation.id,
    runId,
    participantId: participant.id,
    triggerMessageId: "user-message",
    request: {
      kind: "portable",
      permissions: ["webAccess"]
    },
    runPermissions: defaultChatAgentPermissions()
  });
  await remote.setConnected(runId, true);

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: permission.requestId ?? permission.id,
    approve: true,
    scope: "once"
  });

  const firstRead = await remote.queryPermissionDecision(runId, permission.requestId ?? permission.id);
  const secondRead = await remote.queryPermissionDecision(runId, permission.requestId ?? permission.id);

  assert.equal(firstRead?.status, "approved");
  assert.deepEqual(secondRead, firstRead);
});

test("remote terminal record marks the simulated run terminal without launching a process", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant]);
  let runCount = 0;
  const { remote, storage } = await testRemoteRun({
    conversation,
    run: async (runParticipant) => {
      runCount += 1;
      return {
        participant: runParticipant,
        ok: true,
        content: "should not run",
        durationMs: 1
      };
    }
  });
  const runId = await remote.startSimulatedRun({ conversationId: conversation.id, runId: "terminal-run" });

  await remote.setConnected(runId, true);
  await remote.markTerminal(conversation.id, runId, "cancelled", "timeout");

  assert.equal(runCount, 0);
  assert.equal((storage.current.metadata.remoteRunReplay as any)[runId].terminalState, "cancelled");
});

async function testRemoteRun(options: {
  conversation?: Conversation;
  run?: (...args: any[]) => Promise<any>;
} = {}): Promise<{
  service: ChatService;
  remote: RemoteRunService;
  storage: any;
  root: string;
  conversation: Conversation;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-remote-runs-test-"));
  const conversation = options.conversation ?? chatConversation([chatParticipant()]);
  const storage = {
    current: clone(conversation),
    async getConversation(id: string): Promise<Conversation | undefined> {
      return this.current?.id === id ? clone(this.current) : undefined;
    },
    async saveConversation(next: Conversation): Promise<void> {
      this.current = clone(next);
    }
  };
  const settings = {
    async getPublicSettings(): Promise<AppSettings> {
      return {
        roundLimitDefault: 1,
        cliAgentRunTimeoutMs: 24 * 60 * 60_000,
        providers: [
          { kind: "codex-cli", label: "Codex CLI", enabled: true },
          { kind: "claude-code", label: "Claude Code", enabled: true }
        ],
        chatRoleConfigs: [ROLE],
        chatBehaviorRules: [],
        chatSavedPrompts: [],
        chatParticipantConfigs: [],
        chatParticipantSeedState: {}
      };
    }
  };
  const cliRunner = {
    async detectAgents(): Promise<[]> {
      return [];
    },
    run: options.run ?? (async (participant: ParticipantConfig) => ({
      participant,
      ok: true,
      content: "ok",
      durationMs: 1
    }))
  };
  const debugLogs = {
    async write(): Promise<void> {
      return undefined;
    }
  };
  const service = new ChatService(storage as never, settings as never, cliRunner as never, debugLogs as never);
  const remote = new RemoteRunService(service, { spoolRoot: root });
  return { service, remote, storage, root, conversation };
}

function chatParticipant(
  permissionPatch: Partial<ReturnType<typeof defaultChatAgentPermissions>> = {}
): ChatParticipant {
  const permissions = normalizeChatAgentPermissions({
    ...defaultChatAgentPermissions(),
    ...permissionPatch,
    shell: {
      ...defaultChatAgentPermissions().shell,
      ...permissionPatch.shell
    }
  });
  return {
    id: `participant-${randomUUID()}`,
    handle: "drew",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    kind: "codex-cli",
    agentMode: "default",
    permissions
  };
}

function chatConversation(participants: ChatParticipant[]): Conversation {
  return {
    id: `conversation-${randomUUID()}`,
    title: "Remote run test",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    messages: [{
      id: "user-message",
      role: "user",
      content: "Please work remotely.",
      createdAt: NOW,
      status: "done"
    }],
    findings: [],
    metadata: {
      participants
    }
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
