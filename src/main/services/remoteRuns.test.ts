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
  ParticipantConfig,
  RemoteRunHandle
} from "../../shared/types";
import { APP_PERMISSIONS_REQUEST_CHANGE_TOOL } from "./appMcp";
import { ChatService } from "./chat";
import { buildCloudRunSshTarget, validateCloudRunSshWorkerFields } from "./cloudRunWorkers";
import { remoteMirrorPath, remoteMirrorSlug } from "./remoteMirrorSync";
import type { RemoteMirrorSyncRequest, RemoteMirrorSyncRunner } from "./remoteMirrorSync";
import { forwardedDesktopEnvironment, RemoteRunService } from "./remoteRuns";
import { RemoteRunCoordinator } from "./remoteRunCoordinator";
import type {
  RemoteCodexExecutor,
  RemoteDetachedWorkerCancelRequest,
  RemoteDetachedWorkerLaunchRequest,
  RemoteDetachedWorkerPollRequest,
  RemoteDetachedWorkerReapRequest,
  RemoteDetachedWorkerSnapshot,
  RemoteDetachedWorkerTransport,
  RemoteDetachedWorkerDecisionRequest,
  RemoteWorkerEvent
} from "./remoteRuns";

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

test("detached remote run launches without waiting and projects final output on reconnect", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant]);
  const worker = new FakeDetachedWorkerTransport();
  const { remote, storage } = await testRemoteRun({ conversation, detachedWorkerTransport: worker });

  const state = await remote.startDetachedRun({
    conversationId: conversation.id,
    runId: "detached-run",
    participant: participantConfig(participant),
    prompt: "Run detached.",
    worker: { host: "worker.example" }
  });

  assert.equal(state.status, "running");
  assert.equal(storage.current.messages.filter((message: Conversation["messages"][number]) => message.role === "participant").length, 0);

  await remote.setConnected("detached-run", false);
  worker.push("detached-run", {
    kind: "provider_output",
    workerSeq: 2,
    stream: "stdout",
    content: `${JSON.stringify({ type: "agent_message_delta", delta: "Working remotely." })}\n`
  });
  worker.push("detached-run", {
    kind: "provider_result",
    workerSeq: 3,
    ok: true,
    content: "Detached final."
  });
  worker.push("detached-run", {
    kind: "terminal_state",
    workerSeq: 4,
    status: "completed"
  });

  await remote.pollDetachedRun({ runId: "detached-run", worker: { host: "worker.example" } });

  const rendered = storage.current.messages.filter((message: Conversation["messages"][number]) =>
    message.role === "participant"
  );
  const records = await remote.readRecords("detached-run");
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].content, "Detached final.");
  assert.equal(rendered[0].status, "done");
  assert.deepEqual(records.filter((record) => record.workerSeq).map((record) => record.id), [
    "detached-run:worker:1",
    "detached-run:worker:2",
    "detached-run:final",
    "detached-run:worker:4"
  ]);
  assert.equal((storage.current.metadata.remoteRunReplay as any)["detached-run"].terminalState, "completed");
});

