import { randomUUID } from "node:crypto";
import type { ChatMessage, Conversation, ReviewProgress, SendChatMessageRequest, StartReviewResult } from "../../shared/types";
import {
  chatMessageVisualThreadRootId,
  chatParticipantRequestReplyRootMap
} from "../../shared/chatParticipantRequestThreads";
import { RelayTunnelClient, type RelayTunnelMessage } from "./relayTunnelClient";
import { openMobileRelayPayload, sealMobileRelayPayload } from "./mobileRelaySealing";

type ProgressCallback = (progress: ReviewProgress) => void;

export interface MobileRelayControlOptions {
  relayUrl: string;
  rendezvousId: string;
  relayCapability: string;
  relaySealKeyBase64: string;
  conversationId?: string;
  streamId: string;
  reconnectDelayMs?: number;
  isActive?: () => boolean;
  /** Called when a frame from the phone is decrypted, which proves the device
   *  holds the pairing key. Reading counts, not just sending. */
  onPhoneActivity?: () => void;
}

export interface MobileRelayChatSender {
  sendMessage(
    request: SendChatMessageRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback
  ): Promise<StartReviewResult>;
  hasAcceptedMobileEvent?(conversationId: string, eventId: string): Promise<boolean>;
  hasMobileMailboxResultForMobileEvent?(conversationId: string, eventId: string): Promise<boolean>;
  tryAcquireMobileEventExecution?(event: MobileOutboxEvent, runId: string): Promise<boolean>;
}

export interface MobileRelayAcceptedResult {
  eventIds: string[];
  runIds: string[];
}

interface MobileRelayAcceptedDetail extends MobileRelayAcceptedResult {
  outboxEvents: Array<{
    event: MobileOutboxEvent;
    runId: string;
  }>;
  runningBatches: MobileTimelineEvents[];
}

export interface MobileRelayChatListItem {
  id: string;
  title: string;
  group: string;
  snippet: string;
  who?: string;
  updatedAt: string;
  running: boolean;
  participants: string[];
  members?: MobileRelayChatMember[];
}

export interface MobileRelayChatMember {
  id: string;
  handle: string;
  mentionHandle: string;
  displayName: string;
  roleLabel: string;
  kind: "claude-code" | "codex-cli" | "gemini-cli";
  avatarId?: string;
}

export interface MobileRelayChatCatalog {
  listChats(): Promise<MobileRelayChatListItem[]>;
  listTimeline(conversationId: string): Promise<MobileTimelineEvent[]>;
  isConversationAllowed?(conversationId: string): Promise<boolean> | boolean;
}

interface MobileOutboxRequest {
  type: "mobile.outbox.events";
  events: MobileOutboxEvent[];
}

export interface MobileOutboxEvent {
  eventId: string;
  conversationId: string;
  createdAt?: string;
  payload: {
    content: string;
  };
}

interface MobileOutboxAck {
  type: "mobile.outbox.ack";
  ackRole: "desktop";
  eventIds: string[];
  runIds: string[];
}

interface MobileTimelineEvent {
  id: string;
  role: "you" | "participant" | "system";
  participantLabel?: string;
  content: string;
  status: "pending" | "done" | "error";
  createdAt: string;
  runId?: string;
  messageId?: string;
  mobileEventId?: string;
  /** Id of the message this one is filed under, so the phone can collapse
   *  replies exactly the way the desktop does. Absent on main-timeline rows. */
  threadRootId?: string;
}

export interface MobileTimelineEvents {
  type: "mobile.timeline.events";
  conversationId?: string;
  events: MobileTimelineEvent[];
}

export interface MobileTimelineSink {
  publishTimeline(timeline: MobileTimelineEvents, options?: MobileTimelinePublishOptions): Promise<void>;
}

export interface MobileTimelinePublishOptions {
  /** W-C: this batch carries a run's terminal snapshot, so the relay should
   *  ring. Only the terminal-progress path sets it. It is stated by the caller
   *  that knows a run finished rather than inferred from batch contents: a
   *  conversation snapshot is full of finished messages and a phone-originated
   *  user message carries the run's own id, so inference rings at the start of
   *  a run as well as the end. */
  runFinished?: boolean;
  /** Also mark the batch when the events that actually go out — after
   *  already-delivered ones are dropped — include a participant message that
   *  has stopped being pending. The run-state transition alone is not enough:
   *  the finished answer is published about a second BEFORE the run leaves the
   *  active set, so by the time the transition is observed there is nothing
   *  left to send and the marker rides an empty batch that is never appended. */
  markTerminalParticipant?: boolean;
  /** W-M(d): send this batch to the live socket only, never to the durable
   *  sink. Partial reply text is for someone watching right now; persisting it
   *  would re-append the whole growing answer to the mailbox on every flush. */
  liveOnly?: boolean;
}

interface MobileChatListRequest {
  type: "mobile.chat-list.request";
}

interface MobileTimelineRequest {
  type: "mobile.timeline.request";
  conversationId: string;
}

