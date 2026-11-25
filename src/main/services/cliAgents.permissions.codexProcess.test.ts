import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CliAgentRunner, CodexAppServerRunError } from "./cliAgents";
import { cliParts } from "./cliAgents/test/cliParts";
import type { CodexServerRequestDelivery } from "./codexApprovals";
import type { ParticipantRunResult } from "./providers";
import { assertFixtureProcessStops, makeRunner, testProcessExists, writeCodexAppServerFixture } from "./cliAgents/test/runnerFixtures";

// Claude Code's own config on this computer (Claude in Chrome, for one) must
// not decide these tests: an empty config folder is a fresh Claude Code.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "aa-claude-config-"));

test("codex app-server is launched with a member's provider overrides before --listen, sees the key only in env, and closeWarmAgents retires it", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-app-server-host-"));
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: "thread-fixture" }, model: "glm-5.3" } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-fixture" } } });
    const report = JSON.stringify({ argv: process.argv.slice(1), keyPresent: process.env.CODEX_PROVIDER_HOST_API_KEY === "zai-secret" });
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-fixture", turnId: "turn-fixture", itemId: "agent-fixture", delta: report } });
    send({ method: "item/completed", params: { threadId: "thread-fixture", turnId: "turn-fixture", item: { id: "agent-fixture", type: "agentMessage", text: report } } });
    send({ method: "turn/completed", params: { threadId: "thread-fixture", turn: { id: "turn-fixture", status: "completed" } } });
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  const overrides = ['model_provider="accordagents_host"', 'model_providers.accordagents_host.env_key="CODEX_PROVIDER_HOST_API_KEY"'];
  try {
    const result = await cliParts(runner).codexRuns.runCodexAppServerWarmOrOneShot(
      { id: "participant-fixture", kind: "codex-cli", label: "Codex", codexConfigOverrides: overrides },
      "Report your launch.",
      fixtureDir,
      undefined,
      "chat",
      undefined,
      {
        agentMode: "default",
        agentEnv: { CODEX_PROVIDER_HOST_API_KEY: "zai-secret" },
        agentEnvKey: "host:h1",
        warm: { conversationId: "conversation-fixture", participantId: "participant-fixture", contextKey: "context-fixture", idleTimeoutMs: 60_000 }
      }
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    const report = JSON.parse(result.content) as { argv: string[]; keyPresent: boolean };
    const listenIndex = report.argv.indexOf("--listen");
    for (const override of overrides) {
      const index = report.argv.indexOf(override);
      assert.ok(index > 0 && report.argv[index - 1] === "-c", report.argv.join(" "));
      assert.ok(index < listenIndex, "overrides precede --listen");
    }
    assert.equal(report.argv.some((arg) => arg.includes("zai-secret")), false, "key never in argv");
    assert.equal(report.keyPresent, true, "key reaches the process env");
    assert.equal(cliParts(runner).warmAgents.entries.size, 1);
    await runner.closeWarmAgents("conversation-fixture", "participant-fixture", "provider-binding-changed");
    assert.equal(cliParts(runner).warmAgents.entries.size, 0);
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("codex app-server production transport round-trips an approval and acknowledges delivery", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-app-server-"));
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (message.params?.capabilities?.requestAttestation !== false) process.exit(21);
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: "thread-fixture" }, model: "gpt-5" } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-fixture" } } });
    send({ method: "turn/started", params: { threadId: "thread-fixture", turn: { id: "turn-fixture" } } });
    send({
      id: "approval-fixture",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-fixture",
        turnId: "turn-fixture",
        itemId: "item-fixture",
        startedAtMs: 1,
        environmentId: null,
        command: "git push origin scratch",
        cwd: process.cwd(),
        availableDecisions: ["accept", "decline"]
      }
    });
    return;
  }
  if (message.id === "approval-fixture") {
    if (message.result?.decision !== "accept") process.exit(22);
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-fixture", turnId: "turn-fixture", itemId: "agent-fixture", delta: "Approval delivered." } });
    send({ method: "item/completed", params: { threadId: "thread-fixture", turnId: "turn-fixture", item: { id: "agent-fixture", type: "agentMessage", text: "Approval delivered." } } });
    send({ method: "turn/completed", params: { threadId: "thread-fixture", turn: { id: "turn-fixture", status: "completed" } } });
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  let delivered = false;
  try {
    const result = await cliParts(runner).codexRuns.runCodexAppServerWarmOrOneShot(
      { id: "participant-fixture", kind: "codex-cli", label: "Codex" },
      "Run the protected command.",
      fixtureDir,
      undefined,
      "chat",
      undefined,
      {
        agentMode: "auto",
        warm: {
          conversationId: "conversation-fixture",
          participantId: "participant-fixture",
          contextKey: "context-fixture",
          idleTimeoutMs: 60_000
        },
        onCodexServerRequest: async (request: { method: string; responseDelivered: Promise<void> }) => {
          assert.equal(request.method, "item/commandExecution/requestApproval");
          void request.responseDelivered.then(() => { delivered = true; });
          return { decision: "accept" };
        }
      }
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.content, /Approval delivered/);
    assert.equal(delivered, true);
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("codex app-server production transport returns method-specific results for every direct approval method", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-direct-methods-"));
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const permissions = { network: { enabled: true }, fileSystem: null };
const approvals = [
  { id: "direct-command", method: "item/commandExecution/requestApproval", params: {
    threadId: "thread-methods", turnId: "turn-methods", itemId: "item-command", startedAtMs: 1,
    approvalId: "callback-a", environmentId: null, command: "git status", cwd: process.cwd(), availableDecisions: ["acceptForSession"]
  }, expected: { decision: "acceptForSession" } },
  { id: "direct-command-b", method: "item/commandExecution/requestApproval", params: {
    threadId: "thread-methods", turnId: "turn-methods", itemId: "item-command", startedAtMs: 1,
    approvalId: "callback-b", environmentId: null, command: "git status", cwd: process.cwd(), availableDecisions: ["decline"]
  }, expected: { decision: "decline" } },
  { id: "direct-file", method: "item/fileChange/requestApproval", params: {
    threadId: "thread-methods", turnId: "turn-methods", itemId: "item-file", startedAtMs: 2,
    reason: null, grantRoot: null
  }, expected: { decision: "accept" } },
  { id: "direct-permissions", method: "item/permissions/requestApproval", params: {
    threadId: "thread-methods", turnId: "turn-methods", itemId: "item-permissions", environmentId: null,
    startedAtMs: 3, cwd: process.cwd(), reason: "Need network", permissions
  }, expected: { permissions, scope: "turn" } },
  { id: "legacy-command", method: "execCommandApproval", params: {
    conversationId: "thread-methods", callId: "call-command", approvalId: "subcommand-1",
    command: ["printf", "two words"], cwd: process.cwd(), reason: null, parsedCmd: []
  }, expected: { decision: "approved_for_session" } },
  { id: "legacy-file", method: "applyPatchApproval", params: {
    conversationId: "thread-methods", callId: "call-file",
    fileChanges: { "scratch.txt": { type: "add", content: "safe" } }, reason: null, grantRoot: null
  }, expected: { decision: "approved" } }
];
let next = 0;
const sendNext = () => {
  if (approvals[next].id === "direct-file") {
    send({ method: "item/fileChange/patchUpdated", params: {
      threadId: "thread-methods", turnId: "turn-methods", itemId: "item-file",
      changes: [{ path: "scratch.txt", kind: { type: "update" } }]
    } });
  }
  send(approvals[next]);
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (message.params?.capabilities?.requestAttestation !== false) process.exit(31);
    if (message.method === "account/login/start") process.exit(32);
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-methods" }, model: "gpt-5" } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-methods" } } });
    send({ method: "turn/started", params: { threadId: "thread-methods", turn: { id: "turn-methods" } } });
    sendNext();
  } else if (next < approvals.length && message.id === approvals[next].id) {
    if (JSON.stringify(message.result) !== JSON.stringify(approvals[next].expected)) process.exit(33 + next);
    next += 1;
    if (next < approvals.length) {
      sendNext();
    } else {
      send({ method: "item/agentMessage/delta", params: { threadId: "thread-methods", turnId: "turn-methods", itemId: "agent-methods", delta: "All method-specific results delivered." } });
      send({ method: "item/completed", params: { threadId: "thread-methods", turnId: "turn-methods", item: { id: "agent-methods", type: "agentMessage", text: "All method-specific results delivered." } } });
      send({ method: "turn/completed", params: { threadId: "thread-methods", turn: { id: "turn-methods", status: "completed" } } });
    }
  } else if (message.method === "account/login/start") {
    process.exit(38);
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  const seen: string[] = [];
  try {
    const result = await cliParts(runner).codexRuns.runCodexAppServerWarmOrOneShot(
      { id: "participant-methods", kind: "codex-cli", label: "Codex" },
      "Exercise direct approvals.",
      fixtureDir,
      undefined,
      "chat",
      undefined,
      {
        agentMode: "auto",
        warm: {
          conversationId: "conversation-methods",
          participantId: "participant-methods",
          contextKey: "context-methods",
          idleTimeoutMs: 60_000
        },
        onCodexServerRequest: async (request: { method: string; params?: Record<string, unknown> }) => {
          seen.push(request.method);
          if (request.method === "item/commandExecution/requestApproval") {
            return seen.filter((method) => method === request.method).length === 1
              ? { decision: "acceptForSession" }
              : { decision: "decline" };
          }
          if (request.method === "item/fileChange/requestApproval") {
            assert.deepEqual(request.params?.fileChanges, [{ path: "scratch.txt", kind: { type: "update" } }]);
            return { decision: "accept" };
          }
          if (request.method === "item/permissions/requestApproval") return { permissions: { network: { enabled: true }, fileSystem: null }, scope: "turn" };
          if (request.method === "execCommandApproval") return { decision: "approved_for_session" };
          return { decision: "approved" };
        }
      }
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(seen, [
      "item/commandExecution/requestApproval",
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "execCommandApproval",
      "applyPatchApproval"
    ]);
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("codex app-server production transport sends the exact same-session Guardian override", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-guardian-override-"));
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-guardian" }, model: "gpt-5" } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-guardian" } } });
    send({ method: "turn/started", params: { threadId: "thread-guardian", turn: { id: "turn-guardian" } } });
    send({ method: "item/autoApprovalReview/completed", params: {
      threadId: "thread-guardian", turnId: "turn-guardian", startedAtMs: 10, completedAtMs: 20,
      reviewId: "review-guardian", targetItemId: "item-guardian", decisionSource: "agent",
      review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "Protected action" },
      action: { type: "command", source: "unifiedExec", command: "git push origin scratch", cwd: process.cwd() }
    } });
    send({ method: "item/completed", params: { threadId: "thread-guardian", turnId: "turn-guardian", item: {
      id: "item-guardian", type: "commandExecution", status: "failed", command: "git push origin scratch"
    } } });
    send({ method: "item/agentMessage/delta", params: {
      threadId: "thread-guardian", turnId: "turn-guardian", itemId: "agent-guardian", delta: "Guardian denial recorded."
    } });
    send({ method: "item/completed", params: { threadId: "thread-guardian", turnId: "turn-guardian", item: {
      id: "agent-guardian", type: "agentMessage", text: "Guardian denial recorded."
    } } });
    send({ method: "turn/completed", params: {
      threadId: "thread-guardian", turn: { id: "turn-guardian", status: "completed" }
    } });
  } else if (message.method === "thread/approveGuardianDeniedAction") {
    const event = message.params?.event;
    if (message.params?.threadId !== "thread-guardian" || event?.type !== "guardian_assessment" ||
      event?.id !== "review-guardian" || event?.target_item_id !== "item-guardian" || event?.turn_id !== "turn-guardian" ||
      event?.action?.type !== "command" || event?.action?.source !== "unified_exec") process.exit(51);
    send({ id: message.id, result: {} });
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  let deliveryAcknowledged = false;
  let guardianSignal: AbortSignal | undefined;
  let resolveDecision!: () => void;
  let resolveDelivery!: (receipt: CodexServerRequestDelivery) => void;
  let rejectDelivery!: (error: unknown) => void;
  const delivery = new Promise<CodexServerRequestDelivery>((resolve, reject) => {
    resolveDelivery = resolve;
    rejectDelivery = reject;
  });
  void delivery.catch(() => undefined);
  try {
    const result = await cliParts(runner).codexRuns.runCodexAppServerWarmOrOneShot(
      { id: "participant-guardian", kind: "codex-cli", label: "Codex" },
      "Retry the protected command.",
      fixtureDir,
      undefined,
      "chat",
      undefined,
      {
        agentMode: "auto",
        warm: {
          conversationId: "conversation-guardian",
          participantId: "participant-guardian",
          contextKey: "context-guardian",
          idleTimeoutMs: 60_000
        },
        onCodexServerRequest: (request: { method: string; signal: AbortSignal; responseDelivered: Promise<CodexServerRequestDelivery> }) => {
          assert.equal(request.method, "item/autoApprovalReview/denied");
          guardianSignal = request.signal;
          void request.responseDelivered.then((receipt) => {
            deliveryAcknowledged = true;
            resolveDelivery(receipt);
          }, rejectDelivery);
          return new Promise((resolve, reject) => {
            resolveDecision = () => resolve({ decision: "approveRetry" });
            request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
          });
        }
      }
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.content, /Guardian denial recorded/);
    assert.equal(guardianSignal?.aborted, false);
    assert.equal(deliveryAcknowledged, false);
    resolveDecision();
    const receipt = await Promise.race([
      delivery,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Guardian override was not acknowledged")), 1_500))
    ]);
    assert.equal(deliveryAcknowledged, true);
    // The turn had completed before the decision: Codex only records it, so
    // the chat must continue the participant with it.
    assert.deepEqual(receipt, { turnActive: false });
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("codex app-server reports a Guardian override delivered into the still-running turn", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-guardian-live-"));
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-guardian-live" }, model: "gpt-5" } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-guardian-live" } } });
    send({ method: "turn/started", params: { threadId: "thread-guardian-live", turn: { id: "turn-guardian-live" } } });
    send({ method: "item/autoApprovalReview/completed", params: {
      threadId: "thread-guardian-live", turnId: "turn-guardian-live", startedAtMs: 10, completedAtMs: 20,
      reviewId: "review-guardian-live", targetItemId: "item-guardian-live", decisionSource: "agent",
      review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "Protected action" },
      action: { type: "command", source: "unifiedExec", command: "git push origin scratch", cwd: process.cwd() }
    } });
    send({ method: "item/completed", params: { threadId: "thread-guardian-live", turnId: "turn-guardian-live", item: {
      id: "item-guardian-live", type: "commandExecution", status: "failed", command: "git push origin scratch"
    } } });
    // The turn keeps working: it ends only after the User's decision arrives.
  } else if (message.method === "thread/approveGuardianDeniedAction") {
    if (message.params?.threadId !== "thread-guardian-live" || message.params?.event?.id !== "review-guardian-live") process.exit(52);
    send({ id: message.id, result: {} });
    send({ method: "item/agentMessage/delta", params: {
      threadId: "thread-guardian-live", turnId: "turn-guardian-live", itemId: "agent-guardian-live", delta: "Retried inside the running turn."
    } });
    send({ method: "item/completed", params: { threadId: "thread-guardian-live", turnId: "turn-guardian-live", item: {
      id: "agent-guardian-live", type: "agentMessage", text: "Retried inside the running turn."
    } } });
    send({ method: "turn/completed", params: {
      threadId: "thread-guardian-live", turn: { id: "turn-guardian-live", status: "completed" }
    } });
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  let resolveDecision!: () => void;
  let resolveRequested!: () => void;
  const requested = new Promise<void>((resolve) => { resolveRequested = resolve; });
  let resolveDelivery!: (receipt: CodexServerRequestDelivery) => void;
  let rejectDelivery!: (error: unknown) => void;
  const delivery = new Promise<CodexServerRequestDelivery>((resolve, reject) => {
    resolveDelivery = resolve;
    rejectDelivery = reject;
  });
  void delivery.catch(() => undefined);
  try {
    const resultPromise: Promise<ParticipantRunResult> = cliParts(runner).codexRuns.runCodexAppServerWarmOrOneShot(
      { id: "participant-guardian-live", kind: "codex-cli", label: "Codex" },
      "Push the scratch branch.",
      fixtureDir,
      undefined,
      "chat",
      undefined,
      {
        agentMode: "auto",
        warm: {
          conversationId: "conversation-guardian-live",
          participantId: "participant-guardian-live",
          contextKey: "context-guardian-live",
          idleTimeoutMs: 60_000
        },
        onCodexServerRequest: (request: { method: string; signal: AbortSignal; responseDelivered: Promise<CodexServerRequestDelivery> }) => {
          assert.equal(request.method, "item/autoApprovalReview/denied");
          void request.responseDelivered.then(resolveDelivery, rejectDelivery);
          resolveRequested();
          return new Promise((resolve, reject) => {
            resolveDecision = () => resolve({ decision: "approveRetry" });
            request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
          });
        }
      }
    );
    await Promise.race([
      requested,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Guardian denial was not offered")), 1_500))
    ]);
    resolveDecision();
    const receipt = await Promise.race([
      delivery,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Guardian override was not acknowledged")), 1_500))
    ]);
    // Codex applies the decision inside the running turn: no continuation.
    assert.deepEqual(receipt, { turnActive: true });
    const result = await resultPromise;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.content, /Retried inside the running turn/);
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("codex app-server reports turnActive when the approval ack and turn/completed arrive in one stdout chunk", async () => {
  // Regression: sampling turnActive AFTER `await sendRequest` let a coalesced
  // ack+turn/completed clear pendingTurn first, yielding turnActive:false for a
  // retry Codex already ran in-turn — which restarted it a second time. The fake
  // writes the ack and the turn/completed in a single write to force coalescing.
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-guardian-coalesced-"));
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-guardian-coalesced" }, model: "gpt-5" } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-guardian-coalesced" } } });
    send({ method: "turn/started", params: { threadId: "thread-guardian-coalesced", turn: { id: "turn-guardian-coalesced" } } });
    send({ method: "item/autoApprovalReview/completed", params: {
      threadId: "thread-guardian-coalesced", turnId: "turn-guardian-coalesced", startedAtMs: 10, completedAtMs: 20,
      reviewId: "review-guardian-coalesced", targetItemId: "item-guardian-coalesced", decisionSource: "agent",
      review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "Protected action" },
      action: { type: "command", source: "unifiedExec", command: "git push origin scratch", cwd: process.cwd() }
    } });
    send({ method: "item/completed", params: { threadId: "thread-guardian-coalesced", turnId: "turn-guardian-coalesced", item: {
      id: "item-guardian-coalesced", type: "commandExecution", status: "failed", command: "git push origin scratch"
    } } });
  } else if (message.method === "thread/approveGuardianDeniedAction") {
    if (message.params?.threadId !== "thread-guardian-coalesced" || message.params?.event?.id !== "review-guardian-coalesced") process.exit(53);
    // One write: the approve ack AND the item/agentMessage + turn/completed for
    // the in-turn retry, so the runner parses them in a single data event.
    const lines = [
      { id: message.id, result: {} },
      { method: "item/agentMessage/delta", params: { threadId: "thread-guardian-coalesced", turnId: "turn-guardian-coalesced", itemId: "agent-guardian-coalesced", delta: "Retried inside the running turn." } },
      { method: "item/completed", params: { threadId: "thread-guardian-coalesced", turnId: "turn-guardian-coalesced", item: { id: "agent-guardian-coalesced", type: "agentMessage", text: "Retried inside the running turn." } } },
      { method: "turn/completed", params: { threadId: "thread-guardian-coalesced", turn: { id: "turn-guardian-coalesced", status: "completed" } } }
    ];
    process.stdout.write(lines.map((value) => JSON.stringify(value)).join("\\n") + "\\n");
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  let resolveDecision!: () => void;
  let resolveRequested!: () => void;
  const requested = new Promise<void>((resolve) => { resolveRequested = resolve; });
  let resolveDelivery!: (receipt: CodexServerRequestDelivery) => void;
  let rejectDelivery!: (error: unknown) => void;
  const delivery = new Promise<CodexServerRequestDelivery>((resolve, reject) => {
    resolveDelivery = resolve;
    rejectDelivery = reject;
  });
  void delivery.catch(() => undefined);
  try {
    const resultPromise: Promise<ParticipantRunResult> = cliParts(runner).codexRuns.runCodexAppServerWarmOrOneShot(
      { id: "participant-guardian-coalesced", kind: "codex-cli", label: "Codex" },
      "Push the scratch branch.",
      fixtureDir,
      undefined,
      "chat",
      undefined,
      {
        agentMode: "auto",
        warm: {
          conversationId: "conversation-guardian-coalesced",
          participantId: "participant-guardian-coalesced",
          contextKey: "context-guardian-coalesced",
          idleTimeoutMs: 60_000
        },
        onCodexServerRequest: (request: { method: string; signal: AbortSignal; responseDelivered: Promise<CodexServerRequestDelivery> }) => {
          assert.equal(request.method, "item/autoApprovalReview/denied");
          void request.responseDelivered.then(resolveDelivery, rejectDelivery);
          resolveRequested();
          return new Promise((resolve, reject) => {
            resolveDecision = () => resolve({ decision: "approveRetry" });
            request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
          });
        }
      }
    );
    await Promise.race([
      requested,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Guardian denial was not offered")), 1_500))
    ]);
    resolveDecision();
    const receipt = await Promise.race([
      delivery,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Guardian override was not acknowledged")), 1_500))
    ]);
    // The retry ran inside the turn; the receipt must say so even though
    // turn/completed was coalesced with the ack. Otherwise chat starts a
    // second continuation and the approved command runs twice.
    assert.deepEqual(receipt, { turnActive: true });
    const result = await resultPromise;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.content, /Retried inside the running turn/);
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("codex app-server expires a completed-turn Guardian denial before the next turn starts", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-guardian-next-turn-"));
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let turn = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-guardian-next" }, model: "gpt-5" } });
  } else if (message.method === "turn/start") {
    turn += 1;
    const turnId = "turn-guardian-" + turn;
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ method: "turn/started", params: { threadId: "thread-guardian-next", turn: { id: turnId } } });
    if (turn === 1) {
      send({ method: "item/autoApprovalReview/completed", params: {
        threadId: "thread-guardian-next", turnId, startedAtMs: 10, completedAtMs: 20,
        reviewId: "review-guardian-next", targetItemId: "item-guardian-next", decisionSource: "agent",
        review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "Protected action" },
        action: { type: "command", source: "unifiedExec", command: "git push origin scratch", cwd: process.cwd() }
      } });
      send({ method: "item/completed", params: { threadId: "thread-guardian-next", turnId, item: {
        id: "item-guardian-next", type: "commandExecution", status: "failed", command: "git push origin scratch"
      } } });
    }
    const text = turn === 1 ? "First turn completed." : "Second turn completed.";
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-guardian-next", turnId, itemId: "agent-" + turn, delta: text } });
    send({ method: "item/completed", params: { threadId: "thread-guardian-next", turnId, item: { id: "agent-" + turn, type: "agentMessage", text } } });
    send({ method: "turn/completed", params: { threadId: "thread-guardian-next", turn: { id: turnId, status: "completed" } } });
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  const participant = { id: "participant-guardian-next", kind: "codex-cli", label: "Codex" } as const;
  const warm = {
    conversationId: "conversation-guardian-next",
    participantId: "participant-guardian-next",
    contextKey: "context-guardian-next",
    idleTimeoutMs: 60_000
  };
  let approvalAborted = false;
  let guardianSignal: AbortSignal | undefined;
  try {
    const first = await cliParts(runner).codexRuns.runCodexAppServerWarmOrOneShot(
      participant,
      "Attempt the protected command.",
      fixtureDir,
      undefined,
      "chat",
      undefined,
      {
        agentMode: "auto",
        warm,
        onCodexServerRequest: (request: { signal: AbortSignal; responseDelivered: Promise<void> }) => {
          guardianSignal = request.signal;
          void request.responseDelivered.catch(() => undefined);
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener("abort", () => {
              approvalAborted = true;
              reject(request.signal.reason);
            }, { once: true });
          });
        }
      }
    );
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.match(first.content, /First turn completed/);
    assert.equal(guardianSignal?.aborted, false);

    const second = await cliParts(runner).codexRuns.runCodexAppServerWarmOrOneShot(
      participant,
      "Start a fresh turn.",
      fixtureDir,
      undefined,
      "chat",
      undefined,
      { agentMode: "auto", warm }
    );
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.match(second.content, /Second turn completed/);
    assert.equal(approvalAborted, true);
    assert.equal(guardianSignal?.aborted, true);
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Codex Stop still terminates the turn when the approval refusal pipe is dead", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-dead-pipe-"));
  const helperPidFile = path.join(fixtureDir, "dead-pipe-helper.pid");
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const readline = require("node:readline");
if (process.platform === "win32") {
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
}
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-dead-pipe" }, model: "gpt-5" } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-dead-pipe" } } });
    send({ method: "turn/started", params: { threadId: "thread-dead-pipe", turn: { id: "turn-dead-pipe" } } });
    send({ id: "approval-dead-pipe", method: "item/fileChange/requestApproval", params: {
      threadId: "thread-dead-pipe", turnId: "turn-dead-pipe", itemId: "item-dead-pipe", startedAtMs: 1, reason: null, grantRoot: null
    } });
    require("node:fs").closeSync(0);
    setInterval(() => {}, 1000);
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, { codexExecutable: codexPath, nativeProcessDbPath: path.join(fixtureDir, "native-processes.sqlite3") }) as any;
  const controller = new AbortController();
  let requestSeen!: () => void;
  let approvalAborted = false;
  let helperPid: number | undefined;
  const seen = new Promise<void>((resolve) => { requestSeen = resolve; });
  try {
    const run = cliParts(runner).codexRuns.runCodexAppServerWarmOrOneShot(
      { id: "participant-dead-pipe", kind: "codex-cli", label: "Codex" },
      "Apply the protected change.",
      fixtureDir,
      undefined,
      "chat",
      controller.signal,
      {
        agentMode: "auto",
        warm: {
          conversationId: "conversation-dead-pipe",
          participantId: "participant-dead-pipe",
          contextKey: "context-dead-pipe",
          idleTimeoutMs: 60_000
        },
        onCodexServerRequest: (request: { signal: AbortSignal }) => {
          requestSeen();
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener("abort", () => {
              approvalAborted = true;
              reject(request.signal.reason);
            }, { once: true });
          });
        }
      }
    );
    await seen;
    controller.abort(new Error("Stopped by user."));
    const result = await Promise.race([
      run,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Stop hung after dead approval pipe")), 1_500))
    ]);
    assert.equal(result.ok, false);
    assert.equal(approvalAborted, true);
    assert.match(result.error ?? "", /cancelled|Stopped by user|EPIPE/i);
    if (process.platform === "win32") {
      helperPid = Number.parseInt((await readFile(helperPidFile, "utf8")).trim(), 10);
      await assertFixtureProcessStops(helperPid);
    }
  } finally {
    await runner.shutdownWarmAgents();
    if (helperPid && testProcessExists(helperPid)) {
      process.kill(helperPid, "SIGKILL");
    }
    await rm(fixtureDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("Codex Stop waits for a detached command even after the provider exits", { timeout: 10_000 }, async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX detached process identity test");
    return;
  }
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-stop-detached-"));
  const helperPidFile = path.join(fixtureDir, "helper.pid");
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thread-detached" } } });
  if (message.method === "turn/interrupt") process.exit(0);
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-detached" } } });
    const helper = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready')"], {
      detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    helper.on("message", () => {
      writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
      send({ id: "ready", method: "item/commandExecution/requestApproval", params: {
        threadId: "thread-detached", turnId: "turn-detached", itemId: "detached-command", startedAtMs: 1,
        environmentId: null, command: "fixture", cwd: process.cwd(), availableDecisions: ["accept", "decline"]
      } });
    });
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, { codexExecutable: codexPath, nativeProcessDbPath: path.join(fixtureDir, "native-processes.sqlite3") }) as any;
  const controller = new AbortController();
  let ready!: () => void;
  const seen = new Promise<void>((resolve) => { ready = resolve; });
  let helperPid: number | undefined;
  try {
    const run = cliParts(runner).codexRuns.runCodexAppServerWarmOrOneShot(
      { id: "codex-detached", kind: "codex-cli", label: "Codex" }, "Wait.", fixtureDir,
      undefined, "chat", controller.signal, {
        agentMode: "auto",
        warm: { conversationId: "detached", participantId: "codex-detached", contextKey: "detached" },
        onCodexServerRequest: (request: { signal: AbortSignal }) => {
          ready();
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
          });
        }
      }
    );
    await seen;
    helperPid = Number((await readFile(helperPidFile, "utf8")).trim());
    assert.equal(testProcessExists(helperPid), true);
    controller.abort(new Error("Stopped by user."));
    const result = await run;
    assert.equal(result.ok, false);
    assert.equal(testProcessExists(helperPid), false, "Stop must not finish while a captured command survives");
  } finally {
    await runner.shutdownWarmAgents();
    if (helperPid && testProcessExists(helperPid)) process.kill(helperPid, "SIGKILL");
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Codex ignores cross-thread resolution and retires approval when its item completes", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "accord-codex-retire-approval-"));
  const codexPath = await writeCodexAppServerFixture(fixtureDir, `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOsName: "macos", platformArch: "arm64" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-retire" }, model: "gpt-5" } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-retire" } } });
    send({ method: "turn/started", params: { threadId: "thread-retire", turn: { id: "turn-retire" } } });
    send({ id: "approval-retire", method: "item/commandExecution/requestApproval", params: {
      threadId: "thread-retire", turnId: "turn-retire", itemId: "item-retire", startedAtMs: 1,
      environmentId: null, command: "git status", cwd: process.cwd(), availableDecisions: ["accept", "decline"]
    } });
    send({ method: "serverRequest/resolved", params: { threadId: "thread-other", requestId: "approval-retire" } });
    setTimeout(() => {
      send({ method: "item/completed", params: { threadId: "thread-retire", turnId: "turn-retire", item: {
        id: "item-retire", type: "commandExecution", status: "completed", command: "git status"
      } } });
      send({ method: "turn/completed", params: { threadId: "thread-retire", turn: { id: "turn-retire", status: "completed" } } });
    }, 75);
  }
});
`);
  const runner = new CliAgentRunner(undefined, undefined, codexPath) as any;
  let aborted = false;
  const output: string[] = [];
  try {
    const result = await cliParts(runner).codexRuns.runCodexAppServerWarmOrOneShot(
      { id: "participant-retire", kind: "codex-cli", label: "Codex" },
      "Run the protected command.",
      fixtureDir,
      undefined,
      "chat",
      undefined,
      {
        agentMode: "auto",
        warm: {
          conversationId: "conversation-retire",
          participantId: "participant-retire",
          contextKey: "context-retire",
          idleTimeoutMs: 60_000
        },
        onOutput: (event: { text?: string }) => { if (event.text) output.push(event.text); },
        onCodexServerRequest: (request: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            aborted = true;
            reject(request.signal.reason);
          }, { once: true });
        })
      }
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(aborted, true);
    assert.match(output.join(""), /Ignored serverRequest\/resolved for thread thread-other/);
  } finally {
    await runner.shutdownWarmAgents();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("codex app-server never replays a prompt after the provider accepted the turn", async () => {
  const runner = makeRunner() as any;
  let oneShotRuns = 0;
  cliParts(runner).codexAppServer.createCodexAppServerWarmAgent = () => ({
    key: "warm-key",
    scopeKey: "conversation-1:participant-1",
    providerKind: "codex-cli",
    process: { exitCode: null },
    queue: Promise.resolve(),
    closed: false,
    run: async () => {
      throw new CodexAppServerRunError(new Error("app-server disconnected"), true);
    }
  });
  cliParts(runner).warmAgentClose.closeWarmAgent = async () => undefined;
  cliParts(runner).codexRuns.runCodexOneShot = async () => {
    oneShotRuns += 1;
    return { ok: true, content: "REPLAYED" };
  };

  const result = await cliParts(runner).codexRuns.runCodexAppServerWarmOrOneShot(
    { id: "participant-1", kind: "codex-cli", label: "Codex" },
    "ONE_SHOT_PROMPT",
    "/tmp/repo",
    undefined,
    "chat",
    undefined,
    {
      warm: {
        conversationId: "conversation-1",
        participantId: "participant-1",
        contextKey: "context-1",
        idleTimeoutMs: 60_000
      }
    }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /app-server disconnected/);
  assert.equal(oneShotRuns, 0);
});

test("codex app-server initialization failure never replays a command through one-shot execution", async () => {
  const runner = makeRunner() as any;
  let oneShotRuns = 0;
  cliParts(runner).codexAppServer.createCodexAppServerWarmAgent = () => ({
    key: "warm-key",
    scopeKey: "conversation-1:participant-1",
    providerKind: "codex-cli",
    process: { exitCode: null },
    queue: Promise.resolve(),
    closed: false,
    run: async () => {
      throw new CodexAppServerRunError(new Error("initialize failed"), false);
    }
  });
  cliParts(runner).warmAgentClose.closeWarmAgent = async () => undefined;
  cliParts(runner).codexRuns.runCodexOneShot = async () => {
    oneShotRuns += 1;
    return { ok: true, content: "FALLBACK" };
  };

  const result = await cliParts(runner).codexRuns.runCodexAppServerWarmOrOneShot(
    { id: "participant-1", kind: "codex-cli", label: "Codex" },
    "PROMPT",
    "/tmp/repo",
    undefined,
    "chat",
    undefined,
    {
      warm: {
        conversationId: "conversation-1",
        participantId: "participant-1",
        contextKey: "context-1",
        idleTimeoutMs: 60_000
      }
    }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /initialize failed/);
  assert.equal(oneShotRuns, 0);
});