test("detached reconnect preserves workerSeq ordering and skips duplicate worker events", async () => {
  const participant = chatParticipant({ webAccess: false });
  const conversation = chatConversation([participant]);
  const worker = new FakeDetachedWorkerTransport();
  const { remote, service, storage, root } = await testRemoteRun({ conversation, detachedWorkerTransport: worker });

  await remote.startDetachedRun({
    conversationId: conversation.id,
    runId: "ordered-run",
    participant: participantConfig(participant),
    prompt: "Need permission.",
    worker: { host: "worker.example" }
  });
  await remote.setConnected("ordered-run", false);
  worker.push("ordered-run", {
    kind: "provider_output",
    workerSeq: 2,
    stream: "stdout",
    content: `${JSON.stringify({ type: "agent_message_delta", delta: "Before permission." })}\n`
  });
  worker.push("ordered-run", {
    kind: "permission_pending",
    workerSeq: 3,
    requestId: "permission-from-worker",
    triggerMessageId: "user-message",
    request: {
      kind: "portable",
      permissions: ["webAccess"],
      reason: "Need web."
    },
    runPermissions: defaultChatAgentPermissions()
  });

  await remote.pollDetachedRun({ runId: "ordered-run", worker: { host: "worker.example" } });

  const participantMessageIndex = storage.current.messages.findIndex((message: Conversation["messages"][number]) =>
    message.role === "participant" && message.content === "Before permission."
  );
  const permissionMessageIndex = storage.current.messages.findIndex((message: Conversation["messages"][number]) =>
    message.role === "system" && message.content.includes("Permission approval needed")
  );
  assert.ok(participantMessageIndex > 0);
  assert.ok(permissionMessageIndex > participantMessageIndex);
  assert.equal((storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[]).length, 1);

  const replayFromColdCursor = new RemoteRunService(service, { spoolRoot: root, detachedWorkerTransport: worker });
  await replayFromColdCursor.pollDetachedRun({
    runId: "ordered-run",
    worker: { host: "worker.example" },
    afterWorkerSeq: 0
  });

  assert.equal(
    storage.current.messages.filter((message: Conversation["messages"][number]) =>
      message.role === "participant" && message.content === "Before permission."
    ).length,
    1
  );
  assert.equal((storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[]).length, 1);
});

test("detached permission approval writes the decision back to the worker", async () => {
  const participant = chatParticipant({ webAccess: false });
  const conversation = chatConversation([participant]);
  const worker = new FakeDetachedWorkerTransport();
  const { remote, service } = await testRemoteRun({ conversation, detachedWorkerTransport: worker });

  await remote.startDetachedRun({
    conversationId: conversation.id,
    runId: "decision-detached-run",
    participant: participantConfig(participant),
    prompt: "Need permission.",
    worker: { host: "worker.example" }
  });
  worker.push("decision-detached-run", {
    kind: "permission_pending",
    workerSeq: 2,
    requestId: "remote-approval",
    triggerMessageId: "user-message",
    request: {
      kind: "portable",
      permissions: ["webAccess"]
    },
    runPermissions: defaultChatAgentPermissions()
  });
  await remote.pollDetachedRun({ runId: "decision-detached-run", worker: { host: "worker.example" } });

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: "remote-approval",
    approve: true,
    scope: "once"
  });

  assert.equal(worker.decisions.length, 1);
  assert.equal(worker.decisions[0].runId, "decision-detached-run");
  assert.equal(worker.decisions[0].decision.status, "approved");
});

test("detached cancel fallback records a local terminal without writing workerSeq", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant]);
  const worker = new FakeDetachedWorkerTransport();
  worker.cancelWithoutWorkerTerminal = true;
  const { remote, storage } = await testRemoteRun({ conversation, detachedWorkerTransport: worker });

  await remote.startDetachedRun({
    conversationId: conversation.id,
    runId: "local-cancel-terminal-run",
    participant: participantConfig(participant),
    prompt: "Long task.",
    worker: { host: "worker.example" }
  });
  await remote.cancelDetachedRun({
    runId: "local-cancel-terminal-run",
    worker: { host: "worker.example" },
    reason: "user cancelled"
  });

  const records = await remote.readRecords("local-cancel-terminal-run");
  const terminal = records.find((record) => record.kind === "terminal_state");
  assert.equal(terminal?.kind, "terminal_state");
  assert.equal(terminal.status, "cancelled");
  assert.equal(terminal.workerSeq, undefined);
  assert.equal((storage.current.metadata.remoteRunReplay as any)["local-cancel-terminal-run"].terminalState, "cancelled");
});

