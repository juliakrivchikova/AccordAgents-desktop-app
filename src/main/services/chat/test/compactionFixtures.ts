// What the compaction tests set up.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { ChatParticipant, ChatParticipantSession, ChatRoleConfig, Conversation, ParticipantConfig } from "../../../../shared/types";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../../../shared/agentPermissions";
import { DEFAULT_CHAT_PROMPT_CONTEXT } from "../../../../shared/chatPromptContext";
import { ChatService } from "../../chat";
import { chatParts } from "./chatParts";
import type { ChatServerLink } from "../../chatServerOps";
import type { HubFeedEntry, HubOp, HubOpEffect, HubTurn } from "../../../../shared/hubOps";

export const NOW = "2026-01-01T00:00:00.000Z";

export const ROLE: ChatRoleConfig = {
  id: "administrator",
  label: "Administrator",
  instructions: "Answer directly.",
  version: 1,
  updatedAt: NOW
};

/** A message the server holds (a machine member's compaction is a turn
 *  placed against one). */
export function acceptedMessage(id = "anchor"): any {
  return { id, role: "user", content: "Earlier.", createdAt: NOW, status: "done", metadata: { threadId: id, serverSeq: 7, serverWriter: "desktop-device" } };
}

/** The User's server as a chat sees it, played by the test. */
export function fakeServerLink(deviceId: string) {
  const ops: HubOp[] = [];
  let seq = 100;
  const turnOf = (op: HubOp, state: HubTurn["state"]): HubTurn | undefined => op.kind === "turn.request" || op.kind === "turn.claim"
    ? { runId: op.runId, conversationId: op.conversationId, messageId: op.messageId, participantId: op.participantId, state,
      ...(state === "requested" ? { requestedBy: deviceId } : { executorDeviceId: deviceId }),
      ...(op.kind === "turn.request" && op.request ? { request: op.request } : {}) }
    : undefined;
  const link: ChatServerLink & { ops: HubOp[] } = {
    ops,
    deviceId: () => deviceId,
    queueSql: (queued) => { ops.push(...queued); return ""; },
    enqueue: async (queued) => { ops.push(...queued); },
    nudge: () => undefined,
    messageAccepted: async () => ({ status: "accepted", seq: ++seq }),
    opAnswered: async (opId) => {
      const op = ops.find((item) => item.opId === opId);
      if (op?.kind === "turn.request") return { status: "accepted", seq: ++seq, turn: turnOf(op, "requested") };
      if (op?.kind === "turn.claim") return { status: "accepted", seq: ++seq, claim: "claimed", turn: turnOf(op, "claimed") };
      return { status: "accepted", seq: ++seq };
    },
    waitingTurns: async () => ({ requested: [], claimed: [] }),
    machineName: () => "Box"
  };
  return link;
}

let feedSeq = 0;

export function fromServer(deviceId: string, effect: HubOpEffect): HubFeedEntry {
  feedSeq += 1;
  return { seq: 500 + feedSeq, opId: `feed-${feedSeq}`, deviceId, conversationId: "chat-compact", acceptedAt: new Date().toISOString(), effect };
}

// --- going on after a member's own compaction (the User, 2026-11-25) ---------

/** A chat whose one member's turns the test plays: what each prompt was, and
 *  the app tools each turn acts with (the grant its CLI got). */
export function selfCompactingChat(options: {
  participant?: Partial<ChatParticipant>;
  others?: ChatParticipant[];
  turn: (context: { prompt: string; participantId: string; actor: any; service: ChatService; call: number; signal?: AbortSignal; options: Record<string, unknown> }) => Promise<string | { content: string; turnContinues?: boolean }>;
  compactSession?: (signal: AbortSignal | undefined) => Promise<Record<string, unknown>>;
}) {
  const participant = chatParticipant(options.participant);
  const members = [participant, ...(options.others ?? [])];
  const conversation = chatConversation(members, members.map((member) => chatSession(member, `session-${member.id}`)));
  const grants = new Map<string, any>();
  const note = (grant: any): { url: string; token: string } => {
    grants.set(grant.participantId, grant);
    return { url: "http://127.0.0.1:1/mcp", token: `token-${grant.participantId}` };
  };
  const prompts: Array<{ participantId: string; prompt: string }> = [];
  const order: string[] = [];
  const debugEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const made = testService({
    conversation,
    debugEvents,
    appMcp: { issueToken: note, updateToken: (_token: string, grant: any) => note(grant), clientStatus: () => undefined },
    compactSession: async (runParticipant, _repoPath, _diffMode, _kind, signal) => {
      order.push(`compact ${runParticipant.id}`);
      return options.compactSession ? await options.compactSession(signal) : { participant: runParticipant, ok: true, sessionId: `session-${runParticipant.id}` };
    },
    run: async (runParticipant, prompt, _repoPath, _diffMode, _kind, signal, runOptions) => {
      prompts.push({ participantId: runParticipant.id, prompt });
      order.push(`turn ${runParticipant.id}`);
      const content = await options.turn({
        prompt, participantId: runParticipant.id, actor: { ...grants.get(runParticipant.id), capabilities: ["compaction.request", "participants.request"] },
        service: made.service, call: prompts.filter((item) => item.participantId === runParticipant.id).length, signal, options: runOptions
      });
      const said = typeof content === "string" ? { content } : content;
      return { participant: runParticipant, ok: true, ...said, durationMs: 1, sessionId: `session-${runParticipant.id}` };
    }
  });
  chatParts(made.service).chatHistory.ensureHistoryFiles = async () => tmpdir();
  const replies = (): any[] => made.storage.current.messages.filter((message: any) => message.role === "participant" && message.status === "done");
  const approvals = (): any[] => made.storage.current.metadata.pendingAppToolApprovals ?? [];
  return { ...made, participant, conversation, prompts, order, debugEvents, replies, approvals };
}

