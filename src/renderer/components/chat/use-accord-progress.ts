import { useMemo } from "react";
import { dockedAccordOfMessages, type DockedAccord } from "../../../shared/accordProgress";
import type { ChatMessage } from "../../../shared/types";

export type { DockedAccord };

/** The chat's newest Accord with a document, for the card pinned above the
 *  composer (accordProgress.ts); also when its launch is not loaded. */
export function useDockedAccord(messages: ChatMessage[], artifactNotesKey: string): DockedAccord | undefined {
  return useMemo(() => dockedAccordOfMessages(messages), [artifactNotesKey, messages]);
}
