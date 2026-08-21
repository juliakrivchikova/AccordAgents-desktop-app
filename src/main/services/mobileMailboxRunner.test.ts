import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { ChatMessage, Conversation } from "../../shared/types";
import {
  REMOTE_APP_MCP_TOOL_CONTRACTS,
  REMOTE_APP_MCP_WORKER_CONTRACT_SNIPPET
} from "./remoteAppMcpTools.generated";
import {
  MOBILE_RUNNER_CONTEXT_KIND,
  MOBILE_RUNNER_POLICY_KIND,
  enqueueLatestMobileMailboxRunnerPublish,
  mobileMailboxRunnerContextDelivery,
  mobileMailboxRunnerInstallCommand,
  mobileMailboxRunnerPolicyFromConversation,
  mobileMailboxRunnerScript
} from "./mobileMailboxRunner";

const requireScript = createRequire(__filename);
const { createReferenceMailboxServer } = requireScript(path.join(process.cwd(), "scripts/mailbox-reference-server.cjs")) as {
  createReferenceMailboxServer(options?: { locked?: boolean }): {
    listen(): Promise<{ url: string }>;
    close(): Promise<void>;
  };
};

// The E2E tests run the locked mailbox contract end to end: the reference
// server requires registration plus the bearer token, and stores sealed
// payloads only, exactly like the production relay worker.
const TEST_SEAL_KEY = randomBytes(32).toString("base64url");
const TEST_MAILBOX_TOKEN = "runner-test-mailbox-token";
const TEST_RUNNER_AUTH_ENV = {
  ACCORD_MOBILE_MAILBOX_TOKEN: TEST_MAILBOX_TOKEN,
  ACCORD_MOBILE_RELAY_SEAL_KEY: TEST_SEAL_KEY
};