test("detached cancel and reap project terminal state through worker events", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant]);
  const worker = new FakeDetachedWorkerTransport();
  const { remote, storage } = await testRemoteRun({ conversation, detachedWorkerTransport: worker });

  await remote.startDetachedRun({
    conversationId: conversation.id,
    runId: "cancel-detached-run",
    participant: participantConfig(participant),
    prompt: "Long task.",
    worker: { host: "worker.example" }
  });
  await remote.cancelDetachedRun({ runId: "cancel-detached-run", worker: { host: "worker.example" }, reason: "user cancelled" });
  assert.equal((storage.current.metadata.remoteRunReplay as any)["cancel-detached-run"].terminalState, "cancelled");

  worker.reaped.push({
    state: {
      runId: "expired-run",
      conversationId: conversation.id,
      participantId: participant.id,
      status: "failed"
    },
    events: [{
      kind: "terminal_state",
      workerSeq: 1,
      status: "failed",
      reason: "max runtime"
    }]
  });
  await remote.reapExpiredRuns({ worker: { host: "worker.example" } });
  assert.equal((storage.current.metadata.remoteRunReplay as any)["expired-run"].terminalState, "failed");
});

test("remote run coordinator retries poll errors and drains later terminal state", async () => {
  const handle = remoteRunHandle({
    runId: "retry-run",
    startedAt: new Date().toISOString()
  });
  const chat = new FakeCoordinatorChat(handle);
  let pollCount = 0;
  const remoteRuns = {
    registerDetachedRunContext(): void {},
    async pollDetachedRun(): Promise<any> {
      pollCount += 1;
      if (pollCount === 1) {
        throw new Error("ssh unavailable");
      }
      return {
        runId: handle.runId,
        conversationId: handle.conversationId,
        participantId: handle.participantId,
        status: "completed",
        completedAt: new Date().toISOString()
      };
    }
  };
  const coordinator = new RemoteRunCoordinator(
    remoteRuns as never,
    chat as never,
    coordinatorSettings({ maxRuntimeMs: 60_000, pollIntervalMs: 1 }) as never,
    coordinatorDebugLogs() as never
  );

  coordinator.trackRun(handle);

  await waitFor(() => chat.current.status === "completed");
  assert.equal(pollCount, 2);
});

test("remote run coordinator marks expired runs failed instead of polling forever", async () => {
  const handle = remoteRunHandle({
    runId: "expired-coordinator-run",
    startedAt: new Date(Date.now() - 5_000).toISOString()
  });
  const chat = new FakeCoordinatorChat(handle);
  let pollCount = 0;
  const remoteRuns = {
    registerDetachedRunContext(): void {},
    async pollDetachedRun(): Promise<any> {
      pollCount += 1;
      return {
        runId: handle.runId,
        status: "running"
      };
    }
  };
  const coordinator = new RemoteRunCoordinator(
    remoteRuns as never,
    chat as never,
    coordinatorSettings({ maxRuntimeMs: 1, pollIntervalMs: 1 }) as never,
    coordinatorDebugLogs() as never
  );

  coordinator.trackRun(handle);

  await waitFor(() => chat.current.status === "failed");
  assert.equal(pollCount, 0);
  assert.match(chat.current.error ?? "", /exceeded max runtime/);
});

test("cloud run SSH target validation rejects argv-sensitive values", () => {
  assert.equal(buildCloudRunSshTarget({ host: "worker.example", user: "ubuntu" }), "ubuntu@worker.example");
  assert.throws(() => buildCloudRunSshTarget({ host: "-oProxyCommand=touch /tmp/pwned" }), /Worker host/);
  assert.throws(() => buildCloudRunSshTarget({ host: "worker.example", user: "-oProxyCommand=touch /tmp/pwned" }), /Worker user/);
  assert.throws(() => validateCloudRunSshWorkerFields({
    host: "worker.example",
    identityFile: "-oProxyCommand=touch /tmp/pwned"
  }), /Worker identity file/);
});