interface MobileChatListResponse {
  type: "mobile.chat-list";
  chats: MobileRelayChatListItem[];
}

export class MobileRelayControlService {
  private readonly client: RelayTunnelClient;
  private readonly abortController = new AbortController();
  private connected = false;
  private readonly lastTimelineSignatureById = new Map<string, string>();
  private readonly ackedRunIds = new Set<string>();
  private readonly lastActiveRunIdsByConversation = new Map<string, Set<string>>();
  /** W-C: runs already announced as finished. The content arm below sees the
   *  same terminal message twice — once as the terminal progress batch, then
   *  again inside the conversation snapshot that follows a second later, with a
   *  different projection and therefore a different delivery signature, so the
   *  already-delivered filter does not stop it. Announcing a run once is what
   *  makes "one notification per finished run" true. */
  private readonly announcedFinishedRunIds = new Set<string>();
  /** W-C diagnostics: set by the owner to record every snapshot decision. */
  onSnapshotDiagnostic?: (detail: {
    conversationId: string;
    runFinished: boolean;
    activeRunIds: string[];
    running: boolean;
  }) => void;
  /** Live-channel diagnostics: what the live path actually did with a
   *  live-only batch — sent it, or skipped it because the tunnel was down.
   *  Without this, dropped live frames are indistinguishable from a healthy
   *  idle channel. */
  onLiveDiagnostic?: (detail: {
    kind: "sent" | "skipped-disconnected" | "empty-after-dedup" | "no-content";
    logicalMessageId: string;
    events: number;
    bytes: number;
    rendezvousId: string;
  }) => void;
  private readonly queuedProgressByRunId = new Map<string, ReviewProgress[]>();
  private readonly conversationIdByRunId = new Map<string, string>();
  private readonly runStartedAtByRunId = new Map<string, string>();
  private readonly acceptedMobileEventKeys = new Set<string>();
  private readonly acceptingMobileEventKeys = new Set<string>();

  constructor(
    private readonly options: MobileRelayControlOptions,
    private readonly chat: MobileRelayChatSender,
    private readonly catalog?: MobileRelayChatCatalog,
    private readonly progress?: ProgressCallback,
    private readonly timelineSink?: MobileTimelineSink
  ) {
    this.client = new RelayTunnelClient({
      relayUrl: options.relayUrl,
      rendezvousId: options.rendezvousId,
      role: "desktop",
      capability: options.relayCapability,
      streamId: options.streamId,
      reconnectDelayMs: options.reconnectDelayMs
    });
    this.client.on("message", (message) => {
      // A malformed or undecryptable frame (rendezvous id and capability are
      // visible to the relay operator) must never escape as an
      // unhandledRejection: the process-level handler shows an error box and
      // quits when the window is closed, which is exactly when background phone
      // control is the only thing running.
      void this.handleMessage(message).catch((error) => {
        console.error("Mobile relay message handling failed:", error instanceof Error ? error.message : error);
      });
    });
    // Without a listener the tunnel's errors — including the close reason the
    // relay states when it refuses or evicts this connection — vanish, and a
    // reconnect loop looks like silence.
    this.client.on("error", (error) => {
      console.error("Mobile relay tunnel error:", error.message);
    });
    // connected must follow the tunnel, not the first dial. connect() setting
    // it once meant a failed first dial left it false forever while the
    // background loop held a perfectly good socket — and every live frame was
    // then silently skipped, with all durable paths still working: streaming
    // dead, everything else green.
    this.client.on("state", (state) => {
      this.connected = state === "connected";
    });
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    await this.client.connect();
    this.connected = true;
  }

  close(): void {
    this.abortController.abort();
    this.client.close();
    this.connected = false;
  }

  /** W-C: publishes an interrupted run's recovered terminals as their own
   *  marked batch. It cannot ride a conversation snapshot: recovery runs at
   *  process start, where the snapshot path deliberately stays silent because
   *  it is delivering the whole history at once. */
  pushRecoveredRunTerminals(conversation: Conversation, messages: ChatMessage[]): void {
    if (!this.isActive() || messages.length === 0) {
      return;
    }
    const threadRoots = chatParticipantRequestReplyRootMap(conversation);
    const events = messages
      .filter((message) => Boolean(message.content.trim()))
      .map((message) => timelineEventFromMessage(message, message.id, conversation, threadRoots));
    if (events.length === 0) {
      return;
    }
    // Deliberately does NOT touch lastActiveRunIdsByConversation: the recovery
    // batch carries its own explicit marker and never consults that map, while
    // warming it would flip the next snapshot out of first-delivery silence and
    // ring again on the cold history recovery's own save pushes.
    void this.sendTimelineBatch(
      `timeline:${conversation.id}:recovered:${conversation.updatedAt}`,
      { type: "mobile.timeline.events", conversationId: conversation.id, events },
      { runFinished: true }
    ).catch(() => {
      // Recovery is best effort; the phone also reconciles on its next open.
    });
  }

