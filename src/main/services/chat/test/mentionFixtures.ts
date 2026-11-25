// What these chat tests set up.
import assert from "node:assert/strict";
import { ChatService } from "../../chat";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../../../shared/agentPermissions";
import type {
  ChatAppToolApproval, ChatMessage, ChatParticipant, ChatParticipantRequestStatus, ChatRoleConfig, Conversation
} from "../../../../shared/types";

export const NOW = "2026-05-19T12:00:00.000Z";

export const ROLE: ChatRoleConfig = {
  id: "engineer",
  label: "Engineer",
  instructions: "Answer directly.",
  version: 1,
  appToolCapabilities: [],
  updatedAt: NOW
};

export function testService(options: {
  canRequestPermissions?: boolean;
  conversations?: Conversation[];
  onSnapshot?: (conversation: Conversation) => void;
  onProgress?: (progress: { agentProgress?: { partialContent?: string } }) => void;
} = {}): {
  service: ChatService;
  storage: {
    getConversation(id: string): Promise<Conversation | undefined>;
    listConversations(): Promise<Array<{ id: string; kind: Conversation["kind"] }>>;
    saveConversation(conversation: Conversation): Promise<void>;
  };
} {
  const conversations = new Map((options.conversations ?? []).map((conversation) => [conversation.id, cloneConversation(conversation)]));
  const storage = {
    async getConversation(id: string): Promise<Conversation | undefined> {
      const conversation = conversations.get(id);
      return conversation ? cloneConversation(conversation) : undefined;
    },
    async listConversations(): Promise<Array<{ id: string; kind: Conversation["kind"] }>> {
      return Array.from(conversations.values()).map((conversation) => ({
        id: conversation.id,
        kind: conversation.kind
      }));
    },
    async saveConversation(conversation: Conversation): Promise<void> {
      conversations.set(conversation.id, cloneConversation(conversation));
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
    service: new ChatService(
      storage as never,
      settings as never,
      cliRunner as never,
      debugLogs as never,
      appMcp as never,
      options.onSnapshot,
      undefined,
      options.onProgress as never
    ),
    storage
  };
}

export function chatParticipant(
  permissionPatch: Partial<ReturnType<typeof defaultChatAgentPermissions>> = {},
  participantPatch: Partial<ChatParticipant> = {}
): ChatParticipant {
  return {
    id: "participant-1",
    handle: "drew",
    roleConfigId: ROLE.id,
    kind: "codex-cli",
    agentMode: "default",
    permissions: normalizeChatAgentPermissions({
      ...defaultChatAgentPermissions(),
      ...permissionPatch
    }),
    ...participantPatch
  };
}

export function chatConversation(participants: ChatParticipant[], repoPath: string): Conversation {
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

export function participantRequestApproval(
  requester: ChatParticipant,
  target: ChatParticipant,
  requestMessage: ChatMessage,
  runId: string
): ChatAppToolApproval {
  const batch = requestMessage.metadata?.participantRequest;
  assert.ok(batch);
  return {
    id: `approval-${target.handle}`,
    conversationId: "conversation-1",
    requesterParticipantId: requester.id,
    requesterHandle: requester.handle,
    requesterRoleConfigId: requester.roleConfigId,
    toolName: "app_chat_request_participants",
    capability: "participants.request",
    status: "pending",
    request: {
      requests: [{
        target: target.handle,
        prompt: "Review this."
      }],
      resumeRequester: true,
      source: "mcp",
      requestMessageId: requestMessage.id,
      batchId: batch.id
    },
    summary: `Ask @${target.handle}`,
    createdAt: NOW,
    updatedAt: NOW,
    resumeContext: {
      runId,
      triggerMessageId: "trigger-message",
      participantRequestBatchId: batch.id
    }
  };
}

export function userMessage(id: string, content: string): ChatMessage {
  return {
    id,
    role: "user",
    content,
    createdAt: NOW,
    status: "done",
    metadata: { threadId: id }
  };
}

export function participantRequestItem(
  target: ChatParticipant,
  status: ChatParticipantRequestStatus,
  updatedAt = NOW
) {
  return {
    targetParticipantId: target.id,
    targetHandle: target.handle,
    prompt: "Review this.",
    status,
    createdAt: NOW,
    updatedAt
  };
}

export function participantRequestMessageWithItems(
  requester: ChatParticipant,
  items: ReturnType<typeof participantRequestItem>[]
): ChatMessage {
  return {
    id: "request-message",
    role: "participant",
    participantId: requester.id,
    participantLabel: `@${requester.handle}`,
    content: items.map((item) => `@${item.targetHandle} ${item.prompt}`).join("\n"),
    createdAt: NOW,
    status: "done",
    metadata: {
      threadId: "request-message",
      participantRequest: {
        id: "batch-1",
        requesterParticipantId: requester.id,
        requesterHandle: requester.handle,
        source: "mcp",
        resumeRequester: true,
        status: items.some((item) => item.status === "pending_approval")
          ? "pending_approval"
          : items.some((item) => item.status === "running")
            ? "running"
            : items[0]?.status ?? "completed",
        depth: 1,
        createdAt: NOW,
        updatedAt: items.reduce((latest, item) => item.updatedAt > latest ? item.updatedAt : latest, NOW),
        triggerMessageId: "trigger-message",
        items
      }
    }
  };
}

export function participantMessage(participant: ChatParticipant, id: string, content: string): ChatMessage {
  return {
    id,
    role: "participant",
    participantId: participant.id,
    participantLabel: `@${participant.handle}`,
    content,
    createdAt: NOW,
    status: "done",
    metadata: { threadId: id }
  };
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for operation.")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}

export function cloneConversation(conversation: Conversation): Conversation {
  return JSON.parse(JSON.stringify(conversation)) as Conversation;
}
