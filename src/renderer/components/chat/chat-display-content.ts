import type {
  ChatParticipantRequestBatch,
  Conversation
} from "../../../shared/types";
import { chatParticipantReference } from "../conversation/conversation-display";
import { stripChatControlBlocks } from "../../../shared/chatControlBlocks";

export function chatDisplayContent(message: Conversation["messages"][number], author: string): string {
  if (message.metadata?.participantRequest) {
    return participantRequestDisplayContent(message.metadata.participantRequest);
  }
  if (message.role !== "participant") {
    return message.content;
  }
  const lines = message.content.replace(/\r\n/g, "\n").split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim());
  if (firstContentIndex < 0) {
    return "";
  }
  const firstLine = lines[firstContentIndex].trim();
  const labels = [author, message.participantLabel].filter((value): value is string => Boolean(value));
  if (!labels.some((label) => firstLine === label || firstLine === `@${label.replace(/^@/, "")}`)) {
    return stripChatControlBlocks(message.content);
  }
  const next = [...lines.slice(0, firstContentIndex), ...lines.slice(firstContentIndex + 1)];
  while (next.length > 0 && !next[0].trim()) {
    next.shift();
  }
  return stripChatControlBlocks(next.join("\n"));
}

function participantRequestDisplayContent(batch: ChatParticipantRequestBatch): string {
  if (batch.source === "inferred") {
    const targets = batch.items.map((item) => chatParticipantReference(item.targetHandle)).join(", ");
    return `Asked ${targets} for input.`;
  }
  return batch.items.map((item) => `${chatParticipantReference(item.targetHandle)} ${item.prompt}`.trim()).join("\n");
}