  /** W-M: progress for a run started on the desktop. Its progress never reaches
   *  this service otherwise — the phone would see one placeholder at the start
   *  and nothing again until the answer landed, so there is nothing to watch.
   *  Published live-only: it is the growing reply, not a record. */
  noteExternalChatProgress(progress: ReviewProgress): void {
    // Scoped to the pairing's own conversation: a control never publishes text
    // from a conversation this phone was not paired to.
    // A pairing scoped to the whole workspace has no single conversationId, so
    // requiring one here turned streaming off entirely for that pairing shape.
    const conversationId = this.conversationIdByRunId.get(progress.runId) ?? this.options.conversationId;
    if (!this.isActive() || !progress.agentProgress) {
      return;
    }
    if (conversationId && !this.conversationIdByRunId.has(progress.runId)) {
      this.conversationIdByRunId.set(progress.runId, conversationId);
    }
    if (!this.runStartedAtByRunId.has(progress.runId)) {
      this.runStartedAtByRunId.set(progress.runId, progress.createdAt);
    }
    // Only the live text: the finish is announced by the paths that own it.
    if (MobileRelayControlService.isTerminalProgress(progress)) {
      return;
    }
    void this.sendTimelineProgress(progress, { liveOnly: true }).catch(() => {
      // Watching is best effort; the timeline itself is unaffected.
    });
  }

  pushConversationSnapshot(conversation: Conversation): void {
    if (!this.isActive()) {
      return;
    }
    // Computed here, not inside the async publish: snapshots arrive in order
    // but publish concurrently, and a later one must not observe an earlier
    // one's active-run set.
    const { runFinished, seenBefore } = this.snapshotFinishesRun(conversation);
    this.onSnapshotDiagnostic?.({
      conversationId: conversation.id,
      runFinished,
      activeRunIds: Array.isArray((conversation.metadata as { activeRunIds?: unknown }).activeRunIds)
        ? ((conversation.metadata as { activeRunIds?: string[] }).activeRunIds ?? [])
        : [],
      running: (conversation.metadata as { running?: unknown }).running === true
    });
    void this.sendConversationSnapshot(conversation, runFinished, seenBefore).catch(() => {
      // The phone may have gone away; durable sync remains the source of truth.
    });
  }

  async acceptSealedMobileOutbox(ciphertext: string): Promise<MobileRelayAcceptedResult> {
    if (!this.isActive()) {
      return emptyAcceptedResult();
    }
    const accepted = await this.prepareMobileOutboxRequest(assertMobileOutboxRequest(
      await openMobileRelayPayload(ciphertext, this.options.relaySealKeyBase64)
    ));
    await this.deliverAcceptedOutboxEvents("direct", accepted);
    return {
      eventIds: accepted.eventIds,
      runIds: accepted.runIds
    };
  }

  async acceptMobileOutboxEvents(
    events: MobileOutboxEvent[],
    logicalMessageId: string = "mailbox"
  ): Promise<MobileRelayAcceptedResult> {
    if (!this.isActive()) {
      return emptyAcceptedResult();
    }
    const accepted = await this.prepareMobileOutboxRequest(assertMobileOutboxRequest({
      type: "mobile.outbox.events",
      events
    }));
    this.markRunIdsAcked(accepted.runIds);
    await this.sendAcceptedRunningBatches(logicalMessageId, accepted).catch(() => {
      // The phone may be offline; mailbox timeline publication remains best-effort.
    });
    await this.deliverAcceptedOutboxEvents(logicalMessageId, accepted);
    return {
      eventIds: accepted.eventIds,
      runIds: accepted.runIds
    };
  }

  private async handleMessage(message: RelayTunnelMessage): Promise<void> {
    if (!this.isActive()) {
      return;
    }
    const payload = await openMobileRelayPayload<unknown>(message.ciphertext, this.options.relaySealKeyBase64);
    this.options.onPhoneActivity?.();
    if (isMobileChatListRequest(payload)) {
      await this.sendChatList(`${message.logicalMessageId}:chat-list`);
      return;
    }
    if (isMobileTimelineRequest(payload)) {
      await this.sendConversationTimeline(payload.conversationId, `${message.logicalMessageId}:timeline`);
      return;
    }
    const accepted = await this.prepareMobileOutboxRequest(assertMobileOutboxRequest(payload));
    await this.sendAck(message.logicalMessageId, accepted);
    this.markRunIdsAcked(accepted.runIds);
    await this.sendAcceptedRunningBatches(message.logicalMessageId, accepted).catch(() => {
      // The phone may have gone away after ack; durable sync remains the source of truth.
    });
    void this.deliverAcceptedOutboxEvents(message.logicalMessageId, accepted).catch(() => {
      // The phone may have gone away after ack; durable sync remains the source of truth.
    });
  }

