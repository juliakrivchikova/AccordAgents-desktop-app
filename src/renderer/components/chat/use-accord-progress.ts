import { useEffect, useMemo, useRef } from "react";
import { accordClosedLines, accordInputsOfMessages, accordOfLaunch, dockedAccordOfMessages, type DockedAccord } from "../../../shared/accordProgress";
import type { ChatMessage, ChatParticipant } from "../../../shared/types";
import { setAccordDockClosing } from "./accord-dock-store";
import type { AccordLinesValue } from "./chat-accord-closed-line";

export type { DockedAccord };

/** The chat's newest Accord with a document, for the card pinned above the
 *  composer (accordProgress.ts), also when its launch is not loaded; none
 *  once it was closed into the chat, on any device (the User, 2026-11-16).
 *  With it, what the lines closed Accords left in the chat open. */
export function useDockedAccord(
  messages: ChatMessage[],
  artifactNotesKey: string,
  participants: ChatParticipant[],
  closedLaunchIds: readonly string[] = []
): { docked: DockedAccord | undefined; latest: DockedAccord | undefined; accordLines: AccordLinesValue } {
  const newest = useMemo(() => dockedAccordOfMessages(messages), [artifactNotesKey, messages]);
  // Folded into the chat: the chat's record of the lines her server took,
  // over the whole chat, and the lines among the loaded messages.
  const lines = accordClosedLines(messages);
  const linesKey = [...lines.values()].join("\n");
  const closedKey = closedLaunchIds.join("\n");
  useEffect(() => {
    // Her cross was pressed here: the chat's record has it now.
    for (const launchId of closedLaunchIds) setAccordDockClosing(launchId, false);
  }, [closedKey]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const participantsRef = useRef(participants);
  participantsRef.current = participants;
  // Every update brings a new member list: keyed by what the card shows of it.
  // The sessions view names a member by its model and effort and where it
  // runs (useMemberModelSummary), so those count too.
  const participantsKey = participants.map((member) => [
    member.id, member.handle, member.kind, member.avatarId ?? "", member.model ?? "", member.reasoningEffort ?? "",
    member.hostId ?? "", member.hostVendor ?? "", member.homeMachineId ?? "", member.cloudRun ? "cloud" : ""
  ].join(":")).join("\n");
  // Worked out again only when the notes, the lines or the members change,
  // not on every update of a running turn; the chat's Accords are read once
  // for all its lines.
  const accordLines = useMemo<AccordLinesValue>(() => {
    let inputs: ReturnType<typeof accordInputsOfMessages> | undefined;
    const known = new Map<string, DockedAccord | undefined>();
    return {
      participants: participantsRef.current,
      accordOf: (launchId) => {
        if (!known.has(launchId)) {
          inputs ??= accordInputsOfMessages(messagesRef.current);
          known.set(launchId, accordOfLaunch(inputs.launches, inputs.notes, launchId));
        }
        return known.get(launchId);
      }
    };
  }, [artifactNotesKey, linesKey, participantsKey]);
  const closed = newest ? lines.has(newest.launchId) || closedLaunchIds.includes(newest.launchId) : false;
  // The latest, also once closed: the sessions view lists it with the members.
  return { docked: newest && !closed ? newest : undefined, latest: newest, accordLines };
}