test("real remote codex run spools raw provider output and renders final output", async () => {
  const participant = chatParticipant({ webAccess: false });
  const conversation = chatConversation([participant]);
  const sessionId = "11111111-1111-4111-8111-111111111111";
  let sawClosedPrompt = false;
  let sawNoRepoFlags = false;
  const { remote, storage } = await testRemoteRun({
    conversation,
    codexExecutor: async (request, callbacks) => {
      sawClosedPrompt = request.invocation.input.includes("Summarize remotely.");
      sawNoRepoFlags =
        request.invocation.args.includes("--skip-git-repo-check") &&
        // Remote runs persist the session (persistSession) so codex exec resume
        // can continue after an offline permission approval, so they are NOT
        // ephemeral (unlike a local one-off no-repo run).
        !request.invocation.args.includes("--ephemeral") &&
        request.invocation.args.includes("--ignore-rules") &&
        request.invocation.args.includes("--json") &&
        request.invocation.args.includes("--output-last-message") &&
        request.invocation.args.includes(request.remoteFinalPath);
      callbacks.onStdout(`${JSON.stringify({ type: "thread.started", thread_id: sessionId })}\n`);
      callbacks.onStdout(`${JSON.stringify({ type: "agent_message", message: "stdout fallback" })}\n`);
      callbacks.onStderr("diagnostic line\n");
      return {
        stdout: "",
        stderr: "",
        finalMessage: "final from remote file\n",
        exitCode: 0,
        timedOut: false
      };
    }
  });

  const result = await remote.startRealRun({
    conversationId: conversation.id,
    runId: "real-run",
    participant: participantConfig(participant),
    prompt: "Summarize remotely.",
    worker: { host: "worker.example" },
    sourceMessageId: "user-message",
    threadId: "user-message"
  });

  const records = await remote.readRecords("real-run");
  const rendered = storage.current.messages.filter((message: Conversation["messages"][number]) =>
    message.role === "participant"
  );

  assert.equal(sawClosedPrompt, true);
  assert.equal(sawNoRepoFlags, true);
  assert.equal(result.kind, "provider_result");
  assert.equal(result.ok, true);
  assert.equal(result.content, "final from remote file");
  assert.equal(result.sessionId, sessionId);
  assert.deepEqual(records.map((record) => record.kind), [
    "lifecycle",
    "provider_output",
    "provider_output",
    "provider_output",
    "provider_result",
    "terminal_state"
  ]);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].content, "final from remote file");
  assert.equal(rendered[0].metadata?.appMessageSource, "remote-run-provider");
  assert.equal(rendered[0].metadata?.sourceMessageId, "user-message");
  assert.equal((storage.current.metadata.remoteRunReplay as any)["real-run"].terminalState, "completed");
});

test("mirror path derivation is deterministic and collision-resistant", () => {
  const first = remoteMirrorSlug("/Users/dev/projects/myapp");
  const second = remoteMirrorSlug("/Users/dev/projects/myapp");
  const sibling = remoteMirrorSlug("/Users/dev/other/myapp");
  assert.equal(first, second);
  assert.notEqual(first, sibling);
  assert.match(first, /^myapp-[0-9a-f]{10}$/);
  assert.equal(
    remoteMirrorPath("/srv/worker", "/Users/dev/projects/myapp"),
    `/srv/worker/mirrors/${first}`
  );
});

test("mirror-sync detached run up-syncs before launch and runs codex in the mirror", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant]);
  const localDir = await mkdtemp(path.join(tmpdir(), "accordagents-mirror-src-"));
  await mkdir(path.join(localDir, ".git"), { recursive: true });
  await writeFile(path.join(localDir, "file.txt"), "hello", "utf8");
  const order: string[] = [];
  const mirrorSync = new FakeMirrorSync();
  const originalUp = mirrorSync.syncUp.bind(mirrorSync);
  mirrorSync.syncUp = async (request) => {
    order.push("sync-up");
    await originalUp(request);
  };
  class OrderedTransport extends FakeDetachedWorkerTransport {
    launched: RemoteDetachedWorkerLaunchRequest | undefined;

    override async launch(request: RemoteDetachedWorkerLaunchRequest): Promise<RemoteDetachedWorkerSnapshot> {
      order.push("launch");
      this.launched = request;
      return super.launch(request);
    }
  }
  const worker = new OrderedTransport();
  const { remote } = await testRemoteRun({ conversation, detachedWorkerTransport: worker, mirrorSync });

  const expectedMirror = remoteMirrorPath("/srv/worker", localDir);
  const state = await remote.startDetachedRun({
    conversationId: conversation.id,
    runId: "mirror-run",
    participant: participantConfig(participant),
    prompt: "Work in the mirror.",
    worker: { host: "worker.example", workerRoot: "/srv/worker" },
    sync: { localPath: localDir }
  });

  assert.deepEqual(order, ["sync-up", "launch"]);
  assert.deepEqual(mirrorSync.calls, [{ kind: "up", localPath: localDir, remotePath: expectedMirror }]);
  assert.deepEqual(state.sync, { localPath: localDir, remotePath: expectedMirror });
  const args = worker.launched?.invocation.args ?? [];
  const cdIndex = args.indexOf("--cd");
  assert.ok(cdIndex >= 0);
  assert.equal(args[cdIndex + 1], expectedMirror);
  assert.ok(args.includes("sandbox_workspace_write.network_access=true"));
  assert.ok(args.some((arg) => arg === `sandbox_workspace_write.writable_roots=["${expectedMirror}/.git"]`));
});