  private async prepareMobileOutboxRequest(request: MobileOutboxRequest): Promise<MobileRelayAcceptedDetail> {
    const eventIds: string[] = [];
    const runIds: string[] = [];
    const outboxEvents: MobileRelayAcceptedDetail["outboxEvents"] = [];
    const runningBatches: MobileTimelineEvents[] = [];
    for (const event of request.events) {
      if (!(await this.isConversationAllowed(event.conversationId))) {
        throw new Error("Mobile relay event conversationId is outside the paired scope.");
      }
      const runId = `mobile-${event.eventId || randomUUID()}`;
      const mobileEventKey = mobileEventScopeKey(event.conversationId, event.eventId);
      eventIds.push(event.eventId);
      runIds.push(runId);
      if (this.acceptedMobileEventKeys.has(mobileEventKey) || this.acceptingMobileEventKeys.has(mobileEventKey)) {
        continue;
      }
      this.acceptingMobileEventKeys.add(mobileEventKey);
      try {
        if (await this.mobileEventIsAlreadyHandled(event)) {
          this.acceptedMobileEventKeys.add(mobileEventKey);
          continue;
        }
        if (this.chat.tryAcquireMobileEventExecution && !await this.chat.tryAcquireMobileEventExecution(event, runId)) {
          this.acceptedMobileEventKeys.add(mobileEventKey);
          continue;
        }
        this.acceptedMobileEventKeys.add(mobileEventKey);
        this.conversationIdByRunId.set(runId, event.conversationId);
        this.runStartedAtByRunId.set(runId, event.createdAt ?? new Date().toISOString());
        runningBatches.push({
          type: "mobile.timeline.events",
          conversationId: event.conversationId,
          events: [runningTimelineEventForOutbox(event, runId)]
        });
        outboxEvents.push({ event, runId });
      } finally {
        this.acceptingMobileEventKeys.delete(mobileEventKey);
      }
    }
    return { eventIds, runIds, outboxEvents, runningBatches };
  }

  private async deliverAcceptedOutboxEvents(
    logicalMessageId: string,
    accepted: MobileRelayAcceptedDetail
  ): Promise<void> {
    for (const [index, item] of accepted.outboxEvents.entries()) {
      try {
        if (await this.mobileEventIsAlreadyHandled(item.event)) {
          continue;
        }
        const result = await this.chat.sendMessage(
          {
            conversationId: item.event.conversationId,
            content: item.event.payload.content,
            runId: item.runId,
            mobileEventId: item.event.eventId
          },
          this.abortController.signal,
          (progress) => this.handleChatProgress(progress)
        );
        const events = timelineEventsFromConversation(result.conversation);
        if (events.length > 0) {
          await this.sendTimelineBatch(`${logicalMessageId}:timeline:${index}`, {
            type: "mobile.timeline.events",
            conversationId: item.event.conversationId,
            events
          });
        }
      } catch (error) {
        // A throw means no terminal progress ever arrived, so this batch is the
        // only thing that says the run is over. The completed-result batch
        // above is deliberately NOT marked: for a run that finishes normally
        // the terminal-progress snapshot already rang, and marking both would
        // ring twice for one run.
        await this.sendTimelineBatch(`${logicalMessageId}:error:${index}`, {
          type: "mobile.timeline.events",
          conversationId: item.event.conversationId,
          events: [errorTimelineEventForOutbox(item.event, item.runId, error)]
        }, { runFinished: true });
      }
    }
    await this.flushQueuedProgress(accepted.runIds);
  }

  private async isConversationAllowed(conversationId: string): Promise<boolean> {
    if (this.options.conversationId) {
      return conversationId === this.options.conversationId;
    }
    if (this.catalog?.isConversationAllowed) {
      return this.catalog.isConversationAllowed(conversationId);
    }
    return true;
  }

  private async sendAck(logicalMessageId: string, accepted: MobileRelayAcceptedResult): Promise<void> {
    const ack = await sealMobileRelayPayload({
      type: "mobile.outbox.ack",
      ackRole: "desktop",
      eventIds: accepted.eventIds,
      runIds: accepted.runIds
    } satisfies MobileOutboxAck, this.options.relaySealKeyBase64);
    await this.client.sendCiphertext({
      logicalMessageId: `${logicalMessageId}:ack`,
      ciphertext: ack
    });
  }

  private async sendChatList(logicalMessageId: string): Promise<void> {
    if (!this.isActive()) {
      return;
    }
    const chats = this.catalog ? await this.catalog.listChats() : [];
    const response: MobileChatListResponse = {
      type: "mobile.chat-list",
      chats: this.options.conversationId
        ? chats.filter((chat) => chat.id === this.options.conversationId)
        : chats
    };
    const ciphertext = await sealMobileRelayPayload(response, this.options.relaySealKeyBase64);
    await this.client.sendCiphertext({ logicalMessageId, ciphertext });
  }

