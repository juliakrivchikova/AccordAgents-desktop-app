import type {
  Conversation,
  ConversationKind
} from "../../../shared/types";

export interface TimelineMessageDisplay {
  content: string;
  markdown: boolean;
}

interface LineProtocolItem {
  title: string;
  severity?: string;
  claim?: string;
  evidence?: string;
  action?: string;
}

export function displayMessageContent(message: Conversation["messages"][number], kind: ConversationKind): TimelineMessageDisplay {
  const content = summarizeRawProviderJson(message.content) ?? message.content;
  if (kind === "implementation-plan" && (message.role === "participant" || message.role === "summary")) {
    return { content, markdown: true };
  }
  const protocolSummary = formatLineProtocolForTimeline(message, kind, content);
  const displayContent = protocolSummary ?? content;
  return { content: displayContent, markdown: Boolean(protocolSummary) };
}

export function isHiddenImplementationPlanInternalMessage(message: Conversation["messages"][number], kind: ConversationKind): boolean {
  if (kind !== "implementation-plan") {
    return false;
  }
  if (message.role === "participant" && message.participantId?.startsWith("arbiter:")) {
    return true;
  }
  return message.role === "user" && message.content.trimStart().startsWith("Implementation-plan decision threads continued:");
}

function formatLineProtocolForTimeline(
  message: Conversation["messages"][number],
  kind: ConversationKind,
  content: string
): string | undefined {
  if (message.role !== "participant" || message.status === "error") {
    return undefined;
  }
  const items = parseLineProtocolItems(content);
  if (!items.length) {
    return undefined;
  }

  const labels = { claim: "Claim", evidence: "Evidence", action: "Action" };
  return items
    .map((item, index) =>
      [
        `### ${index + 1}. ${item.title || "Untitled item"}`,
        item.claim ? `**${labels.claim}:** ${item.claim}` : "",
        item.evidence ? `**${labels.evidence}:** ${item.evidence}` : "",
        item.action ? `**${labels.action}:** ${item.action}` : ""
      ]
        .filter(Boolean)
        .join("\n\n")
    )
    .join("\n\n");
}

function parseLineProtocolItems(content: string): LineProtocolItem[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const items: LineProtocolItem[] = [];
  let current: LineProtocolItem | undefined;
  let currentField: "claim" | "evidence" | "action" | undefined;

  const appendField = (field: "claim" | "evidence" | "action", value: string): void => {
    if (!current) {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    current[field] = current[field] ? `${current[field]}\n${trimmed}` : trimmed;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      currentField = undefined;
      continue;
    }

    const header = trimmed.match(/^[PK]\d+\|(.+)$/i);
    if (header) {
      current = parseLineProtocolHeader(header[1]);
      items.push(current);
      currentField = undefined;
      continue;
    }

    const field = trimmed.match(/^([CEA]):\s*(.*)$/i);
    if (field && current) {
      const key = field[1].toUpperCase();
      currentField = key === "C" ? "claim" : key === "E" ? "evidence" : "action";
      appendField(currentField, field[2]);
      continue;
    }

    if (current && currentField && !/^[A-Z][A-Z0-9_ -]{0,24}:/i.test(trimmed)) {
      appendField(currentField, trimmed);
    }
  }

  return items.filter((item) => item.title || item.claim || item.evidence || item.action);
}

function parseLineProtocolHeader(header: string): LineProtocolItem {
  const fields = header.split("|");
  const item: LineProtocolItem = { title: "" };
  for (const field of fields) {
    const match = field.match(/^([A-Z]+):\s*(.*)$/i);
    if (!match) {
      continue;
    }
    const key = match[1].toUpperCase();
    const value = match[2].trim();
    if (key === "T") {
      item.title = value;
    } else if (key === "S") {
      item.severity = value;
    }
  }
  return item;
}

function summarizeRawProviderJson(content: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const data = JSON.parse(trimmed) as {
      object?: string;
      status?: string;
      model?: string;
      incomplete_details?: { reason?: string };
      output?: unknown[];
    };
    if (data.object !== "response") {
      return undefined;
    }
    if (data.status === "incomplete") {
      const reason = data.incomplete_details?.reason ?? "unknown reason";
      const model = data.model ? ` from ${data.model}` : "";
      return `OpenAI returned an incomplete response${model}: ${reason}. No usable text was produced.`;
    }
    return `OpenAI returned a response object without usable text output${data.status ? ` (status: ${data.status})` : ""}.`;
  } catch {
    return undefined;
  }
}