async function registerTestMailbox(baseUrl: string, mailboxId: string): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/mailbox/register?mailboxId=${mailboxId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TEST_MAILBOX_TOKEN}`
    },
    body: JSON.stringify({
      tokenHashBase64Url: createHash("sha256").update(TEST_MAILBOX_TOKEN, "utf8").digest("base64url")
    })
  });
  assert.equal(response.ok, true, await response.text());
}

function sealTestPayload(payload: unknown): unknown {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(TEST_SEAL_KEY, "base64url"), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tagged = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return { v: 1, alg: "A256GCM", iv: iv.toString("base64url"), ct: tagged.toString("base64url") };
}

function openTestPayload(sealed: unknown): unknown {
  const envelope = sealed as { iv: string; ct: string };
  const tagged = Buffer.from(envelope.ct, "base64url");
  const tag = tagged.subarray(tagged.length - 16);
  const ciphertext = tagged.subarray(0, tagged.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(TEST_SEAL_KEY, "base64url"), Buffer.from(envelope.iv, "base64url"));
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
}

function unsealEvents(events: unknown[] | undefined): ChatEventEnvelope[] {
  return (events ?? []).map((event) => {
    const envelope = event as ChatEventEnvelope;
    return { ...envelope, payload: openTestPayload(envelope.payload) };
  });
}

test("mobile mailbox runner policy snapshot carries cloud participants and recent context", () => {
  const snapshot = mobileMailboxRunnerPolicyFromConversation(conversation());

  assert.equal(snapshot.type, MOBILE_RUNNER_POLICY_KIND);
  assert.deepEqual(snapshot.participants, [{
    id: "participant-codex",
    handle: "codex",
    kind: "codex-cli",
    remoteExecution: "remote"
  }]);
  assert.deepEqual(snapshot.recentMessages?.map((message) => message.content), ["previous"]);
});

test("mobile mailbox runner embeds the generated worker App MCP contract", () => {
  assert.ok(mobileMailboxRunnerScript().includes(REMOTE_APP_MCP_WORKER_CONTRACT_SNIPPET));
  for (const contract of REMOTE_APP_MCP_TOOL_CONTRACTS) {
    assert.ok(contract.definition.annotations, `${contract.definition.name} must declare MCP safety annotations`);
  }
  assert.equal(
    REMOTE_APP_MCP_TOOL_CONTRACTS.find((contract) => contract.handler === "chat-get-participants")
      ?.definition.annotations?.readOnlyHint,
    true
  );
  assert.equal(
    REMOTE_APP_MCP_TOOL_CONTRACTS.find((contract) => contract.handler === "chat-send-message")
      ?.definition.annotations?.readOnlyHint,
    false
  );
});

test("mobile mailbox runner policy references chunked App MCP context without resending unchanged attachments", () => {
  const contextSnapshot = {
    conversationId: "conversation-1",
    messages: [{ id: "message-1", sequence: 0, content: "previous" }],
    attachments: [{ attachment: { id: "attachment-1" }, dataBase64: "cG5n" }]
  };
  const first = mobileMailboxRunnerContextDelivery(contextSnapshot);
  const policy = mobileMailboxRunnerPolicyFromConversation(conversation(), undefined, first.ref);
  const second = mobileMailboxRunnerContextDelivery(contextSnapshot, first.nextState);
  const changed = mobileMailboxRunnerContextDelivery({
    ...contextSnapshot,
    messages: [...contextSnapshot.messages, { id: "message-2", sequence: 1, content: "new" }],
    attachments: [{ attachment: { id: "attachment-1" }, dataBase64Omitted: true }]
  }, first.nextState);

  assert.deepEqual(policy.contextSnapshotRef, first.ref);
  assert.equal(policy.contextSnapshot, undefined);
  assert.equal(policy.recentMessages, undefined);
  assert.ok(first.chunks.length >= 2);
  assert.ok(first.chunks.every((chunk) => Buffer.byteLength(JSON.stringify(chunk), "utf8") < 512 * 1024));
  assert.deepEqual(second.chunks, []);
  assert.equal(changed.chunks.some((chunk) =>
    chunk.fragments?.some((fragment) => fragment.key === "attachment:attachment-1")), false);
  assert.equal(changed.chunks.some((chunk) =>
    chunk.fragments?.some((fragment) => fragment.key === "message:message-2")), true);
  assert.deepEqual(changed.nextState.attachmentBase64Lengths, { "attachment-1": 4 });
});

test("mobile mailbox policy publication coalesces queued snapshots to the newest value", async () => {
  const queues = new Map();
  const published: number[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const publish = async (value: number): Promise<void> => {
    published.push(value);
    if (value === 1) {
      await firstBlocked;
    }
  };

  const first = enqueueLatestMobileMailboxRunnerPublish(queues, "conversation-1", 1, publish);
  await new Promise((resolve) => setImmediate(resolve));
  const second = enqueueLatestMobileMailboxRunnerPublish(queues, "conversation-1", 2, publish);
  const third = enqueueLatestMobileMailboxRunnerPublish(queues, "conversation-1", 3, publish);
  releaseFirst?.();
  await Promise.all([first, second, third]);

  assert.deepEqual(published, [1, 3]);
  assert.equal(queues.size, 0);
});

test("failed mobile mailbox publication leaves delivery state uncommitted for a full retry", async () => {
  const queues = new Map();
  const snapshot = {
    conversationId: "conversation-1",
    messages: [{ id: "message-1", sequence: 0, content: "context" }],
    attachments: [{ attachment: { id: "attachment-1" }, dataBase64: "cG5n" }]
  };
  let committedState: ReturnType<typeof mobileMailboxRunnerContextDelivery>["nextState"] | undefined;
  let attempts = 0;
  const resets: boolean[] = [];
  const attachmentFragments: boolean[] = [];
  const publish = async (): Promise<void> => {
    const delivery = mobileMailboxRunnerContextDelivery(snapshot, committedState);
    resets.push(delivery.chunks[0]?.header?.reset === true);
    attachmentFragments.push(delivery.chunks.some((chunk) =>
      chunk.fragments?.some((fragment) => fragment.key === "attachment:attachment-1")));
    attempts += 1;
    if (attempts === 1) {
      throw new Error("mailbox unavailable");
    }
    committedState = delivery.nextState;
  };

  await assert.rejects(
    enqueueLatestMobileMailboxRunnerPublish(queues, "conversation-1", snapshot, publish),
    /mailbox unavailable/
  );
  assert.equal(queues.size, 0);
  await enqueueLatestMobileMailboxRunnerPublish(queues, "conversation-1", snapshot, publish);

  assert.deepEqual(resets, [true, true]);
  assert.deepEqual(attachmentFragments, [true, true]);
  assert.ok(committedState);
});

test("real-data-sized mailbox context keeps every event bounded and sends only the next message delta", () => {
  const messages = Array.from({ length: 200 }, (_, sequence) => ({
    id: `message-${sequence}`,
    sequence,
    role: sequence % 2 === 0 ? "user" : "participant",
    content: `message ${sequence} ${"x".repeat(4_200)}`,
    createdAt: "2026-08-21T00:00:00.000Z",
    status: "done"
  }));
  const attachments = Array.from({ length: 6 }, (_, index) => ({
    messageId: `message-${190 + index}`,
    sequence: 190 + index,
    attachment: { id: `attachment-${index}`, filename: `image-${index}.png`, mimeType: "image/png" },
    dataBase64: Buffer.alloc(237_500, index).toString("base64")
  }));
  const snapshot = {
    conversationId: "conversation-1",
    title: "Large chat",
    messages,
    attachments,
    messageWindow: { maxSequence: 199, totalMessages: 3_000, oldestIncludedSequence: 0 },
    attachmentWindow: { omittedCount: 0, limit: 6 }
  };
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 2_700_000);

  const first = mobileMailboxRunnerContextDelivery(snapshot);
  const policy = mobileMailboxRunnerPolicyFromConversation(conversation(), undefined, first.ref);
  const unchanged = mobileMailboxRunnerContextDelivery(snapshot, first.nextState);
  const shiftedMessages = messages.slice(1).map((message, sequence) => ({ ...message, sequence }));
  const next = mobileMailboxRunnerContextDelivery({
    ...snapshot,
    messages: [...shiftedMessages, { ...messages[199], id: "message-200", sequence: 199, content: "new turn" }],
    attachments: attachments.map(({ dataBase64: _dataBase64, ...attachment }) => ({
      ...attachment,
      dataBase64Omitted: true
    })),
    messageWindow: { maxSequence: 199, totalMessages: 3_001, oldestIncludedSequence: 0 }
  }, first.nextState);

  assert.ok(Buffer.byteLength(JSON.stringify(policy), "utf8") < 10_000);
  assert.ok(first.chunks.every((chunk) => Buffer.byteLength(JSON.stringify(chunk), "utf8") < 512 * 1024));
  assert.deepEqual(unchanged.chunks, []);
  assert.equal(next.chunks.some((chunk) =>
    chunk.fragments?.some((fragment) => fragment.key.startsWith("attachment:"))), false);
  assert.ok(next.chunks.reduce((total, chunk) => total + Buffer.byteLength(JSON.stringify(chunk), "utf8"), 0) < 100_000);
});

test("mobile mailbox runner install command installs an idempotent route-scoped daemon", () => {
  const command = mobileMailboxRunnerInstallCommand({
    routeId: "route/with unsafe chars",
    mailboxUrl: "https://relay.example.test/v1/mailbox/events?mailboxId=abc",
    mailboxToken: "test-mailbox-token",
    relaySealKeyBase64: "dGVzdC1zZWFsLWtleQ",
    workerRoot: "/home/ubuntu/.accordagents/remote-runs",
    codexPath: "/usr/local/bin/codex",
    claudePath: "/usr/local/bin/claude",
    pollIntervalMs: 1234,
    timeoutMs: 5678
  });

  assert.match(command, /mobile-mailbox-runners\/route_with_unsafe_chars-[a-f0-9]{16}/);
  assert.match(command, /already-running/);
  assert.match(command, /base64 -d > "\$runner"/);
  assert.match(command, /runner-launch\.sh/);
  assert.match(command, /systemctl enable "\$service_name"/);
  assert.match(command, /systemctl restart "\$service_name"/);
  assert.match(command, /"persistence":"systemd"/);
  assert.match(command, /mailbox_url='https:\/\/relay\.example\.test\/v1\/mailbox\/events\?mailboxId=abc'/);
  assert.match(command, /codex_path='\/usr\/local\/bin\/codex'/);
  assert.match(command, /claude_path='\/usr\/local\/bin\/claude'/);
  assert.match(command, /printf "export ACCORD_MOBILE_MAILBOX_URL=%s\\n"/);
  assert.match(command, /printf "export ACCORD_MOBILE_MAILBOX_TOKEN=%s\\n"/);
  assert.match(command, /printf "export ACCORD_MOBILE_RELAY_SEAL_KEY=%s\\n"/);
  assert.match(command, /mailbox_token='test-mailbox-token'/);
  assert.match(command, /relay_seal_key='dGVzdC1zZWFsLWtleQ'/);
  assert.match(command, /printf "export ACCORD_MOBILE_CLAUDE_PATH=%s\\n"/);
  assert.match(command, /ACCORD_MOBILE_RUNNER_OPERATION_LEASE_PATH="\$operations_dir\/mobile-mailbox-runner-route_with_unsafe_chars-[a-f0-9]{16}\.json"/);
  assert.match(command, /ACCORD_MOBILE_RUNNER_OPERATION_LEASE_OWNER='mobile-mailbox-runner:route_with_unsafe_chars-[a-f0-9]{16}'/);
  assert.match(command, /ACCORD_MOBILE_EVENT_CLAIM_TTL_MS=45000/);
  assert.match(command, /poll_interval_ms='1234'/);
  assert.match(command, /timeout_ms='5678'/);
  assert.doesNotMatch(command, /route\/with unsafe chars/);
  assert.equal(command.includes("&;"), false);
  assert.equal(command.includes("then;"), false);
  const syntax = spawnSync("sh", ["-n"], { input: command, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("mobile mailbox runner install command expands tilde worker roots on the remote host", () => {
  const command = mobileMailboxRunnerInstallCommand({
    routeId: "route-a",
    mailboxUrl: "https://relay.example.test/v1/mailbox/events?mailboxId=abc",
    mailboxToken: "test-mailbox-token",
    relaySealKeyBase64: "dGVzdC1zZWFsLWtleQ",
    workerRoot: "~/.accordagents/remote-runs/devices/device-a"
  });

  assert.match(command, /root='~\/\.accordagents\/remote-runs\/devices\/device-a'/);
  assert.match(command, /case "\$root" in "~"\) root="\$HOME";; "~\/"\*\) root="\$HOME\/\$\{root#~\/\}";; esac/);
  const syntax = spawnSync("sh", ["-n"], { input: command, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("mobile mailbox runner consumes mobile outbox and publishes running plus canonical result events", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-mobile-mailbox-runner-"));
  const mailbox = createReferenceMailboxServer({ locked: true });
  const address = await mailbox.listen();
  const mailboxUrl = `${address.url}/v1/mailbox/events?mailboxId=runner-test`;
  await registerTestMailbox(address.url, "runner-test");
  try {
    const runnerPath = path.join(directory, "mobile-runner.js");
    const codexPath = path.join(directory, "fake-codex.js");
    await writeFile(runnerPath, mobileMailboxRunnerScript(), { mode: 0o755 });
    await writeFile(codexPath, fakeCodexScript(), { mode: 0o755 });
    await postJson(mailboxUrl, {
      events: [
        envelope("policy-event", "desktop-origin", 1, MOBILE_RUNNER_POLICY_KIND, mobileMailboxRunnerPolicyFromConversation(conversation())),
        envelope("mobile-event", "mobile-origin", 1, "message.created", {
          content: "@codex run from phone"
        })
      ]
    });

    const result = await runNode(runnerPath, {
      ACCORD_MOBILE_MAILBOX_URL: mailboxUrl,
      ACCORD_MOBILE_RUNNER_ORIGIN_ID: "runner-origin",
      ACCORD_MOBILE_CODEX_PATH: codexPath,
      ACCORD_MOBILE_RUNNER_STATE: path.join(directory, "state.json"),
      ACCORD_MOBILE_RUNNER_ONCE: "1"
    });
    assert.equal(result.code, 0, result.stderr);

    const body = await getJson(mailboxUrl);
    const events = unsealEvents(body.events);
    const timelineEvents = events.filter((event) => event.kind === "mobile.timeline.events");
    const resultMessage = events.find((event) =>
      event.kind === "message.created" &&
      typeof (event.payload as { message?: ChatMessage }).message?.content === "string"
    );
    assert.ok(timelineEvents.some((event) =>
      JSON.stringify(event.payload).includes("@codex is running...")
    ));
    assert.equal((resultMessage?.payload as { message?: ChatMessage }).message?.content, "fake cloud result");
    assert.equal((resultMessage?.payload as { message?: ChatMessage }).message?.participantLabel, "@codex");
  } finally {
    await mailbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mobile mailbox runner exposes the shared App MCP tools to Codex and publishes tool messages", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-mobile-mailbox-runner-mcp-"));
  const mailbox = createReferenceMailboxServer({ locked: true });
  const address = await mailbox.listen();
  const mailboxUrl = `${address.url}/v1/mailbox/events?mailboxId=runner-mcp-test`;
  await registerTestMailbox(address.url, "runner-mcp-test");
  try {
    const runnerPath = path.join(directory, "mobile-runner.js");
    const codexPath = path.join(directory, "fake-mcp-codex.js");
    const contextSnapshot = {
      conversationId: "conversation-1",
      messages: [{
        id: "message-1",
        sequence: 0,
        role: "user",
        author: "User",
        content: "previous",
        createdAt: "2026-08-12T00:00:01.000Z",
        status: "done",
        metadata: { threadId: "message-1" },
        imageAttachments: []
      }],
      messageWindow: { maxSequence: 0, totalMessages: 1, oldestIncludedSequence: 0 },
      attachments: [{
        messageId: "message-1",
        sequence: 0,
        author: "User",
        threadId: "message-1",
        attachment: {
          id: "attachment-1",
          filename: "pixel.png",
          mimeType: "image/png",
          sizeBytes: 3,
          width: 1,
          height: 1,
          createdAt: "2026-08-12T00:00:01.000Z"
        },
        dataBase64: "cG5n"
      }],
      attachmentWindow: { omittedCount: 0, limit: 6 },
      participants: [{ id: "participant-codex", handle: "codex", kind: "codex-cli", remoteExecution: "remote" }]
    };
    const contextDelivery = mobileMailboxRunnerContextDelivery(contextSnapshot);
    await writeFile(runnerPath, mobileMailboxRunnerScript(), { mode: 0o755 });
    await writeFile(codexPath, fakeMcpCodexScript(), { mode: 0o755 });
    await postJson(mailboxUrl, {
      events: [
        ...contextDelivery.chunks.map((chunk, index) => envelope(
          `context-event-${index}`,
          "desktop-origin",
          index + 1,
          MOBILE_RUNNER_CONTEXT_KIND,
          chunk
        )),
        envelope(
          "policy-event",
          "desktop-origin",
          contextDelivery.chunks.length + 1,
          MOBILE_RUNNER_POLICY_KIND,
          mobileMailboxRunnerPolicyFromConversation(conversation(), undefined, contextDelivery.ref)
        ),
        envelope("mobile-event", "mobile-origin", 1, "message.created", {
          content: "@codex inspect App MCP"
        })
      ]
    });

    const result = await runNode(runnerPath, {
      ACCORD_MOBILE_MAILBOX_URL: mailboxUrl,
      ACCORD_MOBILE_RUNNER_ORIGIN_ID: "runner-origin",
      ACCORD_MOBILE_CODEX_PATH: codexPath,
      ACCORD_MOBILE_RUNNER_STATE: path.join(directory, "state.json"),
      ACCORD_MOBILE_RUNNER_ONCE: "1"
    });
    assert.equal(result.code, 0, result.stderr);

    const events = unsealEvents((await getJson(mailboxUrl)).events);
    const toolPost = events.find((event) => {
      const message = (event.payload as { message?: ChatMessage }).message;
      return event.kind === "message.created" && message?.content === "fake mid-run update";
    });
    assert.ok(toolPost, "app_chat_send_message must append to the shared mailbox log");
    const resultMessage = events.find((event) => {
      const message = (event.payload as { message?: ChatMessage }).message;
      return event.kind === "message.created" && message?.metadata?.mobileEventId === "mobile-event";
    });
    const report = JSON.parse((resultMessage?.payload as { message?: ChatMessage }).message?.content ?? "{}") as {
      toolNames?: string[];
      contextMessageIds?: string[];
      attachmentData?: string;
    };
    assert.deepEqual(
      report.toolNames,
      REMOTE_APP_MCP_TOOL_CONTRACTS.map((contract) => contract.definition.name)
    );
    assert.deepEqual(report.contextMessageIds, ["message-1", "mobile-mobile-event"]);
    assert.equal(report.attachmentData, "cG5n");
  } finally {
    await mailbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mobile mailbox runner materializes a delta, prunes removed records, and retains unchanged attachment bytes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-mobile-mailbox-runner-delta-"));
  const mailbox = createReferenceMailboxServer({ locked: true });
  const address = await mailbox.listen();
  const mailboxUrl = `${address.url}/v1/mailbox/events?mailboxId=runner-delta-test`;
  const statePath = path.join(directory, "state.json");
  await registerTestMailbox(address.url, "runner-delta-test");
  try {
    const runnerPath = path.join(directory, "mobile-runner.js");
    const codexPath = path.join(directory, "fake-mcp-codex.js");
    const initialSnapshot = {
      conversationId: "conversation-1",
      messages: [
        { id: "message-removed", sequence: 0, role: "user", author: "User", content: "old", createdAt: "2026-08-12T00:00:00.000Z", status: "done" },
        { id: "message-kept", sequence: 1, role: "user", author: "User", content: "kept", createdAt: "2026-08-12T00:00:01.000Z", status: "done" }
      ],
      messageWindow: { maxSequence: 1, totalMessages: 2, oldestIncludedSequence: 0 },
      attachments: [
        { messageId: "message-removed", sequence: 0, attachment: { id: "attachment-removed" }, dataBase64: "b2xk" },
        { messageId: "message-kept", sequence: 1, attachment: { id: "attachment-1" }, dataBase64: "cG5n" }
      ],
      attachmentWindow: { omittedCount: 0, limit: 6 },
      participants: [{ id: "participant-codex", handle: "codex", kind: "codex-cli", remoteExecution: "remote" }]
    };
    const initial = mobileMailboxRunnerContextDelivery(initialSnapshot);
    await writeFile(runnerPath, mobileMailboxRunnerScript(), { mode: 0o755 });
    await writeFile(codexPath, fakeMcpCodexScript(), { mode: 0o755 });
    await postJson(mailboxUrl, {
      events: [
        ...initial.chunks.map((chunk, index) => envelope(`initial-context-${index}`, "desktop-origin", index + 1, MOBILE_RUNNER_CONTEXT_KIND, chunk)),
        envelope("initial-policy", "desktop-origin", initial.chunks.length + 1, MOBILE_RUNNER_POLICY_KIND,
          mobileMailboxRunnerPolicyFromConversation(conversation(), undefined, initial.ref))
      ]
    });
    const first = await runNode(runnerPath, {
      ACCORD_MOBILE_MAILBOX_URL: mailboxUrl,
      ACCORD_MOBILE_RUNNER_ORIGIN_ID: "runner-origin",
      ACCORD_MOBILE_CODEX_PATH: codexPath,
      ACCORD_MOBILE_RUNNER_STATE: statePath,
      ACCORD_MOBILE_RUNNER_ONCE: "1"
    });
    assert.equal(first.code, 0, first.stderr);

    const nextSnapshot = {
      ...initialSnapshot,
      messages: [
        { ...initialSnapshot.messages[1], sequence: 0 },
        { id: "message-new", sequence: 1, role: "user", author: "User", content: "new", createdAt: "2026-08-12T00:00:02.000Z", status: "done" }
      ],
      messageWindow: { maxSequence: 1, totalMessages: 3, oldestIncludedSequence: 0 },
      attachments: [{
        ...initialSnapshot.attachments[1],
        sequence: 0,
        dataBase64: undefined,
        dataBase64Omitted: true
      }]
    };
    const delta = mobileMailboxRunnerContextDelivery(nextSnapshot, initial.nextState);
    assert.equal(delta.chunks.some((chunk) =>
      chunk.fragments?.some((fragment) => fragment.key.startsWith("attachment:"))), false);
    await postJson(mailboxUrl, {
      events: [
        ...delta.chunks.map((chunk, index) => envelope(`delta-context-${index}`, "desktop-origin", 100 + index, MOBILE_RUNNER_CONTEXT_KIND, chunk)),
        envelope("delta-policy", "desktop-origin", 200, MOBILE_RUNNER_POLICY_KIND,
          mobileMailboxRunnerPolicyFromConversation(conversation(), undefined, delta.ref)),
        envelope("delta-mobile-event", "mobile-origin", 1, "message.created", { content: "@codex inspect delta" })
      ]
    });
    const second = await runNode(runnerPath, {
      ACCORD_MOBILE_MAILBOX_URL: mailboxUrl,
      ACCORD_MOBILE_RUNNER_ORIGIN_ID: "runner-origin",
      ACCORD_MOBILE_CODEX_PATH: codexPath,
      ACCORD_MOBILE_RUNNER_STATE: statePath,
      ACCORD_MOBILE_RUNNER_ONCE: "1"
    });
    assert.equal(second.code, 0, second.stderr);

    const events = unsealEvents((await getJson(mailboxUrl)).events);
    const resultMessage = events.find((event) => {
      const message = (event.payload as { message?: ChatMessage }).message;
      return event.kind === "message.created" && message?.metadata?.mobileEventId === "delta-mobile-event";
    });
    const report = JSON.parse((resultMessage?.payload as { message?: ChatMessage }).message?.content ?? "{}") as {
      contextMessages?: Array<{ id: string; sequence?: number }>;
      contextAttachmentIds?: string[];
      attachmentData?: string;
    };
    assert.deepEqual(report.contextMessages?.slice(0, 2), [
      { id: "message-kept", sequence: 0 },
      { id: "message-new", sequence: 1 }
    ]);
    assert.deepEqual(report.contextAttachmentIds, ["attachment-1"]);
    assert.equal(report.attachmentData, "cG5n");
    const persisted = JSON.parse(await readFile(`${statePath}.context`, "utf8")) as {
      contextSnapshotsByConversation: Record<string, { messagesById: Record<string, unknown>; attachmentsById: Record<string, unknown> }>;
    };
    assert.deepEqual(Object.keys(persisted.contextSnapshotsByConversation["conversation-1"].messagesById).sort(), ["message-kept", "message-new"]);
    assert.deepEqual(Object.keys(persisted.contextSnapshotsByConversation["conversation-1"].attachmentsById), ["attachment-1"]);
  } finally {
    await mailbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mobile mailbox runner fails closed on incomplete context and recovers from a complete reset", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-mobile-mailbox-runner-context-recovery-"));
  const mailbox = createReferenceMailboxServer({ locked: true });
  const address = await mailbox.listen();
  const mailboxUrl = `${address.url}/v1/mailbox/events?mailboxId=runner-context-recovery-test`;
  const markerPath = path.join(directory, "codex-invoked");
  await registerTestMailbox(address.url, "runner-context-recovery-test");
  try {
    const runnerPath = path.join(directory, "mobile-runner.js");
    const codexPath = path.join(directory, "fake-codex.js");
    const statePath = path.join(directory, "state.json");
    const delivery = mobileMailboxRunnerContextDelivery({
      conversationId: "conversation-1",
      messages: [{ id: "message-1", sequence: 0, role: "user", content: "context" }],
      attachments: []
    });
    assert.ok(delivery.chunks.length > 1);
    await writeFile(runnerPath, mobileMailboxRunnerScript(), { mode: 0o755 });
    await writeFile(codexPath, fakeCodexScript(markerPath), { mode: 0o755 });
    await postJson(mailboxUrl, {
      events: [
        ...delivery.chunks.slice(0, -1).map((chunk, index) => envelope(
          `incomplete-context-${index}`, "desktop-origin", index + 1, MOBILE_RUNNER_CONTEXT_KIND, chunk
        )),
        envelope("incomplete-policy", "desktop-origin", 50, MOBILE_RUNNER_POLICY_KIND,
          mobileMailboxRunnerPolicyFromConversation(conversation(), undefined, delivery.ref)),
        envelope("recovery-mobile-event", "mobile-origin", 1, "message.created", { content: "@codex wait for context" })
      ]
    });
    const first = await runNode(runnerPath, {
      ACCORD_MOBILE_MAILBOX_URL: mailboxUrl,
      ACCORD_MOBILE_RUNNER_ORIGIN_ID: "runner-origin",
      ACCORD_MOBILE_CODEX_PATH: codexPath,
      ACCORD_MOBILE_RUNNER_STATE: statePath,
      ACCORD_MOBILE_RUNNER_ONCE: "1"
    });
    assert.equal(first.code, 0, first.stderr);
    await assert.rejects(access(markerPath));

    await postJson(mailboxUrl, {
      events: [
        ...delivery.chunks.map((chunk, index) => envelope(
          `complete-context-${index}`, "desktop-origin", 100 + index, MOBILE_RUNNER_CONTEXT_KIND, chunk
        )),
        envelope("complete-policy", "desktop-origin", 150, MOBILE_RUNNER_POLICY_KIND,
          mobileMailboxRunnerPolicyFromConversation(conversation(), undefined, delivery.ref))
      ]
    });
    const second = await runNode(runnerPath, {
      ACCORD_MOBILE_MAILBOX_URL: mailboxUrl,
      ACCORD_MOBILE_RUNNER_ORIGIN_ID: "runner-origin",
      ACCORD_MOBILE_CODEX_PATH: codexPath,
      ACCORD_MOBILE_RUNNER_STATE: statePath,
      ACCORD_MOBILE_RUNNER_ONCE: "1"
    });
    assert.equal(second.code, 0, second.stderr);
    await access(markerPath);
  } finally {
    await mailbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mobile mailbox runner invokes mentioned remote Claude participant", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-mobile-mailbox-runner-claude-"));
  const mailbox = createReferenceMailboxServer({ locked: true });
  const address = await mailbox.listen();
  const mailboxUrl = `${address.url}/v1/mailbox/events?mailboxId=runner-claude-test`;
  await registerTestMailbox(address.url, "runner-claude-test");
  const argvPath = path.join(directory, "claude-argv.json");
  try {
    const runnerPath = path.join(directory, "mobile-runner.js");
    const claudePath = path.join(directory, "fake-claude.js");
    await writeFile(runnerPath, mobileMailboxRunnerScript(), { mode: 0o755 });
    await writeFile(claudePath, fakeClaudeScript(argvPath), { mode: 0o755 });
    await postJson(mailboxUrl, {
      events: [
        envelope("policy-event", "desktop-origin", 1, MOBILE_RUNNER_POLICY_KIND, mobileMailboxRunnerPolicyFromConversation(conversation([{
          id: "participant-claude",
          handle: "claude",
          kind: "claude-code",
          remoteExecution: "remote",
          agentMode: "auto"
        }]))),
        envelope("mobile-event", "mobile-origin", 1, "message.created", {
          content: "@claude run from phone"
        })
      ]
    });

    const result = await runNode(runnerPath, {
      ACCORD_MOBILE_MAILBOX_URL: mailboxUrl,
      ACCORD_MOBILE_RUNNER_ORIGIN_ID: "runner-origin",
      ACCORD_MOBILE_CLAUDE_PATH: claudePath,
      ACCORD_MOBILE_RUNNER_STATE: path.join(directory, "state.json"),
      ACCORD_MOBILE_RUNNER_ONCE: "1"
    });
    assert.equal(result.code, 0, result.stderr);

    const body = await getJson(mailboxUrl);
    const events = unsealEvents(body.events);
    const resultMessage = events.find((event) =>
      event.kind === "message.created" &&
      typeof (event.payload as { message?: ChatMessage }).message?.content === "string"
    );
    const argv = JSON.parse(await readFile(argvPath, "utf8")) as string[];
    assert.deepEqual(argv.slice(0, 5), ["-p", "--output-format", "json", "--permission-mode", "auto"]);
    const mcpConfigIndex = argv.indexOf("--mcp-config");
    assert.notEqual(mcpConfigIndex, -1);
    const mcpConfig = JSON.parse(argv[mcpConfigIndex + 1]) as {
      mcpServers?: { accord_agents?: { type?: string; url?: string; headers?: { Authorization?: string } } };
    };
    assert.equal(mcpConfig.mcpServers?.accord_agents?.type, "http");
    assert.match(mcpConfig.mcpServers?.accord_agents?.url ?? "", /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.match(mcpConfig.mcpServers?.accord_agents?.headers?.Authorization ?? "", /^Bearer [a-f0-9]{64}$/);
    const allowedToolsIndex = argv.indexOf("--allowedTools");
    assert.notEqual(allowedToolsIndex, -1);
    assert.deepEqual(
      argv[allowedToolsIndex + 1].split(","),
      REMOTE_APP_MCP_TOOL_CONTRACTS.map((contract) => `mcp__accord_agents__${contract.definition.name}`)
    );
    assert.equal((resultMessage?.payload as { message?: ChatMessage }).message?.content, "fake claude result");
    assert.equal((resultMessage?.payload as { message?: ChatMessage }).message?.participantLabel, "@claude");
  } finally {
    await mailbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mobile mailbox runner ignores outbox events outside the current mobile access policy", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-mobile-mailbox-runner-access-"));
  const mailbox = createReferenceMailboxServer({ locked: true });
  const address = await mailbox.listen();
  const mailboxUrl = `${address.url}/v1/mailbox/events?mailboxId=runner-access-test`;
  await registerTestMailbox(address.url, "runner-access-test");
  const codexMarker = path.join(directory, "codex-invoked");
  try {
    const runnerPath = path.join(directory, "mobile-runner.js");
    const codexPath = path.join(directory, "fake-codex.js");
    const policy = {
      ...mobileMailboxRunnerPolicyFromConversation(conversation()),
      mobileAccess: {
        originId: "current-mobile-origin",
        rendezvousId: "rv-current",
        expiresAt: "2099-01-01T00:00:00.000Z"
      }
    };
    await writeFile(runnerPath, mobileMailboxRunnerScript(), { mode: 0o755 });
    await writeFile(codexPath, fakeCodexScript(codexMarker), { mode: 0o755 });
    await postJson(mailboxUrl, {
      events: [
        envelope("policy-event", "desktop-origin", 1, MOBILE_RUNNER_POLICY_KIND, policy),
        envelope("mobile-event", "old-mobile-origin", 1, "message.created", {
          content: "@codex stale phone event"
        })
      ]
    });

    const result = await runNode(runnerPath, {
      ACCORD_MOBILE_MAILBOX_URL: mailboxUrl,
      ACCORD_MOBILE_RUNNER_ORIGIN_ID: "runner-origin",
      ACCORD_MOBILE_CODEX_PATH: codexPath,
      ACCORD_MOBILE_RUNNER_STATE: path.join(directory, "state.json"),
      ACCORD_MOBILE_RUNNER_ONCE: "1"
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await fileExists(codexMarker), false);

    const body = await getJson(mailboxUrl);
    const events = unsealEvents(body.events);
    const resultMessages = events.filter((event) => {
      const message = (event.payload as { message?: ChatMessage }).message;
      return event.kind === "message.created" &&
        message?.metadata?.mobileEventId === "mobile-event";
    });
    assert.equal(resultMessages.length, 0);
  } finally {
    await mailbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mobile mailbox runner holds an operation lease only while processing a cloud message", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-mobile-mailbox-runner-lease-"));
  const mailbox = createReferenceMailboxServer({ locked: true });
  const address = await mailbox.listen();
  const mailboxUrl = `${address.url}/v1/mailbox/events?mailboxId=runner-lease-test`;
  await registerTestMailbox(address.url, "runner-lease-test");
  const leasePath = path.join(directory, "mobile-runner-lease.json");
  try {
    const runnerPath = path.join(directory, "mobile-runner.js");
    const codexPath = path.join(directory, "fake-codex.js");
    await writeFile(runnerPath, mobileMailboxRunnerScript(), { mode: 0o755 });
    await writeFile(codexPath, fakeCodexScript(), { mode: 0o755 });
    await postJson(mailboxUrl, {
      events: [
        envelope("policy-event", "desktop-origin", 1, MOBILE_RUNNER_POLICY_KIND, mobileMailboxRunnerPolicyFromConversation(conversation())),
        envelope("mobile-event", "mobile-origin", 1, "message.created", {
          content: "@codex run from phone"
        })
      ]
    });

    const child = spawn(process.execPath, [runnerPath], {
      env: {
        ...process.env,
        ...TEST_RUNNER_AUTH_ENV,
        ACCORD_MOBILE_MAILBOX_URL: mailboxUrl,
        ACCORD_MOBILE_RUNNER_ORIGIN_ID: "runner-origin",
        ACCORD_MOBILE_CODEX_PATH: codexPath,
        ACCORD_MOBILE_RUNNER_STATE: path.join(directory, "state.json"),
        ACCORD_MOBILE_RUNNER_OPERATION_LEASE_PATH: leasePath,
        ACCORD_MOBILE_RUNNER_OPERATION_LEASE_OWNER: "mobile-mailbox-runner:lease-test",
        ACCORD_MOBILE_RUNNER_ONCE: "1",
        FAKE_CODEX_DELAY_MS: "250"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const runningLease = await waitForFile(leasePath, 2_000);
    assert.equal(runningLease, true, "operation lease must appear while codex is running");
    const result = await waitForChild(child);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await fileExists(leasePath), false, "operation lease must be released after the mobile run");
  } finally {
    await mailbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mobile mailbox runner publishes one canonical result when overlapping processes read the same mobile event", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-mobile-mailbox-runner-overlap-"));
  const mailbox = createReferenceMailboxServer({ locked: true });
  const address = await mailbox.listen();
  const mailboxUrl = `${address.url}/v1/mailbox/events?mailboxId=runner-overlap-test`;
  await registerTestMailbox(address.url, "runner-overlap-test");
  try {
    const runnerPath = path.join(directory, "mobile-runner.js");
    const codexPath = path.join(directory, "fake-codex.js");
    await writeFile(runnerPath, mobileMailboxRunnerScript(), { mode: 0o755 });
    await writeFile(codexPath, fakeCodexScript(), { mode: 0o755 });
    await postJson(mailboxUrl, {
      events: [
        envelope("policy-event", "desktop-origin", 1, MOBILE_RUNNER_POLICY_KIND, mobileMailboxRunnerPolicyFromConversation(conversation())),
        envelope("mobile-event", "mobile-origin", 1, "message.created", {
          content: "@codex run from phone"
        })
      ]
    });

    const baseEnv = {
      ACCORD_MOBILE_MAILBOX_URL: mailboxUrl,
      ACCORD_MOBILE_CODEX_PATH: codexPath,
      ACCORD_MOBILE_RUNNER_ONCE: "1",
      FAKE_CODEX_DELAY_MS: "200"
    };
    const [first, second] = await Promise.all([
      runNode(runnerPath, {
        ...baseEnv,
        ACCORD_MOBILE_RUNNER_ORIGIN_ID: "runner-origin-a",
        ACCORD_MOBILE_RUNNER_STATE: path.join(directory, "state-a.json")
      }),
      runNode(runnerPath, {
        ...baseEnv,
        ACCORD_MOBILE_RUNNER_ORIGIN_ID: "runner-origin-b",
        ACCORD_MOBILE_RUNNER_STATE: path.join(directory, "state-b.json")
      })
    ]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);

    const body = await getJson(mailboxUrl);
    const events = unsealEvents(body.events);
    const resultMessages = events.filter((event) => {
      const message = (event.payload as { message?: ChatMessage }).message;
      return event.kind === "message.created" &&
        message?.metadata?.mobileEventId === "mobile-event";
    });
    const terminalTimelineEvents = events.flatMap((event) => {
      const payload = event.payload as { events?: Array<{ mobileEventId?: string; status?: string }> };
      return event.kind === "mobile.timeline.events" && Array.isArray(payload.events)
        ? payload.events
        : [];
    }).filter((event) =>
      event.mobileEventId === "mobile-event" &&
      event.status !== "pending"
    );
    assert.equal(resultMessages.length, 1);
    assert.equal(terminalTimelineEvents.length, 1);
  } finally {
    await mailbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mobile mailbox runner drains every queued command across ticks without skipping any", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-mobile-mailbox-runner-drain-"));
  const mailbox = createReferenceMailboxServer({ locked: true });
  const address = await mailbox.listen();
  const mailboxUrl = `${address.url}/v1/mailbox/events?mailboxId=runner-drain-test`;
  await registerTestMailbox(address.url, "runner-drain-test");
  try {
    const runnerPath = path.join(directory, "mobile-runner.js");
    const codexPath = path.join(directory, "fake-codex.js");
    const statePath = path.join(directory, "state.json");
    await writeFile(runnerPath, mobileMailboxRunnerScript(), { mode: 0o755 });
    await writeFile(codexPath, fakeCodexScript(), { mode: 0o755 });
    // One policy plus three commands in the same box. A cursor that advanced
    // past the whole page after processing only the first command would strand
    // the other two forever; the runner must drain all three across ticks.
    await postJson(mailboxUrl, {
      events: [
        envelope("policy-event", "desktop-origin", 1, MOBILE_RUNNER_POLICY_KIND, mobileMailboxRunnerPolicyFromConversation(conversation())),
        envelope("mobile-a", "mobile-origin", 1, "message.created", { content: "@codex command a" }),
        envelope("mobile-b", "mobile-origin", 2, "message.created", { content: "@codex command b" }),
        envelope("mobile-c", "mobile-origin", 3, "message.created", { content: "@codex command c" })
      ]
    });

    // `once` processes one command per invocation; three invocations sharing
    // one state.json must resolve all three distinct commands.
    for (let tick = 0; tick < 3; tick += 1) {
      const result = await runNode(runnerPath, {
        ACCORD_MOBILE_MAILBOX_URL: mailboxUrl,
        ACCORD_MOBILE_RUNNER_ORIGIN_ID: "runner-origin",
        ACCORD_MOBILE_CODEX_PATH: codexPath,
        ACCORD_MOBILE_RUNNER_STATE: statePath,
        ACCORD_MOBILE_RUNNER_ONCE: "1"
      });
      assert.equal(result.code, 0, result.stderr);
    }

    const events = unsealEvents((await getJson(mailboxUrl)).events);
    const fulfilled = new Set(
      events
        .filter((event) => event.kind === "message.created")
        .map((event) => (event.payload as { message?: ChatMessage }).message?.metadata?.mobileEventId)
        .filter((id): id is string => typeof id === "string")
    );
    assert.deepEqual([...fulfilled].sort(), ["mobile-a", "mobile-b", "mobile-c"]);
  } finally {
    await mailbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mobile mailbox runner does not invoke codex when another owner holds the execution claim", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-mobile-mailbox-runner-claimed-"));
  const mailbox = createReferenceMailboxServer({ locked: true });
  const address = await mailbox.listen();
  const mailboxUrl = `${address.url}/v1/mailbox/events?mailboxId=runner-claimed-test`;
  await registerTestMailbox(address.url, "runner-claimed-test");
  const claimUrl = `${address.url}/v1/mailbox/claims?mailboxId=runner-claimed-test`;
  const codexMarker = path.join(directory, "codex-invoked");
  try {
    const runnerPath = path.join(directory, "mobile-runner.js");
    const codexPath = path.join(directory, "fake-codex.js");
    await writeFile(runnerPath, mobileMailboxRunnerScript(), { mode: 0o755 });
    await writeFile(codexPath, fakeCodexScript(codexMarker), { mode: 0o755 });
    await postJson(mailboxUrl, {
      events: [
        envelope("policy-event", "desktop-origin", 1, MOBILE_RUNNER_POLICY_KIND, mobileMailboxRunnerPolicyFromConversation(conversation())),
        envelope("mobile-event", "mobile-origin", 1, "message.created", {
          content: "@codex run from phone"
        })
      ]
    });
    await postJson(claimUrl, {
      conversationId: "conversation-1",
      eventId: "mobile-event",
      ownerId: "desktop:route-1",
      ownerRole: "desktop",
      runId: "mobile-mobile-event",
      ttlMs: 60_000
    });

    const result = await runNode(runnerPath, {
      ACCORD_MOBILE_MAILBOX_URL: mailboxUrl,
      ACCORD_MOBILE_RUNNER_ORIGIN_ID: "runner-origin",
      ACCORD_MOBILE_CODEX_PATH: codexPath,
      ACCORD_MOBILE_RUNNER_STATE: path.join(directory, "state.json"),
      ACCORD_MOBILE_RUNNER_ONCE: "1"
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await fileExists(codexMarker), false);

    const body = await getJson(mailboxUrl);
    const events = unsealEvents(body.events);
    const resultMessages = events.filter((event) => {
      const message = (event.payload as { message?: ChatMessage }).message;
      return event.kind === "message.created" &&
        message?.metadata?.mobileEventId === "mobile-event";
    });
    assert.equal(resultMessages.length, 0);
  } finally {
    await mailbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function conversation(participants: NonNullable<Conversation["metadata"]>["participants"] = [{
  id: "participant-codex",
  handle: "codex",
  kind: "codex-cli",
  remoteExecution: "remote"
}]): Conversation {
  return {
    id: "conversation-1",
    title: "Mobile QA",
    kind: "chat",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:01.000Z",
    repoPath: "/repo",
    messages: [{
      id: "message-1",
      role: "user",
      content: "previous",
      createdAt: "2026-08-12T00:00:01.000Z",
      metadata: {}
    }],
    findings: [],
    metadata: {
      participants
    }
  };
}

function envelope(
  eventId: string,
  originId: string,
  originSeq: number,
  kind: string,
  payload: unknown
): ChatEventEnvelope {
  return {
    eventId,
    conversationId: "conversation-1",
    logScopeId: "conversation-1",
    originId,
    originSeq,
    logicalTs: `${String(originSeq).padStart(16, "0")}:${originId}:conversation-1`,
    kind,
    payload: sealTestPayload(payload),
    payloadHash: `sha256:${eventId}:payload`,
    eventHash: `sha256:${eventId}:event`,
    keyId: originId,
    signature: "test-signature",
    createdAt: "2026-08-12T00:00:02.000Z"
  } as ChatEventEnvelope;
}

function fakeCodexScript(markerPath?: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const delayMs = Math.max(0, Number(process.env.FAKE_CODEX_DELAY_MS || 0));
if (delayMs > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}
${markerPath ? `fs.writeFileSync(${JSON.stringify(markerPath)}, "invoked");` : ""}
const index = process.argv.indexOf("--output-last-message");
if (index >= 0 && process.argv[index + 1]) {
  fs.writeFileSync(process.argv[index + 1], "fake cloud result");
}
process.exit(0);
`;
}