  private async sendConversationTimeline(conversationId: string, logicalMessageId: string): Promise<void> {
    if (!this.isActive()) {
      return;
    }
    if (!(await this.isConversationAllowed(conversationId))) {
      throw new Error("Mobile relay timeline request is outside the paired scope.");
    }
    const timeline: MobileTimelineEvents = {
      type: "mobile.timeline.events",
      conversationId,
      events: this.catalog ? await this.catalog.listTimeline(conversationId) : []
    };
    const ciphertext = await sealMobileRelayPayload(timeline, this.options.relaySealKeyBase64);
    await this.client.sendCiphertext({ logicalMessageId, ciphertext });
  }

  /** W-C: a desktop-originated run never reaches the terminal-progress path
   *  here — its progress goes to the desktop window, and the phone learns of it
   *  through conversation snapshots. The end of such a run is exactly the
   *  moment the conversation stops having an active run it previously had, so
   *  that transition is what states the marker. This is knowledge the snapshot
   *  carries about run state, not an inference from message contents. */
  private snapshotFinishesRun(conversation: Conversation): { runFinished: boolean; seenBefore: boolean } {
    const metadata = conversation.metadata as { activeRunIds?: unknown; running?: unknown };
    const active = new Set(
      (Array.isArray(metadata.activeRunIds) ? metadata.activeRunIds : [])
        .filter((runId): runId is string => typeof runId === "string" && runId.trim().length > 0)
    );
    const previous = this.lastActiveRunIdsByConversation.get(conversation.id);
    this.lastActiveRunIdsByConversation.set(conversation.id, active);
    if (previous === undefined) {
      // First snapshot for this conversation since the process started: there
      // is no transition to observe, and the whole history is about to be
      // delivered at once, so nothing here may ring.
      return { runFinished: false, seenBefore: false };
    }
    for (const runId of previous) {
      if (!active.has(runId)) {
        return { runFinished: true, seenBefore: true };
      }
    }
    return { runFinished: false, seenBefore: true };
  }

  private async sendConversationSnapshot(
    conversation: Conversation,
    runFinished = false,
    seenBefore = false
  ): Promise<void> {
    if (!this.isActive()) {
      return;
    }
    if (!(await this.isConversationAllowed(conversation.id))) {
      return;
    }
    const events = timelineEventsFromSnapshot(conversation);
    if (events.length === 0) {
      return;
    }
    await this.sendTimelineBatch(`timeline:${conversation.id}:snapshot:${conversation.updatedAt}`, {
      type: "mobile.timeline.events",
      conversationId: conversation.id,
      events
    }, { runFinished, markTerminalParticipant: seenBefore });
  }

  private async sendAcceptedRunningBatches(
    logicalMessageId: string,
    accepted: MobileRelayAcceptedDetail
  ): Promise<void> {
    for (const [index, batch] of accepted.runningBatches.entries()) {
      await this.sendTimelineBatch(`${logicalMessageId}:running:${index}`, batch);
    }
  }

  private async mobileEventIsAlreadyHandled(event: MobileOutboxEvent): Promise<boolean> {
    return await this.chat.hasAcceptedMobileEvent?.(event.conversationId, event.eventId) === true ||
      await this.chat.hasMobileMailboxResultForMobileEvent?.(event.conversationId, event.eventId) === true;
  }

  private handleChatProgress(progress: ReviewProgress): void {
    this.progress?.(progress);
    if (!this.ackedRunIds.has(progress.runId)) {
      this.queuedProgressByRunId.set(progress.runId, [
        ...(this.queuedProgressByRunId.get(progress.runId) ?? []),
        progress
      ]);
      return;
    }
    void this.sendTimelineProgressUpdate(progress).catch(() => {
      // The phone may have gone away after ack; durable sync remains the source of truth.
    });
  }

  private markRunIdsAcked(runIds: string[]): void {
    for (const runId of runIds) {
      this.ackedRunIds.add(runId);
    }
  }

  private async flushQueuedProgress(runIds: string[]): Promise<void> {
    for (const runId of runIds) {
      const queued = this.queuedProgressByRunId.get(runId) ?? [];
      this.queuedProgressByRunId.delete(runId);
      for (const progress of queued) {
        await this.sendTimelineProgressUpdate(progress).catch(() => {
          // The phone may have gone away after ack; durable sync remains the source of truth.
        });
      }
    }
  }

  private async sendTimelineProgressUpdate(progress: ReviewProgress): Promise<void> {
    await this.sendTimelineProgress(progress);
    await this.sendConversationSnapshotForTerminalProgress(progress);
  }

  private static isTerminalProgress(progress: ReviewProgress): boolean {
    return progress.phase === "done" ||
      progress.phase === "error" ||
      progress.agentProgress?.state === "finished";
  }

