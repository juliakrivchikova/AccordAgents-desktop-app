export function clearChatRunMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...metadata, running: false };
  delete next.runId;
  return next;
}
