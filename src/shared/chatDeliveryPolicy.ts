import type { ChatMessage, ChatParticipant, Conversation } from "./types";

export interface ChatDispatchReplyContext {
  parentMessageId?: string;
  threadId?: string;
  chatThreadRootId?: string;
}

export interface ChatDeliveryPolicyOptions {
  administratorRoleId: string;
  administratorHandles: string[];
}

export interface ChatDeliveryPolicyInput {
  conversation: Conversation;
  participants: ChatParticipant[];
  content: string;
  context?: ChatDispatchReplyContext;
  options: ChatDeliveryPolicyOptions;
}

export interface ChatDeliveryPolicyResult {
  targets: ChatParticipant[];
  unknownHandles: string[];
}

export function resolveChatDeliveryTargets(input: ChatDeliveryPolicyInput): ChatDeliveryPolicyResult {
  let dispatch = resolveChatMentionTargets(input.participants, input.content, input.options);
  if (dispatch.targets.length === 0 && dispatch.unknownHandles.length === 0) {
    const fallback = resolveLastSenderTarget(input.conversation, input.participants, input.context)
      ?? defaultAdministratorDispatchTarget(input.participants, input.options);
    if (fallback) {
      dispatch = { ...dispatch, targets: [fallback] };
    }
  }
  return dispatch;
}

export function resolveChatMentionTargets(
  participants: ChatParticipant[],
  content: string,
  options: ChatDeliveryPolicyOptions
): ChatDeliveryPolicyResult {
  const targets = new Map<string, ChatParticipant>();
  const unknownHandles: string[] = [];
  for (const handle of extractChatMentions(content)) {
    const participant = chatParticipantForMentionHandle(participants, handle, options);
    if (participant) {
      targets.set(participant.id, participant);
    } else if (!unknownHandles.some((item) => item.toLowerCase() === handle.toLowerCase())) {
      unknownHandles.push(handle);
    }
  }
  return { targets: Array.from(targets.values()), unknownHandles };
}

export function chatParticipantForMentionHandle(
  participants: ChatParticipant[],
  handle: string,
  options: ChatDeliveryPolicyOptions
): ChatParticipant | undefined {
  const normalized = handle.trim().replace(/^@/, "").toLowerCase();
  const exact = participants.find((item) => item.handle.toLowerCase() === normalized);
  if (exact) {
    return exact;
  }
  if (options.administratorHandles.some((item) => item.toLowerCase() === normalized)) {
    return defaultAdministratorDispatchTarget(participants, options);
  }
  return undefined;
}

export function mentionHandlesForChatParticipant(
  participant: ChatParticipant,
  options: ChatDeliveryPolicyOptions
): string[] {
  const handles = [participant.handle];
  if (participant.roleConfigId === options.administratorRoleId) {
    handles.push(...options.administratorHandles);
  }
  const seen = new Set<string>();
  return handles.filter((handle) => {
    const normalized = handle.toLowerCase();
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

export function extractChatMentions(content: string): string[] {
  const matches = withoutFencedCode(content).matchAll(/@([A-Za-z0-9_-]{1,32})/g);
  return Array.from(matches, (match) => match[1]);
}

function resolveLastSenderTarget(
  conversation: Conversation,
  participants: ChatParticipant[],
  context?: ChatDispatchReplyContext
): ChatParticipant | undefined {
  const participantById = (id: string | undefined): ChatParticipant | undefined =>
    id ? participants.find((participant) => participant.id === id) : undefined;

  const threadScoped = Boolean(context?.threadId || context?.chatThreadRootId);
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message.role !== "participant") {
      continue;
    }
    if (threadScoped) {
      if (!messageMatchesDispatchThread(message, context)) {
        continue;
      }
    } else if (!messageIsVisibleTopLevelChatParticipant(message)) {
      continue;
    }
    const author = participantById(message.participantId);
    if (author) {
      return author;
    }
  }

  if (context?.parentMessageId) {
    const parent = conversation.messages.find((message) => message.id === context.parentMessageId);
    if (parent?.role === "participant") {
      return participantById(parent.participantId);
    }
  }

  return undefined;
}

function defaultAdministratorDispatchTarget(
  participants: ChatParticipant[],
  options: ChatDeliveryPolicyOptions
): ChatParticipant | undefined {
  return participants.find((participant) => participant.roleConfigId === options.administratorRoleId);
}

function messageMatchesDispatchThread(message: ChatMessage, context: ChatDispatchReplyContext | undefined): boolean {
  if (context?.threadId && message.metadata?.threadId === context.threadId) {
    return true;
  }
  if (!context?.chatThreadRootId) {
    return false;
  }
  return (
    message.id === context.chatThreadRootId ||
    message.metadata?.chatThreadRootId === context.chatThreadRootId ||
    message.metadata?.threadId === context.chatThreadRootId
  );
}

function messageIsVisibleTopLevelChatParticipant(message: ChatMessage): boolean {
  return message.metadata?.hiddenFromTimeline !== true && !message.metadata?.chatThreadRootId;
}

function withoutFencedCode(content: string): string {
  return content.replace(/```[\s\S]*?```/g, "");
}