  private async sendTimelineProgress(
    progress: ReviewProgress,
    extra?: MobileTimelinePublishOptions
  ): Promise<void> {
    const agent = progress.agentProgress;
    // W-M(d): partial reply text is for someone watching live. The durable
    // copy of a PENDING row — timeline store and mailbox — carries only the
    // activity label; persisting the growing answer re-appended it
    // cumulatively on every flush. A terminal tick's text is not partial —
    // it is the finish, and the ring rides the batch that carries it — so
    // terminals keep their content on every channel.
    const keepText = extra?.liveOnly === true || MobileRelayControlService.isTerminalProgress(progress);
    const content = (keepText ? agent?.partialContent?.trim() : undefined) ||
      agent?.remoteRunStatus?.label?.trim() ||
      agent?.activity?.trim();
    if (!agent || !content) {
      if (extra?.liveOnly === true) {
        this.onLiveDiagnostic?.({ kind: "no-content", logicalMessageId: `progress:${progress.runId}`, events: 0, bytes: 0, rendezvousId: this.options.rendezvousId });
      }
      return;
    }
    const id = agent.messageId?.trim() ||
      `${progress.runId}:${agent.participantId ?? agent.participantLabel}`;
    const conversationId = this.conversationIdByRunId.get(progress.runId) ?? this.options.conversationId;
    const timeline: MobileTimelineEvents = {
      type: "mobile.timeline.events",
      ...(conversationId ? { conversationId } : {}),
      events: [{
        id,
        role: "participant",
        participantLabel: agent.participantLabel,
        content,
        status: agent.state === "finished" ? "done" : "pending",
        createdAt: progress.createdAt,
        runId: progress.runId,
        ...(agent.messageId ? { messageId: agent.messageId } : {}),
        ...(agent.mobileEventId ? { mobileEventId: agent.mobileEventId } : {})
      }]
    };
    // W-C: this is the batch that carries the finish for a phone-originated
    // run. Marking the catalog re-projection below instead made the ring depend
    // on whether the projection happened to differ from this event: identical,
    // and the marked batch dedups empty and never rings; different, and a later
    // snapshot can ring a second time.
    if (MobileRelayControlService.isTerminalProgress(progress)) {
      // Announced here so the conversation snapshot that follows — carrying the
      // same message with a different projection — cannot ring for it again.
      this.announcedFinishedRunIds.add(progress.runId);
    }
    await this.sendTimelineBatch(
      `timeline:${id}:${progress.createdAt}`,
      timeline,
      { ...extra, runFinished: MobileRelayControlService.isTerminalProgress(progress) }
    );
  }

  /** Test seam: the terminal re-projection is the batch that re-stamped live
   *  rows, so it has to be drivable directly. */
  async publishTerminalReprojectionForTest(progress: ReviewProgress): Promise<void> {
    await this.sendConversationSnapshotForTerminalProgress(progress);
  }

  private async sendConversationSnapshotForTerminalProgress(progress: ReviewProgress): Promise<void> {
    const terminal = MobileRelayControlService.isTerminalProgress(progress);
    if (!terminal || !this.catalog) {
      return;
    }
    const conversationId = this.conversationIdByRunId.get(progress.runId) ?? this.options.conversationId;
    if (!conversationId) {
      return;
    }
    const startedAt = this.runStartedAtByRunId.get(progress.runId);
    const events = (await this.catalog.listTimeline(conversationId))
      .filter((event) => !startedAt || timelineEventAtOrAfter(event.createdAt, startedAt))
      .slice(-40)
      .map((event) => ({
        ...event,
        // W-N/W-M: stamp ONLY events that have no run of their own. Claiming
        // every participant row for the finishing run tagged another run's
        // still-live row as belonging to a run that just ended — and the phone
        // drops a pending row whose run is already terminal. That is the
        // "Thinking appears for a second and vanishes" the user kept seeing:
        // any run finishing anywhere in the conversation killed the live one.
        ...(!event.runId && (event.role === "participant" || event.role === "system")
          ? { runId: progress.runId }
          : {})
      }));
    if (events.length === 0) {
      return;
    }
    // Deliberately unmarked: sendTimelineProgress above already carried the
    // finish. This re-projection exists to reconcile the phone's view, and
    // marking it too would ring a second time whenever it survives the
    // already-delivered filter.
    await this.sendTimelineBatch(`timeline:${conversationId}:${progress.runId}:snapshot:${progress.createdAt}`, {
      type: "mobile.timeline.events",
      conversationId,
      events
    });
  }

