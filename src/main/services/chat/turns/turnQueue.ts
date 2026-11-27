import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatParticipant, Conversation } from "../../../../shared/types";
import { CHAT_PROMPT_SUGGESTION_LOCAL_SOURCE } from "../../chatPromptSuggestions";
import { agentContextUsageByParticipant } from "../compaction/contextUsage";
import { chatParticipants } from "../members/identity";
import { deliversNow, memberDeliveryWay, participantTurnMode } from "../members/roleRuntime";
import { turnSegmentKey } from "../requests/delegationGroups";
import { turnShown } from "../runs/runOwnerRecords";
import { chainParticipantTurn, offersPromptSuggestionAfter, waitForParticipantTurnReservation } from "./turnOrder";
import type { ClaudeWriteGate } from "./types";
import type { ChatPromptContextScope, ParticipantTurnReservation, ProgressCallback, ServerTurnOpen } from "../types";
import type { ChatModules } from "../modules";

/** Where a turn goes among the member's turns (reserveParticipantTurn):
 *  `next` right after what runs now, before every turn already waiting (a
 *  member's own compaction and the turn it goes on in, a request delivered now
 *  to a member whose CLI cannot take it mid-turn, once its running turn is
 *  cut); `live` into the member's live CLI at once, as a message typed there
 *  mid-turn (it waits only for an operation on its session); `elsewhere` for
 *  a member on another device, which orders its turns there: nothing here
 *  waits for it, and the turns waiting here wait for it. */
export type TurnPriority = "next" | "live" | "elsewhere";

interface HeldTurn {
  /** Settled once the turn is released. */
  done: Promise<void>;
  operation: boolean;
  mode: "exclusive" | "shared" | "following";
  byUser: boolean;
  userFirst: boolean;
  running: boolean;
  priority?: TurnPriority;
}

function setOf<T>(map: Map<string, Set<T>>, key: string): Set<T> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

