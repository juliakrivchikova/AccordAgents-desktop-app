import { createHash } from "node:crypto";
import { REMOTE_APP_MCP_WORKER_CONTRACT_SNIPPET } from "./remoteAppMcpTools.generated";
import { MOBILE_MAILBOX_RUNNER_CRYPTO_SNIPPET } from "./mobileMailboxRunnerCrypto.generated";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { ChatMessage, ChatParticipant, Conversation } from "../../shared/types";
import type { MobilePairingPackage } from "../../shared/mobilePairing";

export const MOBILE_RUNNER_POLICY_KIND = "mobile.runner.policy";

export interface MobileMailboxRunnerParticipant {
  id: string;
  handle: string;
  kind: ChatParticipant["kind"];
  remoteExecution?: ChatParticipant["remoteExecution"];
  agentMode?: ChatParticipant["agentMode"];
  permissions?: ChatParticipant["permissions"];
  model?: string;
  reasoningEffort?: string;
}

export interface MobileMailboxRunnerPolicy {
  type: typeof MOBILE_RUNNER_POLICY_KIND;
  conversationId: string;
  title: string;
  updatedAt: string;
  participants: MobileMailboxRunnerParticipant[];
  recentMessages: Array<{
    role: ChatMessage["role"];
    participantId?: string;
    participantLabel?: string;
    content: string;
    createdAt: string;
  }>;
  contextSnapshot?: Record<string, unknown>;
  mobileAccess?: {
    originId: string;
    rendezvousId: string;
    expiresAt: string;
  };
}

