import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatParticipant, Conversation } from "../../../../shared/types";
import { CHAT_PROMPT_SUGGESTION_LOCAL_SOURCE } from "../../chatPromptSuggestions";
import { agentContextUsageByParticipant } from "../compaction/contextUsage";
import { chatParticipants } from "../members/identity";
import { participantTurnMode } from "../members/roleRuntime";
import { turnSegmentKey } from "../requests/delegationGroups";
import { turnShown } from "../runs/runOwnerRecords";
import { chainParticipantTurn, offersPromptSuggestionAfter, waitForParticipantTurnReservation } from "./turnOrder";
import type { ClaudeWriteGate } from "./types";
import type { ChatPromptContextScope, ParticipantTurnReservation, ProgressCallback, ServerTurnOpen } from "../types";
import type { ChatModules } from "../modules";

/** The order of one member's turns, and where each runs. */
export class TurnQueue {
  private readonly participantTurnQueues = new Map<string, Promise<void>>();
  /** Exclusive same-participant operations only (see reserveParticipantTurn). */
  private readonly participantExclusiveTurnQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "delegation" | "host" | "participantBatch" | "participantTurn" | "promptSuggestions" | "remoteTurns"
      | "requesterResumes" | "serverLink" | "serverTurns"
    >
  ) {}

  async runParticipantTurnSerialized(
    conversation: Conversation,
    participant: ChatParticipant,
    triggerMessage: ChatMessage,
    runId: string,
    signal: AbortSignal | undefined,
    progress: ProgressCallback | undefined,
    options: {
      continuation?: boolean;
      warnings: string[];
      promptConversation?: Conversation;
      workspacePath?: string;
      promptContextScope?: ChatPromptContextScope;
      /** Messages outside the scope this turn reads too (preparePromptContextForRun). */
      extraPromptContextMessageIds?: readonly string[];
      participantRequestDepth?: number;
      participantRequestBatchId?: string;
      chainRootId?: string;
      queuedBehindHandle?: string;
      existingPendingMessage?: ChatMessage;
      turnReservation?: ParticipantTurnReservation;
      writeGate?: ClaudeWriteGate;
      /** A turn of its own on the server, named after this run, even when its
       *  trigger is a User's message to this member, whose own turn is over
       *  (a permission approval's resume). */
      ownServerTurn?: boolean;
    }
  ): Promise<ChatMessage[]> {
    const turnSegmentId = randomUUID();
    const liveTurnKey = turnSegmentKey(conversation.id, turnSegmentId);
    this.chat.delegation.liveTurnSegments.add(liveTurnKey);
    const reservation = options.turnReservation ?? this.reserveParticipantTurn(conversation.id, participant.id, participantTurnMode(participant, triggerMessage));
    let turnController: { signal: AbortSignal; cleanup: () => void } | undefined;
    // Whether the turn this run took on the server was ended there.
    let serverTurnEnded = false;
    try {
      turnController = this.chat.participantBatch.ensureChatTurnController(conversation, participant, runId, signal);
      await waitForParticipantTurnReservation(reservation, turnController.signal);
      if (turnController.signal.aborted) {
        throw new Error("Chat run cancelled.");
      }
      // The member's settings as they are when its turn starts, not when the
      // turn was asked for: a continuation waits for other members' turns,
      // and the User may change the member's model or permissions meanwhile,
      // which the dedicated CLI applies to its next turn.
      // A member removed while its turn waited does not run at all.
      const current = chatParticipants(conversation).find((item) => item.id === participant.id);
      if (!current) {
        throw new Error(`@${participant.handle} was removed from this chat.`);
      }
      participant = current;
      if (!this.chat.host.machineRuntime) {
        this.chat.promptSuggestions.suggestions.replyStarted(conversation.id, participant.id, runId);
      }
      // Every path that runs a member's turn (first turn, continuations,
      // request runners, resumes) goes through here: the User's server first
      // (Д4, Д13), then here or on the member's own device.
      const opened: ServerTurnOpen = this.chat.serverLink.current
        ? await this.chat.serverTurns.openServerTurn(conversation, participant, triggerMessage, runId, turnController.signal, options.ownServerTurn === true)
        : { kind: "none" };
      // Where it runs was decided there (after any move of it): as the chat
      // has it now.
      participant = chatParticipants(conversation).find((item) => item.id === participant.id) ?? participant;
      if (opened.kind !== "local") serverTurnEnded = true;
      if (opened.kind === "stopped" || opened.kind === "skip") {
        this.chat.serverTurns.serverTurnOpens.delete(runId);
        if (opened.kind === "stopped" && !options.existingPendingMessage && !turnShown(conversation, triggerMessage, participant, opened.serverRunId)) {
          await this.chat.serverTurns.noteTurnStoppedBeforeStart(conversation, triggerMessage, participant);
        }
        return [];
      }
      // A member that runs on another device is reached only through the
      // User's server (Д4, Д13): without a link to it, it does not start.
      if (opened.kind === "none" && !this.chat.host.runsHere(participant)) {
        throw new Error(participant.homeMachineId || participant.cloudRun
          ? `@${participant.handle} runs on a cloud machine, which this device reaches only through your server; it is not linked to it yet.`
          : `@${participant.handle} runs on your computer, which this machine reaches only through your server; it is not linked to it yet.`);
      }
      let messages: ChatMessage[];
      if (opened.kind === "remote") {
        messages = await this.chat.remoteTurns.runParticipantTurnRemote(conversation, participant, triggerMessage, runId, opened, turnController.signal, progress, {
          warnings: options.warnings,
          existingPendingMessage: options.existingPendingMessage,
          continuation: options.continuation,
          turnSegmentId
        });
        this.chat.serverTurns.serverTurnOpens.delete(runId);
      } else {
        let outcome: "done" | "error" | "stopped" = "error";
        try {
          messages = await this.chat.participantTurn.runParticipantTurn(conversation, participant, triggerMessage, runId, turnController.signal, progress, {
            ...options,
            turnSegmentId,
            queuedInCli: Boolean(reservation.behindMemberTurn)
          });
          outcome = turnController.signal.aborted ? "stopped" : "done";
        } catch (error) {
          outcome = turnController.signal.aborted ? "stopped" : "error";
          throw error;
        } finally {
          // Its context use goes with the turn's end, for every other device.
          if (opened.kind === "local") this.chat.serverTurns.finishServerTurn(runId, outcome, agentContextUsageByParticipant(conversation)[participant.id]);
          serverTurnEnded = true;
        }
      }
      if (!this.chat.host.machineRuntime && offersPromptSuggestionAfter(participant, triggerMessage, messages, turnController.signal)) {
        // A cloud member's machine is chosen while its turn is prepared.
        const machineId = chatParticipants(conversation).find((item) => item.id === participant.id)?.homeMachineId
          ?? participant.homeMachineId;
        const source = opened.kind === "remote" ? machineId : CHAT_PROMPT_SUGGESTION_LOCAL_SOURCE;
        if (source) {
          this.chat.promptSuggestions.suggestions.replyFinished(conversation.id, participant.id, runId, source);
        }
      }
      return messages;
    } finally {
      reservation.release();
      const stopped = turnController?.signal.aborted ?? false;
      turnController?.cleanup();
      // Taken on the server before it waited its turn here (a send takes it
      // first), and stopped or failed before it ran: ended there too, never
      // left taken with every device showing it busy.
      if (!serverTurnEnded) await this.endServerTurnNotRun(runId, stopped);
      this.chat.delegation.liveTurnSegments.delete(liveTurnKey);
      this.chat.requesterResumes.resumeDelegationsOfEndedTurn(liveTurnKey);
    }
  }

  private async endServerTurnNotRun(runId: string, stopped: boolean): Promise<void> {
    const opening = this.chat.serverTurns.serverTurnOpens.get(runId);
    if (!opening) return;
    const opened = await opening.catch(() => undefined);
    if (opened?.kind === "local") this.chat.serverTurns.finishServerTurn(runId, stopped ? "stopped" : "error");
    else this.chat.serverTurns.serverTurnOpens.delete(runId);
  }

  /** Same-participant turns are serialized, except that a Claude Code member
   *  takes a message while it is working or while its background work runs,
   *  exactly as its dedicated CLI does: the CLI queues the message itself and
   *  hands it to the running step (`shared` turns). Exclusive operations such
   *  as compaction still wait for every earlier turn, and shared turns wait for
   *  an earlier exclusive one. A `following` turn (a member going on after its
   *  own compaction) waits for every earlier turn too, but the User's next
   *  message joins it as it joins a turn of her own. */
  reserveParticipantTurn(
    conversationId: string,
    participantId: string,
    mode: "exclusive" | "shared" | "following" = "exclusive"
  ): ParticipantTurnReservation {
    const key = `${conversationId}:${participantId}`;
    if (mode === "following") {
      const all = chainParticipantTurn(this.participantTurnQueues, key);
      return { queued: all.queued, wait: async () => { await all.previousReady; }, release: all.release };
    }
    if (mode === "shared") {
      const exclusiveTail = this.participantExclusiveTurnQueues.get(key);
      const exclusiveReady = (exclusiveTail ?? Promise.resolve()).catch(() => undefined);
      const all = chainParticipantTurn(this.participantTurnQueues, key);
      return {
        queued: Boolean(exclusiveTail),
        behindMemberTurn: all.queued,
        wait: async () => {
          await exclusiveReady;
        },
        release: all.release
      };
    }
    const all = chainParticipantTurn(this.participantTurnQueues, key);
    const exclusive = chainParticipantTurn(this.participantExclusiveTurnQueues, key);
    return {
      queued: all.queued,
      wait: async () => {
        await all.previousReady;
      },
      release: () => {
        all.release();
        exclusive.release();
      }
    };
  }
}