  private async sendTimelineBatch(
    logicalMessageId: string,
    timeline: MobileTimelineEvents,
    options?: MobileTimelinePublishOptions
  ): Promise<void> {
    if (!this.isActive()) {
      return;
    }
    const events = timeline.events.filter((event) => {
      const id = event.messageId?.trim() || event.id;
      const signature = timelineEventDeliverySignature(event);
      if (this.lastTimelineSignatureById.get(id) === signature) {
        return false;
      }
      this.lastTimelineSignatureById.set(id, signature);
      return true;
    });
    if (events.length === 0) {
      if (options?.liveOnly === true) {
        this.onLiveDiagnostic?.({ kind: "empty-after-dedup", logicalMessageId, events: 0, bytes: 0, rendezvousId: this.options.rendezvousId });
      }
      return;
    }
    const ciphertext = await sealMobileRelayPayload({
      ...timeline,
      events
    }, this.options.relaySealKeyBase64);
    if (this.timelineSink && options?.liveOnly !== true) {
      const newlyFinishedRunIds = options?.markTerminalParticipant === true
        ? events
          .filter((event) =>
            event.role === "participant" &&
            typeof event.status === "string" &&
            event.status !== "pending" &&
            typeof event.runId === "string" &&
            event.runId.trim().length > 0 &&
            !this.announcedFinishedRunIds.has(event.runId))
          .map((event) => event.runId as string)
        : [];
      for (const runId of newlyFinishedRunIds) {
        this.announcedFinishedRunIds.add(runId);
      }
      const runFinished = options?.runFinished === true || newlyFinishedRunIds.length > 0;
      await this.timelineSink.publishTimeline({
        ...timeline,
        events
      }, { ...options, runFinished }).catch(() => {
        // Relay delivery should not fail merely because durable timeline sync is temporarily unavailable.
      });
    }
    if (!this.connected) {
      if (options?.liveOnly === true) {
        this.onLiveDiagnostic?.({ kind: "skipped-disconnected", logicalMessageId, events: events.length, bytes: ciphertext.length, rendezvousId: this.options.rendezvousId });
      }
      return;
    }
    await this.client.sendCiphertext({ logicalMessageId, ciphertext });
    if (options?.liveOnly === true) {
      this.onLiveDiagnostic?.({ kind: "sent", logicalMessageId, events: events.length, bytes: ciphertext.length, rendezvousId: this.options.rendezvousId });
    }
  }

  private isActive(): boolean {
    return this.options.isActive?.() !== false;
  }
}

function emptyAcceptedResult(): MobileRelayAcceptedResult {
  return { eventIds: [], runIds: [] };
}

function timelineEventDeliverySignature(event: MobileTimelineEvent): string {
  return JSON.stringify({
    role: event.role,
    participantLabel: event.participantLabel ?? "",
    content: event.content,
    status: event.status,
    runId: event.runId ?? ""
  });
}

function isMobileChatListRequest(value: unknown): value is MobileChatListRequest {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    (value as Partial<MobileChatListRequest>).type === "mobile.chat-list.request");
}

function isMobileTimelineRequest(value: unknown): value is MobileTimelineRequest {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    (value as Partial<MobileTimelineRequest>).type === "mobile.timeline.request" &&
    typeof (value as Partial<MobileTimelineRequest>).conversationId === "string" &&
    (value as Partial<MobileTimelineRequest>).conversationId?.trim());
}

function assertMobileOutboxRequest(value: unknown): MobileOutboxRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mobile relay request must be an object.");
  }
  const request = value as Partial<MobileOutboxRequest>;
  if (request.type !== "mobile.outbox.events" || !Array.isArray(request.events)) {
    throw new Error("Mobile relay request must contain mobile.outbox.events.");
  }
  if (request.events.length === 0) {
    throw new Error("Mobile relay request must contain at least one event.");
  }
  for (const event of request.events) {
    assertMobileOutboxEvent(event);
  }
  return request as MobileOutboxRequest;
}

