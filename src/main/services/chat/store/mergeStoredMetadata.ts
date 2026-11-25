import { CHAT_LIST_ORDER_METADATA_KEYS } from "../../chatChanges";
import type { ChatParticipantWatcherState, ChatParticipantCompactionState } from "../../../../shared/types";
import { normalizeChatAgentPermissions } from "../../../../shared/agentPermissions";
import { PARTICIPANT_COMPACTIONS_KEY, readActiveRunIds, readParticipantCompactions } from "../../../../shared/chatRunState";
import { sanitizeWarningList } from "../../../../shared/warnings";
import { isTerminalAppToolApprovalStatus } from "../approvals/approvalRecords";
import { mergeAgentContextUsageRecords } from "../compaction/contextUsage";
import { mergeRemovedChatMessageIds } from "./mergeStoredChat";
import { mergePromptContextPointers } from "../turns/promptContextRecords";

export function mergeStoredChatMetadata(
  storedMetadata: Record<string, unknown>,
  currentMetadata: Record<string, unknown>,
  requestPermissionGrants?: ReadonlySet<string>,
  liveRunIdsHere?: ReadonlySet<string>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...storedMetadata,
    ...currentMetadata
  };
  // Reactions held for messages not here yet are only ever changed by
  // applying a chat change, which saves them; a copy held in memory by a
  // long-running flow is older.
  if (storedMetadata.pendingChatReactions !== undefined) merged.pendingChatReactions = storedMetadata.pendingChatReactions;
  else delete merged.pendingChatReactions;
  // So is the pin (setPinned, or a pin from another device applied here),
  // which may change while a member runs: a turn's older copy must not
  // pin again what she unpinned.
  for (const key of CHAT_LIST_ORDER_METADATA_KEYS) {
    if (storedMetadata[key] !== undefined) merged[key] = storedMetadata[key];
    else delete merged[key];
  }
  if (merged.autoTitle) {
    delete merged.autoTitleEligibility;
  }
  const participants = mergeMetadataItemsByKey(
    storedMetadata.participants,
    currentMetadata.participants,
    "id",
    (stored, current) => mergeStoredChatParticipantMetadata(stored, current, requestPermissionGrants),
    { appendCurrentMissing: false }
  );
  if (participants) {
    merged.participants = participants;
  }
  const promptContextPointers = mergePromptContextPointers(storedMetadata.promptContextPointers, currentMetadata.promptContextPointers);
  if (promptContextPointers) {
    merged.promptContextPointers = promptContextPointers;
  }
  const compactions = mergeParticipantCompactions(storedMetadata, currentMetadata, liveRunIdsHere);
  if (compactions) {
    merged[PARTICIPANT_COMPACTIONS_KEY] = compactions;
  } else {
    delete merged[PARTICIPANT_COMPACTIONS_KEY];
  }
  const watchers = mergeParticipantWatchers(storedMetadata.participantWatchers, currentMetadata.participantWatchers, participants);
  if (watchers) {
    merged.participantWatchers = watchers;
  } else {
    delete merged.participantWatchers;
  }
  const storedParticipantIds = new Set(participants?.map((participant) => metadataStringKey(participant, "id")).filter(Boolean));
  const sessions = mergeMetadataItemsByKey(
    storedMetadata.participantSessions,
    currentMetadata.participantSessions,
    "participantId",
    (stored, current) => mergeStoredParticipantSessionMetadata(stored, current),
    {
      shouldAppendCurrentMissing: (current) => {
        const participantId = metadataStringKey(current, "participantId");
        return !participantId || storedParticipantIds.size === 0 || storedParticipantIds.has(participantId);
      }
    }
  );
  if (sessions) {
    merged.participantSessions = sessions;
  }
  const contextUsage = mergeAgentContextUsageRecords(
    storedMetadata.agentContextUsageByParticipant,
    currentMetadata.agentContextUsageByParticipant
  );
  if (contextUsage) {
    merged.agentContextUsageByParticipant = contextUsage;
  }
  const warnings = sanitizeWarningList([
    ...sanitizeWarningList(storedMetadata.warnings),
    ...sanitizeWarningList(currentMetadata.warnings)
  ]);
  if (warnings.length > 0) {
    merged.warnings = warnings;
  } else {
    delete merged.warnings;
  }
  const removedMessageIds = mergeRemovedChatMessageIds(
    storedMetadata.removedChatMessageIds,
    currentMetadata.removedChatMessageIds
  );
  if (removedMessageIds.length > 0) {
    merged.removedChatMessageIds = removedMessageIds;
  } else {
    delete merged.removedChatMessageIds;
  }
  const approvals = mergeMetadataItemsByKey(
    storedMetadata.pendingAppToolApprovals,
    currentMetadata.pendingAppToolApprovals,
    "id",
    (stored, current) => newerAppToolApprovalMetadataItem(stored, current)
  );
  if (approvals) {
    merged.pendingAppToolApprovals = approvals;
  }
  const policies = mergeMetadataItemsByKey(
    storedMetadata.appToolApprovalPolicies,
    currentMetadata.appToolApprovalPolicies,
    "id",
    (stored, current) => newerMetadataItem(stored, current),
    { appendCurrentMissing: false }
  );
  if (policies) {
    merged.appToolApprovalPolicies = policies;
  }
  // `remoteRunHandles` and `remoteRunReplay` record runs made through the
  // transport that no longer exists. Nothing writes them now, so the spread
  // above carries what is stored through untouched: old runs stay readable
  // and keep showing what they showed.
  return merged;
}

