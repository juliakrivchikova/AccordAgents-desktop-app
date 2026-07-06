export interface AccordLauncherPreferences {
  lastFacilitatorParticipantId?: string;
  lastFacilitatorHandle?: string;
  subjects: string[];
}

export interface AccordFacilitatorCandidate {
  id: string;
  handle: string;
}

export interface AccordTargetCandidate {
  id: string;
}

export const ACCORD_SUBJECT_HISTORY_LIMIT = 5;

export function parseAccordLauncherPreferencesJson(raw: string | null | undefined): AccordLauncherPreferences {
  if (!raw) {
    return { subjects: [] };
  }
  try {
    return normalizeAccordLauncherPreferences(JSON.parse(raw) as unknown);
  } catch {
    return { subjects: [] };
  }
}

export function normalizeAccordLauncherPreferences(raw: unknown): AccordLauncherPreferences {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { subjects: [] };
  }
  const record = raw as Record<string, unknown>;
  const lastFacilitatorParticipantId = typeof record.lastFacilitatorParticipantId === "string" && record.lastFacilitatorParticipantId.trim()
    ? record.lastFacilitatorParticipantId.trim()
    : undefined;
  const lastFacilitatorHandle = typeof record.lastFacilitatorHandle === "string" && record.lastFacilitatorHandle.trim()
    ? normalizeAccordFacilitatorHandle(record.lastFacilitatorHandle)
    : undefined;
  const subjects = Array.isArray(record.subjects)
    ? normalizeAccordSubjectHistory(record.subjects)
    : [];
  return {
    ...(lastFacilitatorParticipantId ? { lastFacilitatorParticipantId } : {}),
    ...(lastFacilitatorHandle ? { lastFacilitatorHandle } : {}),
    subjects
  };
}

export function nextAccordSubjectHistory(subjects: readonly string[], subject: string): string[] {
  const trimmed = subject.trim();
  if (!trimmed) {
    return normalizeAccordSubjectHistory([...subjects]);
  }
  return normalizeAccordSubjectHistory([trimmed, ...subjects]);
}

export function normalizeAccordSubjectHistory(rawSubjects: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const subjects: string[] = [];
  for (const raw of rawSubjects) {
    if (typeof raw !== "string") {
      continue;
    }
    const subject = raw.trim();
    const key = accordSubjectKey(subject);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    subjects.push(subject);
    if (subjects.length >= ACCORD_SUBJECT_HISTORY_LIMIT) {
      break;
    }
  }
  return subjects;
}

export function preferredAccordFacilitator<T extends AccordFacilitatorCandidate>(
  participants: readonly T[],
  preferences: AccordLauncherPreferences
): T | undefined {
  const preferredId = preferences.lastFacilitatorParticipantId;
  const preferredHandle = normalizeAccordFacilitatorHandle(preferences.lastFacilitatorHandle);
  return participants.find((participant) => participant.id === preferredId)
    ?? participants.find((participant) => normalizeAccordFacilitatorHandle(participant.handle) === preferredHandle)
    ?? participants[0];
}

export function reconcileAccordTargetIds<T extends AccordTargetCandidate>(
  currentTargetIds: readonly string[],
  newFacilitatorParticipantId: string,
  participants: readonly T[]
): string[] {
  const hadFacilitatorAsTarget = currentTargetIds.includes(newFacilitatorParticipantId);
  const nextTargetIds = currentTargetIds.filter((id) => id !== newFacilitatorParticipantId);
  return nextTargetIds.length === 0 && hadFacilitatorAsTarget
    ? participants.filter((participant) => participant.id !== newFacilitatorParticipantId).map((participant) => participant.id)
    : nextTargetIds;
}

export function normalizeAccordFacilitatorHandle(handle: string | undefined): string {
  return handle?.trim().replace(/^@+/, "").toLowerCase() ?? "";
}

function accordSubjectKey(subject: string): string {
  return subject.trim().replace(/\s+/g, " ").toLowerCase();
}
