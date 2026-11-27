import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatParticipant, Conversation } from "../../../../shared/types";
import { CHAT_PROMPT_SUGGESTION_LOCAL_SOURCE } from "../../chatPromptSuggestions";
import { agentContextUsageByParticipant } from "../compaction/contextUsage";
import { chatParticipants } from "../members/identity";
import { deliversNow, memberDeliveryWay, participantTurnMode } from "../members/roleRuntime";
import { mainSessionParticipantId } from "../../../../shared/mainSession";
import { turnSegmentKey } from "../requests/delegationGroups";
import { abortableWait } from "../runs/abortableWait";
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
  /** A request from another member that may go out with the ones waiting
   *  next to it (takeCombinableTurns). */
  combinable?: { trigger: ChatMessage; chars: number; runId: string };
  /** Taken into the turn of the request before it: its reply answers it
   *  (`stopped`: that reply was stopped before the member started). */
  combinedInto?: Promise<CombinedReply>;
  /** Ends its wait once it is taken into another turn. */
  wake?: () => void;
}

/** At most this many requests go out in one turn. */
const COMBINED_REQUESTS_MAX = 8;

function setOf<T>(map: Map<string, Set<T>>, key: string): Set<T> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

/** How a member's turn runs (runParticipantTurnSerialized). */
interface SerializedTurnOptions {
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
  /** A request from another member (participantRequests): it may go out
   *  with the requests waiting next to it, all within `maxChars`. */
  combine?: { chars: number; maxChars: number };
  /** The requests that go out with this turn's trigger, taken here or by the
   *  device that asked for this turn. */
  combinedTriggers?: ChatMessage[];
}

/** What the turn a request went out in ended with: its messages (none: it
 *  did not run), or `stopped` when the User stopped it before the member
 *  started. */
type CombinedReply = ChatMessage[] | "stopped";

/** A request taken into another's turn that did not answer it. */
class NotAnsweredTogether extends Error {}

/** A request taken into another's turn that the User stopped before the
 *  member started: it ends stopped with it, as a Stop of that reply ends
 *  every request it answers. */
export class CombinedTurnStopped extends Error {
  constructor() { super("Chat run cancelled."); }
}