test("mirror-sync down-syncs exactly once when the run reaches terminal state", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant]);
  const localDir = await mkdtemp(path.join(tmpdir(), "accordagents-mirror-src-"));
  const mirrorSync = new FakeMirrorSync();
  const worker = new FakeDetachedWorkerTransport();
  const { remote } = await testRemoteRun({ conversation, detachedWorkerTransport: worker, mirrorSync });
  const target = { host: "worker.example", workerRoot: "/srv/worker" };
  const expectedMirror = remoteMirrorPath("/srv/worker", localDir);

  await remote.startDetachedRun({
    conversationId: conversation.id,
    runId: "mirror-terminal-run",
    participant: participantConfig(participant),
    prompt: "Finish and sync back.",
    worker: target,
    sync: { localPath: localDir }
  });
  assert.equal(mirrorSync.calls.filter((call) => call.kind === "down").length, 0);

  worker.push("mirror-terminal-run", {
    kind: "provider_result",
    workerSeq: 2,
    ok: true,
    content: "Mirror final."
  });
  worker.push("mirror-terminal-run", {
    kind: "terminal_state",
    workerSeq: 3,
    status: "completed"
  });
  await remote.pollDetachedRun({ runId: "mirror-terminal-run", worker: target });
  await remote.pollDetachedRun({ runId: "mirror-terminal-run", worker: target });

  const downCalls = mirrorSync.calls.filter((call) => call.kind === "down");
  assert.equal(downCalls.length, 1);
  assert.deepEqual(downCalls[0], { kind: "down", localPath: localDir, remotePath: expectedMirror });
});

test("concurrent run on a busy mirror skips the destructive up-sync", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant]);
  const localDir = await mkdtemp(path.join(tmpdir(), "accordagents-mirror-src-"));
  const mirrorSync = new FakeMirrorSync();
  const worker = new FakeDetachedWorkerTransport();
  const { remote } = await testRemoteRun({ conversation, detachedWorkerTransport: worker, mirrorSync });
  const target = { host: "worker.example", workerRoot: "/srv/worker" };

  await remote.startDetachedRun({
    conversationId: conversation.id,
    runId: "mirror-busy-a",
    participant: participantConfig(participant),
    prompt: "First run.",
    worker: target,
    sync: { localPath: localDir }
  });
  await remote.startDetachedRun({
    conversationId: conversation.id,
    runId: "mirror-busy-b",
    participant: participantConfig(participant),
    prompt: "Second run, same project.",
    worker: target,
    sync: { localPath: localDir }
  });

  assert.equal(mirrorSync.calls.filter((call) => call.kind === "up").length, 1);
});