export interface MobileMailboxRunnerInstallRequest {
  routeId: string;
  mailboxUrl: string;
  /** Bearer token for the pairing's locked mailbox; every read, write, and
   *  claim the runner makes must present it. */
  mailboxToken: string;
  /** Pairing seal key so the runner can open sealed mailbox payloads and seal
   *  its own appends; the relay only ever stores ciphertext. */
  relaySealKeyBase64: string;
  workerRoot?: string;
  codexPath?: string;
  claudePath?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export function mobileMailboxRunnerPolicyFromConversation(
  conversation: Conversation,
  pairing?: MobilePairingPackage,
  contextSnapshot?: Record<string, unknown>
): MobileMailboxRunnerPolicy {
  return {
    type: MOBILE_RUNNER_POLICY_KIND,
    conversationId: conversation.id,
    title: conversation.title || "Chat",
    updatedAt: conversation.updatedAt,
    participants: mobileMailboxRunnerParticipants(conversation),
    recentMessages: conversation.messages
      .filter((message) => message.role !== "summary" && Boolean(message.content.trim()))
      .slice(-40)
      .map((message) => ({
        role: message.role,
        ...(message.participantId ? { participantId: message.participantId } : {}),
        ...(message.participantLabel ? { participantLabel: message.participantLabel } : {}),
        content: message.content,
        createdAt: message.createdAt
      })),
    ...(contextSnapshot ? { contextSnapshot } : {}),
    ...(pairing ? {
      mobileAccess: {
        originId: mobileOriginIdForPairing(pairing),
        rendezvousId: pairing.rendezvousId,
        expiresAt: pairing.expiresAt
      }
    } : {})
  };
}

export function isMobileRunnerPolicyEvent(event: ChatEventEnvelope): boolean {
  const payload = event.payload as Partial<MobileMailboxRunnerPolicy> | undefined;
  return event.kind === MOBILE_RUNNER_POLICY_KIND && payload?.type === MOBILE_RUNNER_POLICY_KIND;
}

export function mobileOriginIdForPairing(pairing: MobilePairingPackage): string {
  return `mobile-${sha256Hex([
    pairing.stableRoutingId,
    pairing.rendezvousId,
    pairing.fingerprint,
    "mobile"
  ].filter(Boolean).join(":")).slice(0, 32)}`;
}

export function mobileMailboxRunnerInstallCommand(request: MobileMailboxRunnerInstallRequest): string {
  const routeId = request.routeId.trim();
  const mailboxUrl = request.mailboxUrl.trim();
  const mailboxToken = request.mailboxToken.trim();
  const relaySealKeyBase64 = request.relaySealKeyBase64.trim();
  if (!routeId) {
    throw new Error("Mobile mailbox runner routeId is required.");
  }
  if (!mailboxUrl) {
    throw new Error("Mobile mailbox runner mailboxUrl is required.");
  }
  if (!mailboxToken) {
    throw new Error("Mobile mailbox runner mailboxToken is required.");
  }
  if (!relaySealKeyBase64) {
    throw new Error("Mobile mailbox runner relaySealKeyBase64 is required.");
  }
  const root = request.workerRoot?.trim() || "~/.accordagents/remote-runs";
  const routeSegment = safeRouteSegment(routeId);
  const script = mobileMailboxRunnerScript();
  const scriptHash = sha256Hex(script);
  const scriptBase64 = Buffer.from(script, "utf8").toString("base64");
  const codexPath = request.codexPath?.trim() || "codex";
  const claudePath = request.claudePath?.trim() || "claude";
  const serviceName = `accordagents-mobile-mailbox-runner-${routeSegment}.service`;
  const pollIntervalMs = Number.isFinite(request.pollIntervalMs)
    ? Math.max(250, Math.floor(request.pollIntervalMs ?? 2500))
    : 2500;
  const timeoutMs = Number.isFinite(request.timeoutMs)
    ? Math.max(1000, Math.floor(request.timeoutMs ?? 86_400_000))
    : 86_400_000;

  return [
    "set -eu",
    "umask 077",
    `root=${shellQuote(root)}`,
    'case "$root" in "~") root="$HOME";; "~/"*) root="$HOME/${root#~/}";; esac',
    `dir="$root/mobile-mailbox-runners/${routeSegment}"`,
    'operations_dir="$root/operations"',
    'runner="$dir/runner.js"',
    'launcher="$dir/runner-launch.sh"',
    'pidfile="$dir/runner.pid"',
    'hashfile="$dir/runner.sha256"',
    'logfile="$dir/runner.log"',
    `service_name=${shellQuote(serviceName)}`,
    'service_tmp="$dir/$service_name"',
    `mailbox_url=${shellQuote(mailboxUrl)}`,
    `mailbox_token=${shellQuote(mailboxToken)}`,
    `relay_seal_key=${shellQuote(relaySealKeyBase64)}`,
    `codex_path=${shellQuote(codexPath)}`,
    `claude_path=${shellQuote(claudePath)}`,
    `poll_interval_ms=${shellQuote(String(pollIntervalMs))}`,
    `timeout_ms=${shellQuote(String(timeoutMs))}`,
    'mkdir -p "$dir" "$operations_dir"',
    'shell_quote() { printf "\'%s\'" "$(printf "%s" "$1" | sed "s/\'/\'\\\\\'\'/g")"; }',
    'current_pid=""',
    'if [ -f "$pidfile" ]; then',
    '  pid="$(cat "$pidfile" 2>/dev/null || true)"',
    "  case \"$pid\" in ''|*[!0-9]*) pid='';; esac",
    '  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o args= 2>/dev/null | grep -F "$runner" >/dev/null; then current_pid="$pid"; fi',
    "fi",
    'if [ -n "$current_pid" ]; then kill "$current_pid" 2>/dev/null || true; sleep 1; fi',
    `printf %s ${shellQuote(scriptBase64)} | base64 -d > "$runner"`,
    'chmod 700 "$runner"',
    `printf %s ${shellQuote(scriptHash)} > "$hashfile"`,
    'rm -f "$logfile"',
    'printf "%s\\n" "#!/bin/sh" > "$launcher"',
    'printf "export ACCORD_MOBILE_MAILBOX_URL=%s\\n" "$(shell_quote "$mailbox_url")" >> "$launcher"',
    'printf "export ACCORD_MOBILE_MAILBOX_TOKEN=%s\\n" "$(shell_quote "$mailbox_token")" >> "$launcher"',
    'printf "export ACCORD_MOBILE_RELAY_SEAL_KEY=%s\\n" "$(shell_quote "$relay_seal_key")" >> "$launcher"',
    `printf "export ACCORD_MOBILE_RUNNER_ORIGIN_ID=%s\\n" "$(shell_quote ${shellQuote(`mobile-runner-${routeSegment}`)})" >> "$launcher"`,
    'printf "export ACCORD_MOBILE_CODEX_PATH=%s\\n" "$(shell_quote "$codex_path")" >> "$launcher"',
    'printf "export ACCORD_MOBILE_CLAUDE_PATH=%s\\n" "$(shell_quote "$claude_path")" >> "$launcher"',
    'printf "export ACCORD_MOBILE_RUNNER_STATE=%s\\n" "$(shell_quote "$dir/state.json")" >> "$launcher"',
    `printf "export ACCORD_MOBILE_RUNNER_OPERATION_LEASE_PATH=%s\\n" "$(shell_quote "$operations_dir/mobile-mailbox-runner-${routeSegment}.json")" >> "$launcher"`,
    `printf "export ACCORD_MOBILE_RUNNER_OPERATION_LEASE_OWNER=%s\\n" "$(shell_quote ${shellQuote(`mobile-mailbox-runner:${routeSegment}`)})" >> "$launcher"`,
    'printf "export ACCORD_MOBILE_EVENT_CLAIM_TTL_MS=%s\\n" "$(shell_quote 45000)" >> "$launcher"',
    'printf "export ACCORD_MOBILE_RUNNER_POLL_MS=%s\\n" "$(shell_quote "$poll_interval_ms")" >> "$launcher"',
    'printf "export ACCORD_MOBILE_RUNNER_TIMEOUT_MS=%s\\n" "$(shell_quote "$timeout_ms")" >> "$launcher"',
    'printf "exec node %s\\n" "$(shell_quote "$runner")" >> "$launcher"',
    'chmod 700 "$launcher"',
    'if command -v systemctl >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then',
    '  {',
    '    printf "%s\\n" "[Unit]"',
    '    printf "%s\\n" "Description=AccordAgents mobile mailbox runner"',
    '    printf "%s\\n" "After=network-online.target"',
    '    printf "%s\\n" "Wants=network-online.target"',
    '    printf "\\n%s\\n" "[Service]"',
    '    printf "%s\\n" "Type=simple"',
    '    printf "User=%s\\n" "$(id -un)"',
    '    printf "WorkingDirectory=%s\\n" "$dir"',
    '    printf "ExecStart=/bin/sh %s\\n" "$launcher"',
    '    printf "%s\\n" "Restart=always"',
    '    printf "%s\\n" "RestartSec=5"',
    '    printf "%s\\n" "KillSignal=SIGTERM"',
    '    printf "%s\\n" "TimeoutStopSec=30"',
    '    printf "\\n%s\\n" "[Install]"',
    '    printf "%s\\n" "WantedBy=multi-user.target"',
    '  } > "$service_tmp"',
    '  sudo -n install -m 0644 "$service_tmp" "/etc/systemd/system/$service_name"',
    '  sudo -n systemctl daemon-reload',
    '  sudo -n systemctl enable "$service_name" >/dev/null',
    '  sudo -n systemctl restart "$service_name"',
    '  sleep 1',
    '  active_pid="$(sudo -n systemctl show "$service_name" --property MainPID --value 2>/dev/null || true)"',
    '  printf %s "$active_pid" > "$pidfile"',
    `  printf '{"ok":true,"status":"started","persistence":"systemd","service":${JSON.stringify(serviceName)},"pid":%s,"scriptHash":${JSON.stringify(scriptHash)}}\\n' "$active_pid"`,
    '  exit 0',
    'fi',
    `if [ -n "$current_pid" ] && [ -f "$hashfile" ] && [ "$(cat "$hashfile" 2>/dev/null || true)" = ${shellQuote(scriptHash)} ]; then printf '{"ok":true,"status":"already-running","persistence":"process","pid":%s}\\n' "$current_pid"; exit 0; fi`,
    'ACCORD_MOBILE_MAILBOX_URL="$mailbox_url" ACCORD_MOBILE_MAILBOX_TOKEN="$mailbox_token" ACCORD_MOBILE_RELAY_SEAL_KEY="$relay_seal_key" ACCORD_MOBILE_RUNNER_ORIGIN_ID=' + shellQuote(`mobile-runner-${routeSegment}`) + ' ACCORD_MOBILE_CODEX_PATH="$codex_path" ACCORD_MOBILE_CLAUDE_PATH="$claude_path" ACCORD_MOBILE_RUNNER_STATE="$dir/state.json" ACCORD_MOBILE_RUNNER_OPERATION_LEASE_PATH="$operations_dir/mobile-mailbox-runner-' + routeSegment + '.json" ACCORD_MOBILE_RUNNER_OPERATION_LEASE_OWNER=' + shellQuote(`mobile-mailbox-runner:${routeSegment}`) + ' ACCORD_MOBILE_EVENT_CLAIM_TTL_MS=45000 ACCORD_MOBILE_RUNNER_POLL_MS="$poll_interval_ms" ACCORD_MOBILE_RUNNER_TIMEOUT_MS="$timeout_ms" nohup node "$runner" > "$logfile" 2>&1 < /dev/null & started_pid="$!"',
    'printf %s "$started_pid" > "$pidfile"',
    `printf '{"ok":true,"status":"started","persistence":"process","pid":%s,"scriptHash":${JSON.stringify(scriptHash)}}\\n' "$started_pid"`
  ].join("\n");
}

export function mobileMailboxRunnerScript(): string {
  return String.raw`#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

${REMOTE_APP_MCP_WORKER_CONTRACT_SNIPPET}

const mailboxUrl = requiredEnv("ACCORD_MOBILE_MAILBOX_URL");
const mailboxToken = requiredEnv("ACCORD_MOBILE_MAILBOX_TOKEN");
const relaySealKeyBase64 = requiredEnv("ACCORD_MOBILE_RELAY_SEAL_KEY");
const originId = process.env.ACCORD_MOBILE_RUNNER_ORIGIN_ID || "mobile-runner-" + crypto.randomUUID();
const codexPath = process.env.ACCORD_MOBILE_CODEX_PATH || "codex";
const claudePath = process.env.ACCORD_MOBILE_CLAUDE_PATH || "claude";
const statePath = process.env.ACCORD_MOBILE_RUNNER_STATE || path.join(os.tmpdir(), "accordagents-mobile-runner-state.json");
const pollIntervalMs = Math.max(250, Number(process.env.ACCORD_MOBILE_RUNNER_POLL_MS || 2500));
const once = process.env.ACCORD_MOBILE_RUNNER_ONCE === "1";
const operationLeasePath = process.env.ACCORD_MOBILE_RUNNER_OPERATION_LEASE_PATH || "";
const operationLeaseOwner = process.env.ACCORD_MOBILE_RUNNER_OPERATION_LEASE_OWNER || originId;
const operationLeaseTtlMs = Math.max(5000, Number(process.env.ACCORD_MOBILE_RUNNER_OPERATION_LEASE_TTL_MS || 30000));
const executionClaimTtlMs = Math.max(5000, Number(process.env.ACCORD_MOBILE_EVENT_CLAIM_TTL_MS || 45000));
const state = readJson(statePath, { originSeq: 1, processedEventIds: [], prevHash: undefined });
const processed = new Set(Array.isArray(state.processedEventIds) ? state.processedEventIds : []);
// W1 arrival cursor: the runner reads only what it has not seen, so policies
// seen in earlier ticks are cached in state rather than re-listed each poll.
// processedEventIds stays as the safety net for epoch resets.
if (!Number.isFinite(state.mailboxCursor)) { state.mailboxCursor = 0; }
if (typeof state.mailboxEpoch !== "string") { state.mailboxEpoch = ""; }
if (!state.policiesByConversation || typeof state.policiesByConversation !== "object") {
  state.policiesByConversation = {};
}
let running = false;
let operationLeaseTimer;
let executionClaimTimer;
let appMcpServerState;
let activeAppMcpRun;

function requiredEnv(key) {
  const value = process.env[key];
  if (!value || !value.trim()) {
    console.error(key + " is required");
    process.exit(2);
  }
  return value.trim();
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function bootId() {
  try { return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || "unknown"; } catch { return "unknown"; }
}

function renewOperationLease() {
  if (!operationLeasePath) { return; }
  const now = Date.now();
  writeJsonAtomic(operationLeasePath, {
    leaseId: path.basename(operationLeasePath).replace(/\.json$/, ""),
    ownerId: operationLeaseOwner,
    kind: "mobile-mailbox-runner",
    bootId: bootId(),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + operationLeaseTtlMs).toISOString()
  });
}

function releaseOperationLease() {
  if (!operationLeasePath) { return; }
  try { fs.unlinkSync(operationLeasePath); } catch {}
}

function startOperationLeaseRenewal() {
  if (!operationLeasePath) { return; }
  renewOperationLease();
  operationLeaseTimer = setInterval(renewOperationLease, Math.max(1000, Math.floor(operationLeaseTtlMs / 3)));
  if (operationLeaseTimer.unref) { operationLeaseTimer.unref(); }
}

function stopOperationLeaseRenewal() {
  if (operationLeaseTimer) { clearInterval(operationLeaseTimer); operationLeaseTimer = undefined; }
  releaseOperationLease();
}

function stableJson(value) {
  if (value === null || typeof value !== "object") { return JSON.stringify(value); }
  if (Array.isArray(value)) { return "[" + value.map(stableJson).join(",") + "]"; }
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function nextEvent(conversationId, kind, payload, requestedEventId) {
  const originSeq = Number(state.originSeq || 1);
  const createdAt = new Date().toISOString();
  const payloadHash = "sha256:" + sha256(stableJson(payload));
  const eventId = requestedEventId || crypto.randomUUID();
  const unsigned = {
    eventId,
    conversationId,
    logScopeId: conversationId,
    originId,
    originSeq,
    logicalTs: String(originSeq).padStart(16, "0") + ":" + originId + ":" + conversationId,
    kind,
    payloadHash,
    prevHash: state.prevHash || null,
    keyId: originId,
    createdAt
  };
  const eventHash = "sha256:" + sha256(stableJson(unsigned));
  state.originSeq = originSeq + 1;
  state.prevHash = eventHash;
  return {
    ...unsigned,
    ...(unsigned.prevHash ? { prevHash: unsigned.prevHash } : {}),
    payload,
    eventHash,
    signature: "runner-unsigned"
  };
}

// Sealed payloads use the generated single-source contract (W4): the exact
// same text the phone runs, embedded below, using Node's global WebCrypto.
${MOBILE_MAILBOX_RUNNER_CRYPTO_SNIPPET}

async function sealPayload(payload) {
  return globalThis.AccordMailboxCrypto.sealToEnvelope(payload, relaySealKeyBase64);
}

async function openPayload(sealed) {
  return globalThis.AccordMailboxCrypto.openEnvelope(sealed, relaySealKeyBase64);
}

function authHeaders(extra) {
  return Object.assign({ authorization: "Bearer " + mailboxToken }, extra || {});
}

async function fetchJson(url, options) {
  const merged = Object.assign({}, options || {});
  merged.headers = authHeaders(merged.headers);
  const response = await fetch(url, merged);
  const text = await response.text();
  if (!response.ok) {
    throw new Error("Mailbox HTTP " + response.status + ": " + text);
  }
  return text.trim() ? JSON.parse(text) : {};
}

async function fetchMailboxPage(afterArrival) {
  const url = new URL(mailboxUrl);
  url.searchParams.set("limit", "1000");
  url.searchParams.set("afterArrival", String(Math.max(0, afterArrival)));
  return fetchJson(url.toString(), { headers: { accept: "application/json" } });
}

async function listMailboxEvents() {
  let body = await fetchMailboxPage(state.mailboxCursor);
  const epoch = typeof body.epoch === "string" ? body.epoch : "";
  if (epoch && epoch !== state.mailboxEpoch) {
    // The box was destroyed and recreated: arrival numbering restarted, so
    // the cursor no longer applies. Re-read from zero; the processed set and
    // execution claims absorb the replay. No refill — a runner must never
    // re-execute expired commands.
    state.mailboxEpoch = epoch;
    state.mailboxCursor = 0;
    writeJsonAtomic(statePath, state);
    body = await fetchMailboxPage(0);
  }
  const events = Array.isArray(body.events) ? body.events : [];
  let maxArrival = state.mailboxCursor;
  const opened = [];
  for (const event of events) {
    if (!event || typeof event !== "object") { continue; }
    if (Number.isFinite(event.arrivalSeq) && event.arrivalSeq > maxArrival) { maxArrival = event.arrivalSeq; }
    try {
      opened.push(Object.assign({}, event, { payload: await openPayload(event.payload) }));
    } catch (error) {
      // An unreadable payload is not for this pairing; skip it.
    }
  }
  // The runner processes at most one message per tick, so the cursor must
  // never advance past a still-unprocessed command: doing so would skip every
  // other command in the page forever, silently losing phone requests in the
  // exact desktop-offline path the runner exists for. Advance only up to just
  // before the lowest pending command; everything below that (policies,
  // already-processed or fulfilled events, other pairings) is safe to skip.
  let nextCursor = maxArrival;
  for (const message of mobileMessages(opened)) {
    if (Number.isFinite(message.arrivalSeq) && message.arrivalSeq - 1 < nextCursor) {
      nextCursor = message.arrivalSeq - 1;
    }
  }
  if (nextCursor > state.mailboxCursor) {
    state.mailboxCursor = nextCursor;
    writeJsonAtomic(statePath, state);
  }
  return opened;
}

// W-C: the runner is a publisher too, and runner-executed runs are precisely
// the laptop-closed case the doorbell exists for. Like the desktop it states
// the marker at the one call site that knows a run finished, rather than
// inferring it from batch contents.
async function appendMailboxEvents(events, options) {
  if (events.length === 0) { return; }
  const runFinished = Boolean(options && options.runFinished);
  const sealed = await Promise.all(events.map(async (event) => Object.assign({}, event, { payload: await sealPayload(event.payload) })));
  await fetchJson(mailboxUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(runFinished ? { events: sealed, runFinished: true } : { events: sealed })
  });
}

function toolTextResult(result) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(result, null, 2)
    }]
  };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > 1024 * 1024) {
        reject(new Error("MCP request body is too large."));
        request.destroy();
      }
    });
    request.on("error", reject);
    request.on("end", () => {
      try {
        resolve(body.trim() ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
  });
}

function appMcpContextSnapshot(run) {
  const policy = run.policy && typeof run.policy === "object" ? run.policy : {};
  const base = policy.contextSnapshot && typeof policy.contextSnapshot === "object"
    ? policy.contextSnapshot
    : {};
  const messages = Array.isArray(base.messages)
    ? base.messages.slice()
    : (Array.isArray(policy.recentMessages) ? policy.recentMessages : []).map((message, sequence) => ({
        sequence,
        id: "mobile-policy-message-" + sequence,
        role: message.role,
        author: message.participantLabel || (message.role === "user" ? "User" : message.role),
        participantId: message.participantId,
        participantLabel: message.participantLabel,
        content: message.content,
        createdAt: message.createdAt,
        status: "done",
        metadata: {}
      }));
  const mobileMessageId = "mobile-" + run.event.eventId;
  const alreadyIncluded = messages.some((message) => message && (
    message.id === mobileMessageId ||
    message.id === run.event.eventId ||
    (message.metadata && message.metadata.mobileEventId === run.event.eventId)
  ));
  if (!alreadyIncluded) {
    const lastSequence = messages.reduce((highest, message) =>
      message && typeof message.sequence === "number" && isFinite(message.sequence)
        ? Math.max(highest, message.sequence)
        : highest, -1);
    messages.push({
      sequence: lastSequence + 1,
      id: mobileMessageId,
      role: "user",
      author: "User",
      content: String(run.event.payload.content || ""),
      createdAt: run.event.createdAt || new Date().toISOString(),
      status: "done",
      metadata: {
        appMessageSource: "mobile-relay",
        mobileEventId: run.event.eventId,
        threadId: mobileMessageId
      },
      imageAttachments: []
    });
  }
  const maxSequence = messages.reduce((highest, message) =>
    message && typeof message.sequence === "number" && isFinite(message.sequence)
      ? Math.max(highest, message.sequence)
      : highest, -1);
  const baseWindow = base.messageWindow && typeof base.messageWindow === "object"
    ? base.messageWindow
    : {};
  return Object.assign({}, base, {
    conversationId: run.event.conversationId,
    title: policy.title || base.title,
    participantId: run.participant.id,
    participantHandle: run.participant.handle,
    triggerMessageId: mobileMessageId,
    messages,
    attachments: Array.isArray(base.attachments) ? base.attachments : [],
    attachmentWindow: base.attachmentWindow && typeof base.attachmentWindow === "object"
      ? base.attachmentWindow
      : { omittedCount: 0 },
    messageWindow: Object.assign({}, baseWindow, {
      maxSequence,
      totalMessages: Math.max(
        messages.length,
        typeof baseWindow.totalMessages === "number" ? baseWindow.totalMessages + (alreadyIncluded ? 0 : 1) : 0
      ),
      oldestIncludedSequence: messages.length > 0 ? messages[0].sequence : undefined
    }),
    participants: Array.isArray(base.participants) ? base.participants : (Array.isArray(policy.participants) ? policy.participants : [])
  });
}

async function appendAppMcpChatMessage(run, content) {
  const createdAt = new Date().toISOString();
  const messageId = "mobile-runner-tool-message-" + crypto.randomUUID();
  const message = {
    id: messageId,
    role: "participant",
    participantId: run.participant.id,
    participantLabel: "@" + run.participant.handle,
    content,
    status: "done",
    createdAt,
    metadata: {
      runId: run.runId,
      appMessageSource: "app_chat_send_message",
      sourceMessageId: run.event.eventId,
      threadId: "mobile-" + run.event.eventId
    }
  };
  const event = nextEvent(run.event.conversationId, "message.created", { message });
  await appendMailboxEvents([event]);
  writeJsonAtomic(statePath, state);
  return event;
}

async function handleAppMcpRequest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return rpcError(null, -32600, "Invalid JSON-RPC request.");
  }
  const id = raw.id;
  const method = typeof raw.method === "string" ? raw.method : "";
  const notify = id === undefined;
  if (method === "initialize") {
    return notify ? undefined : rpcResult(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "accordagents-mobile-mailbox-runner", version: "0.1.0" }
    });
  }
  if (method === "notifications/initialized") {
    return undefined;
  }
  if (method === "tools/list") {
    return notify ? undefined : rpcResult(id, {
      tools: REMOTE_APP_MCP_TOOL_CONTRACTS.map((contract) => contract.definition)
    });
  }
  if (method !== "tools/call") {
    return notify ? undefined : rpcError(id, -32601, "Unsupported MCP method: " + (method || "unknown") + ".");
  }
  const run = activeAppMcpRun;
  if (!run) {
    return notify ? undefined : rpcError(id, -32000, "No mobile mailbox participant run is active.");
  }
  const params = raw.params && typeof raw.params === "object" ? raw.params : {};
  const name = params.name;
  const args = params.arguments || {};
  const toolHandler = REMOTE_APP_MCP_TOOL_HANDLER_BY_NAME[name];
  if (toolHandler === "permissions-request") {
    const requestId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const event = nextEvent(run.event.conversationId, "mobile.runner.permission.requested", {
      type: "mobile.runner.permission.requested",
      requestId,
      runId: run.runId,
      participantId: run.participant.id,
      triggerMessageId: run.event.eventId,
      request: args,
      createdAt
    });
    await appendMailboxEvents([event]);
    writeJsonAtomic(statePath, state);
    return notify ? undefined : rpcResult(id, toolTextResult({
      ok: true,
      status: "pending_user_approval",
      requestId,
      approvalId: requestId,
      request: args,
      updatedAt: createdAt
    }));
  }
  if (toolHandler === "chat-send-message") {
    if (notify) { return undefined; }
    const content = typeof args.content === "string" ? args.content.trim() : "";
    if (!content) {
      return rpcError(id, -32602, "ChatSendMessageDenied. Problem: content was empty. Cause: a mid-run post must carry text. Fix: pass a non-empty content string.");
    }
    if (content.length > 20000) {
      return rpcError(id, -32602, "ChatSendMessageDenied. Problem: content is too long for a mid-run post. Cause: the limit is 20000 characters. Fix: post a shorter update, or put the long form in an artifact when the run is over.");
    }
    if (args.attachments !== undefined) {
      return rpcError(id, -32602, "ChatSendMessageDenied. Problem: attachments cannot be sent from a cloud run yet. Cause: this run posts through the shared event log, which carries text. Fix: post the text now and attach the image from a desktop turn.");
    }
    const event = await appendAppMcpChatMessage(run, content);
    return rpcResult(id, toolTextResult({
      ok: true,
      status: "published_to_shared_log",
      publishedAt: event.createdAt,
      note: "The post was appended to the shared chat event log."
    }));
  }
  const snapshot = appMcpContextSnapshot(run);
  if (toolHandler === "chat-get-context") {
    return notify ? undefined : rpcResult(id, toolTextResult({ ok: true, snapshot }));
  }
  if (toolHandler === "chat-get-participants") {
    return notify ? undefined : rpcResult(id, toolTextResult({
      ok: true,
      participants: snapshot.participants || []
    }));
  }
  if (toolHandler === "chat-read-messages") {
    if (notify) { return undefined; }
    const all = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    const window = snapshot.messageWindow && typeof snapshot.messageWindow === "object" ? snapshot.messageWindow : {};
    const messageId = typeof args.messageId === "string" && args.messageId.trim() ? args.messageId.trim() : undefined;
    const threadId = typeof args.threadId === "string" && args.threadId.trim() ? args.threadId.trim() : undefined;
    const before = typeof args.beforeSequence === "number" && isFinite(args.beforeSequence) ? args.beforeSequence : undefined;
    const after = typeof args.afterSequence === "number" && isFinite(args.afterSequence) ? args.afterSequence : undefined;
    const limit = typeof args.limit === "number" && isFinite(args.limit) && args.limit > 0
      ? Math.min(200, Math.floor(args.limit))
      : 40;
    const matched = all.filter((message) => {
      if (!message || typeof message !== "object") { return false; }
      if (messageId) { return message.id === messageId; }
      if (threadId && (!message.metadata || message.metadata.threadId !== threadId)) { return false; }
      const sequence = typeof message.sequence === "number" ? message.sequence : undefined;
      if (before !== undefined && sequence !== undefined && sequence >= before) { return false; }
      if (after !== undefined && sequence !== undefined && sequence <= after) { return false; }
      return true;
    });
    const selected = after !== undefined
      ? matched.slice(0, limit)
      : matched.slice(Math.max(0, matched.length - limit));
    const oldest = selected.length > 0 ? selected[0].sequence : undefined;
    const newest = selected.length > 0 ? selected[selected.length - 1].sequence : undefined;
    return rpcResult(id, toolTextResult({
      ok: true,
      conversationId: snapshot.conversationId,
      requesterParticipantId: snapshot.participantId,
      snapshotAtRunStart: true,
      filters: { messageId, threadId, beforeSequence: before, afterSequence: after, limit },
      messages: selected,
      page: {
        oldestSequence: oldest,
        newestSequence: newest,
        hasMoreBefore: oldest !== undefined
          ? matched.some((message) => typeof message.sequence === "number" && message.sequence < oldest)
          : false,
        hasMoreAfter: newest !== undefined
          ? matched.some((message) => typeof message.sequence === "number" && message.sequence > newest)
          : false,
        totalMessages: typeof window.totalMessages === "number" ? window.totalMessages : all.length,
        totalMatchingMessages: matched.length,
        oldestIncludedSequence: window.oldestIncludedSequence
      }
    }));
  }
  if (toolHandler === "chat-list-attachments" || toolHandler === "chat-read-attachment") {
    if (notify) { return undefined; }
    const bundled = Array.isArray(snapshot.attachments) ? snapshot.attachments : [];
    const window = snapshot.attachmentWindow && typeof snapshot.attachmentWindow === "object" ? snapshot.attachmentWindow : {};
    if (toolHandler === "chat-read-attachment") {
      const attachmentId = typeof args.attachmentId === "string" ? args.attachmentId.trim() : "";
      const found = bundled.find((item) => item && item.attachment && item.attachment.id === attachmentId);
      if (!found) {
        return rpcError(id, -32602, "AttachmentReadDenied. Problem: this attachment was not bundled with this run. Cause: the id is absent, belongs to another conversation, is newer than this run, or fell outside the run's attachment budget. Fix: call app_chat_list_attachments for the ids that are available.");
      }
      const mimeType = found.attachment && typeof found.attachment.mimeType === "string"
        ? found.attachment.mimeType
        : "image/png";
      const summary = {
        conversationId: snapshot.conversationId,
        requesterParticipantId: snapshot.participantId,
        messageId: found.messageId,
        sequence: found.sequence,
        author: found.author,
        threadId: found.threadId,
        attachment: found.attachment,
        snapshotAtRunStart: true,
        dataBase64: "[omitted: returned as MCP image content]"
      };
      return rpcResult(id, {
        content: [
          { type: "text", text: JSON.stringify(summary, null, 2) },
          { type: "image", data: found.dataBase64, mimeType }
        ]
      });
    }
    const messageId = typeof args.messageId === "string" && args.messageId.trim() ? args.messageId.trim() : undefined;
    const threadId = typeof args.threadId === "string" && args.threadId.trim() ? args.threadId.trim() : undefined;
    const limit = typeof args.limit === "number" && isFinite(args.limit) && args.limit > 0
      ? Math.min(50, Math.floor(args.limit))
      : 20;
    const matched = bundled.filter((item) => {
      if (!item || typeof item !== "object") { return false; }
      if (messageId && item.messageId !== messageId) { return false; }
      if (threadId && item.threadId !== threadId) { return false; }
      return true;
    }).slice(-limit);
    return rpcResult(id, toolTextResult({
      ok: true,
      conversationId: snapshot.conversationId,
      requesterParticipantId: snapshot.participantId,
      snapshotAtRunStart: true,
      filters: { messageId, threadId, limit },
      attachments: matched.map((item) => ({
        messageId: item.messageId,
        sequence: item.sequence,
        author: item.author,
        threadId: item.threadId,
        attachment: item.attachment
      })),
      omittedCount: typeof window.omittedCount === "number" ? window.omittedCount : 0
    }));
  }
  return notify ? undefined : rpcError(id, -32603, "Unknown worker relay tool: " + String(name || "") + ".");
}

function ensureAppMcpServer() {
  if (appMcpServerState) {
    return Promise.resolve(appMcpServerState);
  }
  return new Promise((resolve, reject) => {
    const token = crypto.randomBytes(32).toString("hex");
    const server = http.createServer(async (request, response) => {
      if (request.method !== "POST" || (request.url || "").split("?")[0] !== "/mcp") {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("Not found");
        return;
      }
      if (request.headers.authorization !== "Bearer " + token) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      try {
        const payload = await readJsonBody(request);
        const requests = Array.isArray(payload) ? payload : [payload];
        const results = [];
        for (const item of requests) {
          const result = await handleAppMcpRequest(item);
          if (result) { results.push(result); }
        }
        if (results.length === 0) {
          response.writeHead(202);
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(Array.isArray(payload) ? results : results[0]));
      } catch (error) {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(rpcError(null, -32700, error instanceof Error ? error.message : String(error))));
      }
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : undefined;
      if (!port) {
        server.close();
        reject(new Error("Mobile mailbox App MCP server did not expose a listen address."));
        return;
      }
      server.unref();
      appMcpServerState = {
        server,
        token,
        url: "http://127.0.0.1:" + port + "/mcp"
      };
      resolve(appMcpServerState);
    });
  });
}

function stopAppMcpServer() {
  activeAppMcpRun = undefined;
  if (appMcpServerState && appMcpServerState.server) {
    try { appMcpServerState.server.close(); } catch {}
  }
  appMcpServerState = undefined;
}

function mailboxClaimUrl() {
  const url = new URL(mailboxUrl);
  url.pathname = "/v1/mailbox/claims";
  return url.toString();
}

async function acquireMobileEventClaim(event, runId) {
  const body = await fetchJson(mailboxClaimUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      conversationId: event.conversationId,
      eventId: event.eventId,
      ownerId: originId,
      ownerRole: "cloud-runner",
      runId,
      ttlMs: executionClaimTtlMs
    })
  });
  return body && body.acquired === true;
}

function startExecutionClaimRenewal(event, runId) {
  stopExecutionClaimRenewal();
  executionClaimTimer = setInterval(() => {
    acquireMobileEventClaim(event, runId).catch((error) => {
      console.error(error && error.stack || String(error));
    });
  }, Math.max(1000, Math.floor(executionClaimTtlMs / 3)));
  if (executionClaimTimer.unref) { executionClaimTimer.unref(); }
}

function stopExecutionClaimRenewal() {
  if (executionClaimTimer) { clearInterval(executionClaimTimer); executionClaimTimer = undefined; }
}

function latestPolicies(events) {
  // Cursor reads only deliver each policy event once, so the latest policy
  // per conversation is cached in state and refreshed from new events.
  let changed = false;
  for (const event of events) {
    const payload = event && event.payload;
    if (event && event.kind === "mobile.runner.policy" && payload && payload.type === "mobile.runner.policy") {
      state.policiesByConversation[event.conversationId] = payload;
      changed = true;
    }
  }
  if (changed) {
    writeJsonAtomic(statePath, state);
  }
  const policies = new Map();
  for (const [conversationId, payload] of Object.entries(state.policiesByConversation)) {
    policies.set(conversationId, payload);
  }
  return policies;
}

function mobileMessages(events) {
  const fulfilledMobileEventIds = mobileEventIdsWithTerminalOutput(events);
  return events.filter((event) => {
    const payload = event && event.payload;
    return event &&
      event.kind === "message.created" &&
      payload &&
      typeof payload.content === "string" &&
      !payload.message &&
      !processed.has(event.eventId) &&
      !fulfilledMobileEventIds.has(event.eventId);
  });
}

function policyAcceptsMobileMessage(policy, event) {
  const access = policy && policy.mobileAccess;
  if (!access || typeof access !== "object") { return true; }
  const expectedOriginId = typeof access.originId === "string" ? access.originId.trim() : "";
  if (expectedOriginId && event.originId !== expectedOriginId) { return false; }
  const expiresAt = typeof access.expiresAt === "string" ? Date.parse(access.expiresAt) : NaN;
  if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) { return false; }
  const eventCreatedAt = typeof event.createdAt === "string" ? Date.parse(event.createdAt) : NaN;
  if (Number.isFinite(eventCreatedAt) && Number.isFinite(expiresAt) && eventCreatedAt >= expiresAt) { return false; }
  return true;
}

function mobileEventIdsWithTerminalOutput(events) {
  const fulfilled = new Set();
  for (const event of events) {
    const payload = event && event.payload;
    if (!payload || typeof payload !== "object") { continue; }
    if (event.kind === "message.created" && payload.message && payload.message.metadata) {
      const metadata = payload.message.metadata;
      const mobileEventId = typeof metadata.mobileEventId === "string"
        ? metadata.mobileEventId
        : typeof metadata.sourceMessageId === "string" ? metadata.sourceMessageId : "";
      if (mobileEventId) { fulfilled.add(mobileEventId); }
    }
    if (event.kind === "mobile.timeline.events" && Array.isArray(payload.events)) {
      for (const timelineEvent of payload.events) {
        if (!timelineEvent || timelineEvent.status === "pending") { continue; }
        const mobileEventId = typeof timelineEvent.mobileEventId === "string" ? timelineEvent.mobileEventId : "";
        if (mobileEventId) { fulfilled.add(mobileEventId); }
      }
    }
  }
  return fulfilled;
}

function mobileRunKey(event) {
  return sha256([event.conversationId || "", event.eventId || ""].join("\0")).slice(0, 40);
}

function participantFor(policy, content) {
  const participants = Array.isArray(policy.participants) ? policy.participants : [];
  const mentioned = String(content || "").match(/@([A-Za-z0-9._-]{1,32})/);
  if (mentioned) {
    const normalized = mentioned[1].toLowerCase();
    const exact = participants.find((item) => String(item.handle || "").toLowerCase() === normalized);
    if (exact) { return exact; }
  }
  return participants.find((item) => supportsCloudRun(item) && item.remoteExecution === "remote");
}

function supportsCloudRun(participant) {
  return participant && (participant.kind === "codex-cli" || participant.kind === "claude-code");
}

function promptFor(policy, message, participant) {
  const recent = Array.isArray(policy.recentMessages) ? policy.recentMessages : [];
  return [
    "You are running as an AccordAgents cloud participant while the desktop is unavailable.",
    "Participant: @" + participant.handle,
    "Chat: " + String(policy.title || policy.conversationId || message.conversationId),
    "",
    "Recent chat context:",
    recent.map((item) => {
      const who = item.participantLabel || item.role || "message";
      return "[" + item.createdAt + "] " + who + ": " + item.content;
    }).join("\n"),
    "",
    "New mobile message:",
    String(message.payload.content || "").trim()
  ].join("\n");
}

function runCodex(prompt, runId, appMcp) {
  const finalPath = path.join(os.tmpdir(), runId + ".txt");
  const timeoutMs = Math.max(1000, Number(process.env.ACCORD_MOBILE_RUNNER_TIMEOUT_MS || 86400000));
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let spawnError;
    let timedOut = false;
    const child = cp.spawn(codexPath, [
      "exec",
      "--skip-git-repo-check",
      "--output-last-message",
      finalPath,
      "-c",
      "approval_policy=\"never\"",
      "-c",
      "mcp_servers.accord_agents.url=\"" + appMcp.url + "\"",
      "-c",
      "mcp_servers.accord_agents.bearer_token_env_var=\"ACCORD_AGENTS_MCP_TOKEN\"",
      prompt
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      env: Object.assign({}, process.env, { ACCORD_AGENTS_MCP_TOKEN: appMcp.token })
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000).unref?.();
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      let final = "";
      try { final = fs.readFileSync(finalPath, "utf8").trim(); } catch {}
      const content = final || stdout.trim() || stderr.trim();
      resolve({
        ok: code === 0 && !spawnError && !signal && !timedOut,
        content,
        exitCode: code,
        error: spawnError
          ? String(spawnError.message || spawnError)
          : timedOut
            ? "Cloud participant timed out."
            : signal ? "Cloud participant exited with signal " + signal + "." : undefined
      });
    });
  });
}

function runClaude(prompt, participant, appMcp) {
  const timeoutMs = Math.max(1000, Number(process.env.ACCORD_MOBILE_RUNNER_TIMEOUT_MS || 86400000));
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let spawnError;
    let timedOut = false;
    const args = [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      claudePermissionMode(participant),
      "--mcp-config",
      JSON.stringify({
        mcpServers: {
          accord_agents: {
            type: "http",
            url: appMcp.url,
            headers: { Authorization: "Bearer " + appMcp.token }
          }
        }
      }),
      "--allowedTools",
      REMOTE_APP_MCP_TOOL_CONTRACTS.map((contract) => "mcp__accord_agents__" + contract.definition.name).join(",")
    ];
    if (participant.model) {
      args.push("--model", String(participant.model));
    }
    const effort = claudeReasoningEffort(participant.reasoningEffort);
    if (effort) {
      args.push("--effort", effort);
    }
    const child = cp.spawn(claudePath, args, {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000).unref?.();
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const content = extractClaudeText(stdout) || stderr.trim();
      resolve({
        ok: code === 0 && !spawnError && !signal && !timedOut,
        content,
        exitCode: code,
        error: spawnError
          ? String(spawnError.message || spawnError)
          : timedOut
            ? "Cloud participant timed out."
            : signal ? "Cloud participant exited with signal " + signal + "." : undefined
      });
    });
    child.stdin.end(prompt);
  });
}

function claudePermissionMode(participant) {
  const mode = participant && participant.agentMode;
  if (mode === "plan") { return "plan"; }
  if (mode === "auto") { return "auto"; }
  return participant && participant.permissions && participant.permissions.workspaceWrite === true
    ? "acceptEdits"
    : "default";
}

function claudeReasoningEffort(value) {
  return value && value !== "none" ? String(value) : "";
}

function extractClaudeText(stdout) {
  for (const candidate of [stdout].concat(stdout.split(/\r?\n/).reverse())) {
    const trimmed = String(candidate || "").trim();
    if (!trimmed) { continue; }
    try {
      const parsed = JSON.parse(trimmed);
      return String(parsed.result || parsed.content || parsed.message || "").trim();
    } catch {}
  }
  return stdout.trim();
}

function runParticipant(prompt, participant, runId, appMcp) {
  return participant.kind === "claude-code"
    ? runClaude(prompt, participant, appMcp)
    : runCodex(prompt, runId, appMcp);
}

async function processMobileMessage(event, policy) {
  const participant = participantFor(policy, event.payload.content);
  if (!participant || participant.remoteExecution !== "remote" || !supportsCloudRun(participant)) {
    return false;
  }
  const runId = "mobile-" + event.eventId;
  if (!await acquireMobileEventClaim(event, runId)) {
    return false;
  }
  startExecutionClaimRenewal(event, runId);
  startOperationLeaseRenewal();
  try {
    const runKey = mobileRunKey(event);
    const participantLabel = "@" + participant.handle;
    const runningId = runId + ":" + participant.handle;
    await appendMailboxEvents([
      nextEvent(event.conversationId, "mobile.timeline.events", {
        type: "mobile.timeline.events",
        conversationId: event.conversationId,
        events: [{
          id: runningId,
          role: "participant",
          participantLabel,
          content: participantLabel + " is running...",
          status: "pending",
          createdAt: new Date().toISOString(),
          runId,
          messageId: runningId,
          mobileEventId: event.eventId
        }]
      }, "mobile-runner-running-" + runKey)
    ]);
    const appMcp = await ensureAppMcpServer();
    activeAppMcpRun = { policy, event, participant, runId };
    let result;
    try {
      result = await runParticipant(promptFor(policy, event, participant), participant, runId, appMcp);
    } finally {
      activeAppMcpRun = undefined;
    }
    if (!await acquireMobileEventClaim(event, runId)) {
      return false;
    }
    const messageId = "mobile-runner-result-" + runKey;
    const message = {
      id: messageId,
      role: "participant",
      participantId: participant.id,
      participantLabel,
      content: result.content || (result.ok ? "" : result.error || "Cloud participant failed."),
      status: result.ok ? "done" : "error",
      createdAt: new Date().toISOString(),
      metadata: {
        runId,
        appMessageSource: "remote-run-provider-output",
        sourceMessageId: event.eventId,
        mobileEventId: event.eventId
      }
    };
    await appendMailboxEvents([
      nextEvent(event.conversationId, "message.created", { message }, "mobile-runner-result-message-" + runKey),
      nextEvent(event.conversationId, "mobile.timeline.events", {
        type: "mobile.timeline.events",
        conversationId: event.conversationId,
        events: [{
          id: message.id,
          role: "participant",
          participantLabel,
          content: message.content,
          status: message.status,
          createdAt: message.createdAt,
          runId,
          messageId: message.id,
          mobileEventId: event.eventId
        }]
      }, "mobile-runner-result-timeline-" + runKey)
    ], { runFinished: true });
    processed.add(event.eventId);
    state.processedEventIds = Array.from(processed).slice(-1000);
    writeJsonAtomic(statePath, state);
    return true;
  } finally {
    stopExecutionClaimRenewal();
    stopOperationLeaseRenewal();
  }
}

async function tick() {
  if (running) { return false; }
  running = true;
  try {
    const events = await listMailboxEvents();
    const policies = latestPolicies(events);
    for (const event of mobileMessages(events)) {
      const policy = policies.get(event.conversationId);
      if (!policy) { continue; }
      if (!policyAcceptsMobileMessage(policy, event)) { continue; }
      if (await processMobileMessage(event, policy)) {
        return true;
      }
    }
    return false;
  } finally {
    running = false;
  }
}

async function main() {
  do {
    try {
      const processedOne = await tick();
      if (once && processedOne) { return; }
    } catch (error) {
      console.error(error && error.stack || String(error));
      if (once) { process.exitCode = 1; return; }
    }
    if (once) { return; }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (true);
}

process.on("SIGINT", () => { stopExecutionClaimRenewal(); stopOperationLeaseRenewal(); stopAppMcpServer(); process.exit(130); });
process.on("SIGTERM", () => { stopExecutionClaimRenewal(); stopOperationLeaseRenewal(); stopAppMcpServer(); process.exit(143); });
process.on("exit", () => { stopExecutionClaimRenewal(); stopOperationLeaseRenewal(); stopAppMcpServer(); });

main();
`;
}

function mobileMailboxRunnerParticipants(conversation: Conversation): MobileMailboxRunnerParticipant[] {
  const participants = Array.isArray(conversation.metadata.participants)
    ? conversation.metadata.participants
    : [];
  return participants
    .filter((participant): participant is ChatParticipant => Boolean(participant && participant.id && participant.handle))
    .map((participant) => ({
      id: participant.id,
      handle: participant.handle,
      kind: participant.kind,
      ...(participant.remoteExecution ? { remoteExecution: participant.remoteExecution } : {}),
      ...(participant.agentMode ? { agentMode: participant.agentMode } : {}),
      ...(participant.permissions ? { permissions: participant.permissions } : {}),
      ...(participant.model ? { model: participant.model } : {}),
      ...(participant.reasoningEffort ? { reasoningEffort: participant.reasoningEffort } : {})
    }));
}

function safeRouteSegment(routeId: string): string {
  const normalized = routeId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^_+|_+$/g, "");
  const hash = sha256Hex(routeId).slice(0, 16);
  const prefix = normalized.slice(0, 48) || "route";
  return `${prefix}-${hash}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
