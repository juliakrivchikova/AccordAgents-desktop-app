import { asRecord, stringField } from "../runs/records";
import { textFromAssistantMessageItem } from "../codex/execOutput";


export function extractClaudeStreamEventTextDelta(event: unknown): string | undefined {
  const record = asRecord(event);
  if (!record) {
    return undefined;
  }
  if (stringField(record, "type") !== "stream_event") {
    return undefined;
  }
  const inner = asRecord(record.event);
  if (!inner) {
    return undefined;
  }
  if (stringField(inner, "type") !== "content_block_delta") {
    return undefined;
  }
  const delta = asRecord(inner.delta);
  if (!delta) {
    return undefined;
  }
  if (stringField(delta, "type") !== "text_delta") {
    return undefined;
  }
  return stringField(delta, "text");
}

export function extractClaudeWarmAssistantText(event: unknown): string | undefined {
  const record = asRecord(event);
  if (!record) {
    return undefined;
  }
  const type = stringField(record, "type");
  if (type !== "assistant") {
    return undefined;
  }
  const message = asRecord(record.message);
  if (message) {
    return textFromAssistantMessageItem(message);
  }
  return textFromAssistantMessageItem(record);
}

export function extractClaudeWarmResultText(event: unknown): string | undefined {
  const record = asRecord(event);
  if (!record) {
    return undefined;
  }
  return stringField(record, "result") ?? stringField(record, "content") ?? stringField(record, "message");
}
