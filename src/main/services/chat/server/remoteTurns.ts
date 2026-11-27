import type { CloudRunPreparationProgress, CloudRunSelection } from "../../../../shared/cloudRunPreparation";
import { newOpId, serverSeqOf } from "../../chatServerOps";
import type { HubTurn } from "../../../../shared/hubOps";
import type { ChatMessage, ChatMessageMetadata, ChatParticipant, ChatProviderKind, Conversation } from "../../../../shared/types";
import { chatParticipants } from "../members/identity";
import { RemoteTurnNotStartedError } from "./remoteTurnErrors";
import { createChatMessage } from "../store/messages";
import { emitProgress } from "../turns/replyMessages";
import type { ProgressCallback, ServerTurnOpen } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** A turn of a member that runs on a machine, as the desktop follows it. */
export class RemoteTurns {
  private prepareCloudSelection?: (selection: CloudRunSelection, provider: ChatProviderKind, progress: (snapshot: CloudRunPreparationProgress) => void) => Promise<string>;
  private prepareMachineProject?: (machineId: string, localPath: string, signal?: AbortSignal, progress?: (message: string) => void) => Promise<void>;
  /** Desktop side: why a machine cannot take turns right now (its runtime is
   *  being updated), shown on a member's waiting bubble. */
  machineWaitReason?: (machineId: string) => string | undefined;
  /** Desktop side: runs before a turn of a machine member is asked (the
   *  machine's settings, with where its project lives, go to the server). */
  private beforeRemoteTurn?: (machineId: string) => Promise<void>;
  /** Desktop side: whether a chat's project is ready on a machine (a machine
   *  set up from here has it copied before its member's first turn). */
  machineProjectReady?: (machineId: string, repoPath: string) => Promise<boolean>;

  constructor(
    private readonly chat: Pick<ChatModules, "machineSupport" | "serverLink" | "serverPlaceholders" | "serverTurns" | "store">,
    private readonly deps: Pick<ChatDependencies, "debugLogs">
  ) {}

  /** Machines transport: participants whose home is an enrolled machine run
   *  there through the machine link; the desktop keeps the pending bubble,
   *  progress, and the final messages exactly as for a local participant. */
  setCloudRunPreparation(prepare: NonNullable<RemoteTurns["prepareCloudSelection"]>): void {
    this.prepareCloudSelection = prepare;
  }

  setMachineProjectPreparation(prepare: NonNullable<RemoteTurns["prepareMachineProject"]>): void {
    this.prepareMachineProject = prepare;
  }

  async prepareParticipantProjects(repoPath: string | undefined, participants: Array<{ homeMachineId?: string }>, signal?: AbortSignal, progress?: (message: string) => void): Promise<void> {
    if (!repoPath || !this.prepareMachineProject) return;
    for (const id of new Set(participants.map(participant => participant.homeMachineId).filter((id): id is string => Boolean(id)))) {
      signal?.throwIfAborted();
      await this.prepareMachineProject(id, repoPath, signal, progress);
    }
  }

  /** Desktop side: why a machine cannot take turns right now, if it cannot. */
  setMachineWaitReason(reason: ((machineId: string) => string | undefined) | undefined): void {
    this.machineWaitReason = reason;
  }

  /** Desktop side: see beforeRemoteTurn and machineProjectReady. */
  setRemoteTurnPreparation(preparation: {
    beforeRemoteTurn?: (machineId: string) => Promise<void>;
    machineProjectReady?: (machineId: string, repoPath: string) => Promise<boolean>;
  } | undefined): void {
    this.beforeRemoteTurn = preparation?.beforeRemoteTurn;
    this.machineProjectReady = preparation?.machineProjectReady;
  }

