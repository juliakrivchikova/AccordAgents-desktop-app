import type { ChatAppToolApproval, Conversation, ReviewProgress } from "../../shared/types";
import {
  HUB_APPROVAL_CARD_EVENT_KIND,
  HUB_APPROVAL_CARD_SCOPE,
  type HubComposerCatalog,
  type HubMachineWakeRequest
} from "../../shared/hubProtocol";
import type { ChatEventLogService } from "./chatEventLog";
import type { HubClient } from "./hubClient";
import { MachineProgressSender } from "./machineProgressSender";
import type { StorageService } from "./storage";

/**
 * What the desktop puts on the User's server for her phone, so the phone
 * needs nothing from the desktop itself: the approval cards of its own
 * members, its own members' live progress, the composer's catalog and the key
 * the server may wake a stopped machine with. A member on a machine is that
 * machine's to publish; the desktop says nothing for it.
 */

/** How often a running member's text goes to the server, at most. */
const PROGRESS_TEXT_FLUSH_MS = 1_000;
/** How long a reading of whether a phone is paired stands. */
const PHONES_RECHECK_MS = 30_000;
/** Runs whose progress is published at once, at most (the oldest stop). */
const PROGRESS_RUNS_MAX = 32;

export class HubPhonePublisher {
  /** Each local approval as last published: its status and update stamp. */
  private readonly publishedApprovals = new Map<string, string>();
  /** Local approvals noted and not published yet (no server link or no
   *  phone at the time), the newest word on each. */
  private readonly unpublished = new Map<string, { conversationId: string; approval: ChatAppToolApproval; stamp: string }>();
  private approvalQueue: Promise<void> = Promise.resolve();
  /** Members by chat that live on a machine: their progress is not ours. */
  private readonly machineMembers = new Map<string, Set<string>>();
  private readonly progress = new Map<string, MachineProgressSender<void>>();
  private catalogTimer?: ReturnType<typeof setTimeout>;
  private catalogQueue: Promise<void> = Promise.resolve();
  /** Custom avatars already on the server, by id and content. */
  private readonly uploadedAvatars = new Map<string, { stamp: string; entry: HubComposerCatalog["avatars"][string] }>();
  private wakeQueue: Promise<void> = Promise.resolve();
  private wakePublished?: string;
  /** Whether a phone is paired, as last read (progress is many updates a
   *  second: it is not asked each time). */
  private phones?: { has: boolean; at: number };
  /** Chats whose members' homes are being read (their progress waits). */
  private readonly membersLoading = new Set<string>();
  /** The catalog last published, without its stamp: an unchanged one is not
   *  sent again (settings are written often, the catalog rarely changes). */
  private catalogPublished?: string;

  constructor(private readonly options: {
    storage: Pick<StorageService, "deviceEventBlobs">;
    eventLog: Pick<ChatEventLogService, "appendLocalEvent">;
    /** The link to the server, when there is one and it took this desktop as
     *  its owner. */
    client: () => HubClient | undefined;
    /** Whether a phone is paired with the server (nothing is published for
     *  nobody). */
    hasPhones: () => Promise<boolean>;
    /** The members of a chat that live on a machine (read when the chat was
     *  not saved here since this desktop started). */
    machineMembersOf?: (conversationId: string) => Promise<Set<string>>;
    now?: () => number;
    buildCatalog: (upload: (avatarId: string, stamp: string, read: () => Promise<{ mimeType: string; bytes: Buffer }>) => Promise<void>) => Promise<Omit<HubComposerCatalog, "avatars" | "version" | "publishedAt">>;
    wakeKeys: () => Promise<HubMachineWakeRequest["machines"]>;
    log: (event: string, payload: Record<string, unknown>) => void;
  }) {}

