// How a new chat starts (Settings → General → New chats; the User,
// 2026-11-22: "для нового режима — это просто должна быть секция в settings
// с дефолтными значениями провайдера, модели и вещей типа этой"). The
// provider is `AppSettings.assistantProviderKind`; the rest is here. The
// same values start a chat made on the computer and one made from the phone
// (the computer's New chat offer carries them in its main session), and the
// New chat screen's controls start from them; a choice there is that chat's
// only. Fork to new chat does not use them: the fork keeps the member's own.
// Existing chats keep their own settings.

import { chatAccessModeSet, currentChatAccessId } from "./chatAccessModes";
import { isChatProviderKind } from "./chatProviders";
import { normalizeChatReasoningEffort } from "./reasoningEffort";
import type { ChatParticipantRequestPermission, ChatProviderKind, ChatReasoningEffort, NewChatDefaults, NewChatDefaultsUpdate } from "./types";

export type { NewChatDefaults, NewChatDefaultsUpdate };

const VALUE_MAX_LENGTH = 256;

function shortText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= VALUE_MAX_LENGTH ? text : undefined;
}

/** A mode id the CLI has (its current name for one renamed since). */
function accessFor(kind: ChatProviderKind | undefined, value: unknown): string | undefined {
  if (!kind) return undefined;
  const id = currentChatAccessId(kind, shortText(value));
  return id && chatAccessModeSet(kind).options.some((option) => option.id === id) ? id : undefined;
}

/** What is stored, as Settings reads it: anything missing or invalid is the
 *  CLI's own; compaction without asking unless turned off. */
export function normalizeNewChatDefaults(value: unknown): NewChatDefaults {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const kind = isChatProviderKind(record.kind) ? record.kind : undefined;
  const model = kind ? shortText(record.model) : undefined;
  const reasoningEffort = kind ? normalizeChatReasoningEffort(record.reasoningEffort, kind) : undefined;
  const access = accessFor(kind, record.access);
  const homeMachineId = shortText(record.homeMachineId);
  return {
    ...(kind && (model || reasoningEffort || access) ? { kind } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(access ? { access } : {}),
    ...(homeMachineId ? { homeMachineId } : {}),
    compactWithoutAsking: record.compactWithoutAsking !== false
  };
}

/** The defaults with a change from Settings applied. Model, effort and mode
 *  for another CLI than the stored ones start from that CLI's own. */
export function applyNewChatDefaultsUpdate(current: unknown, update: NewChatDefaultsUpdate): NewChatDefaults {
  const base = normalizeNewChatDefaults(current);
  const touchesCli = update.model !== undefined || update.reasoningEffort !== undefined || update.access !== undefined;
  const kind = touchesCli ? update.kind ?? base.kind : base.kind;
  const sameCli = !touchesCli || (kind !== undefined && kind === base.kind);
  const next: Record<string, unknown> = {
    kind,
    model: sameCli ? base.model : undefined,
    reasoningEffort: sameCli ? base.reasoningEffort : undefined,
    access: sameCli ? base.access : undefined,
    homeMachineId: base.homeMachineId,
    compactWithoutAsking: base.compactWithoutAsking
  };
  for (const key of ["model", "reasoningEffort", "access", "homeMachineId"] as const) {
    const value = update[key];
    if (value !== undefined) next[key] = value ?? undefined;
  }
  if (typeof update.compactWithoutAsking === "boolean") next.compactWithoutAsking = update.compactWithoutAsking;
  return normalizeNewChatDefaults(next);
}

/** The defaults with the CLI's model, effort and mode dropped: the provider
 *  changed, so they go back to that CLI's own (where it runs and compaction
 *  stay). */
export function newChatDefaultsForProvider(current: unknown): NewChatDefaults {
  const { homeMachineId, compactWithoutAsking } = normalizeNewChatDefaults(current);
  return { ...(homeMachineId ? { homeMachineId } : {}), compactWithoutAsking };
}

/** The main session's right to compact its context without a card. */
export function newChatCompactionPermission(defaults: Pick<NewChatDefaults, "compactWithoutAsking"> | undefined): ChatParticipantRequestPermission {
  return defaults?.compactWithoutAsking === false ? "ask" : "allow";
}

/** What a new chat's main session starts with on this provider: the model,
 *  effort and mode chosen for its CLI (never for an added provider, nor for
 *  another CLI: those start from their own), where it runs (a machine that
 *  is still set up; none: this computer; an added provider always here: its
 *  key is this computer's, members on one run on this computer only) and its
 *  compaction right. */
export interface NewChatMainSessionStart {
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  access?: string;
  homeMachineId?: string;
  requestCompaction: ChatParticipantRequestPermission;
}

export function newChatMainSessionStart(
  defaults: unknown,
  provider: { kind: ChatProviderKind; hostId?: string },
  /** The machines set up now; a default machine no longer among them is
   *  this computer. Unknown (undefined): kept as stored. */
  machineIds?: ReadonlyArray<string>
): NewChatMainSessionStart {
  const normalized = normalizeNewChatDefaults(defaults);
  const ownCli = !provider.hostId && normalized.kind === provider.kind;
  const homeMachineId = !provider.hostId && normalized.homeMachineId && (!machineIds || machineIds.includes(normalized.homeMachineId))
    ? normalized.homeMachineId
    : undefined;
  return {
    ...(ownCli && normalized.model ? { model: normalized.model } : {}),
    ...(ownCli && normalized.reasoningEffort ? { reasoningEffort: normalized.reasoningEffort } : {}),
    ...(ownCli && normalized.access ? { access: normalized.access } : {}),
    ...(homeMachineId ? { homeMachineId } : {}),
    requestCompaction: newChatCompactionPermission(normalized)
  };
}