/** Each member's compaction, from either copy: one flow's copy does not
 *  erase another member's compaction it never saw. A compaction is kept
 *  while its run is live here, or while the saved chat still has it among
 *  its active runs (another app instance's); one only an older copy still
 *  holds has ended. */
export function mergeParticipantCompactions(
  storedMetadata: Record<string, unknown>,
  currentMetadata: Record<string, unknown>,
  liveRunIdsHere?: ReadonlySet<string>
): Record<string, ChatParticipantCompactionState> | undefined {
  const stored = readParticipantCompactions(storedMetadata);
  const current = readParticipantCompactions(currentMetadata);
  const storedActive = new Set(readActiveRunIds(storedMetadata));
  const merged: Record<string, ChatParticipantCompactionState> = {};
  for (const participantId of new Set([...Object.keys(stored), ...Object.keys(current)])) {
    // The copy's entry first, then the saved one: an older copy can still
    // hold a finished compaction of a member that is compacting again.
    const live = [current[participantId], stored[participantId]].find((state) =>
      state !== undefined && (
        liveRunIdsHere?.has(state.runId) === true ||
        (stored[participantId]?.runId === state.runId && storedActive.has(state.runId))
      )
    );
    if (live) {
      merged[participantId] = live;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Each watcher's newest state wins (every write stamps `updatedAt`), and
 *  only members that still watch keep one: a flow's older copy neither
 *  undoes the User turning a watcher off or on, nor brings back a removed
 *  member's. */
function mergeParticipantWatchers(
  storedValue: unknown,
  currentValue: unknown,
  mergedParticipants: Record<string, unknown>[] | undefined
): Record<string, ChatParticipantWatcherState> | undefined {
  const stored = isMetadataRecord(storedValue) ? storedValue : {};
  const current = isMetadataRecord(currentValue) ? currentValue : {};
  const watching = new Set((mergedParticipants ?? [])
    .filter((participant) => participant.autoWatch === true)
    .map((participant) => metadataStringKey(participant, "id"))
    .filter(Boolean));
  const merged: Record<string, ChatParticipantWatcherState> = {};
  for (const participantId of new Set([...Object.keys(stored), ...Object.keys(current)])) {
    if (!watching.has(participantId)) {
      continue;
    }
    const storedState = isMetadataRecord(stored[participantId]) ? stored[participantId] as unknown as ChatParticipantWatcherState : undefined;
    const currentState = isMetadataRecord(current[participantId]) ? current[participantId] as unknown as ChatParticipantWatcherState : undefined;
    const newer = !storedState
      ? currentState
      : !currentState
        ? storedState
        : String(currentState.updatedAt ?? "") >= String(storedState.updatedAt ?? "") ? currentState : storedState;
    if (newer) {
      merged[participantId] = newer;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeStoredChatParticipantMetadata(
  stored: Record<string, unknown>,
  current: Record<string, unknown>,
  requestPermissionGrants?: ReadonlySet<string>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...stored,
    ...(typeof current.roleConfigVersion === "number" ? { roleConfigVersion: current.roleConfigVersion } : {})
  };
  const storedPermissions = normalizeChatAgentPermissions(
    isMetadataRecord(stored.permissions) ? stored.permissions : undefined
  );
  const currentPermissions = normalizeChatAgentPermissions(
    isMetadataRecord(current.permissions) ? current.permissions : undefined
  );
  if (
    currentPermissions.requestParticipants === "allow" &&
    storedPermissions.requestParticipants !== currentPermissions.requestParticipants &&
    requestPermissionGrants?.has(metadataStringKey(current, "id") ?? "") === true
  ) {
    merged.permissions = {
      ...storedPermissions,
      requestParticipants: currentPermissions.requestParticipants
    };
  }
  return merged;
}

function mergeStoredParticipantSessionMetadata(
  stored: Record<string, unknown>,
  current: Record<string, unknown>
): Record<string, unknown> {
  const storedUpdatedAt = typeof stored.updatedAt === "string" ? stored.updatedAt : "";
  const currentUpdatedAt = typeof current.updatedAt === "string" ? current.updatedAt : "";
  if (storedUpdatedAt !== currentUpdatedAt) {
    return currentUpdatedAt > storedUpdatedAt ? current : stored;
  }
  const merged = { ...stored, ...current };
  for (const key of [
    "sessionId",
    "executionSessionId",
    "remoteSession",
    "invalidatedRemoteSessionId",
    "invalidatedRemoteSessionAt"
  ]) {
    if (!Object.prototype.hasOwnProperty.call(current, key) && Object.prototype.hasOwnProperty.call(stored, key)) {
      merged[key] = stored[key];
    }
  }
  return merged;
}

function mergeMetadataItemsByKey(
  storedValue: unknown,
  currentValue: unknown,
  key: string,
  mergeItem: (stored: Record<string, unknown>, current: Record<string, unknown>) => Record<string, unknown>,
  options: {
    appendCurrentMissing?: boolean;
    shouldAppendCurrentMissing?: (current: Record<string, unknown>) => boolean;
  } = {}
): Record<string, unknown>[] | undefined {
  const storedItems = Array.isArray(storedValue) ? storedValue.filter(isMetadataRecord) : [];
  const currentItems = Array.isArray(currentValue) ? currentValue.filter(isMetadataRecord) : [];
  if (storedItems.length === 0 && currentItems.length === 0) {
    return undefined;
  }
  const currentByKey = new Map(
    currentItems
      .map((item) => [metadataStringKey(item, key), item] as const)
      .filter(([itemKey]) => Boolean(itemKey))
  );
  const merged = storedItems.map((storedItem) => {
    const itemKey = metadataStringKey(storedItem, key);
    const currentItem = itemKey ? currentByKey.get(itemKey) : undefined;
    return currentItem ? mergeItem(storedItem, currentItem) : storedItem;
  });
  if (options.appendCurrentMissing !== false) {
    const storedKeys = new Set(storedItems.map((item) => metadataStringKey(item, key)).filter(Boolean));
    for (const currentItem of currentItems) {
      const itemKey = metadataStringKey(currentItem, key);
      if ((!itemKey || !storedKeys.has(itemKey)) && (options.shouldAppendCurrentMissing?.(currentItem) ?? true)) {
        merged.push(currentItem);
      }
    }
  }
  return merged;
}

function mergeMetadataRecords(storedValue: unknown, currentValue: unknown): Record<string, unknown> | undefined {
  const stored = isMetadataRecord(storedValue) ? storedValue : undefined;
  const current = isMetadataRecord(currentValue) ? currentValue : undefined;
  if (!stored && !current) {
    return undefined;
  }
  return {
    ...(stored ?? {}),
    ...(current ?? {})
  };
}

function newerMetadataItem(
  stored: Record<string, unknown>,
  current: Record<string, unknown>
): Record<string, unknown> {
  const storedUpdatedAt = typeof stored.updatedAt === "string" ? stored.updatedAt : "";
  const currentUpdatedAt = typeof current.updatedAt === "string" ? current.updatedAt : "";
  return currentUpdatedAt >= storedUpdatedAt ? current : stored;
}

function newerAppToolApprovalMetadataItem(
  stored: Record<string, unknown>,
  current: Record<string, unknown>
): Record<string, unknown> {
  // Machine notifications and local queued/receipt feedback are applied by
  // this mutation queue. A turn's older copy must not undo those writes,
  // even when the native card's updatedAt did not change (a rejected answer).
  if (typeof stored.homeMachineId === "string" && stored.homeMachineId) return stored;
  const storedStatus = typeof stored.status === "string" ? stored.status : undefined;
  const currentStatus = typeof current.status === "string" ? current.status : undefined;
  const storedTerminal = storedStatus ? isTerminalAppToolApprovalStatus(storedStatus) : false;
  const currentTerminal = currentStatus ? isTerminalAppToolApprovalStatus(currentStatus) : false;
  if (storedTerminal !== currentTerminal) {
    return currentTerminal ? current : stored;
  }
  return newerMetadataItem(stored, current);
}

function metadataStringKey(item: Record<string, unknown>, key: string): string | undefined {
  const value = item[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function isMetadataRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