  /** A chat saved here: its local approvals that changed go to the server,
   *  and which members live on machines is noted. */
  noteConversation(conversation: Conversation): void {
    const participants = Array.isArray(conversation.metadata?.participants) ? conversation.metadata.participants as Array<{ id?: string; homeMachineId?: string }> : [];
    const onMachines = new Set(participants.filter((participant) => participant?.id && participant.homeMachineId).map((participant) => participant.id as string));
    this.machineMembers.set(conversation.id, onMachines);
    if (this.machineMembers.size > 500) this.machineMembers.delete(this.machineMembers.keys().next().value!);
    const approvals = (conversation.metadata as { pendingAppToolApprovals?: ChatAppToolApproval[] } | undefined)?.pendingAppToolApprovals ?? [];
    for (const approval of approvals) {
      // A machine's member's card is published by that machine.
      if (approval.homeMachineId) continue;
      const key = `${conversation.id}\n${approval.id}`;
      const stamp = `${approval.status}\u0000${approval.updatedAt}`;
      if (this.publishedApprovals.get(key) === stamp) continue;
      // An approval settled long before this desktop started needs no card.
      if (!this.publishedApprovals.has(key) && !this.unpublished.has(key) && approval.status !== "pending") {
        this.publishedApprovals.set(key, stamp);
        continue;
      }
      this.unpublished.set(key, { conversationId: conversation.id, approval, stamp });
    }
    if (this.publishedApprovals.size > 5_000) this.publishedApprovals.clear();
    this.flushApprovals();
  }

  /** Publishes the cards noted but not on the server yet: at once when it
   *  can, again once the server confirms this desktop or a phone pairs. */
  flushApprovals(): void {
    if (this.unpublished.size === 0) return;
    this.approvalQueue = this.approvalQueue.then(async () => {
      if (!this.options.client() || !await this.options.hasPhones()) return;
      for (const [key, card] of [...this.unpublished]) {
        if (this.unpublished.get(key) !== card) continue;
        try {
          const payload = await this.options.storage.deviceEventBlobs().prepare({ conversationId: card.conversationId, approval: card.approval });
          await this.options.eventLog.appendLocalEvent({ conversationId: card.conversationId, logScopeId: HUB_APPROVAL_CARD_SCOPE, kind: HUB_APPROVAL_CARD_EVENT_KIND, payload });
          this.publishedApprovals.set(key, card.stamp);
          if (this.unpublished.get(key) === card) this.unpublished.delete(key);
        } catch (error) {
          this.options.log("hub.phone.card-error", { conversationId: card.conversationId, message: error instanceof Error ? error.message : String(error) });
        }
      }
    }).catch(() => undefined);
  }

  /** A run's progress, as the desktop's own window sees it: a local member's
   *  goes to the server, coalesced, for the phone to show live. It is posted,
   *  not written to the order: nothing keeps it once the run is over. */
  noteProgress(progress: ReviewProgress, conversationId: string | undefined): void {
    const agent = progress.agentProgress;
    if (!agent || !conversationId || !this.options.client()) return;
    if (!this.phonesPaired()) return;
    let onMachines = this.machineMembers.get(conversationId);
    if (!onMachines) {
      if (this.options.machineMembersOf) {
        // Not known yet whether this member lives on a machine (its
        // progress is the machine's to publish): the next update knows.
        this.loadMembers(conversationId);
        return;
      }
      onMachines = new Set();
    }
    if (agent.participantId && onMachines.has(agent.participantId)) return;
    const terminal = progress.phase === "done" || progress.phase === "error" || progress.phase === "cancelled" || agent.state === "finished";
    let sender = this.progress.get(progress.runId);
    if (!sender) {
      if (terminal) return;
      const runId = progress.runId;
      const created: MachineProgressSender<void> = new MachineProgressSender<void>({
        conversationId,
        textFlushMs: PROGRESS_TEXT_FLUSH_MS,
        publish: async (frame) => {
          const client = this.options.client();
          if (!client) throw new Error("No server link.");
          await client.postProgress([frame]);
        },
        stored: async () => undefined,
        onError: (error) => {
          // Live progress is not caught up later: this run's sender stops,
          // and the next update starts a new stream the server takes whole.
          created.close();
          if (this.progress.get(runId) === created) this.progress.delete(runId);
          this.options.log("hub.phone.progress-error", { runId, message: error instanceof Error ? error.message : String(error) });
        },
        onRecovered: () => undefined
      });
      sender = created;
      this.progress.set(progress.runId, sender);
      while (this.progress.size > PROGRESS_RUNS_MAX) {
        const [oldest, stale] = this.progress.entries().next().value as [string, MachineProgressSender<void>];
        stale.close();
        this.progress.delete(oldest);
      }
    }
    sender.note(progress);
    if (terminal) {
      const finished = sender;
      this.progress.delete(progress.runId);
      void finished.finish().catch(() => undefined);
    }
  }