test("pre-provisioned remoteCwd mode never touches the mirror sync", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant]);
  const mirrorSync = new FakeMirrorSync();
  class CapturingTransport extends FakeDetachedWorkerTransport {
    launched: RemoteDetachedWorkerLaunchRequest | undefined;

    override async launch(request: RemoteDetachedWorkerLaunchRequest): Promise<RemoteDetachedWorkerSnapshot> {
      this.launched = request;
      return super.launch(request);
    }
  }
  const worker = new CapturingTransport();
  const { remote } = await testRemoteRun({
    conversation,
    detachedWorkerTransport: worker,
    mirrorSync,
    remoteGitDirProbe: async () => true
  });

  const state = await remote.startDetachedRun({
    conversationId: conversation.id,
    runId: "provisioned-run",
    participant: participantConfig(participant),
    prompt: "Run in the pre-provisioned clone.",
    worker: { host: "worker.example" },
    repoPath: "/home/ubuntu/work/repo"
  });

  worker.push("provisioned-run", {
    kind: "terminal_state",
    workerSeq: 2,
    status: "completed"
  });
  await remote.pollDetachedRun({ runId: "provisioned-run", worker: { host: "worker.example" } });

  assert.equal(state.sync, undefined);
  assert.deepEqual(mirrorSync.calls, []);
  const args = worker.launched?.invocation.args ?? [];
  assert.ok(args.includes("sandbox_workspace_write.network_access=true"));
  assert.ok(args.some((arg) => arg === 'sandbox_workspace_write.writable_roots=["/home/ubuntu/work/repo/.git"]'));
});

test("forwardedDesktopEnvironment strips machine-specific vars and keeps the rest", () => {
  const forwarded = forwardedDesktopEnvironment({
    PATH: "/opt/homebrew/bin:/usr/bin",
    HOME: "/Users/dev",
    TMPDIR: "/var/folders/xy",
    SHELL: "/bin/zsh",
    LC_ALL: "en_US.UTF-8",
    DYLD_LIBRARY_PATH: "/usr/local/lib",
    __CF_USER_TEXT_ENCODING: "0x0:0:0",
    ELECTRON_RUN_AS_NODE: "1",
    npm_config_prefix: "/opt/homebrew",
    NVM_DIR: "/Users/dev/.nvm",
    ACCORD_AGENTS_MCP_TOKEN: "internal",
    GH_TOKEN: "gh-secret",
    GITHUB_TOKEN: "gh-secret-2",
    AWS_PROFILE: "work",
    MY_PROJECT_FLAG: "on"
  });
  assert.deepEqual(forwarded, {
    GH_TOKEN: "gh-secret",
    GITHUB_TOKEN: "gh-secret-2",
    AWS_PROFILE: "work",
    MY_PROJECT_FLAG: "on"
  });
});

test("detached run forwards desktop env with app-MCP token precedence", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant]);
  class CapturingTransport extends FakeDetachedWorkerTransport {
    launched: RemoteDetachedWorkerLaunchRequest | undefined;

    override async launch(request: RemoteDetachedWorkerLaunchRequest): Promise<RemoteDetachedWorkerSnapshot> {
      this.launched = request;
      return super.launch(request);
    }
  }
  const worker = new CapturingTransport();
  const { remote } = await testRemoteRun({ conversation, detachedWorkerTransport: worker });

  process.env.AA_TEST_FORWARDED_SECRET = "forward-me";
  process.env.ACCORD_AGENTS_MCP_TOKEN = "must-not-forward";
  try {
    await remote.startDetachedRun({
      conversationId: conversation.id,
      runId: "env-forward-run",
      participant: participantConfig(participant),
      prompt: "Use the forwarded env.",
      worker: { host: "worker.example" },
      options: {
        appMcp: { url: "http://127.0.0.1:9999/mcp", token: "per-run-token" }
      }
    });
  } finally {
    delete process.env.AA_TEST_FORWARDED_SECRET;
    delete process.env.ACCORD_AGENTS_MCP_TOKEN;
  }

  const env = worker.launched?.invocation.env ?? {};
  assert.equal(env.AA_TEST_FORWARDED_SECRET, "forward-me");
  assert.equal(env.ACCORD_AGENTS_MCP_TOKEN, "per-run-token");
  assert.equal(env.PATH, undefined);
  assert.equal(env.HOME, undefined);
});

test("real remote codex run falls back to parsed stdout when final output is missing", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant]);
  const { remote, storage } = await testRemoteRun({
    conversation,
    codexExecutor: async (_request, callbacks) => {
      callbacks.onStdout(`${JSON.stringify({ type: "agent_message", message: "parsed stdout reply" })}\n`);
      return {
        stdout: "",
        stderr: "",
        finalMessage: "",
        exitCode: 0,
        timedOut: false
      };
    }
  });

  const result = await remote.startRealRun({
    conversationId: conversation.id,
    runId: "stdout-fallback-run",
    participant: participantConfig(participant),
    prompt: "Reply from stdout.",
    worker: { host: "worker.example" }
  });

  const rendered = storage.current.messages.filter((message: Conversation["messages"][number]) =>
    message.role === "participant"
  );

  assert.equal(result.content, "parsed stdout reply");
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].content, "parsed stdout reply");
});

