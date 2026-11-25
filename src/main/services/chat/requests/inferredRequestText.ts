import { sessionsMentionSentenceTitle } from "../../../../shared/mainSessionView";
import type { ChatMessage, ChatParticipant, Conversation } from "../../../../shared/types";
import { APP_CHAT_SEND_MESSAGE_TOOL } from "../../appMcp";
import { confirmationRequestWasAsked } from "../approvals/approvalRecords";
import { extractMentions, mentionHandlesForParticipant, withoutFencedCode } from "../choices/mentions";
import { chatParticipants, formatHandleList } from "../members/identity";
import { PARTICIPANT_REQUEST_SCRUTINY_APPENDIX } from "./constants";
import { participantRequestBatches, participantRequestHasUnfinishedItems } from "./requestRecords";
import type { InferredParticipantRequestSuppressionScope } from "./types";

export function inferredParticipantRequestSuppression(
  conversation: Conversation,
  requester: ChatParticipant,
  sourceMessage: ChatMessage
): {
  targetHandles: Set<string>;
  scopeByTarget: Map<string, InferredParticipantRequestSuppressionScope>;
} {
  const sourceIsToolPosted = sourceMessage.metadata?.appMessageSource === APP_CHAT_SEND_MESSAGE_TOOL;
  const turnSegmentId = sourceMessage.metadata?.turnSegmentId;
  const runId = sourceMessage.metadata?.runId;
  const participantRequestBatchId = sourceMessage.metadata?.participantRequestBatchId;
  if ((sourceIsToolPosted && !turnSegmentId) || (!sourceIsToolPosted && !runId && !participantRequestBatchId)) {
    return { targetHandles: new Set(), scopeByTarget: new Map() };
  }

  const messageById = new Map(conversation.messages.map((message) => [message.id, message]));
  const resumedBatch = !sourceIsToolPosted && participantRequestBatchId
    ? participantRequestBatches(conversation).find((batch) =>
        batch.id === participantRequestBatchId &&
        batch.source === "inferred" &&
        batch.requesterParticipantId === requester.id &&
        Boolean(batch.triggerMessageId)
      )
    : undefined;
  const resumedBatchSource = resumedBatch?.triggerMessageId
    ? messageById.get(resumedBatch.triggerMessageId)
    : undefined;
  const originatingToolSegmentId = resumedBatchSource?.metadata?.appMessageSource === APP_CHAT_SEND_MESSAGE_TOOL
    ? resumedBatchSource.metadata.turnSegmentId
    : undefined;
  const targetHandles = originatingToolSegmentId
    ? inferredParticipantRequestTargetsForSegment(
        conversation,
        requester,
        originatingToolSegmentId,
        { toolPostedOnly: true, messageById }
      )
    : new Set<string>();
  const scopeByTarget = new Map<string, InferredParticipantRequestSuppressionScope>();
  for (const targetHandle of targetHandles) {
    scopeByTarget.set(targetHandle, "final-source-tool-origin-segment");
  }
  for (const batch of participantRequestBatches(conversation)) {
    if (
      batch.source !== "inferred" ||
      batch.requesterParticipantId !== requester.id ||
      !batch.triggerMessageId
    ) {
      continue;
    }
    const priorSource = messageById.get(batch.triggerMessageId);
    // Asked already from this very reply: by a post during its turn, which
    // is part of the reply (interimPosts.ts).
    const fromSameReply = batch.triggerMessageId === sourceMessage.id;
    if (!fromSameReply && priorSource?.metadata?.appMessageSource !== APP_CHAT_SEND_MESSAGE_TOOL) {
      continue;
    }
    const matchesRun = !sourceIsToolPosted && Boolean(runId) && priorSource?.metadata?.runId === runId;
    const matchesScope = fromSameReply || (sourceIsToolPosted
      ? priorSource?.metadata?.turnSegmentId === turnSegmentId
      : matchesRun);
    if (!matchesScope) {
      continue;
    }
    const decidingScope: InferredParticipantRequestSuppressionScope = sourceIsToolPosted
      ? "tool-source-segment"
      : "final-source-tool-origin-run";
    for (const item of batch.items) {
      const handle = item.targetHandle.toLowerCase();
      targetHandles.add(handle);
      if (!scopeByTarget.has(handle)) {
        scopeByTarget.set(handle, decidingScope);
      }
    }
  }
  return { targetHandles, scopeByTarget };
}