function fakeMcpCodexScript(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const urlSetting = process.argv.find((arg) => arg.startsWith("mcp_servers.accord_agents.url="));
const url = JSON.parse(urlSetting.slice("mcp_servers.accord_agents.url=".length));
const token = process.env.ACCORD_AGENTS_MCP_TOKEN;
let requestId = 0;
async function rpc(method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, ...(params ? { params } : {}) })
  });
  const body = await response.json();
  if (body.error) { throw new Error(body.error.message); }
  return body.result;
}
async function main() {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-codex", version: "1" } });
  const listed = await rpc("tools/list");
  const context = await rpc("tools/call", { name: "app_chat_get_context", arguments: {} });
  const attachment = await rpc("tools/call", { name: "app_chat_read_attachment", arguments: { attachmentId: "attachment-1" } });
  await rpc("tools/call", { name: "app_chat_send_message", arguments: { content: "fake mid-run update" } });
  const parsedContext = JSON.parse(context.content[0].text);
  const report = {
    toolNames: listed.tools.map((tool) => tool.name),
    contextMessageIds: parsedContext.snapshot.messages.map((message) => message.id),
    contextMessages: parsedContext.snapshot.messages.map((message) => ({ id: message.id, sequence: message.sequence })),
    contextAttachmentIds: parsedContext.snapshot.attachments.map((item) => item.attachment.id),
    attachmentData: attachment.content[1].data
  };
  const index = process.argv.indexOf("--output-last-message");
  fs.writeFileSync(process.argv[index + 1], JSON.stringify(report));
}
main().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
`;
}

function fakeClaudeScript(argvPath?: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  ${argvPath ? `fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));` : ""}
  process.stdout.write(JSON.stringify({
    result: "fake claude result",
    session_id: "11111111-1111-4111-8111-111111111111"
  }) + "\\n");
});
`;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TEST_MAILBOX_TOKEN}`
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return text.trim() ? JSON.parse(text) : {};
}

async function getJson(url: string): Promise<{ events?: unknown[] }> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${TEST_MAILBOX_TOKEN}` }
  });
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return (text.trim() ? JSON.parse(text) : {}) as { events?: unknown[] };
}

function runNode(scriptPath: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ...TEST_RUNNER_AUTH_ENV, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fileExists(file)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
