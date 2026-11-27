import type {
  ChatMessage, ChatParticipant, ChatPromptContextPointerAdvance, ChatPromptContextPointerEntry, Conversation
} from "../../../../shared/types";
import { cappedTaskReplyRecords } from "../requests/delegationGroups";
import {
  commitPromptContextPointerAdvance, inFlightPromptContextKey, isParticipantOwnPromptContextMessage, isPromptContextMessage, newestPostsReadThrough,
  normalizedPromptContextPointers, promptContextBlock, promptContextPointerAtOrAfter, promptContextPointerForScope,
  promptContextRecordsAfterPointer, promptContextScopeForTrigger, selectPromptContextRecords
} from "./promptContextRecords";
import { newMessageNonce } from "./promptSections";
import { takenBackMessageIds } from "./takenBackMessages";
import type { ClaudeWriteGate } from "./types";
import type { ChatPromptContextScope } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

interface PreparedPromptContext {
  block: string;
  resumeFallbackBlock: string;
  pointerAdvance?: ChatPromptContextPointerAdvance;
  /** The other threads a turn that took waiting messages in read
   *  (preparePromptContextForTurn). */
  otherPointerAdvances?: ChatPromptContextPointerAdvance[];
}

/** What a turn read is passed: the next turn reads only what came after. */
export function commitPreparedPromptContext(conversation: Conversation, participantId: string, prepared: PreparedPromptContext): void {
  for (const advance of [prepared.pointerAdvance, ...(prepared.otherPointerAdvances ?? [])]) {
    commitPromptContextPointerAdvance(conversation, participantId, advance);
  }
}

function scopeKey(scope: ChatPromptContextScope): string {
  return scope.type === "thread" ? `thread:${scope.threadRootId}` : "timeline";
}

interface InFlightPromptContext {
  runId: string;
  entry: ChatPromptContextPointerEntry;
}

/** Chat messages a member has not seen yet, sent with its turn once. */
export class PromptContext {
  /** Chat context already sent to a member by a turn that is still running.
   *  A message the member takes while it works (a Claude Code member, see
   *  reserveParticipantTurn) must not send that context to it a second time. */
  private readonly inFlightPromptContext = new Map<string, InFlightPromptContext[]>();
  /** Per member: settles when the latest dispatched Claude Code message has
   *  been written to its CLI, so messages reach the CLI in the order sent. */
  private readonly claudeMessageWriteOrder = new Map<string, Promise<void>>();

  constructor(
    private readonly chat: Pick<ChatModules, "activeRuns" | "store">,
    private readonly deps: Pick<ChatDependencies, "settings">
  ) {}

