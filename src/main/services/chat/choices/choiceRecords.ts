import { randomUUID } from "node:crypto";
import type {
  ChatChoiceOption, ChatMessage, ChatParticipant, ChatPendingChoice, ChatPendingMention, Conversation
} from "../../../../shared/types";
import { participantForMentionHandle, withoutFencedCode } from "./mentions";
import { chatParticipants } from "../members/identity";
import { extractParticipantRequestMentions } from "../requests/inferredRequestText";

interface ChatChoiceDraft {
  title?: string;
  question?: string;
  recommendedOptionId?: string;
  options: ChatChoiceOption[];
}

function pendingMentionsFromAgentReply(conversation: Conversation, sourceParticipant: ChatParticipant, content: string): ChatPendingMention[] {
  const participants = chatParticipants(conversation);
  const handles = extractParticipantRequestMentions(content);
  const mentions = new Map<string, ChatPendingMention>();
  for (const handle of handles) {
    const target = participantForMentionHandle(participants, handle);
    if (!target || target.id === sourceParticipant.id) {
      continue;
    }
    mentions.set(target.id, {
      targetParticipantId: target.id,
      targetHandle: target.handle,
      status: "pending"
    });
  }
  return Array.from(mentions.values());
}

export function pendingChoiceFromAgentReply(content: string): ChatPendingChoice | undefined {
  const draft = extractUserChoiceDraft(content);
  if (!draft) {
    return undefined;
  }
  return {
    id: `choice-${randomUUID()}`,
    title: (draft.title || draft.question || "Choose an option").trim().slice(0, 120),
    question: (draft.question || draft.title || "Choose an option.").trim(),
    options: draft.options,
    recommendedOptionId: draft.recommendedOptionId,
    status: "pending",
    selectedAt: undefined,
    askedAt: new Date().toISOString()
  };
}

function extractUserChoiceDraft(content: string): ChatChoiceDraft | undefined {
  const lines = withoutFencedCode(content).replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*user choice\s*:\s*(.*)$/i);
    if (!match) {
      continue;
    }
    const blockLines: string[] = [];
    const inline = match[1].trim();
    if (inline && !/^none\.?$/i.test(inline)) {
      blockLines.push(`Q: ${inline}`);
    }
    for (let next = index + 1; next < lines.length; next += 1) {
      const trimmed = lines[next].trim();
      if (!trimmed) {
        if (blockLines.length > 0) {
          break;
        }
        continue;
      }
      if (/^#{1,6}\s+/.test(trimmed) || /^participant requests\s*:/i.test(trimmed) || /^return to requester after replies\s*:/i.test(trimmed)) {
        break;
      }
      if (/^user choice\s*:/i.test(trimmed)) {
        break;
      }
      if (isUserChoiceProtocolLine(trimmed)) {
        blockLines.push(trimmed);
        continue;
      }
      break;
    }
    const draft = parseUserChoiceBlock(blockLines);
    if (draft) {
      return draft;
    }
  }
  return undefined;
}

function isUserChoiceProtocolLine(line: string): boolean {
  const normalized = stripListMarker(line);
  return /^(?:T|TITLE|Q|QUESTION|R|RECOMMENDED|O\d+)\s*[:|]/i.test(normalized) || /^(?:[-*]|\d+[.)])\s+\S/.test(line);
}

function parseUserChoiceBlock(lines: string[]): ChatChoiceDraft | undefined {
  const draft: ChatChoiceDraft = { options: [] };
  let nextOptionIndex = 1;
  const usedOptionIds = new Set<string>();

  for (const line of lines) {
    const normalized = stripListMarker(line);
    if (!normalized) {
      continue;
    }
    const field = normalized.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*[:|]\s*(.*)$/);
    if (field) {
      const key = field[1].toUpperCase();
      const value = field[2].trim();
      if (!value) {
        continue;
      }
      if (key === "T" || key === "TITLE") {
        draft.title = value;
        continue;
      }
      if (key === "Q" || key === "QUESTION") {
        draft.question = value;
        continue;
      }
      if (key === "R" || key === "RECOMMENDED") {
        draft.recommendedOptionId = value;
        continue;
      }
      if (/^O\d+$/i.test(key)) {
        addChoiceOption(draft, key.toUpperCase(), value, usedOptionIds);
        nextOptionIndex = Math.max(nextOptionIndex, Number(key.slice(1)) + 1 || nextOptionIndex);
        continue;
      }
    }
    while (usedOptionIds.has(`O${nextOptionIndex}`)) {
      nextOptionIndex += 1;
    }
    addChoiceOption(draft, `O${nextOptionIndex}`, normalized, usedOptionIds);
    nextOptionIndex += 1;
  }

  if (draft.options.length < 2 || !(draft.question?.trim() || draft.title?.trim())) {
    return undefined;
  }
  draft.recommendedOptionId = resolveRecommendedChoiceOptionId(draft.recommendedOptionId, draft.options);
  return draft;
}