  /** A member that runs on another device: its turn is asked of that device
   *  on the server, and this device shows a placeholder until the member's
   *  own bubble arrives, then waits for the turn to end there. Stop is asked
   *  on the server too, and shown as waiting until that device confirms
   *  (parity exception "Stop on an unreachable machine is shown waiting"). */
  async runParticipantTurnRemote(
    conversation: Conversation,
    participant: ChatParticipant,
    triggerMessage: ChatMessage,
    localRunId: string,
    opened: Extract<ServerTurnOpen, { kind: "remote" }>,
    signal: AbortSignal | undefined,
    progress: ProgressCallback | undefined,
    options: {
      warnings: string[]; existingPendingMessage?: ChatMessage; continuation?: boolean; turnSegmentId: string;
      /** Requests that go out with the trigger (TurnQueue takeCombinableTurns). */
      combinedTriggerIds?: string[];
    }
  ): Promise<ChatMessage[]> {
    const link = this.chat.serverLink.current!;
    const serverRunId = opened.serverRunId;
    // A machine whose program would run its mode otherwise than its controls
    // say is never asked: refused before a bubble is shown for it here (one
    // made for it already says why; a member's request says why in its card).
    const refused = this.chat.machineSupport.machineCliModesRefusal(conversation, participant);
    if (refused) {
      // A turn the server holds for it already (its machine changed, or the
      // machine greeted again, after the message named it) is stopped there,
      // so that machine never takes it.
      if (opened.canonical) {
        await link.enqueue([{ opId: newOpId(), kind: "turn.stop", conversationId: conversation.id, runId: serverRunId, messageId: triggerMessage.id, participantId: participant.id }]).catch(() => undefined);
      }
      throw new RemoteTurnNotStartedError(refused);
    }
    let placeholder = options.existingPendingMessage;
    if (!placeholder) {
      placeholder = createChatMessage(
        "participant",
        "",
        { id: participant.id, kind: participant.kind, label: `@${participant.handle}`, model: participant.model },
        {
          threadId: triggerMessage.metadata?.threadId ?? triggerMessage.id,
          parentMessageId: triggerMessage.id,
          chatThreadRootId: triggerMessage.metadata?.chatThreadRootId,
          sourceMessageId: triggerMessage.id,
          requesterParticipantId: options.continuation ? triggerMessage.participantId : undefined,
          approvedContinuation: options.continuation || undefined,
          runId: serverRunId,
          turnSegmentId: options.turnSegmentId
        },
        "pending"
      );
      placeholder.metadata = { ...placeholder.metadata, serverPlaceholder: true };
      const created = placeholder;
      await this.chat.store.withChatMutation(conversation, async () => {
        conversation.messages.push(created);
        conversation.updatedAt = new Date().toISOString();
        this.chat.store.queueSnapshot(conversation);
      });
    }
    const bubble = placeholder;
    const setOnBubble = async (patch: (metadata: ChatMessageMetadata) => ChatMessageMetadata) => {
      await this.chat.store.withChatMutation(conversation, async () => {
        for (const message of conversation.messages) {
          if (message.participantId === participant.id && message.metadata?.runId === bubble.metadata?.runId && message.status === "pending") {
            message.metadata = patch({ ...(message.metadata ?? {}) });
          }
        }
        this.chat.store.queueSnapshot(conversation);
      });
    };
    try {
      // A cloud member's machine is made ready first; the member then names it.
      if (participant.cloudRun && !participant.homeMachineId) {
        if (!this.prepareCloudSelection) throw new Error("Cloud setup is not available on this device.");
        // What the preparation says (a sign-in it waits for) is on the bubble,
        // and a Stop ends the wait at once.
        const preparing = this.prepareCloudSelection(participant.cloudRun, participant.kind, (snapshot) => {
          emitProgress(localRunId, progress, "initial", snapshot.message, { participantLabel: `@${participant.handle}` });
          if (!signal?.aborted) void setOnBubble((metadata) => ({ ...metadata, cloudRunPreparation: snapshot })).catch(() => undefined);
        });
        let abort: (() => void) | undefined;
        const cancelled = new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal?.reason ?? new Error("Chat run cancelled."));
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
        void preparing.catch(() => undefined);
        let machineId: string;
        try { machineId = await Promise.race([preparing, cancelled]); }
        finally { if (abort) signal?.removeEventListener("abort", abort); }
        signal?.throwIfAborted();
        await setOnBubble((metadata) => { delete metadata.cloudRunPreparation; return metadata; });
        await this.chat.store.withChatMutation(conversation, async () => {
          const members = chatParticipants(conversation);
          const ready = members.find((item) => item.id === participant.id);
          if (!ready) throw new Error("The member left the chat while Cloud was preparing.");
          conversation.metadata = { ...conversation.metadata, participants: members.map((item) => item.id === ready.id ? { ...ready, homeMachineId: machineId } : item) };
          await this.chat.store.saveConversation(conversation);
          participant = { ...ready, homeMachineId: machineId };
        });
      }
      if (participant.homeMachineId) {
        const machineId = participant.homeMachineId;
        // A Cloud run machine whose program turned out to run its mode
        // otherwise than its controls say is never asked either, before
        // anything is copied there; a bubble shown only here goes (a bubble
        // made for it already says why).
        const refusal = this.chat.machineSupport.machineCliModesRefusal(conversation, participant);
        if (refusal) {
          if (!options.existingPendingMessage) await this.chat.serverPlaceholders.dropServerPlaceholder(conversation, bubble.id);
          throw new Error(refusal);
        }
        // The chat's project is on the member's machine before its turn is
        // asked there (copied once, never over what is there), and the machine
        // knows where it is: its settings on the server say so.
        if (conversation.repoPath && this.prepareMachineProject) {
          await this.prepareParticipantProjects(conversation.repoPath, [participant], signal, (message) => {
            emitProgress(localRunId, progress, "initial", message, { participantLabel: `@${participant.handle}` });
            void setOnBubble((metadata) => ({ ...metadata, cloudRunPreparation: { operationId: localRunId, message } })).catch(() => undefined);
          });
          await setOnBubble((metadata) => { delete metadata.cloudRunPreparation; return metadata; });
        }
        await this.beforeRemoteTurn?.(machineId).catch((error: unknown) => {
          void this.deps.debugLogs.write("chat.remote-turn.prepare-error", { conversationId: conversation.id, machineId, message: error instanceof Error ? error.message : String(error) });
        });
        signal?.throwIfAborted();
      }
    } catch (error) {
      // Stopped while its machine or project was made ready: the turn is
      // stopped on the server too, so its machine never starts it (a User's
      // message asked for it already).
      if (signal?.aborted) {
        await link.enqueue([{ opId: newOpId(), kind: "turn.stop", conversationId: conversation.id, runId: serverRunId, messageId: triggerMessage.id, participantId: participant.id }]).catch(() => undefined);
        // A member whose cloud machine is not chosen yet has no device but
        // this one: it says the member stopped, as for a local member stopped
        // before it started (a machine says so for its own members).
        const said = conversation.messages.some((item) => item.role === "system" && item.content === `@${participant.handle} stopped by user.` &&
          item.metadata?.parentMessageId === triggerMessage.id);
        if (!participant.homeMachineId && !said) await this.chat.serverTurns.noteTurnStoppedBeforeStart(conversation, triggerMessage, participant);
        throw error;
      }
      // It could not be made ready: the bubble says why, as a local member's
      // that could not start does (only this device has it).
      throw new RemoteTurnNotStartedError(error instanceof Error ? error.message : String(error));
    }
    const machineName = participant.homeMachineId ? link.machineName(participant.homeMachineId) ?? "the machine" : "this computer";
    const placed = (turn: HubTurn) => turn.state !== "requested";
    const ended = (turn: HubTurn) => turn.state === "finished" || turn.state === "stopped";
    // Why the machine cannot take it right now (its runtime is being
    // updated), when this device knows.
    const waitReason = participant.homeMachineId ? this.machineWaitReason?.(participant.homeMachineId) : undefined;
    await setOnBubble((metadata) => ({ ...metadata, machinePending: { machineName, at: new Date().toISOString(), ...(waitReason ? { reason: waitReason } : {}) } }));
    // The requests that go out with it are on the server before the member's
    // device reads them (Д13), as the message the turn answers is.
    const combined = options.combinedTriggerIds ?? [];
    for (const id of combined) {
      const stored = conversation.messages.find((message) => message.id === id);
      if (stored && serverSeqOf(stored) === undefined) await link.messageAccepted(conversation.id, id, signal);
    }
    // Asked of the member's device (a User's message asked it already).
    const opId = newOpId();
    await link.enqueue([{ opId, kind: "turn.request", conversationId: conversation.id, runId: serverRunId, messageId: triggerMessage.id, participantId: participant.id,
      ...(bubble.metadata?.serverPlaceholder ? { pendingMessageId: bubble.id } : {}),
      request: { kind: "turn", ...(options.continuation ? { continuation: true } : {}), ...(combined.length > 0 ? { combined } : {}) } }]);
    const asked = await link.opAnswered(opId);
    if (asked.status === "rejected") {
      // Refused by the server (a machine whose program cannot run its mode,
      // say): a bubble shown only here goes, as a refused turn has none.
      if (!options.existingPendingMessage) await this.chat.serverPlaceholders.dropServerPlaceholder(conversation, bubble.id);
      throw new Error(`@${participant.handle} could not be started on ${machineName}: ${asked.reason}`);
    }
    let turn: HubTurn | undefined = asked.turn;
    try {
      if (!turn || !placed(turn)) turn = await this.chat.serverTurns.waitForServerTurn(serverRunId, placed, signal);
      await setOnBubble((metadata) => { delete metadata.machinePending; return metadata; });
      // The member's device may have written its bubble before this one
      // showed the placeholder: the placeholder goes.
      await this.chat.store.withChatMutation(conversation, async () => {
        const real = conversation.messages.some((message) => !message.metadata?.serverPlaceholder && message.participantId === participant.id && message.metadata?.runId === serverRunId);
        if (!real) return;
        this.chat.serverPlaceholders.removeServerPlaceholders(conversation, (message) => message.participantId === participant.id && message.metadata?.runId === serverRunId);
        this.chat.store.queueSnapshot(conversation);
      });
      if (!ended(turn)) turn = await this.chat.serverTurns.waitForServerTurn(serverRunId, ended, signal);
    } catch (error) {
      if (!signal?.aborted) throw error;
      // Stop: asked on the server; shown as waiting until the member's
      // device confirms (the approved parity exception).
      await link.enqueue([{ opId: newOpId(), kind: "turn.stop", conversationId: conversation.id, runId: serverRunId, messageId: triggerMessage.id, participantId: participant.id }]);
      await setOnBubble((metadata) => ({ ...metadata, stopPending: { machineName, at: new Date().toISOString() } }));
      turn = await this.chat.serverTurns.waitForServerTurn(serverRunId, ended);
      // Confirmed: whatever the bubble's state now, it no longer waits.
      await this.chat.store.withChatMutation(conversation, async () => {
        for (const message of conversation.messages) {
          if (message.participantId === participant.id && message.metadata?.runId === serverRunId && message.metadata?.stopPending) {
            const { stopPending: _confirmed, ...rest } = message.metadata;
            message.metadata = rest;
          }
        }
        this.chat.store.queueSnapshot(conversation);
      });
    }
    const refreshed = await this.chat.store.requireChat(conversation.id);
    if (turn.state === "stopped" && !turn.executorDeviceId) {
      // Never taken: the placeholder goes, the stop is said once.
      await this.chat.store.withChatMutation(conversation, async () => {
        this.chat.serverPlaceholders.removeServerPlaceholders(conversation, (message) => message.metadata?.runId === bubble.metadata?.runId);
        this.chat.store.queueSnapshot(conversation);
      });
      return [];
    }
    return refreshed.messages.filter((message) => message.participantId === participant.id && message.metadata?.runId === serverRunId && message.status !== "pending");
  }
}
