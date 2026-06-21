import type {
  ChatParticipantRequestBatch,
  Conversation
} from "../../../shared/types";
import { chatParticipantReference } from "../conversation/conversation-display";

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

function stripChatControlBlocks(content: string): string {
  return stripUserChoiceBlocks(stripNoParticipantRequests(content)).trimEnd();
}

function stripNoParticipantRequests(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const next: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (/^participant requests\s*:\s*none\.?$/i.test(trimmed)) {
      continue;
    }
    if (/^participant requests\s*:\s*$/i.test(trimmed)) {
      const following = lines[index + 1]?.trim();
      if (following && /^(?:[-*]|\d+[.)])\s+none\.?$/i.test(following)) {
        index += 1;
        continue;
      }
    }
    next.push(line);
  }
  return next.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function stripUserChoiceBlocks(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const nextLines: string[] = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      nextLines.push(lines[index]);
      continue;
    }
    if (inFence || !/^user choice\s*:/i.test(trimmed)) {
      nextLines.push(lines[index]);
      continue;
    }
    for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
      const blockTrimmed = lines[blockIndex].trim();
      if (!blockTrimmed) {
        index = blockIndex;
        continue;
      }
      if (isUserChoiceDisplayProtocolLine(blockTrimmed)) {
        index = blockIndex;
        continue;
      }
      break;
    }
  }
  return nextLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function isUserChoiceDisplayProtocolLine(line: string): boolean {
  const normalized = line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim();
  return /^(?:T|TITLE|Q|QUESTION|R|RECOMMENDED|O\d+)\s*[:|]/i.test(normalized);
}