function addChoiceOption(draft: ChatChoiceDraft, optionId: string, value: string, usedOptionIds: Set<string>): void {
  const parsed = parseChoiceOptionText(value);
  if (!parsed.label) {
    return;
  }
  let id = optionId.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  if (!id || usedOptionIds.has(id)) {
    let index = draft.options.length + 1;
    while (usedOptionIds.has(`O${index}`)) {
      index += 1;
    }
    id = `O${index}`;
  }
  usedOptionIds.add(id);
  draft.options.push({ id, ...parsed });
}

function parseChoiceOptionText(value: string): { label: string; description?: string } {
  const parts = value.split(/\s+\|\s+/);
  const label = parts.shift()?.trim() ?? "";
  const description = parts.join(" | ").trim();
  return {
    label,
    description: description || undefined
  };
}

function resolveRecommendedChoiceOptionId(value: string | undefined, options: ChatChoiceOption[]): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const byId = options.find((option) => option.id.toLowerCase() === normalized.toLowerCase());
  if (byId) {
    return byId.id;
  }
  const byLabel = options.find((option) => option.label.toLowerCase() === normalized.toLowerCase());
  return byLabel?.id;
}

function stripListMarker(line: string): string {
  return line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim();
}

export function updatePendingMentionStatus(sourceMessage: ChatMessage, targetIds: Set<string>, status: ChatPendingMention["status"]): void {
  const now = new Date().toISOString();
  sourceMessage.metadata = {
    ...sourceMessage.metadata,
    pendingMentions: (sourceMessage.metadata?.pendingMentions ?? []).map((mention) =>
      targetIds.has(mention.targetParticipantId)
        ? {
            ...mention,
            status,
            approvedAt: status === "approved" ? now : mention.approvedAt,
            rejectedAt: status === "rejected" ? now : mention.rejectedAt
          }
        : mention
    )
  };
}

export function updatePendingChoiceSelection(
  sourceMessage: ChatMessage,
  choiceId: string,
  selectedOptionId: string,
  customAnswer?: string,
  note?: string
): void {
  const choice = sourceMessage.metadata?.pendingChoice;
  if (!choice || choice.id !== choiceId) {
    return;
  }
  // Answered after it expired (the answer crossed the expiry): answered.
  const { expiredAt: _expiredAt, cancelledAt: _cancelledAt, ...waiting } = choice;
  sourceMessage.metadata = {
    ...sourceMessage.metadata,
    pendingChoice: {
      ...waiting,
      status: "selected",
      selectedOptionId,
      customAnswer: customAnswer || undefined,
      note: note || undefined,
      selectedAt: new Date().toISOString()
    }
  };
}

export function updatePendingChoiceCancellation(
  sourceMessage: ChatMessage,
  choiceId: string
): void {
  const choice = sourceMessage.metadata?.pendingChoice;
  if (!choice || choice.id !== choiceId) {
    return;
  }
  // Cancelled by the User (after it expired, too): her cancel is what it shows.
  const { expiredAt: _expiredAt, ...rest } = choice;
  sourceMessage.metadata = {
    ...sourceMessage.metadata,
    pendingChoice: {
      ...rest,
      status: "cancelled",
      cancelledAt: new Date().toISOString()
    }
  };
}

export function formatChoiceSelectionForChat(
  sourceMessage: ChatMessage,
  choice: ChatPendingChoice,
  selectedOption: ChatChoiceOption | undefined,
  customAnswer?: string,
  note?: string
): string {
  const requester = sourceMessage.participantLabel ?? "the requester";
  const isCustomAnswer = !selectedOption && Boolean(customAnswer?.trim());
  return [
    `Choice selected for ${requester}.`,
    "",
    `Choice: ${choice.title}`,
    `Question: ${choice.question}`,
    selectedOption ? `Selected option: ${selectedOption.label}` : "",
    selectedOption?.description ? `Option context: ${selectedOption.description}` : "",
    isCustomAnswer ? "Selected option: Write your own answer" : "",
    customAnswer?.trim() ? `Custom answer: ${customAnswer.trim()}` : "",
    note?.trim() ? `Note: ${note.trim()}` : ""
  ].filter(Boolean).join("\n");
}