export function inferredParticipantRequestTargetsForSegment(
  conversation: Conversation,
  requester: ChatParticipant,
  turnSegmentId: string | undefined,
  options: { toolPostedOnly?: boolean; messageById?: ReadonlyMap<string, ChatMessage> } = {}
): Set<string> {
  const targetHandles = new Set<string>();
  if (!turnSegmentId) {
    return targetHandles;
  }
  const messageById = options.messageById ?? new Map(conversation.messages.map((message) => [message.id, message]));
  for (const batch of participantRequestBatches(conversation)) {
    if (
      batch.source !== "inferred" ||
      batch.requesterParticipantId !== requester.id ||
      !batch.triggerMessageId
    ) {
      continue;
    }
    const source = messageById.get(batch.triggerMessageId);
    if (
      source?.metadata?.turnSegmentId !== turnSegmentId ||
      (options.toolPostedOnly && source.metadata?.appMessageSource !== APP_CHAT_SEND_MESSAGE_TOOL)
    ) {
      continue;
    }
    for (const item of batch.items) {
      targetHandles.add(item.targetHandle.toLowerCase());
    }
  }
  return targetHandles;
}

export function inferredParticipantRequestWarning(
  requesterHandle: string,
  targetHandles: string[],
  error: unknown
): string {
  const targetSummary = formatHandleList(targetHandles.map((handle) => `@${handle}`));
  const subject = targetSummary
    ? `Participant ${targetHandles.length === 1 ? "mention" : "mentions"} from @${requesterHandle} to ${targetSummary}`
    : `Participant mentions from @${requesterHandle}`;
  const verb = targetHandles.length === 1 ? "was" : "were";
  const message = error instanceof Error ? error.message : String(error);
  if (/max depth/i.test(message)) {
    return `${subject} ${verb} not triggered because the participant-request depth limit was reached.`;
  }
  if (/chain limit/i.test(message)) {
    return `${subject} ${verb} not triggered because the participant-request chain limit was reached.`;
  }
  if (/rate limit/i.test(message)) {
    return `${subject} ${verb} not triggered because the participant-request rate limit was reached.`;
  }
  if (/disabled/i.test(message)) {
    return `${subject} ${verb} not triggered because participant requests are disabled for @${requesterHandle}.`;
  }
  return `${subject} ${verb} not triggered because the inferred request could not be prepared.`;
}

export function hasActiveParticipantRequestForTargets(
  conversation: Conversation,
  requester: ChatParticipant,
  sourceMessageId: string,
  targetHandles: string[]
): boolean {
  const targets = new Set(targetHandles.map((handle) => handle.toLowerCase()));
  return participantRequestBatches(conversation).some((batch) => {
    if (batch.requesterParticipantId !== requester.id) {
      return false;
    }
    if (batch.triggerMessageId === sourceMessageId) {
      return participantRequestHasUnfinishedItems(batch);
    }
    if (!participantRequestHasUnfinishedItems(batch)) {
      return false;
    }
    return batch.items.some((item) =>
      targets.has(item.targetHandle.toLowerCase()) &&
      ["pending_approval", "running", "resuming_requester"].includes(item.status)
    );
  });
}

export function inferredParticipantRequestPrompt(requesterHandle: string, snippet: string): string {
  const base = [
    `@${requesterHandle} appeared to request your input in this chat reply.`,
    `Relevant excerpt: ${snippet}`,
    "",
    "First determine whether you are the primary/direct addressee of this request.",
    "Handle the request only if the excerpt is asking you to do work or provide input.",
    "Reply only \"Noted\" if the message is addressed to another participant or only mentions you as context.",
    "If you are the direct addressee, respond directly to the request, focusing only on the points that need your input."
  ].join("\n");
  if (!confirmationRequestWasAsked(snippet)) {
    return base;
  }
  return [base, "", PARTICIPANT_REQUEST_SCRUTINY_APPENDIX].join("\n");
}

