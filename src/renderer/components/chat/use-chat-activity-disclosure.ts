import { useCallback, useEffect, useMemo, useState } from "react";

export interface ChatActivityDisclosureState {
  expandedProcessingTranscriptMessageIds: ReadonlySet<string>;
  expandedActivityIds: ReadonlySet<string>;
  fullyExpandedDetailIds: ReadonlySet<string>;
  revealedDetailIds: ReadonlySet<string>;
  toggleProcessingTranscript: (messageId: string) => void;
  toggleActivity: (eventId: string) => void;
  toggleDetailLength: (eventId: string) => void;
  toggleDetailReveal: (eventId: string) => void;
}

interface StoredDisclosureState {
  conversationId: string;
  expandedProcessingTranscriptMessageIds: ReadonlySet<string>;
  expandedActivityIds: ReadonlySet<string>;
  fullyExpandedDetailIds: ReadonlySet<string>;
  revealedDetailIds: ReadonlySet<string>;
}

export function useChatActivityDisclosure(conversationId: string): ChatActivityDisclosureState {
  const [stored, setStored] = useState<StoredDisclosureState>(() => emptyDisclosureState(conversationId));
  const active = stored.conversationId === conversationId
    ? stored
    : emptyDisclosureState(conversationId);

  useEffect(() => {
    setStored((current) => current.conversationId === conversationId
      ? current
      : emptyDisclosureState(conversationId));
  }, [conversationId]);

  const toggleProcessingTranscript = useCallback((messageId: string) => {
    setStored((current) => toggleDisclosureSet(
      current,
      conversationId,
      "expandedProcessingTranscriptMessageIds",
      messageId
    ));
  }, [conversationId]);
  const toggleActivity = useCallback((eventId: string) => {
    setStored((current) => toggleDisclosureSet(current, conversationId, "expandedActivityIds", eventId));
  }, [conversationId]);
  const toggleDetailLength = useCallback((eventId: string) => {
    setStored((current) => toggleDisclosureSet(current, conversationId, "fullyExpandedDetailIds", eventId));
  }, [conversationId]);
  const toggleDetailReveal = useCallback((eventId: string) => {
    setStored((current) => toggleDisclosureSet(current, conversationId, "revealedDetailIds", eventId));
  }, [conversationId]);

  return useMemo(() => ({
    expandedProcessingTranscriptMessageIds: active.expandedProcessingTranscriptMessageIds,
    expandedActivityIds: active.expandedActivityIds,
    fullyExpandedDetailIds: active.fullyExpandedDetailIds,
    revealedDetailIds: active.revealedDetailIds,
    toggleProcessingTranscript,
    toggleActivity,
    toggleDetailLength,
    toggleDetailReveal
  }), [active, toggleActivity, toggleDetailLength, toggleDetailReveal, toggleProcessingTranscript]);
}

function emptyDisclosureState(conversationId: string): StoredDisclosureState {
  return {
    conversationId,
    expandedProcessingTranscriptMessageIds: new Set<string>(),
    expandedActivityIds: new Set<string>(),
    fullyExpandedDetailIds: new Set<string>(),
    revealedDetailIds: new Set<string>()
  };
}

function toggleDisclosureSet(
  stored: StoredDisclosureState,
  conversationId: string,
  key:
    | "expandedProcessingTranscriptMessageIds"
    | "expandedActivityIds"
    | "fullyExpandedDetailIds"
    | "revealedDetailIds",
  eventId: string
): StoredDisclosureState {
  const current = stored.conversationId === conversationId
    ? stored
    : emptyDisclosureState(conversationId);
  const nextSet = new Set(current[key]);
  if (nextSet.has(eventId)) {
    nextSet.delete(eventId);
  } else {
    nextSet.add(eventId);
  }
  return { ...current, [key]: nextSet };
}