function assertMobileOutboxEvent(value: unknown): asserts value is MobileOutboxEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mobile relay outbox event must be an object.");
  }
  const event = value as Partial<MobileOutboxEvent>;
  assertNonEmptyString(event.eventId, "eventId");
  assertNonEmptyString(event.conversationId, "conversationId");
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new Error("Mobile relay outbox event requires payload.");
  }
  assertNonEmptyString((event.payload as Partial<MobileOutboxEvent["payload"]>).content, "payload.content");
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Mobile relay outbox event requires ${label}.`);
  }
}

function mobileEventScopeKey(conversationId: string, eventId: string): string {
  return `${conversationId}\0${eventId}`;
}

function timelineEventsFromConversation(conversation: Conversation): MobileTimelineEvent[] {
  const threadRoots = chatParticipantRequestReplyRootMap(conversation);
  return conversation.messages
    .filter((message) => message.role !== "summary" && message.role !== "user" && Boolean(message.content.trim()))
    .slice(-40)
    // Each message falls back to its OWN id, never to the sending run's. Lending
    // one run's identity to forty unrelated history rows made every one of them
    // look like that run's terminal, and the phone deletes a pending row when
    // its run terminates — which is what killed the in-progress row about a
    // second after it appeared. It also desynchronised the delivery signatures
    // this projection shares with the snapshot projection, so the two took
    // turns re-delivering the whole history to each other.
    .map((message) => timelineEventFromMessage(message, message.id, conversation, threadRoots));
}

function timelineEventsFromSnapshot(conversation: Conversation): MobileTimelineEvent[] {
  const threadRoots = chatParticipantRequestReplyRootMap(conversation);
  return conversation.messages
    .filter((message) => message.role !== "summary" && Boolean(message.content.trim()))
    .slice(-40)
    .map((message) => timelineEventFromMessage(message, message.id, conversation, threadRoots));
}

function timelineEventFromMessage(
  message: ChatMessage,
  fallbackRunId: string,
  conversation?: Conversation,
  threadRoots?: ReturnType<typeof chatParticipantRequestReplyRootMap>
): MobileTimelineEvent {
  const runId = typeof message.metadata?.runId === "string" ? message.metadata.runId : fallbackRunId;
  const mobileEventId = mobileEventIdFromMessage(message, runId) ?? mobileEventIdFromSourceMessage(message, conversation);
  // Same helper the desktop renders with, so the two cannot drift apart.
  const threadRootId = conversation
    ? chatMessageVisualThreadRootId(conversation, message, threadRoots)
    : undefined;
  return {
    id: message.id,
    ...(threadRootId && threadRootId !== message.id ? { threadRootId } : {}),
    role: message.role === "participant" ? "participant" : message.role === "system" ? "system" : "you",
    ...(message.participantLabel ? { participantLabel: message.participantLabel } : {}),
    content: message.content,
    status: message.status ?? "done",
    createdAt: message.createdAt,
    runId,
    messageId: message.id,
    ...(mobileEventId ? { mobileEventId } : {})
  };
}

function mobileEventIdFromMessage(message: ChatMessage, runId: string): string | undefined {
  const explicit = message.metadata?.mobileEventId;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  const sourceMessageId = message.metadata?.sourceMessageId;
  if (typeof sourceMessageId === "string" && sourceMessageId.trim() && runId === `mobile-${sourceMessageId.trim()}`) {
    return sourceMessageId.trim();
  }
  return undefined;
}

/** A participant answer to a phone-sent message runs under a fresh fan-out
 *  run id the phone has never heard of, while the phone's in-progress
 *  placeholder row is keyed by the ingest run (`mobile-<eventId>`) and the
 *  mobile event id. The answer's terminal must therefore carry the source
 *  message's mobile event id, or the placeholder outlives the answer — a
 *  "Thinking" row that never clears. Terminals only: a pending event
 *  carrying the id would let the phone's superseded-pending filter eat the
 *  live row it belongs to. */
function mobileEventIdFromSourceMessage(message: ChatMessage, conversation?: Conversation): string | undefined {
  if (message.role !== "participant" || (message.status ?? "done") === "pending" || !conversation) {
    return undefined;
  }
  const sourceMessageId = typeof message.metadata?.sourceMessageId === "string" ? message.metadata.sourceMessageId.trim() : "";
  if (!sourceMessageId) {
    return undefined;
  }
  const source = conversation.messages.find((candidate) => candidate.id === sourceMessageId);
  if (!source) {
    return undefined;
  }
  const sourceRunId = typeof source.metadata?.runId === "string" ? source.metadata.runId : "";
  return mobileEventIdFromMessage(source, sourceRunId);
}

function timelineEventAtOrAfter(eventCreatedAt: string, startedAt: string): boolean {
  const eventTime = Date.parse(eventCreatedAt);
  const startTime = Date.parse(startedAt);
  if (!Number.isFinite(eventTime) || !Number.isFinite(startTime)) {
    return eventCreatedAt >= startedAt;
  }
  return eventTime >= startTime;
}

function runningTimelineEventForOutbox(event: MobileOutboxEvent, runId: string): MobileTimelineEvent {
  const participantLabel = participantLabelFromContent(event.payload.content);
  const id = `${runId}:${participantLabel ?? "participant"}`;
  return {
    id,
    role: "participant",
    ...(participantLabel ? { participantLabel } : {}),
    content: participantLabel ? `${participantLabel} is running...` : "Running...",
    status: "pending",
    createdAt: nextTimelineCreatedAt(event.createdAt),
    runId,
    messageId: id,
    mobileEventId: event.eventId
  };
}

function errorTimelineEventForOutbox(event: MobileOutboxEvent, runId: string, error: unknown): MobileTimelineEvent {
  const participantLabel = participantLabelFromContent(event.payload.content);
  const id = `${runId}:${participantLabel ?? "participant"}:error`;
  return {
    id,
    role: "participant",
    ...(participantLabel ? { participantLabel } : {}),
    content: error instanceof Error ? error.message : String(error),
    status: "error",
    createdAt: nextTimelineCreatedAt(event.createdAt),
    runId,
    messageId: id,
    mobileEventId: event.eventId
  };
}

function participantLabelFromContent(content: string): string | undefined {
  return content.trim().match(/^(@[A-Za-z0-9._-]+)/)?.[1];
}

function nextTimelineCreatedAt(source: unknown): string {
  const now = Date.now();
  if (typeof source !== "string") {
    return new Date(now).toISOString();
  }
  const sourceTime = Date.parse(source);
  return new Date(Number.isFinite(sourceTime) ? Math.max(now, sourceTime + 1) : now).toISOString();
}
