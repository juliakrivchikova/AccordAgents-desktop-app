import { chatTextEndsAtSentenceOrParagraphBoundary } from "../../../../shared/processingTranscript";
import { APP_MCP_SERVER, appToolOutputKept, type CodexFileChange } from "../../cliToolActivity";
import type { CodexAppServerPendingTurn } from "./types";
import { emitLiveOutput } from "../runs/outputText";
import { asRecord, findStringField, stringField } from "../runs/records";

const CODEX_ACTIVITY_OUTPUT_MAX_LINES = 20;
const CODEX_ACTIVITY_OUTPUT_MAX_CHARS = 2_000;

export function codexAppServerFinalContent(turn: CodexAppServerPendingTurn): string {
  const completedMessages = completedAgentMessagesForFinal(turn.completedAgentMessages, turn.finalMessage);
  if (completedMessages.length > 0) {
    return finalTextFromMessageItems(completedMessages, { fencedBlockEndsBlock: true });
  }
  return trailingTextBlock(turn.streamedText || turn.messages.join(""));
}

function completedAgentMessagesForFinal(completedMessages: string[], finalMessage: string | undefined): string[] {
  const messages = completedMessages.filter((message) => message.trim());
  if (finalMessage?.trim() && messages.at(-1) !== finalMessage) {
    messages.push(finalMessage);
  }
  return messages;
}

export function finalTextFromMessageItems(
  messages: string[],
  options: { fencedBlockEndsBlock?: boolean } = {}
): string {
  let currentIndex = messages.length - 1;
  let finalText = messages[currentIndex] ?? "";
  while (currentIndex > 0) {
    const previous = messages[currentIndex - 1] ?? "";
    const separator = agentMessageBoundarySeparator(
      previous,
      messages[currentIndex] ?? finalText,
      options
    );
    if (separator === "\n\n") {
      break;
    }
    finalText = `${previous.trimEnd()}${separator}${separator ? finalText.trimStart() : finalText}`;
    currentIndex -= 1;
  }
  return finalText.trim();
}

export function trailingTextBlock(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trimEnd();
  const splitIndex = normalized.lastIndexOf("\n\n");
  if (splitIndex < 0) {
    return normalized.trim();
  }
  let start = splitIndex + 2;
  while (normalized[start] === "\n") {
    start += 1;
  }
  return normalized.slice(start).trim();
}

export function textWithAgentMessageBoundary(
  previous: string,
  next: string,
  options: { fencedBlockEndsBlock?: boolean } = {}
): string {
  const trimmedPrevious = previous.trimEnd();
  if (!trimmedPrevious) {
    return previous;
  }
  return `${trimmedPrevious}${agentMessageBoundarySeparator(trimmedPrevious, next, options)}`;
}