  async preparePromptContextForRun(
    conversation: Conversation,
    promptConversation: Conversation,
    participant: ChatParticipant,
    triggerMessage: ChatMessage,
    scope: ChatPromptContextScope,
    isResumingSession: boolean,
    runId?: string,
    /** Messages outside the scope the turn must read as well (the replies to
     *  the main session's tasks of one turn, resumed together), as untrusted
     *  context like the scope's own. */
    extraMessageIds?: readonly string[],
    /** The message's nonce (ChatPromptBuildOptions.turnNonce). */
    nonce: string = newMessageNonce(),
    /** Messages the turn gets as its own, not as chat it has not seen (the
     *  ones it took in, preparePromptContextForTurn). */
    ownMessageIds: ReadonlySet<string> = new Set()
  ): Promise<PreparedPromptContext> {
    const settings = await this.deps.settings.getPublicSettings();
    const policy = scope.type === "thread"
      ? settings.chatPromptContext.thread
      : settings.chatPromptContext.timeline;
    let block = "";
    let resumeFallbackBlock = "";
    let pointerAdvance: ChatPromptContextPointerAdvance | undefined;
    await this.chat.store.withChatMutation(conversation, async () => {
      const pointers = normalizedPromptContextPointers(conversation.metadata.promptContextPointers);
      const participantPointers = pointers[participant.id] ?? {};
      const committed = promptContextPointerForScope(participantPointers, scope);
      const inFlightKey = inFlightPromptContextKey(conversation.id, participant.id, scope);
      const inFlight = this.inFlightPromptContextFloor(inFlightKey);
      const pointer = inFlight && !promptContextPointerAtOrAfter(committed, inFlight) ? inFlight : committed;
      const records = promptContextRecordsAfterPointer(promptConversation.messages, scope, pointer, triggerMessage.id);
      const takenBack = takenBackMessageIds([...promptConversation.messages, ...conversation.messages], participant.id);
      const renderCandidates = records.filter((record) => record.message.id !== triggerMessage.id && !ownMessageIds.has(record.message.id) &&
        !takenBack.has(record.message.id) && !record.message.metadata?.takenBack);
      const resumedRenderCandidates = isResumingSession
        ? renderCandidates.filter((record) => !isParticipantOwnPromptContextMessage(record.message, participant.id))
        : renderCandidates;
      // A running reply's posts are read but never passed: the pointer stops
      // before the reply unless a finished message after it is read too.
      const advanceTo = [...records].reverse().find((record) => !record.interimPostsOnly);
      const selection = selectPromptContextRecords(resumedRenderCandidates, policy);
      const fallbackSelection = resumedRenderCandidates === renderCandidates
        ? selection
        : selectPromptContextRecords(renderCandidates, policy);
      // The replies to the main session's tasks of one turn are read in a
      // block of their own, each and all of them cut to fit
      // (cappedTaskReplyRecords), the one in the scope's thread too.
      const extraIds = new Set(extraMessageIds ?? []);
      const outsideExtra = <T extends { message: ChatMessage }>(records: T[]): T[] =>
        extraIds.size > 0 ? records.filter((record) => !extraIds.has(record.message.id)) : records;
      block = promptContextBlock(scope, policy, outsideExtra(selection.included), selection.omittedCount, undefined, nonce);
      resumeFallbackBlock = promptContextBlock(
        scope,
        policy,
        outsideExtra(fallbackSelection.included),
        fallbackSelection.omittedCount,
        undefined,
        nonce
      );
      if (extraIds.size > 0) {
        const records = cappedTaskReplyRecords(promptConversation.messages
          .map((message, sequence) => ({ message, sequence }))
          .filter((record) => extraIds.has(record.message.id) && record.message.id !== triggerMessage.id && isPromptContextMessage(record.message)));
        const extra = promptContextBlock(scope, { mode: "all_unseen" }, records, 0, "Replies to the tasks you gave in one turn", nonce);
        block = [block, extra].filter(Boolean).join("\n\n");
        resumeFallbackBlock = [resumeFallbackBlock, extra].filter(Boolean).join("\n\n");
      }
      if (advanceTo) {
        // The newest post this turn read (or an earlier turn did): the next
        // turn reads only posts made after it.
        const postsReadThrough = newestPostsReadThrough(
          advanceTo.message.createdAt,
          [pointer?.postsReadThrough, ...records.flatMap((record) => record.interimPostsOnly ? [record.message.createdAt] : [])]
        );
        pointerAdvance = {
          scope,
          entry: {
            messageId: advanceTo.message.id,
            sequence: advanceTo.sequence,
            ...(typeof advanceTo.message.createdAt === "string" && advanceTo.message.createdAt.trim()
              ? { createdAt: advanceTo.message.createdAt }
              : {}),
            ...(postsReadThrough ? { postsReadThrough } : {})
          }
        };
        if (runId) {
          this.registerInFlightPromptContext(conversation.id, participant.id, pointerAdvance, runId);
        }
      }
    });
    return { block, resumeFallbackBlock, pointerAdvance };
  }