/** The reply of the turn a request went out with, or a Stop of its own run first. */
async function abortableReply(reply: Promise<CombinedReply>, signal: AbortSignal): Promise<CombinedReply> {
  let ended: CombinedReply = [];
  await abortableWait(reply.then((value) => { ended = value; }), signal);
  return ended;
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
  /** Runs whose request a request's turn before it answered (takeAnsweredTogether). */
  private readonly answeredTogether = new Set<string>();
  /** Runs whose turn the User's server said was stopped before it began. */
  private readonly stoppedBeforeStart = new Set<string>();
  /** Runs of requests taken into another request's turn, until they end:
   *  a Stop of one ends only its request (isJoinedRun). */
  private readonly joinedRuns = new Set<string>();

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
    options: SerializedTurnOptions
  ): Promise<ChatMessage[]> {
    try {
      return await this.runTurnSerialized(conversation, participant, triggerMessage, runId, signal, progress, options);
    } catch (error) {
      if (!(error instanceof NotAnsweredTogether)) throw error;
      // Taken into another request's turn that did not answer it (that turn
      // ended before it ran, or the member's device did not take it in): it
      // runs on its own, as it would have, in the place it had (right after
      // that turn, before what was asked of the member since).
      const { combine: _combine, turnReservation: _reservation, ...own } = options;
      return this.runTurnSerialized(conversation, participant, triggerMessage, runId, signal, progress, {
        ...own,
        turnReservation: this.reserveParticipantTurn(conversation.id, participant.id, "exclusive", { priority: "next" })
      });
    }
  }

  /** Whether this run's request was answered by the turn of a request
   *  before it, which it went out with (asked once, after the run). */
  /** Whether this run's turn was stopped on the User's server before it
   *  began (it returned no reply); asked once, after the run. */
  takeStoppedBeforeStart(runId: string): boolean {
    return this.stoppedBeforeStart.delete(runId);
  }

  takeAnsweredTogether(runId: string): boolean {
    return this.answeredTogether.delete(runId);
  }

  private async runTurnSerialized(
    conversation: Conversation,
    participant: ChatParticipant,
    triggerMessage: ChatMessage,
    runId: string,
    signal: AbortSignal | undefined,
    progress: ProgressCallback | undefined,
    options: SerializedTurnOptions
  ): Promise<ChatMessage[]> {
    const turnSegmentId = randomUUID();
    const liveTurnKey = turnSegmentKey(conversation.id, turnSegmentId);
    this.chat.delegation.liveTurnSegments.add(liveTurnKey);
    const reservation = options.turnReservation ?? this.reserveTurnFor(conversation, participant, triggerMessage);
    if (options.combine) this.markCombinable(reservation, triggerMessage, options.combine.chars, runId);
    // The requests that go out with this one, and the end of this turn for
    // them (its reply, or none when it did not run).
    let combinedTriggers = options.combinedTriggers ?? [];
    let settleCombined: ((ended: CombinedReply) => void) | undefined;
    let answered: ChatMessage[] | undefined;
    const runKey = `${conversation.id}:${participant.id}`;
    // A request delivered now to a member here: a CLI that cannot take it in
    // the middle of a turn has its running turn cut now, and this turn runs
    // next; Claude Code gets the CLI's send-now once the message is in its
    // queue (onCliMessageWritten below).
    const delivery = this.deliveryPriority(participant, triggerMessage, conversation);
    let turnController: { signal: AbortSignal; cleanup: () => void } | undefined;
    // Whether the turn this run took on the server was ended there.
    let serverTurnEnded = false;
    let runningHere = false;
    try {
      turnController = this.chat.participantBatch.ensureChatTurnController(conversation, participant, runId, signal);
      // Waiting for the member's own compaction and the turn it goes on in,
      // it would only wait longer: nothing is cut then.
      if (delivery === "next" && !turnController.signal.aborted && !this.memberActivity(conversation.id, participant.id).compacting) {
        void this.chat.runCancel.deliverNow(conversation.id, participant.id, runId, "interrupt-and-restart").catch(() => undefined);
      }
      await waitForParticipantTurnReservation(reservation, turnController.signal);
      if (turnController.signal.aborted) {
        throw new Error("Chat run cancelled.");
      }
      const combinedInto = this.combinedInto(reservation);
      if (combinedInto) {
        // It went out with the request before it: that turn's reply answers
        // it. Its place is given up now (what waits behind it still waits
        // for that turn).
        reservation.release();
        const messages = await abortableReply(combinedInto, turnController.signal);
        if (messages === "stopped") throw new CombinedTurnStopped();
        if (!messages[0]?.metadata?.combinedRequestMessageIds?.includes(triggerMessage.id)) {
          // It runs on its own: a run of the member like any other.
          this.joinedRuns.delete(runId);
          throw new NotAnsweredTogether();
        }
        this.answeredTogether.add(runId);
        return messages;
      }
      setOf(this.runningTurnRuns, runKey).add(runId);
      runningHere = true;
      if (options.combine && !options.combinedTriggers) {
        const result = new Promise<CombinedReply>((resolve) => { settleCombined = resolve; });
        combinedTriggers = this.takeCombinableTurns(reservation, conversation.id, participant.id, result, options.combine.maxChars);
        if (combinedTriggers.length === 0) settleCombined = undefined;
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
        if (opened.kind === "stopped") {
          this.stoppedBeforeStart.add(runId);
          while (this.stoppedBeforeStart.size > 1_000) this.stoppedBeforeStart.delete(this.stoppedBeforeStart.values().next().value as string);
        }
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
          turnSegmentId,
          ...(combinedTriggers.length > 0 ? { combinedTriggerIds: combinedTriggers.map((message) => message.id) } : {})
        });
        this.chat.serverTurns.serverTurnOpens.delete(runId);
      } else {
        let outcome: "done" | "error" | "stopped" = "error";
        try {
          messages = await this.chat.participantTurn.runParticipantTurn(conversation, participant, triggerMessage, runId, turnController.signal, progress, {
            ...options,
            turnSegmentId,
            combinedTriggers,
            queuedInCli: Boolean(reservation.behindMemberTurn),
            ...(delivery === "live" && participant.kind === "codex-cli" ? {
              // Codex steers its running turn with it; when it cannot, the
              // running turn is cut and this one runs next, in its session.
              steerIntoRunningTurn: (outcome: "steered" | "not-steered" | "after-turn") => {
                void this.chat.runCancel.deliverNow(conversation.id, participant.id, runId, outcome === "not-steered" ? "interrupt-and-restart" : outcome).catch(() => undefined);
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
      answered = messages;
      return messages;
    } finally {
      // The requests that went out with it get its reply; stopped by the
      // User before it gave one, they end stopped with it; otherwise (it did
      // not run) they run on their own.
      const stoppedByUser = Boolean(turnController?.signal.aborted) && !this.chat.activeRuns.sentNowRunIds.has(runId);
      settleCombined?.(stoppedByUser && !answered?.length ? "stopped" : answered ?? []);
      if (runningHere) {
        this.runningTurnRuns.get(runKey)?.delete(runId);
        if (this.runningTurnRuns.get(runKey)?.size === 0) this.runningTurnRuns.delete(runKey);
      }
      this.chat.activeRuns.cliReturnedRunIds.delete(runId);
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
        // A Claude Code CLI holds the message until the running step's next
        // tool result (a Codex steer takes it at once).
        ...(options.priority === "live" && mode === "shared" && runningNow.length > 0 ? { behindMemberTurn: true } : {}),
        wait: async () => {
          // Waited for again by whoever it was handed to: it runs already.
          if (ended || held.running) return;
          await Promise.all(waitsFor.map((turn) => turn.done));
          for (let first = this.userTurnsFirst(key, held); held.userFirst && !held.running && first.length > 0; first = this.userTurnsFirst(key, held)) {
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
        if (!held.combinedInto) await Promise.race([chained.wait(), new Promise<void>((resolve) => { held.wake = resolve; })]);
        if (ended || held.running || held.combinedInto) return;
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

  /** A request from another member that waits for its turn and may go out
   *  together with the requests waiting next to it, as the member's
   *  dedicated CLI sends what was queued while it worked in one message. */
  markCombinable(reservation: ParticipantTurnReservation, trigger: ChatMessage, chars: number, runId: string): void {
    const held = this.heldOf.get(reservation);
    if (held && !held.running && !held.priority && held.mode === "exclusive") held.combinable = { trigger, chars, runId };
  }

  /** A run of a request taken into another request's turn: it does not run
   *  the member, and its Stop ends only its own request (not, say, the
   *  member going on after a compaction it asked for in that turn). */
  isJoinedRun(runId: string): boolean {
    return this.joinedRuns.has(runId);
  }

  /** The run of a request taken into another's turn has ended. */
  endJoinedRun(runId: string): void {
    this.joinedRuns.delete(runId);
  }

  /** The requests waiting right behind a request whose turn begins, taken
   *  into it in the order they were made: up to the first turn that is not
   *  such a request (the User's message, a resume, an operation), at most
   *  COMBINED_REQUESTS_MAX, and only while all their text stays within
   *  `maxChars` (one request's limit: Antigravity gets its prompt as an
   *  argument). Each taken turn's wait ends; its reply is `result`'s. */
  takeCombinableTurns(reservation: ParticipantTurnReservation, conversationId: string, participantId: string, result: Promise<CombinedReply>, maxChars: number): ChatMessage[] {
    const lead = this.heldOf.get(reservation);
    if (!lead?.combinable) return [];
    const key = `${conversationId}:${participantId}`;
    const taken: HeldTurn[] = [];
    let chars = lead.combinable.chars;
    for (const turn of this.pendingTurns.get(key) ?? []) {
      if (turn === lead) continue;
      if (!turn.combinable || turn.combinedInto || turn.running || taken.length + 1 >= COMBINED_REQUESTS_MAX) break;
      if (chars + turn.combinable.chars > maxChars) break;
      chars += turn.combinable.chars;
      taken.push(turn);
    }
    for (const turn of taken) {
      turn.combinedInto = result;
      this.joinedRuns.add(turn.combinable!.runId);
      for (const map of [this.pendingTurns, this.readyTurns]) map.get(key)?.delete(turn);
      turn.wake?.();
    }
    return taken.map((turn) => turn.combinable!.trigger);
  }

  /** The reply of the turn this one was taken into, if it was. */
  combinedInto(reservation: ParticipantTurnReservation): Promise<CombinedReply> | undefined {
    return this.heldOf.get(reservation)?.combinedInto;
  }

  private heldReservation(held: HeldTurn, reservation: ParticipantTurnReservation): ParticipantTurnReservation {
    this.heldOf.set(reservation, held);
    return reservation;
  }

  /** The turn this run took, wherever it runs, by the reservation's order:
   *  a turn delivered now goes before the waiting ones (deliveryPriority). */
  reserveTurnFor(conversation: Conversation, participant: ChatParticipant, triggerMessage: ChatMessage): ParticipantTurnReservation {
    const mode = participantTurnMode(participant, triggerMessage, mainSessionParticipantId(conversation.metadata) ?? "");
    const priority = this.deliveryPriority(participant, triggerMessage, conversation);
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
  deliveryPriority(participant: ChatParticipant, triggerMessage: ChatMessage, conversation?: Conversation): TurnPriority | undefined {
    if (!deliversNow(triggerMessage, participant.id, conversation ? mainSessionParticipantId(conversation.metadata) ?? "" : undefined)) return undefined;
    if (!this.chat.host.runsHere(participant)) return "elsewhere";
    return memberDeliveryWay(participant) === "into-running-turn" ? "live" : "next";
  }

  /** The runs of a member's turns that run now (not those waiting). */
  runningTurnRunIds(conversationId: string, participantId: string): string[] {
    return [...(this.runningTurnRuns.get(`${conversationId}:${participantId}`) ?? [])];
  }

  /** What the member does now: an operation on its session, a turn, or nothing. */
  memberActivity(conversationId: string, participantId: string): { running: "operation" | "turn" | "none"; waiting: number; compacting: boolean; goingOn: boolean } {
    const key = `${conversationId}:${participantId}`;
    const running = [...(this.runningTurns.get(key) ?? [])];
    // Its own compaction and the turn it goes on in are put first: a request
    // delivered now comes after them. Once only that turn is left and runs,
    // the member works again (goingOn).
    const ownCompaction = [...(this.priorityTurns.get(key) ?? [])].filter((turn) => turn.priority === "next" && (turn.operation || turn.userFirst));
    return {
      running: running.some((turn) => turn.operation) ? "operation" : running.length > 0 ? "turn" : "none",
      waiting: this.pendingTurns.get(key)?.size ?? 0,
      compacting: ownCompaction.length > 0,
      goingOn: ownCompaction.length > 0 && ownCompaction.every((turn) => turn.userFirst && turn.running)
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