export function agentMessageBoundarySeparator(
  previous: string,
  next: string,
  options: { fencedBlockEndsBlock?: boolean } = {}
): string {
  if (!previous.trim() || !next) {
    return "";
  }
  if (
    chatTextEndsAtSentenceOrParagraphBoundary(previous) ||
    (
      options.fencedBlockEndsBlock === true &&
      /(?:^|\n)```[ \t]*$/.test(previous.trimEnd())
    )
  ) {
    return "\n\n";
  }
  if (/^\s|^[,.;:!?)]/.test(next)) {
    return "";
  }
  return " ";
}

export function appendCodexAppServerAgentText(
  pending: CodexAppServerPendingTurn,
  text: string,
  startsBlock: boolean
): void {
  if (!text) {
    return;
  }
  if (startsBlock && pending.visibleTranscript.trim()) {
    const trimmed = pending.visibleTranscript.trimEnd();
    pending.visibleTranscript = textWithAgentMessageBoundary(trimmed, text, {
      fencedBlockEndsBlock: true
    });
  }
  pending.visibleTranscript += text;
  emitLiveOutput(pending.onOutput, "text", text, pending.visibleTranscript);
}

export function appendCodexAppServerAgentTextDelta(
  pending: CodexAppServerPendingTurn,
  delta: string
): void {
  const normalized = normalizeCodexAppServerTextChunk(delta, pending.agentTextPendingCarriageReturn === true);
  pending.agentTextPendingCarriageReturn = normalized.pendingCarriageReturn;
  if (!normalized.text) {
    return;
  }
  pending.messages.push(normalized.text);
  if (pending.nextAgentMessageStartsBlock) {
    pending.streamedText = textWithAgentMessageBoundary(
      pending.streamedText,
      normalized.text,
      { fencedBlockEndsBlock: true }
    );
  }
  pending.streamedText += normalized.text;
  appendCodexAppServerAgentText(pending, normalized.text, pending.nextAgentMessageStartsBlock);
  pending.nextAgentMessageStartsBlock = false;
}

export function flushCodexAppServerAgentText(pending: CodexAppServerPendingTurn): void {
  if (!pending.agentTextPendingCarriageReturn) {
    return;
  }
  pending.agentTextPendingCarriageReturn = false;
  const text = "\r";
  pending.messages.push(text);
  if (pending.nextAgentMessageStartsBlock) {
    pending.streamedText = textWithAgentMessageBoundary(
      pending.streamedText,
      text,
      { fencedBlockEndsBlock: true }
    );
  }
  pending.streamedText += text;
  appendCodexAppServerAgentText(pending, text, pending.nextAgentMessageStartsBlock);
  pending.nextAgentMessageStartsBlock = false;
}

export function normalizeCodexAppServerCompleteText(text: string): string {
  return normalizeCodexAppServerTextChunk(text, false, { final: true }).text;
}

function normalizeCodexAppServerTextChunk(
  text: string,
  pendingCarriageReturn: boolean,
  options: { final?: boolean } = {}
): { text: string; pendingCarriageReturn: boolean } {
  let remaining = text;
  let normalized = "";
  if (pendingCarriageReturn) {
    if (remaining.startsWith("\n")) {
      normalized += "\n";
      remaining = remaining.slice(1);
    } else {
      normalized += "\r";
    }
  }
  let nextPendingCarriageReturn = false;
  if (!options.final && remaining.endsWith("\r")) {
    nextPendingCarriageReturn = true;
    remaining = remaining.slice(0, -1);
  }
  normalized += remaining.replace(/\r\n/g, "\n");
  return {
    text: normalized,
    pendingCarriageReturn: nextPendingCarriageReturn
  };
}

export function codexAppServerCompletedActivityOutput(item: Record<string, unknown> | undefined): string | undefined {
  if (!item) {
    return undefined;
  }
  const type = stringField(item, "type");
  if (type === "commandExecution") {
    return stringField(item, "aggregatedOutput");
  }
  if (type === "mcpToolCall") {
    const error = asRecord(item.error);
    if (error) {
      return stringField(error, "message");
    }
    const result = asRecord(item.result);
    const output = result ? codexAppServerOutputContent(result.content) : undefined;
    // The app's own tools answer with what the app keeps itself (messages,
    // requests, documents): the step keeps no copy of it, but a refusal
    // keeps its reason.
    if (output && stringField(item, "server") === APP_MCP_SERVER && !appToolOutputKept(output, result?.isError === true)) {
      return undefined;
    }
    return output;
  }
  return undefined;
}

export function codexAppServerCompletedActivityDetail(
  invocation: string | undefined,
  output: string | undefined
): string | undefined {
  const preview = codexAppServerBoundedOutputTail(output);
  return [
    invocation,
    preview ? `Output tail:\n${preview}` : undefined
  ].filter((part): part is string => Boolean(part)).join("\n\n") || undefined;
}

function codexAppServerBoundedOutputTail(output: string | undefined): string | undefined {
  if (!output) {
    return undefined;
  }
  const normalized = normalizeCodexAppServerCompleteText(output).trimEnd();
  if (!normalized) {
    return undefined;
  }
  const lines = normalized.split("\n");
  const omittedLines = Math.max(0, lines.length - CODEX_ACTIVITY_OUTPUT_MAX_LINES);
  let tail = lines.slice(-CODEX_ACTIVITY_OUTPUT_MAX_LINES).join("\n");
  let marker = "";
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const omittedChars = Math.max(0, normalized.length - tail.length);
    marker = omittedLines > 0 || omittedChars > 0
      ? `… [${[
          omittedLines > 0 ? `${omittedLines} earlier lines` : undefined,
          omittedChars > 0 ? `${omittedChars} chars omitted` : undefined
        ].filter(Boolean).join("; ")}]`
      : "";
    const availableTailChars = Math.max(
      0,
      CODEX_ACTIVITY_OUTPUT_MAX_CHARS - marker.length - (marker ? 1 : 0)
    );
    if (tail.length <= availableTailChars) {
      break;
    }
    tail = tail.slice(-availableTailChars);
  }
  return marker ? `${marker}\n${tail}` : tail;
}

function codexAppServerOutputContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return codexAppServerReadableJson(value);
  }
  const parts = value.flatMap((entry): string[] => {
    if (typeof entry === "string") {
      return [entry];
    }
    const record = asRecord(entry);
    if (!record) {
      return [];
    }
    const text = findStringField(record, ["text", "outputText", "output_text"]);
    if (text) {
      return [text];
    }
    const type = stringField(record, "type");
    if (type && /image|audio/i.test(type)) {
      return [`[${type} output]`];
    }
    return [codexAppServerReadableJson(record) ?? ""];
  }).filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** An edit's files as the row counts them: path, kind, diff. */
export function codexAppServerFileChanges(value: unknown): CodexFileChange[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    const record = asRecord(entry) ?? {};
    const kindRecord = asRecord(record.kind);
    const kind = stringField(record, "kind") ?? stringField(kindRecord ?? {}, "type");
    return { path: stringField(record, "path"), kind, diff: stringField(record, "diff") };
  });
}

export function codexAppServerFileChangesDetail(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const paths = value.map((entry) => {
    const record = asRecord(entry);
    const path = stringField(record ?? {}, "path");
    const kind = stringField(record ?? {}, "kind");
    return path ? `${kind ? `${kind}: ` : ""}${path}` : undefined;
  }).filter((entry): entry is string => Boolean(entry));
  return paths.length > 0 ? paths.join("\n") : undefined;
}

export function codexAppServerSubagentDetail(item: Record<string, unknown> | undefined): string | undefined {
  if (!item) {
    return undefined;
  }
  const kind = stringField(item, "kind");
  const agentPath = stringField(item, "agentPath");
  return [kind, agentPath].filter(Boolean).join(" · ") || undefined;
}

export function codexAppServerReadableJson(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