  private phonesPaired(): boolean {
    const now = this.options.now?.() ?? Date.now();
    if (!this.phones || now - this.phones.at > PHONES_RECHECK_MS) {
      const asked = now;
      void this.options.hasPhones().then((has) => { this.phones = { has, at: asked }; }, () => undefined);
      // Until the first answer: a phone is assumed (nothing is lost).
      if (!this.phones) return true;
    }
    return this.phones.has;
  }

  /** A phone was paired or removed: asked again at the next update. */
  phonesChanged(): void {
    this.phones = undefined;
  }

  private loadMembers(conversationId: string): void {
    const read = this.options.machineMembersOf;
    if (!read || this.membersLoading.has(conversationId)) return;
    this.membersLoading.add(conversationId);
    void read(conversationId).then((members) => {
      if (!this.machineMembers.has(conversationId)) this.machineMembers.set(conversationId, members);
    }, () => undefined).finally(() => this.membersLoading.delete(conversationId));
  }

  /** Publishes the composer's catalog soon (a burst of setting writes is one). */
  scheduleCatalog(delayMs = 5_000): void {
    if (this.catalogTimer) clearTimeout(this.catalogTimer);
    this.catalogTimer = setTimeout(() => {
      this.catalogTimer = undefined;
      this.catalogQueue = this.catalogQueue.then(() => this.publishCatalog()).catch((error) => {
        this.options.log("hub.phone.catalog-error", { message: error instanceof Error ? error.message : String(error) });
      });
    }, delayMs);
    this.catalogTimer.unref?.();
  }

  private async publishCatalog(): Promise<void> {
    const client = this.options.client();
    if (!client || !await this.options.hasPhones()) return;
    const avatars: HubComposerCatalog["avatars"] = {};
    const parts = await this.options.buildCatalog(async (avatarId, stamp, read) => {
      const known = this.uploadedAvatars.get(avatarId);
      if (known && known.stamp === stamp) {
        avatars[avatarId] = known.entry;
        return;
      }
      const picture = await read();
      const blob = await client.uploadBytes(picture.bytes);
      const entry = { mimeType: picture.mimeType, blob };
      this.uploadedAvatars.set(avatarId, { stamp, entry });
      avatars[avatarId] = entry;
    });
    const content = JSON.stringify({ ...parts, avatars });
    if (content === this.catalogPublished) return;
    await client.setCatalog({ version: 1, publishedAt: new Date().toISOString(), ...parts, avatars });
    this.catalogPublished = content;
    this.options.log("hub.phone.catalog-published", { prompts: parts.prompts.length, skills: parts.skills.length, avatars: Object.keys(avatars).length });
  }

  /** Gives the server the start keys it may wake machines with (unchanged
   *  keys are not sent again). */
  publishWakeKeys(): void {
    this.wakeQueue = this.wakeQueue.then(async () => {
      const client = this.options.client();
      if (!client) return;
      // Only a phone needs the server to wake a machine: with none paired,
      // the server holds no key (an empty set removes the ones it has).
      const machines = await this.options.hasPhones() ? await this.options.wakeKeys() : [];
      const stamp = JSON.stringify(machines.map((machine) => [machine.machineId, machine.instanceId, machine.credentials.accessKeyId]));
      if (stamp === this.wakePublished) return;
      await client.setMachineWake(machines);
      this.wakePublished = stamp;
      this.options.log("hub.phone.wake-keys-published", { machines: machines.length });
    }).catch((error) => {
      this.options.log("hub.phone.wake-keys-error", { message: error instanceof Error ? error.message : String(error) });
    });
  }

  /** Another server (or none): everything is published again. */
  reset(): void {
    this.publishedApprovals.clear();
    this.unpublished.clear();
    this.uploadedAvatars.clear();
    this.phones = undefined;
    this.wakePublished = undefined;
    this.catalogPublished = undefined;
    for (const sender of this.progress.values()) sender.close();
    this.progress.clear();
  }
}
