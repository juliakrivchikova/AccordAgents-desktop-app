export function clearChatRunMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...metadata, running: false };
  delete next.runId;
  delete next.activeRunIds;
  return next;
}

export function readActiveRunIds(metadata: Record<string, unknown>): string[] {
  const raw = metadata.activeRunIds;
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim() && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

export function withActiveRunIdAdded(metadata: Record<string, unknown>, runId: string): Record<string, unknown> {
  const list = readActiveRunIds(metadata);
  if (list.includes(runId)) {
    return { ...metadata, activeRunIds: list, running: true };
  }
  return { ...metadata, activeRunIds: [...list, runId], running: true };
}

export function withActiveRunIdRemoved(metadata: Record<string, unknown>, runId: string): Record<string, unknown> {
  const list = readActiveRunIds(metadata).filter((id) => id !== runId);
  const next: Record<string, unknown> = { ...metadata, activeRunIds: list };
  next.running = list.length > 0;
  if (list.length === 0) {
    delete next.activeRunIds;
  }
  return next;
}

export function conversationIsRunning(metadata: Record<string, unknown>): boolean {
  if (readActiveRunIds(metadata).length > 0) {
    return true;
  }
  return metadata.running === true;
}