/** The order of one member's turns, and where each runs. */
export class TurnQueue {
  private readonly participantTurnQueues = new Map<string, Promise<void>>();
  /** Exclusive same-participant operations only (see reserveParticipantTurn). */
  private readonly participantExclusiveTurnQueues = new Map<string, Promise<void>>();
  /** Reserved turns that have not started, by member. */
  private readonly pendingTurns = new Map<string, Set<HeldTurn>>();
  /** Turns whose place in the line has come, waiting only for turns put
   *  first (blockingPriorityTurns), by member. */
  private readonly readyTurns = new Map<string, Set<HeldTurn>>();
  /** Turns that run now (their wait is over), by member. */
  private readonly runningTurns = new Map<string, Set<HeldTurn>>();
  /** Turns put before the waiting ones, until they end, in their order. */
  private readonly priorityTurns = new Map<string, Set<HeldTurn>>();
  /** The run ids of member turns that run now (runParticipantTurnSerialized). */
  private readonly runningTurnRuns = new Map<string, Set<string>>();
  private readonly heldOf = new WeakMap<ParticipantTurnReservation, HeldTurn>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "delegation" | "host" | "participantBatch" | "participantTurn" | "promptSuggestions" | "remoteTurns"
      | "requesterResumes" | "runCancel" | "serverLink" | "serverTurns"
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
    const reservation = options.turnReservation ?? this.reserveTurnFor(conversation, participant, triggerMessage);
    const runKey = `${conversation.id}:${participant.id}`;
    // A request delivered now to a member here: a CLI that cannot take it in
    // the middle of a turn has its running turn cut now, and this turn runs
    // next; Claude Code gets the CLI's send-now once the message is in its
    // queue (onCliMessageWritten below).
    const delivery = this.deliveryPriority(participant, triggerMessage);
    if (delivery === "next") {
      void this.chat.runCancel.deliverNow(conversation.id, participant.id, runId, "interrupt-and-restart").catch(() => undefined);
    }
    let turnController: { signal: AbortSignal; cleanup: () => void } | undefined;
    // Whether the turn this run took on the server was ended there.
    let serverTurnEnded = false;
    let runningHere = false;
    try {
      turnController = this.chat.participantBatch.ensureChatTurnController(conversation, participant, runId, signal);
      await waitForParticipantTurnReservation(reservation, turnController.signal);
      if (turnController.signal.aborted) {
        throw new Error("Chat run cancelled.");
      }
      setOf(this.runningTurnRuns, runKey).add(runId);
      runningHere = true;
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
            queuedInCli: Boolean(reservation.behindMemberTurn),
            ...(delivery === "live" && participant.kind === "codex-cli" ? {
              // Codex steers its running turn with it; when it cannot, the
              // running turn is cut and this one runs next, in its session.
              steerIntoRunningTurn: (outcome: "steered" | "not-steered") => {
                void this.chat.runCancel.deliverNow(conversation.id, participant.id, runId, outcome === "steered" ? "steered" : "interrupt-and-restart").catch(() => undefined);
              }
            } : delivery === "live" ? {
              onCliMessageWritten: () => {
                void this.chat.runCancel.deliverNow(conversation.id, participant.id, runId, "into-running-turn").catch(() => undefined);
              }
            } : {})
          });
          outcome = turnController.signal.aborted && !this.chat.activeRuns.sentNowRunIds.has(runId) ? "stopped" : "done";
        } catch (error) {
          outcome = turnController.signal.aborted ? (this.chat.activeRuns.sentNowRunIds.has(runId) ? "done" : "stopped") : "error";
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
      if (runningHere) {
        this.runningTurnRuns.get(runKey)?.delete(runId);
        if (this.runningTurnRuns.get(runKey)?.size === 0) this.runningTurnRuns.delete(runKey);
      }
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
   *  message joins it as it joins a turn of her own.
   *
   *  `priority` puts a turn before the turns already waiting (TurnPriority);
   *  those wait for it. `operation` marks work on the member's session itself
   *  (a compaction, a restart, a move): a message delivered into the member's
   *  live CLI waits for it while it runs. */
  reserveParticipantTurn(
    conversationId: string,
    participantId: string,
    mode: "exclusive" | "shared" | "following" = "exclusive",
    options: {
      operation?: boolean;
      priority?: TurnPriority;
      /** A turn for the User's own message (see blockingPriorityTurns). */
      byUser?: boolean;
      /** The turn a member goes on in after its own compaction: the User's
       *  messages that are ready when it may start go first, as her words
       *  come first in it. */
      userFirst?: boolean;
      /** It runs already (a reply the member's CLI began on its own). */
      startsNow?: boolean;
    } = {}
  ): ParticipantTurnReservation {
    const key = `${conversationId}:${participantId}`;
    let finish!: () => void;
    const held: HeldTurn = {
      done: new Promise<void>((resolve) => { finish = resolve; }),
      operation: options.operation === true,
      mode,
      byUser: options.byUser === true,
      userFirst: options.userFirst === true,
      running: false,
      ...(options.priority ? { priority: options.priority } : {})
    };
    let ended = false;
    const begin = (): void => {
      if (ended || held.running) return;
      held.running = true;
      for (const map of [this.pendingTurns, this.readyTurns]) map.get(key)?.delete(held);
      setOf(this.runningTurns, key).add(held);
    };
    // A turn put first is not in the chains: the turns waiting wait for it
    // through blockingPriorityTurns.
    const base = options.priority ? undefined : this.chainedReservation(key, mode);
    const release = (): void => {
      base?.release();
      if (ended) return;
      ended = true;
      for (const map of [this.pendingTurns, this.readyTurns, this.runningTurns, this.priorityTurns]) {
        map.get(key)?.delete(held);
        if (map.get(key)?.size === 0) map.delete(key);
      }
      finish();
    };
    setOf(this.pendingTurns, key).add(held);
    if (options.startsNow) begin();
    if (options.priority) {
      const earlier = [...(this.priorityTurns.get(key) ?? [])];
      const runningNow = [...(this.runningTurns.get(key) ?? [])];
      setOf(this.priorityTurns, key).add(held);
      const waitsFor = options.priority === "next"
        ? [...runningNow, ...earlier]
        : options.priority === "live"
          ? [...runningNow.filter((turn) => turn.operation), ...earlier.filter((turn) => turn.priority === "next")]
          : [];
      return this.heldReservation(held, {
        queued: waitsFor.length > 0,
        ...(options.priority === "live" && runningNow.length > 0 ? { behindMemberTurn: true } : {}),
        wait: async () => {
          await Promise.all(waitsFor.map((turn) => turn.done));
          for (let first = this.userTurnsFirst(key, held); held.userFirst && first.length > 0; first = this.userTurnsFirst(key, held)) {
            await Promise.all(first.map((turn) => turn.done));
          }
          begin();
        },
        release
      });
    }
    const chained = base!;
    // Nothing before it in the line: its place has come already (a go-on
    // turn lets it go first even before its wait has run).
    if (!chained.queued) setOf(this.readyTurns, key).add(held);
    return this.heldReservation(held, {
      queued: chained.queued || (this.priorityTurns.get(key)?.size ?? 0) > 0,
      ...(chained.behindMemberTurn !== undefined ? { behindMemberTurn: chained.behindMemberTurn } : {}),
      wait: async () => {
        await chained.wait();
        if (ended || held.running) return;
        setOf(this.readyTurns, key).add(held);
        for (let first = this.blockingPriorityTurns(key, held); first.length > 0; first = this.blockingPriorityTurns(key, held)) {
          await Promise.all(first.map((turn) => turn.done));
        }
        begin();
      },
      release
    });
  }

  /** The turns put first that a waiting turn waits for, in their order. A
   *  message to a Claude Code member's live CLI does not wait for one
   *  delivered there too. The User's own message goes before a go-on turn
   *  that has not begun, and before every turn put first after it (they wait
   *  for it); it joins a running one that follows her (a Claude Code member's
   *  CLI takes both), as it joins a turn of her own. */
  private blockingPriorityTurns(key: string, self: HeldTurn): HeldTurn[] {
    const blocking: HeldTurn[] = [];
    for (const turn of this.priorityTurns.get(key) ?? []) {
      if (turn === self) continue;
      if (self.mode === "shared" && turn.priority === "live") continue;
      if (self.byUser && turn.userFirst && !turn.running) break;
      if (self.byUser && self.mode === "shared" && turn.userFirst && turn.mode === "following") continue;
      blocking.push(turn);
    }
    return blocking;
  }

  /** The User's own messages a go-on turn lets go first: those whose place
   *  in the line has come (ready or running). */
  private userTurnsFirst(key: string, self: HeldTurn): HeldTurn[] {
    return [...(this.readyTurns.get(key) ?? []), ...(this.runningTurns.get(key) ?? [])].filter((turn) => turn !== self && turn.byUser);
  }

  private heldReservation(held: HeldTurn, reservation: ParticipantTurnReservation): ParticipantTurnReservation {
    this.heldOf.set(reservation, held);
    return reservation;
  }

  /** The turn this run took, wherever it runs, by the reservation's order:
   *  a turn delivered now goes before the waiting ones (deliveryPriority). */
  reserveTurnFor(conversation: Conversation, participant: ChatParticipant, triggerMessage: ChatMessage): ParticipantTurnReservation {
    const mode = participantTurnMode(participant, triggerMessage);
    const priority = this.deliveryPriority(participant, triggerMessage);
    return this.reserveParticipantTurn(conversation.id, participant.id, mode, {
      ...(priority ? { priority } : {}),
      ...(triggerMessage.role === "user" ? { byUser: true } : {}),
      // A native goal runs in a process of its own: a message delivered now
      // waits for it.
      ...(triggerMessage.metadata?.nativeCommand?.name === "goal" ? { operation: true } : {})
    });
  }

  /** How a request asked with `deliver: "now"` takes its place: into the
   *  member's live CLI (a Claude Code member takes it mid-turn), next after
   *  its running turn (which is cut for it), or, for a member on another
   *  device, as that device orders it. */
  deliveryPriority(participant: ChatParticipant, triggerMessage: ChatMessage): TurnPriority | undefined {
    if (!deliversNow(triggerMessage, participant.id)) return undefined;
    if (!this.chat.host.runsHere(participant)) return "elsewhere";
    return memberDeliveryWay(participant) === "into-running-turn" ? "live" : "next";
  }

  /** The runs of a member's turns that run now (not those waiting). */
  runningTurnRunIds(conversationId: string, participantId: string): string[] {
    return [...(this.runningTurnRuns.get(`${conversationId}:${participantId}`) ?? [])];
  }

  /** What the member does now: an operation on its session, a turn, or nothing. */
  memberActivity(conversationId: string, participantId: string): { running: "operation" | "turn" | "none"; waiting: number } {
    const key = `${conversationId}:${participantId}`;
    const running = [...(this.runningTurns.get(key) ?? [])];
    return {
      running: running.some((turn) => turn.operation) ? "operation" : running.length > 0 ? "turn" : "none",
      waiting: this.pendingTurns.get(key)?.size ?? 0
    };
  }

  /** Whether turns of the member wait (other than `except`'s). */
  hasWaitingTurns(conversationId: string, participantId: string, except?: ParticipantTurnReservation): boolean {
    const exceptHeld = except ? this.heldOf.get(except) : undefined;
    return [...(this.pendingTurns.get(`${conversationId}:${participantId}`) ?? [])].some((turn) => turn !== exceptHeld);
  }

  private chainedReservation(key: string, mode: "exclusive" | "shared" | "following"): ParticipantTurnReservation {
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