test("real remote codex non-zero exit records failed provider result", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant]);
  const { remote, storage } = await testRemoteRun({
    conversation,
    codexExecutor: async (_request, callbacks) => {
      callbacks.onStderr("auth failed\n");
      return {
        stdout: "",
        stderr: "auth failed\n",
        finalMessage: "",
        exitCode: 1,
        timedOut: false
      };
    }
  });

  const result = await remote.startRealRun({
    conversationId: conversation.id,
    runId: "failed-run",
    participant: participantConfig(participant),
    prompt: "Fail remotely.",
    worker: { host: "worker.example" }
  });

  const rendered = storage.current.messages.filter((message: Conversation["messages"][number]) =>
    message.role === "participant"
  );

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Remote Codex exited with code 1/);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].status, "error");
  assert.match(rendered[0].content, /auth failed/);
  assert.equal((storage.current.metadata.remoteRunReplay as any)["failed-run"].terminalState, "failed");
});

async function testRemoteRun(options: {
  conversation?: Conversation;
  run?: (...args: any[]) => Promise<any>;
  codexExecutor?: RemoteCodexExecutor;
  detachedWorkerTransport?: RemoteDetachedWorkerTransport;
  mirrorSync?: RemoteMirrorSyncRunner;
  remoteGitDirProbe?: (worker: unknown, gitDirPath: string) => Promise<boolean>;
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
        cloudRuns: { enabled: false, worker: {}, maxRuntimeMs: 24 * 60 * 60_000, pollIntervalMs: 2_500 },
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
  const remote = new RemoteRunService(service, {
    spoolRoot: root,
    codexExecutor: options.codexExecutor,
    detachedWorkerTransport: options.detachedWorkerTransport,
    mirrorSync: options.mirrorSync,
    remoteGitDirProbe: options.remoteGitDirProbe as never
  });
  return { service, remote, storage, root, conversation };
}

class FakeMirrorSync implements RemoteMirrorSyncRunner {
  readonly calls: Array<{ kind: "up" | "down"; localPath: string; remotePath: string }> = [];

  async syncUp(request: RemoteMirrorSyncRequest): Promise<void> {
    this.calls.push({ kind: "up", localPath: request.localPath, remotePath: request.remotePath });
  }

  async syncDown(request: RemoteMirrorSyncRequest): Promise<void> {
    this.calls.push({ kind: "down", localPath: request.localPath, remotePath: request.remotePath });
  }
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

function participantConfig(participant: ChatParticipant): ParticipantConfig {
  return {
    id: participant.id,
    kind: participant.kind,
    label: `@${participant.handle}`,
    model: participant.model,
    reasoningEffort: participant.reasoningEffort
  };
}

class FakeDetachedWorkerTransport implements RemoteDetachedWorkerTransport {
  readonly eventsByRun = new Map<string, RemoteWorkerEvent[]>();
  readonly decisions: RemoteDetachedWorkerDecisionRequest[] = [];
  readonly reaped: RemoteDetachedWorkerSnapshot[] = [];
  cancelWithoutWorkerTerminal = false;

  async launch(request: RemoteDetachedWorkerLaunchRequest): Promise<RemoteDetachedWorkerSnapshot> {
    if (!this.eventsByRun.has(request.runId)) {
      this.eventsByRun.set(request.runId, [{
        kind: "lifecycle",
        workerSeq: 1,
        state: "detached_started"
      }]);
    }
    return this.snapshot(request.runId, 0, {
      conversationId: request.conversationId,
      participantId: request.participant.id,
      status: "running"
    });
  }

  async poll(request: RemoteDetachedWorkerPollRequest): Promise<RemoteDetachedWorkerSnapshot> {
    return this.snapshot(request.runId, request.afterWorkerSeq);
  }

  async cancel(request: RemoteDetachedWorkerCancelRequest): Promise<RemoteDetachedWorkerSnapshot> {
    if (this.cancelWithoutWorkerTerminal) {
      return this.snapshot(request.runId, 0, {
        status: "cancelled",
        error: request.reason
      });
    }
    const events = this.eventsByRun.get(request.runId) ?? [];
    if (!events.some((event) => event.kind === "terminal_state")) {
      events.push({
        kind: "terminal_state",
        workerSeq: events.reduce((max, event) => Math.max(max, event.workerSeq), 0) + 1,
        status: "cancelled",
        reason: request.reason
      });
      this.eventsByRun.set(request.runId, events);
    }
    return this.snapshot(request.runId, 0, { status: "cancelled" });
  }

  async writePermissionDecision(request: RemoteDetachedWorkerDecisionRequest): Promise<void> {
    this.decisions.push(request);
  }

  async reapExpiredRuns(_request: RemoteDetachedWorkerReapRequest): Promise<RemoteDetachedWorkerSnapshot[]> {
    return this.reaped;
  }

  push(runId: string, event: RemoteWorkerEvent): void {
    const events = this.eventsByRun.get(runId) ?? [];
    events.push(event);
    events.sort((a, b) => a.workerSeq - b.workerSeq);
    this.eventsByRun.set(runId, events);
  }

  private snapshot(
    runId: string,
    afterWorkerSeq: number,
    patch: Partial<RemoteDetachedWorkerSnapshot["state"]> = {}
  ): RemoteDetachedWorkerSnapshot {
    const events = (this.eventsByRun.get(runId) ?? []).filter((event) => event.workerSeq > afterWorkerSeq);
    return {
      state: {
        runId,
        status: "running",
        workerCursorSeq: (this.eventsByRun.get(runId) ?? []).reduce((max, event) => Math.max(max, event.workerSeq), 0),
        ...patch
      },
      events
    };
  }
}

class FakeCoordinatorChat {
  current: RemoteRunHandle;

  constructor(handle: RemoteRunHandle) {
    this.current = clone(handle);
  }

  async listActiveRemoteRunHandles(): Promise<RemoteRunHandle[]> {
    return [clone(this.current)];
  }

  async updateRemoteRunHandleState(_conversationId: string, _runId: string, state: any): Promise<RemoteRunHandle> {
    this.current = {
      ...this.current,
      status: state.status,
      workerCursorSeq: state.workerCursorSeq ?? this.current.workerCursorSeq,
      completedAt: state.completedAt ?? this.current.completedAt,
      error: state.error ?? this.current.error,
      updatedAt: new Date().toISOString()
    };
    return clone(this.current);
  }
}

function remoteRunHandle(patch: Partial<RemoteRunHandle> = {}): RemoteRunHandle {
  const startedAt = patch.startedAt ?? new Date().toISOString();
  return {
    runId: "remote-run",
    conversationId: "conversation-1",
    participantId: "participant-1",
    participantHandle: "codex",
    worker: { host: "worker.example" },
    status: "running",
    startedAt,
    updatedAt: startedAt,
    ...patch
  };
}

function coordinatorSettings(patch: { maxRuntimeMs: number; pollIntervalMs: number }): { getPublicSettings(): Promise<AppSettings> } {
  return {
    async getPublicSettings(): Promise<AppSettings> {
      return {
        roundLimitDefault: 1,
        cliAgentRunTimeoutMs: 24 * 60 * 60_000,
        cloudRuns: {
          enabled: true,
          worker: { host: "worker.example" },
          maxRuntimeMs: patch.maxRuntimeMs,
          pollIntervalMs: patch.pollIntervalMs
        },
        providers: [],
        chatRoleConfigs: [],
        chatBehaviorRules: [],
        chatSavedPrompts: [],
        chatParticipantConfigs: []
      };
    }
  };
}

function coordinatorDebugLogs(): { write(): Promise<void> } {
  return {
    async write(): Promise<void> {
      return undefined;
    }
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}