export function testService(options: {
  conversation: Conversation;
  compactSession: (participant: ParticipantConfig, repoPath: string | undefined, diffMode: undefined, kind: "chat", signal: AbortSignal | undefined, options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  contextUsageForSession?: (participant: ParticipantConfig, sessionId: string | undefined) => Promise<Record<string, unknown> | undefined>;
  run?: (participant: ParticipantConfig, prompt: string, repoPath: string | undefined, diffMode: undefined, kind: "chat", signal: AbortSignal | undefined, options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  appMcp?: Record<string, unknown>;
  debugEvents?: Array<{ event: string; payload: Record<string, unknown> }>;
}): { service: ChatService; storage: any } {
  const storage = {
    current: clone(options.conversation),
    async getConversation(id: string): Promise<Conversation | undefined> {
      return this.current?.id === id ? clone(this.current) : undefined;
    },
    async saveConversation(conversation: Conversation): Promise<void> {
      this.current = clone(conversation);
    },
    // What the User's server's feed asks of a device's storage.
    conversationTombstones() {
      return { isDeleted: async () => false, mark: async () => undefined, pendingCopies: async () => [] };
    }
  };
  const settings = {
    async getPublicSettings(): Promise<{ chatRoleConfigs: ChatRoleConfig[]; chatPromptContext: typeof DEFAULT_CHAT_PROMPT_CONTEXT }> {
      return { chatRoleConfigs: [ROLE], chatPromptContext: DEFAULT_CHAT_PROMPT_CONTEXT };
    }
  };
  const cliRunner = {
    async compactSession(...args: Parameters<typeof options.compactSession>): Promise<Record<string, unknown>> {
      return options.compactSession(...args);
    },
    async contextUsageForSession(participant: ParticipantConfig, sessionId: string | undefined): Promise<Record<string, unknown> | undefined> {
      return options.contextUsageForSession?.(participant, sessionId);
    },
    async detectAgents(): Promise<[]> {
      return [];
    },
    async run(...args: Parameters<NonNullable<typeof options.run>>): Promise<Record<string, unknown>> {
      if (!options.run) throw new Error("No turn expected in this test.");
      return options.run(...args);
    }
  };
  const debugLogs = {
    async write(event: string, payload: Record<string, unknown>): Promise<void> {
      options.debugEvents?.push({ event, payload });
    }
  };
  return {
    service: new ChatService(storage as never, settings as never, cliRunner as never, debugLogs as never, options.appMcp as never),
    storage
  };
}

export function chatParticipant(patch: Partial<ChatParticipant> = {}): ChatParticipant {
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

export function selfCompactionActor(participant: ChatParticipant): any {
  return {
    conversationId: "chat-compact",
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: ROLE.version,
    capabilities: ["compaction.request"],
    runId: "active-turn"
  };
}

export function chatSession(participant: ChatParticipant, sessionId: string): ChatParticipantSession {
  return {
    participantId: participant.id,
    sessionId,
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    roleRuntime: "codex-developer-instructions",
    participantKind: participant.kind,
    participantAgentMode: "default",
    participantPermissions: normalizeChatAgentPermissions(participant.permissions),
    runtimeConfigVersion: 1,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    updatedAt: NOW
  };
}

export function chatConversation(participants: ChatParticipant[], sessions: ChatParticipantSession[]): Conversation {
  return {
    id: "chat-compact",
    title: "Compact test",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    messages: [],
    findings: [],
    metadata: {
      participants,
      participantSessions: sessions
    }
  };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await delay(10);
  }
  assert.fail("Timed out waiting for condition.");
}
