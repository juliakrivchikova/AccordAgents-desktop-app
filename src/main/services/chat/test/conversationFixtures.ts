// What the conversation tests set up.
import { ChatService } from "../../chat";
import { chatParts } from "./chatParts";
import type {
  AgentContextUsage, ChatParticipant, ChatParticipantConfig, ChatRoleConfig, Conversation, ConversationSummary
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

export function testService(conversationList: Conversation[], options: {
  closeSessions?: (conversationId: string) => Promise<void>;
  participantConfigs?: ChatParticipantConfig[];
  contextUsageBySession?: Record<string, AgentContextUsage | undefined>;
  contextUsageRequests?: Array<{ sessionId: string | undefined; waitForLog: boolean | undefined }>;
  failSaves?: number;
} = {}): {
  service: ChatService;
  storage: {
    listConversations(): Promise<ConversationSummary[]>;
    getConversation(id: string): Promise<Conversation | undefined>;
    saveConversation(conversation: Conversation): Promise<void>;
    deleteConversation(id: string): Promise<boolean>;
  };
  snapshots: Conversation[];
  historyWrites: string[];
} {
  const conversations = new Map(conversationList.map((conversation) => [conversation.id, cloneConversation(conversation)]));
  const snapshots: Conversation[] = [];
  const historyWrites: string[] = [];
  let remainingFailedSaves = options.failSaves ?? 0;
  const storage = {
    async listConversations(): Promise<ConversationSummary[]> {
      return Array.from(conversations.values()).map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        kind: conversation.kind,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        repoPath: conversation.repoPath,
        running: Boolean(conversation.metadata.running)
      }));
    },
    async getConversation(id: string): Promise<Conversation | undefined> {
      const conversation = conversations.get(id);
      return conversation ? cloneConversation(conversation) : undefined;
    },
    async saveConversation(conversation: Conversation): Promise<void> {
      if (remainingFailedSaves > 0) {
        remainingFailedSaves -= 1;
        throw new Error("injected save failure");
      }
      conversations.set(conversation.id, cloneConversation(conversation));
    },
    async deleteConversation(id: string): Promise<boolean> {
      return conversations.delete(id);
    }
  };
  const settings = {
    async getPublicSettings(): Promise<{ chatRoleConfigs: ChatRoleConfig[]; chatParticipantConfigs: ChatParticipantConfig[] }> {
      return { chatRoleConfigs: [ROLE], chatParticipantConfigs: options.participantConfigs ?? [] };
    }
  };
  const cliRunner = {
    async closeConversationSessions(id: string): Promise<void> { await options.closeSessions?.(id); },
    async detectAgents(): Promise<[]> {
      return [];
    },
    async contextUsageForSession(
      _participant: unknown,
      sessionId: string | undefined,
      requestOptions: { waitForLog?: boolean } = {}
    ): Promise<AgentContextUsage | undefined> {
      options.contextUsageRequests?.push({ sessionId, waitForLog: requestOptions.waitForLog });
      return sessionId ? options.contextUsageBySession?.[sessionId] : undefined;
    }
  };
  const debugLogs = {
    async write(): Promise<void> {
      return undefined;
    }
  };
  const service = new ChatService(
    storage as never,
    settings as never,
    cliRunner as never,
    debugLogs as never,
    undefined,
    (conversation) => snapshots.push(cloneConversation(conversation))
  );
  (chatParts(service).chatHistory as unknown as { ensureHistoryFiles(conversation: Conversation): Promise<string> }).ensureHistoryFiles = async (conversation) => {
    historyWrites.push(conversation.title);
    return "/mock/history";
  };
  (chatParts(service).deletion as unknown as { cleanupDeletedConversationArtifacts(conversation: Conversation): Promise<void> })
    .cleanupDeletedConversationArtifacts = async () => undefined;
  return { service, storage, snapshots, historyWrites };
}

export function chatConversation(patch: Partial<Conversation> = {}): Conversation {
  return {
    id: "conversation-1",
    title: "Test chat",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    repoPath: "/repo",
    messages: [{
      id: "message-1",
      role: "system",
      content: "Chat started.",
      createdAt: NOW,
      status: "done"
    }],
    findings: [],
    metadata: {
      participants: [chatParticipant()],
      participantSessions: [],
      ...(patch.metadata ?? {})
    },
    ...patch
  };
}

export function chatParticipant(patch: Partial<ChatParticipant> = {}): ChatParticipant {
  return {
    id: "participant-1",
    handle: "drew",
    roleConfigId: ROLE.id,
    kind: "codex-cli",
    ...patch
  };
}

export function cloneConversation(conversation: Conversation): Conversation {
  return JSON.parse(JSON.stringify(conversation)) as Conversation;
}

export async function holdChatRunLock(service: ChatService, conversationId: string): Promise<() => Promise<void>> {
  let release!: () => void;
  let runFinished!: () => void;
  const started = new Promise<void>((resolve) => {
    void (chatParts(service).activeRuns as unknown as {
      withChatRunLock<T>(conversationId: string, run: () => Promise<T>): Promise<T>;
    }).withChatRunLock(conversationId, async () => {
      resolve();
      await new Promise<void>((unlock) => {
        release = unlock;
      });
    }).finally(() => runFinished());
  });
  const finished = new Promise<void>((resolve) => {
    runFinished = resolve;
  });
  await started;
  return async () => {
    release();
    await finished;
  };
}
