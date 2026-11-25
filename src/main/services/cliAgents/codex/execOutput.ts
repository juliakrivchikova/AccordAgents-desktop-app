import type { AgentContextUsage, ParticipantConfig } from "../../../../shared/types";
import { buildAgentContextUsage, contextWindowForModel } from "../../../../shared/agentContext";
import type { CliContextReading } from "../../cliContextUsage";
import { asRecord, findSessionId, stringField } from "../runs/records";

/** The member's context from one Codex reading, against the window
 *  Codex reported (its model's entry in the map when it did not). */
export function codexContextUsage(reading: CliContextReading | undefined, participant: ParticipantConfig): AgentContextUsage | undefined {
  if (!reading) {
    return undefined;
  }
  return buildAgentContextUsage({
    usedTokens: reading.usedTokens,
    contextWindowTokens: reading.contextWindowTokens ?? contextWindowForModel(participant.kind, participant.model),
    source: "codex-cli",
    model: participant.model,
    windowFromCli: reading.contextWindowTokens !== undefined
  });
}

function extractCodexText(stdout: string): string {
  const messages: string[] = [];
  const deltas: string[] = [];
  const plainLines: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as unknown;
      const message = extractCodexAssistantMessage(event);
      if (message) {
        messages.push(message);
      }
      const delta = extractCodexAssistantDelta(event);
      if (delta) {
        deltas.push(delta);
      }
    } catch {
      plainLines.push(line.trim());
    }
  }
  return messages.at(-1) ?? (deltas.join("").trim() || plainLines.join("\n").trim() || stdout.trim());
}

function extractCodexSessionId(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as unknown;
      const sessionId = findSessionId(event);
      if (sessionId) {
        return sessionId;
      }
    } catch {
      // Ignore non-JSON status lines from the CLI.
    }
  }
  return undefined;
}

function extractCodexAssistantMessage(event: unknown): string | undefined {
  const record = asRecord(event);
  if (!record) {
    return undefined;
  }

  const type = stringField(record, "type");
  if (type === "agent_message") {
    return stringField(record, "message")?.trim();
  }

  const item = asRecord(record.item);
  if (item) {
    return textFromAssistantMessageItem(item);
  }

  return textFromAssistantMessageItem(record);
}

function extractCodexAssistantDelta(event: unknown): string | undefined {
  const record = asRecord(event);
  if (!record) {
    return undefined;
  }
  const type = stringField(record, "type") ?? "";
  if (!type.includes("output_text") && type !== "agent_message_delta") {
    return undefined;
  }
  return stringField(record, "delta") ?? stringField(record, "text") ?? stringField(record, "message");
}

function extractCodexAssistantStreamingDelta(event: unknown): string | undefined {
  const record = asRecord(event);
  if (!record) {
    return undefined;
  }
  const type = stringField(record, "type");
  if (type !== "agent_message_delta" && type !== "response.output_text.delta") {
    return undefined;
  }
  return stringField(record, "delta");
}

export function textFromAssistantMessageItem(item: Record<string, unknown>): string | undefined {
  const itemType = stringField(item, "type");
  const role = stringField(item, "role");
  if (itemType !== "message" && itemType !== "assistant_message" && itemType !== "agent_message" && role !== "assistant") {
    return undefined;
  }
  if (role && role !== "assistant") {
    return undefined;
  }

  const directText = stringField(item, "message") ?? stringField(item, "text") ?? stringField(item, "output_text");
  if (directText?.trim()) {
    return directText.trim();
  }

  const content = item.content;
  if (typeof content === "string") {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const texts = content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      const blockRecord = asRecord(block);
      if (!blockRecord) {
        return "";
      }
      return stringField(blockRecord, "text") ?? stringField(blockRecord, "output_text") ?? "";
    })
    .filter((text) => text.trim());

  return texts.length ? texts.join("\n").trim() : undefined;
}
