/** Codex refusing `turn/start`'s collaboration mode (a Codex from before it,
 *  or one that does not know the field). */
export function isCodexCollaborationModeRefusal(text: string): boolean {
  return /collaboration[_ ]?mode/i.test(text) && /unknown|invalid|unsupported|not supported|experimental|unexpected/i.test(text);
}

export function codexAppServerMessageKind(
  record: Record<string, unknown>
): "server-request" | "response" | "notification" {
  const hasId = typeof record.id === "string" || typeof record.id === "number";
  if (hasId && typeof record.method === "string") {
    return "server-request";
  }
  return hasId ? "response" : "notification";
}

export class CodexAppServerRunError extends Error {
  readonly turnAccepted: boolean;

  constructor(cause: Error, turnAccepted: boolean) {
    super(cause.message, { cause });
    this.name = "CodexAppServerRunError";
    this.turnAccepted = turnAccepted;
  }
}
