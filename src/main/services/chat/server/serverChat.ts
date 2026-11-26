import { isSafeChatId } from "../../chatChanges";
import { messageForServer, newOpId, serverSeqOf, sortByServerOrder, turnsOfEffect, type ChatServerLink } from "../../chatServerOps";
import { LOCAL_MESSAGE_METADATA_KEYS, SHARED_CONVERSATION_METADATA_KEYS } from "../../chatChanges";
import type { HubFeedEntry, HubOp, HubTurn } from "../../../../shared/hubOps";
import type { ChatMessage, ChatMessageMetadata, ChatParticipant, Conversation } from "../../../../shared/types";
import { accordClosedLaunchId } from "../../../../shared/accordProgress";
import { normalizeAgentContextUsage } from "../../../../shared/agentContext";
import { updateParticipantContextUsage } from "../compaction/contextUsage";
import { chatParticipants, membersDroppedFrom } from "../members/identity";
import { REPLIES_REPAIRED_KEY } from "../runs/interruptions";
import { markServerTurn } from "../runs/runOwnerRecords";
import { recordLastMessageByParticipant } from "../store/lastMessages";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";
import { normalizedRemovedChatMessageIds } from "../store/messages";

/** What the server accepted, applied to this device's copy of the chat. */
export class ServerChat {
  /** Desktop: a machine said its copy of a project is missing. */
  private machineProjectMissing?: (machineId: string, localPath: string) => Promise<void>;
  /** Reads a chat whole from the server (set with the server link). */
  serverChatReader?: (conversationId: string) => Promise<{ conversation: Conversation; turns: HubTurn[] } | undefined>;
  /** The one-time repair below while it runs (a reconnect may ask again). */
  private repliesRepair?: Promise<void>;

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "autoWatch" | "deletion" | "host" | "list" | "memberMoves" | "members" | "queuedRosterChanges" | "replicatedChats"
      | "serverCardMirrors" | "serverCards" | "serverLink" | "serverPlaceholders" | "serverTurns" | "store"
    >,
    private readonly deps: Pick<ChatDependencies, "cliRunner" | "debugLogs" | "storage">
  ) {}

  setMachineProjectMissingHandler(handler: NonNullable<ServerChat["machineProjectMissing"]>): void {
    this.machineProjectMissing = handler;
  }

  setServerChatReader(reader: ((conversationId: string) => Promise<{ conversation: Conversation; turns: HubTurn[] } | undefined>) | undefined): void {
    this.serverChatReader = reader;
  }

  /** Replaces this device's copy of a chat with the server's (a chat this
   *  device does not hold, one moved to the server, or after the feed
   *  forgot this device's place). Its own bookkeeping on messages stays. */
  async reloadChatFromServer(conversationId: string): Promise<void> {
    const read = await this.serverChatReader?.(conversationId);
    if (!read) {
      if (await this.deps.storage.getConversation(conversationId) && this.serverChatReader) {
        // Gone on the server.
        await this.chat.deletion.applyReplicatedConversationDeletion(conversationId, new Date().toISOString());
      }
      return;
    }
    const server = read.conversation;
    const existing = await this.deps.storage.getConversation(conversationId);
    if (!existing) {
      if (this.chat.host.hostMachineId) this.chat.host.localizeRepoPath(server, server.repoPath);
      for (const turn of read.turns) markServerTurn(server, turn);
      await this.chat.store.saveConversation(server, { emitChanges: false });
      for (const turn of read.turns) this.chat.serverTurns.noteServerTurn(turn);
      return;
    }
    await this.chat.store.withChatMutation(existing, async () => {
      const local = new Map(existing.messages.map((message) => [message.id, message]));
      existing.title = server.title;
      if (this.chat.host.hostMachineId) this.chat.host.localizeRepoPath(existing, server.repoPath);
      else if (server.repoPath) existing.repoPath = server.repoPath; else delete existing.repoPath;
      for (const key of SHARED_CONVERSATION_METADATA_KEYS) {
        const value = (server.metadata as Record<string, unknown>)[key];
        if (value === undefined) delete (existing.metadata as Record<string, unknown>)[key];
        else (existing.metadata as Record<string, unknown>)[key] = value;
      }
      const me = this.chat.serverLink.current?.deviceId();
      const fromServer = new Set(server.messages.map((message) => message.id));
      existing.messages = [
        ...server.messages.map((message) => {
          const mine = local.get(message.id);
          if (!mine) return message;
          const kept: Record<string, unknown> = {};
          for (const key of LOCAL_MESSAGE_METADATA_KEYS) {
            const value = mine.metadata?.[key as keyof ChatMessageMetadata];
            if (value !== undefined && key !== "serverPlaceholder") kept[key] = value;
          }
          return { ...message, metadata: { ...(message.metadata ?? {}), ...kept } as ChatMessage["metadata"] };
        }),
        // What this device wrote and the server has not taken yet stays.
        ...existing.messages.filter((message) => !fromServer.has(message.id) && serverSeqOf(message) === undefined &&
          (message.metadata?.serverPlaceholder || !message.metadata?.serverWriter || message.metadata.serverWriter === me))
      ];
      for (const turn of read.turns) markServerTurn(existing, turn);
      existing.messages = sortByServerOrder(existing.messages);
      existing.updatedAt = server.updatedAt > existing.updatedAt ? server.updatedAt : existing.updatedAt;
      await this.chat.store.saveConversation(existing, { emitChanges: false });
    });
    for (const turn of read.turns) this.chat.serverTurns.noteServerTurn(turn);
  }

  /** Applies what the server accepted (from any device, this one included),
   *  in the server's order, to this device's copy. Stored without being sent
   *  back; then members whose turns were asked here start (Д4). */
  async applyServerEntries(entries: HubFeedEntry[]): Promise<void> {
    const me = this.chat.serverLink.current?.deviceId();
    let index = 0;
    while (index < entries.length) {
      const conversationId = entries[index].conversationId;
      const group: HubFeedEntry[] = [];
      while (index < entries.length && entries[index].conversationId === conversationId) group.push(entries[index++]);
      await this.applyServerEntriesFor(conversationId, group, me);
    }
    for (const entry of entries) {
      for (const turn of turnsOfEffect(entry.effect)) this.chat.serverTurns.noteServerTurn(turn);
    }
    this.chat.serverCards.noteServerCardEntries(entries);
  }

  private async applyServerEntriesFor(conversationId: string, entries: HubFeedEntry[], me: string | undefined): Promise<void> {
    if (!isSafeChatId(conversationId)) return;
    const deletion = entries.find((entry) => entry.effect.kind === "conversation.delete");
    if (deletion) {
      if (await this.deps.storage.getConversation(conversationId)) await this.chat.deletion.applyReplicatedConversationDeletion(conversationId, deletion.acceptedAt);
      return;
    }
    if (await this.deps.storage.conversationTombstones().isDeleted(conversationId)) return;
    // Brought to the server whole (`chat.import`: the one-time move, or a chat
    // imported from a CLI thread): read again once, when its last page is
    // there, by every device; the computer that wrote it too, for the place
    // the server gave its messages (without it a new message would sort
    // above the whole history), as the move reads every chat after it.
    if (entries.some((entry) => entry.effect.kind === "chat.import")) {
      if (entries.some((entry) => entry.effect.kind === "chat.import" && entry.effect.last)) {
        await this.reloadChatFromServer(conversationId);
      }
      return;
    }
    let conversation = await this.deps.storage.getConversation(conversationId);
    if (conversation && conversation.kind !== "chat") return;
    if (!conversation) {
      const create = entries.find((entry) => entry.effect.kind === "conversation.create");
      if (!create || create.effect.kind !== "conversation.create") {
        // A chat this device does not hold: read it whole.
        await this.reloadChatFromServer(conversationId);
        return;
      }
      const fields = create.effect.conversation;
      conversation = {
        id: conversationId,
        title: fields.title,
        kind: "chat",
        createdAt: fields.createdAt,
        updatedAt: create.effect.updatedAt,
        ...(fields.repoPath ? { repoPath: fields.repoPath } : {}),
        messages: [],
        findings: [],
        metadata: { participantSessions: [], warnings: [], running: false, ...fields.metadata } as Conversation["metadata"]
      };
      if (this.chat.host.hostMachineId) this.chat.host.localizeRepoPath(conversation, fields.repoPath);
      await this.chat.store.saveConversation(conversation, { emitChanges: false });
    }
    const target = conversation;
    const dropped: ChatParticipant[] = [];
    let archivedNow = false;
    let previousHomes = new Set<string>();
    await this.chat.store.withChatMutation(target, async () => {
      const before = new Set(target.messages.map((message) => message.id));
      // What the chat was before (members, archive, the User's messages):
      // shallow, since applying replaces entries rather than editing them.
      const previous: Conversation = { ...target, messages: [...target.messages], metadata: { ...target.metadata } };
      previousHomes = new Set(chatParticipants(previous).filter((member) => this.chat.host.runsHere(member)).map((member) => member.id));
      for (const entry of entries) this.applyServerEffect(target, entry, me);
      target.messages = sortByServerOrder(target.messages);
      // A member that watches the chat here sees new User messages the way a
      // local one does: a new one resets its wake chain.
      this.chat.replicatedChats.reconcileReplicatedWatcher(previous, target);
      dropped.push(...membersDroppedFrom(previous, target));
      archivedNow = previous.metadata.archived !== true && target.metadata.archived === true;
      await this.chat.store.saveConversation(target, { emitChanges: false });
    });
    // An approved removal waits for every device's turns in the chat to end:
    // another device's turn may just have ended.
    this.chat.queuedRosterChanges.scheduleQueuedMemberRemovals(conversationId);
    // A member that moved here: turns asked of it while it moved wait on the
    // server, and are this device's now.
    if (this.chat.memberMoves.membersArrivedHere(previousHomes, target)) void this.chat.serverTurns.resumeServerTurns().catch(() => undefined);
    // A member that moved away from this machine: its session here goes.
    if (this.chat.host.machineRuntime) void this.chat.memberMoves.retireMovedMembers(target, previousHomes).catch(() => undefined);
    // A move the computer gave up on after this machine handed the session
    // over: the member's held turns go on here now.
    if (this.chat.host.machineRuntime) {
      const cancelled = entries.flatMap((entry) => entry.effect.kind === "message.create" && entry.deviceId !== me
        ? [entry.effect.message.metadata?.memberMoveCancelled?.participantId].filter((id): id is string => typeof id === "string") : []);
      for (const participantId of cancelled) this.chat.memberMoves.memberMoveGates.get(`${conversationId}:${participantId}`)?.release();
      if (cancelled.length > 0) void this.chat.serverTurns.resumeServerTurns().catch(() => undefined);
    }
    // A session handed to a machine that has since answered as the member.
    if (!this.chat.host.machineRuntime && this.chat.memberMoves.takenSessionHandoffs(target).length > 0) void this.chat.memberMoves.clearTakenSessionHandoffs(target).catch(() => undefined);
    // A member this device runs that the chat no longer has (removed on any
    // device) ends its process here, as a local member's does.
    this.chat.members.retireRemovedMembers(conversationId, dropped);
    // An archived chat closes its members' sessions, wherever it was archived.
    if (archivedNow) await this.deps.cliRunner.closeConversationSessions(conversationId).catch(() => undefined);
    // Switched to the sessions view on another device: its members with
    // rights from the classic view go into their CLI's own mode.
    if (entries.some((entry) => entry.deviceId !== me && entry.effect.kind === "conversation.update" && entry.effect.metadata?.chatView === "sessions")) {
      this.chat.list.convertMembersForSessionsView(conversationId);
    }
    // New messages from other devices are what a watching member reads next.
    if (entries.some((entry) => entry.deviceId !== me && entry.effect.kind === "message.create")) {
      this.chat.autoWatch.scheduleAutoWatchEvaluation(conversationId, "server-messages");
    }
  }

  /** One accepted operation, folded into this device's copy. */
  private applyServerEffect(conversation: Conversation, entry: HubFeedEntry, me: string | undefined): void {
    const effect = entry.effect;
    const fromHere = entry.deviceId === me;
    switch (effect.kind) {
      case "conversation.create":
      case "conversation.update": {
        if (fromHere) return;
        const fields = effect.kind === "conversation.create"
          ? { title: effect.conversation.title, repoPath: effect.conversation.repoPath ?? null, metadata: effect.conversation.metadata, removedMetadataKeys: [] as string[] }
          : { title: effect.title, repoPath: effect.repoPath, metadata: effect.metadata ?? {}, removedMetadataKeys: effect.removedMetadataKeys ?? [] };
        if (fields.title !== undefined) conversation.title = fields.title;
        if (fields.repoPath !== undefined) {
          if (this.chat.host.hostMachineId) this.chat.host.localizeRepoPath(conversation, fields.repoPath ?? undefined);
          else if (fields.repoPath === null) delete conversation.repoPath;
          else conversation.repoPath = fields.repoPath;
        }
        for (const [key, value] of Object.entries(fields.metadata)) (conversation.metadata as Record<string, unknown>)[key] = value;
        for (const key of fields.removedMetadataKeys) delete (conversation.metadata as Record<string, unknown>)[key];
        if (effect.updatedAt > conversation.updatedAt) conversation.updatedAt = effect.updatedAt;
        return;
      }
      case "message.create":
      case "message.update": {
        const incoming = effect.message;
        const removed = new Set(Array.isArray(conversation.metadata.removedChatMessageIds) ? conversation.metadata.removedChatMessageIds : []);
        if (removed.has(incoming.id)) return;
        const index = conversation.messages.findIndex((message) => message.id === incoming.id);
        const existing = index >= 0 ? conversation.messages[index] : undefined;
        let next: ChatMessage;
        if (existing && fromHere && !existing.metadata?.serverPlaceholder) {
          // Written here: what this device holds may be newer; only the
          // server's place and writer are taken.
          next = { ...existing, metadata: { ...(existing.metadata ?? {}), serverSeq: incoming.metadata?.serverSeq, serverWriter: incoming.metadata?.serverWriter } };
        } else {
          const local: Record<string, unknown> = {};
          // What this device showed while the member's turn waited (for its
          // machine, for a Stop to be confirmed) ends with the turn.
          const waitingMarks = incoming.status === "pending" ? [] : ["stopPending", "machinePending", "cloudRunPreparation", "queuedBehind"];
          for (const key of LOCAL_MESSAGE_METADATA_KEYS) {
            const value = existing?.metadata?.[key as keyof ChatMessageMetadata];
            if (value !== undefined && key !== "serverPlaceholder" && !waitingMarks.includes(key)) local[key] = value;
          }
          next = { ...incoming, metadata: { ...(incoming.metadata ?? {}), ...local } as ChatMessage["metadata"] };
        }
        if (index >= 0) conversation.messages[index] = next;
        else {
          // The member's real bubble replaces the placeholder shown for it here.
          const runId = typeof incoming.metadata?.runId === "string" ? incoming.metadata.runId : undefined;
          if (runId && incoming.role === "participant") {
            this.chat.serverPlaceholders.removeServerPlaceholders(conversation, (message) => message.participantId === incoming.participantId && message.metadata?.runId === runId);
          }
          conversation.messages.push(next);
        }
        if (effect.kind === "message.create") {
          for (const turn of effect.turns ?? []) markServerTurn(conversation, turn);
        }
        if (incoming.role === "participant") recordLastMessageByParticipant(conversation, next);
        // A closed Accord's line keeps the chat's place in her list.
        if (incoming.createdAt > conversation.updatedAt && !accordClosedLaunchId(incoming)) conversation.updatedAt = incoming.createdAt;
        const missingCopy = incoming.metadata?.missingProjectCopy;
        if (!fromHere && !this.chat.host.machineRuntime && incoming.role === "participant" && missingCopy
          && typeof missingCopy.machineId === "string" && typeof missingCopy.sourcePath === "string") {
          // Outside the chat's mutation: forgetting saves Settings.
          void this.machineProjectMissing?.(missingCopy.machineId, missingCopy.sourcePath).catch(() => undefined);
        }
        return;
      }
      case "message.react": {
        const index = conversation.messages.findIndex((message) => message.id === effect.messageId);
        if (index < 0) return;
        const metadata = { ...(conversation.messages[index].metadata ?? {}) } as ChatMessageMetadata;
        if (effect.reactions && Object.keys(effect.reactions).length) metadata.reactions = effect.reactions; else delete metadata.reactions;
        conversation.messages[index] = { ...conversation.messages[index], metadata };
        return;
      }
      case "message.remove": {
        const removed = Array.isArray(conversation.metadata.removedChatMessageIds) ? conversation.metadata.removedChatMessageIds : [];
        if (!removed.includes(effect.messageId)) conversation.metadata.removedChatMessageIds = [...removed, effect.messageId].slice(-100);
        conversation.messages = conversation.messages.filter((message) => message.id !== effect.messageId);
        return;
      }
      case "turn.request":
      case "turn.claim":
      case "turn.stop":
      case "turn.finish": {
        markServerTurn(conversation, effect.turn);
        // A member elsewhere: its context use, as its device said after the
        // turn, is shown here as a local member's is.
        const usage = effect.kind === "turn.finish" && effect.turn.contextUsage ? normalizeAgentContextUsage(effect.turn.contextUsage) : undefined;
        const member = usage ? chatParticipants(conversation).find((item) => item.id === effect.turn.participantId) : undefined;
        if (usage && member && !this.chat.host.runsHere(member)) updateParticipantContextUsage(conversation, member.id, usage);
        return;
      }
      case "card.raise":
      case "card.answer":
      case "card.settle":
        // A card of a member elsewhere, as the desktop shows it. Cards this
        // device raised are its own (noteServerCardEntries); a machine shows
        // nothing.
        if (this.chat.host.machineRuntime || effect.card.raisedBy === me) return;
        this.chat.serverCardMirrors.noteMirroredCardSeq(effect.card.cardId, entry.seq);
        this.chat.serverCardMirrors.mirrorServerCard(conversation, effect.kind, effect.card, entry.opId);
        return;
      case "conversation.delete":
      case "chat.import":
        return;
    }
  }

  /** Once on this device (2026-11-22): a member's reply that ended here
   *  while the app quit, after its link to the server had stopped, was saved
   *  here only, and the server kept it running for good (the phone showed it
   *  with its time growing and Stop). Its end as this device holds it goes
   *  now; a reply removed here goes from the server too. Read from the
   *  operations this device still keeps (a week), so older ones stay. Runs
   *  in the background: nothing waits for it. */
  repairRepliesLeftRunningOnce(link: ChatServerLink): void {
    if (this.repliesRepair) return;
    this.repliesRepair = this.repairRepliesLeftRunning(link).catch((error) => {
      void this.deps.debugLogs.write("chat.server.replies-repair-error", { message: error instanceof Error ? error.message : String(error) });
    }).finally(() => { this.repliesRepair = undefined; });
  }

  private async repairRepliesLeftRunning(link: ChatServerLink): Promise<void> {
    const hub = this.deps.storage.hub();
    if (await hub.clientState(REPLIES_REPAIRED_KEY)) return;
    const left = await this.deps.storage.hubClientOps().repliesLeftRunning();
    const byChat = new Map<string, string[]>();
    for (const row of left) byChat.set(row.conversationId, [...(byChat.get(row.conversationId) ?? []), row.messageId]);
    let sent = 0;
    let skipped = 0;
    for (const [conversationId, messageIds] of byChat) {
      if (this.chat.deletion.deletedConversationIds.has(conversationId)) continue;
      const conversation = await this.deps.storage.getConversation(conversationId).catch(() => null);
      if (conversation === null) {
        skipped += 1;
        continue;
      }
      if (!conversation || conversation.kind !== "chat") continue;
      // Through the chat's own queue: a save meanwhile is not overtaken.
      await this.chat.store.withChatMutation(conversation, async () => {
        const removed = new Set(normalizedRemovedChatMessageIds(conversation.metadata.removedChatMessageIds));
        const ops: HubOp[] = [];
        for (const messageId of messageIds) {
          const message = conversation.messages.find((item) => item.id === messageId);
          if (!message) {
            if (removed.has(messageId)) ops.push({ opId: newOpId(), kind: "message.remove", conversationId, messageId });
            continue;
          }
          // Still running here, or not this device's to write: left as it is.
          if (message.status === "pending" || !this.chat.host.mayWriteOnServer(conversation, message)) continue;
          ops.push({ opId: newOpId(), kind: "message.update", conversationId, message: messageForServer(message) });
        }
        if (!ops.length) return;
        await link.enqueue(ops);
        sent += ops.length;
      });
    }
    // A chat that could not be read now is looked at again next time.
    if (!skipped) await hub.setClientState(REPLIES_REPAIRED_KEY, new Date().toISOString());
    void this.deps.debugLogs.write("chat.server.replies-repaired", { found: left.length, sent, skippedChats: skipped });
  }
}