export function inferParticipantRequestTargets(
  conversation: Conversation,
  sourceParticipant: ChatParticipant,
  content: string
): Array<{ targetHandle: string; snippet: string; title: string }> {
  const participants = chatParticipants(conversation)
    .filter((participant) => participant.id !== sourceParticipant.id);
  const cleaned = stripInferenceIgnoredText(content);
  // Its task's title is the reply's words as written, inline code as its
  // text: read from the reply without fenced code, where inline code is
  // blanked out (same length) only to find the mention the request is made
  // from, as the request itself ignores mentions in code.
  let titleSource: { text: string; search: string; handles: string[] } | undefined;
  const titleSourceOf = () => {
    if (!titleSource) {
      const text = withoutFencedCode(content);
      titleSource = {
        text,
        search: text.replace(/`[^`\n]+`/g, (code) => " ".repeat(code.length)),
        handles: chatParticipants(conversation).flatMap((participant) => mentionHandlesForParticipant(participant))
      };
    }
    return titleSource;
  };
  const inferred: Array<{ targetHandle: string; snippet: string; title: string }> = [];
  for (const participant of participants) {
    const handles = mentionHandlesForParticipant(participant);
    const match = handles
      .map((handle) => cleaned.match(new RegExp(`@${escapeRegExp(handle)}\\b`, "i")))
      .find((candidate): candidate is RegExpMatchArray => Boolean(candidate));
    if (!match || typeof match.index !== "number") {
      continue;
    }
    const start = Math.max(0, match.index - 120);
    const end = Math.min(cleaned.length, match.index + participant.handle.length + 1200);
    const snippet = cleaned.slice(start, end).replace(/\s+/g, " ").trim();
    // The sessions view names its task by the reply's sentence that
    // mentions it, without @-names (sessionsMentionSentenceTitle).
    const mentioned = match[0].slice(1);
    const source = titleSourceOf();
    const at = source.search.search(new RegExp(`@${escapeRegExp(mentioned)}\\b`, "i"));
    const title = sessionsMentionSentenceTitle(source.text, mentioned, { ...(at >= 0 ? { at } : {}), handles: source.handles });
    inferred.push({ targetHandle: participant.handle, snippet, title });
  }
  return inferred;
}

function stripInferenceIgnoredText(content: string): string {
  let inLegacyProtocolBlock = false;
  return withoutFencedCode(content)
    .replace(/`[^`\n]+`/g, "")
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (/^(?:participant requests|return to requester after replies)\s*:/i.test(trimmed)) {
        inLegacyProtocolBlock = true;
        return false;
      }
      if (inLegacyProtocolBlock) {
        if (!trimmed) {
          inLegacyProtocolBlock = false;
          return true;
        }
        if (/^(?:[-*]|\d+[.)])\s+/.test(trimmed)) {
          return false;
        }
        inLegacyProtocolBlock = false;
      }
      return (
        !trimmed.startsWith(">") &&
        !/^(?:user|system)\s*:\s+/i.test(trimmed)
      );
    })
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractParticipantRequestMentions(content: string): string[] {
  const lines = withoutFencedCode(content).split(/\r?\n/);
  const requestLines: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*participant requests\s*:\s*(.*)$/i);
    if (!match) {
      continue;
    }
    const inline = match[1].trim();
    if (inline) {
      if (/^none\.?$/i.test(inline)) {
        return [];
      }
      requestLines.push(inline);
    }
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next];
      const trimmed = line.trim();
      if (!trimmed) {
        if (requestLines.length > 0) {
          break;
        }
        continue;
      }
      if (/^#{1,6}\s+/.test(trimmed)) {
        break;
      }
      if (/^participant requests\s*:/i.test(trimmed)) {
        break;
      }
      if (/^(?:[-*]|\d+[.)])\s+/.test(trimmed)) {
        if (/^(?:[-*]|\d+[.)])\s+none\.?$/i.test(trimmed)) {
          return [];
        }
        requestLines.push(trimmed);
        continue;
      }
      break;
    }
    break;
  }
  return extractMentions(requestLines.join("\n"));
}

function requesterContinuationRequested(content: string): boolean {
  return withoutFencedCode(content)
    .split(/\r?\n/)
    .some((line) => /^\s*return to requester after replies\s*:\s*(?:yes|true)\s*$/i.test(line));
}