  /** preparePromptContextForRun for a turn, with the messages and requests
   *  it took in (TurnQueue.joinWaitingTurns): it reads what it has not seen
   *  in each of their threads too, as each would have alone, and gets none
   *  of them as chat it has not seen. */
  async preparePromptContextForTurn(
    conversation: Conversation,
    promptConversation: Conversation,
    participant: ChatParticipant,
    triggerMessage: ChatMessage,
    scope: ChatPromptContextScope,
    isResumingSession: boolean,
    runId: string | undefined,
    extraMessageIds: readonly string[] | undefined,
    nonce: string,
    joinedTriggers: readonly ChatMessage[] = []
  ): Promise<PreparedPromptContext> {
    const own = new Set(joinedTriggers.map((message) => message.id));
    const lead = await this.preparePromptContextForRun(conversation, promptConversation, participant, triggerMessage, scope, isResumingSession, runId, extraMessageIds, nonce, own);
    if (joinedTriggers.length === 0) return lead;
    own.add(triggerMessage.id);
    const read = new Set([scopeKey(scope)]);
    const others: PreparedPromptContext[] = [];
    for (const message of joinedTriggers) {
      const other = promptContextScopeForTrigger(message);
      if (read.has(scopeKey(other))) continue;
      read.add(scopeKey(other));
      others.push(await this.preparePromptContextForRun(conversation, promptConversation, participant, message, other, isResumingSession, runId, undefined, nonce, own));
    }
    const all = [lead, ...others];
    return {
      block: all.map((part) => part.block).filter(Boolean).join("\n\n"),
      resumeFallbackBlock: all.map((part) => part.resumeFallbackBlock).filter(Boolean).join("\n\n"),
      ...(lead.pointerAdvance ? { pointerAdvance: lead.pointerAdvance } : {}),
      otherPointerAdvances: others.flatMap((part) => part.pointerAdvance ? [part.pointerAdvance] : [])
    };
  }

  registerInFlightPromptContext(
    conversationId: string,
    participantId: string,
    advance: ChatPromptContextPointerAdvance,
    runId: string
  ): void {
    const key = inFlightPromptContextKey(conversationId, participantId, advance.scope);
    const entries = (this.inFlightPromptContext.get(key) ?? []).filter((item) => item.runId !== runId);
    this.inFlightPromptContext.set(key, [...entries, { runId, entry: advance.entry }]);
  }

  openClaudeWriteGate(conversationId: string, participantId: string): ClaudeWriteGate {
    const key = `${conversationId}:${participantId}`;
    const previous = this.claudeMessageWriteOrder.get(key) ?? Promise.resolve();
    let markWritten!: () => void;
    const written = new Promise<void>((resolve) => { markWritten = resolve; });
    const tail = Promise.all([previous, written]).then(() => undefined);
    this.claudeMessageWriteOrder.set(key, tail);
    void tail.then(() => {
      if (this.claudeMessageWriteOrder.get(key) === tail) {
        this.claudeMessageWriteOrder.delete(key);
      }
    });
    return { previous, markWritten };
  }

  /** The furthest context sent by a turn of this member that is still running. */
  inFlightPromptContextFloor(key: string): ChatPromptContextPointerEntry | undefined {
    const live = (this.inFlightPromptContext.get(key) ?? []).filter((item) => this.chat.activeRuns.chatRunControllers.has(item.runId));
    if (live.length === 0) {
      this.inFlightPromptContext.delete(key);
      return undefined;
    }
    this.inFlightPromptContext.set(key, live);
    let floor: ChatPromptContextPointerEntry | undefined;
    for (const item of live) {
      if (!floor || !promptContextPointerAtOrAfter(floor, item.entry)) {
        floor = item.entry;
      }
    }
    return floor;
  }

  releaseInFlightPromptContext(runId: string): void {
    for (const [key, entries] of this.inFlightPromptContext) {
      const remaining = entries.filter((item) => item.runId !== runId);
      if (remaining.length === 0) {
        this.inFlightPromptContext.delete(key);
      } else if (remaining.length !== entries.length) {
        this.inFlightPromptContext.set(key, remaining);
      }
    }
  }
}
