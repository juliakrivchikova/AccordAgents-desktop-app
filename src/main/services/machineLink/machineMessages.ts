import { randomUUID } from "node:crypto";
import {
  MACHINE_LINK_PROTOCOL, backgroundTasksFromWire, isMachineLinkEnvelope, MACHINE_ATTACHMENT_PART_BYTES, machineSigningKey,
  type MachineAttachmentRequestBody, type MachineHelloBody, type MachineLinkEnvelope, type MachineLinkMessage
} from "../../../shared/machineLink";
import { decodeMachineProgress, type MachineProgressFrame } from "../../../shared/machineProgress";
import type { Conversation, ReviewProgress } from "../../../shared/types";
import { openMachinePayload, sealChannelPayload, sealMachinePayload } from "../machineChannelSealing";
import { signMachineControl, verifyMachineControl } from "../machineControlAuthentication";
import { LIVE_PROGRESS_RUNS_MAX } from "./constants";
import { errorMessage } from "./linkText";
import type { MachineConnection, MachineMemberBackgroundEvent, MachinePromptSuggestionEvent } from "./types";
import type { MachineLinkModules } from "./modules";
import type { MachineLinkDependencies } from "./dependencies";

/** What machines and this computer say to each other. */
export class MachineMessages {
  private readonly progressListeners: Array<(progress: ReviewProgress) => void> = [];
  private readonly suggestionListeners: Array<(event: MachinePromptSuggestionEvent) => void> = [];
  private readonly backgroundListeners: Array<(event: MachineMemberBackgroundEvent) => void> = [];
  private conversationLoader?: (conversationId: string) => Promise<Conversation | undefined>;
  private readonly seenMessageIds = new Set<string>();

  constructor(
    private readonly link: Pick<MachineLinkModules, "machineConnections" | "machineScripts" | "settingsPublication" | "turnHolds">,
    private readonly deps: Pick<MachineLinkDependencies, "debugLogs" | "now" | "options">
  ) {}

  /** A member hosted on a machine started or ended background work; `labels`
   *  empty also when the machine went away (nothing it said holds any more). */
  onMemberBackgroundTasks(listener: (event: MachineMemberBackgroundEvent) => void): () => void {
    this.backgroundListeners.push(listener);
    return () => { const index = this.backgroundListeners.indexOf(listener); if (index >= 0) this.backgroundListeners.splice(index, 1); };
  }

  /** A member's next-prompt suggestion from the machine that ran its reply. */
  onPromptSuggestion(listener: (event: MachinePromptSuggestionEvent) => void): () => void {
    this.suggestionListeners.push(listener);
    return () => { const index = this.suggestionListeners.indexOf(listener); if (index >= 0) this.suggestionListeners.splice(index, 1); };
  }

  /** A machine member's live progress, for this window (the phone reads it
   *  from the server, where the machine posts it itself). */
  onProgress(listener: (progress: ReviewProgress) => void): () => void {
    this.progressListeners.push(listener);
    return () => { const index = this.progressListeners.indexOf(listener); if (index >= 0) this.progressListeners.splice(index, 1); };
  }

  /** Lets the link check that a picture a machine asks for is in a chat. */
  setConversationLoader(loader: (conversationId: string) => Promise<Conversation | undefined>): void {
    this.conversationLoader = loader;
  }

  async handleMessage(connection: MachineConnection, ciphertext: string): Promise<void> {
    const pinned = machineSigningKey(connection.record);
    const payload = await openMachinePayload(ciphertext, await this.deps.options.deviceIdentity.getOrCreateDeviceIdentity(),
      pinned ? [pinned] : undefined, connection.pairing.rendezvousId);
    if (!isMachineLinkEnvelope(payload)) return;
    if (!pinned && payload.body.type !== "machine.hello") {
      throw new Error("A new machine must introduce its identity before sending anything else.");
    }
    const hello = payload.body.type === "machine.hello" ? payload.body : undefined;
    const from = connection.record.deviceId || hello?.deviceId;
    const key = pinned ?? hello?.publicKeyDerBase64;
    if (!from || !key || !verifyMachineControl(payload, { from, publicKeyDerBase64: key, to: this.deps.options.desktopDeviceId, room: connection.pairing.rendezvousId })) {
      throw new Error("A machine's messages carry its signing identity.");
    }
    if (this.seenMessageIds.has(payload.messageId)) return;
    this.seenMessageIds.add(payload.messageId);
    if (this.seenMessageIds.size > 10_000) {
      const first = this.seenMessageIds.values().next().value;
      if (first) this.seenMessageIds.delete(first);
    }
    await this.handleBody(connection, payload.body);
  }

  private async handleBody(connection: MachineConnection, body: MachineLinkMessage): Promise<void> {
    switch (body.type) {
      case "machine.hello":
        await this.handleHello(connection, body);
        return;
      case "machine.turn.progress.delta":
        this.receiveProgress(connection, body);
        return;
      case "machine.member.background":
        if (typeof body.conversationId !== "string" || typeof body.participantId !== "string" || !Array.isArray(body.labels)) return;
        this.emitMemberBackground({
          machineId: connection.record.id,
          member: {
            conversationId: body.conversationId,
            participantId: body.participantId,
            tasks: backgroundTasksFromWire(body.labels, body.startedAt),
            ...(body.environmentPending === true ? { environmentPending: true } : {})
          }
        });
        return;
      case "machine.member.background.snapshot":
        if (!Array.isArray(body.members)) return;
        this.emitMemberBackground({
          machineId: connection.record.id,
          snapshot: body.members
            .filter((member) => member && typeof member.conversationId === "string" && typeof member.participantId === "string" && Array.isArray(member.labels))
            .slice(0, 500)
            .map((member) => ({
              conversationId: member.conversationId,
              participantId: member.participantId,
              tasks: backgroundTasksFromWire(member.labels, member.startedAt),
              ...(member.environmentPending === true ? { environmentPending: true } : {})
            }))
        });
        return;
      case "machine.turn.suggestion":
        if (typeof body.suggestion !== "string" || typeof body.participantId !== "string" || typeof body.runId !== "string") return;
        for (const listener of this.suggestionListeners) {
          listener({ machineId: connection.record.id, conversationId: body.conversationId, runId: body.runId, participantId: body.participantId, suggestion: body.suggestion });
        }
        return;
      case "machine.scripts.result": {
        const pending = connection.pendingScripts.get(body.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          connection.pendingScripts.delete(body.requestId);
          if (body.ok) pending.resolve(body.result);
          else pending.reject(new Error(body.error || "The machine refused."));
        }
        return;
      }
      case "machine.scripts.changed":
        for (const listener of this.link.machineScripts.scriptsChangedListeners) {
          try { listener(connection.record.id); } catch { /* a listener failure never breaks the link */ }
        }
        return;
      case "machine.attachment.request":
        // Served off the inbound chain: reading a chat and sending a picture
        // takes seconds on a large chat, and live progress must not wait.
        void this.answerAttachmentRequest(connection, body);
        return;
      default:
        return;
    }
  }

  /** One live progress frame of a member on this machine: decoded against the
   *  run's stream so far, and shown. A frame whose base was missed (this
   *  desktop reconnected mid-stream) waits for the next whole one: the machine
   *  starts every run's stream anew for a desktop that greets it. */
  private receiveProgress(connection: MachineConnection, frame: MachineProgressFrame): void {
    if (!frame || typeof frame.runId !== "string" || typeof frame.streamId !== "string" || !Number.isSafeInteger(frame.sequence)) return;
    const current = connection.progress.get(frame.runId);
    if (current && current.streamId === frame.streamId && frame.sequence <= current.sequence) return;
    const base = current && current.streamId === frame.streamId && frame.sequence === current.sequence + 1 ? current.progress : undefined;
    let progress: ReviewProgress;
    try {
      progress = decodeMachineProgress(base, frame);
    } catch {
      return;
    }
    const terminal = progress.phase === "done" || progress.phase === "error" || progress.phase === "cancelled" || progress.agentProgress?.state === "finished";
    connection.progress.delete(frame.runId);
    if (!terminal) {
      connection.progress.set(frame.runId, { streamId: frame.streamId, sequence: frame.sequence, progress });
      while (connection.progress.size > LIVE_PROGRESS_RUNS_MAX) connection.progress.delete(connection.progress.keys().next().value as string);
    }
    for (const listener of this.progressListeners) {
      try { listener(progress); } catch (error) {
        void this.deps.debugLogs.write("machine-link.progress.listener-error", { machineId: connection.record.id, message: errorMessage(error) });
      }
    }
  }

  private async handleHello(connection: MachineConnection, hello: MachineHelloBody): Promise<void> {
    // A hello from an instance older than one already seen (the old process
    // saying goodbye late) is ignored, when both carry the start counter.
    const stale = typeof hello.instanceSequence === "number" && typeof connection.latestInstanceSequence === "number"
      && hello.instanceSequence < connection.latestInstanceSequence;
    if (stale) {
      void this.deps.debugLogs.write("machine-link.hello.stale-instance", { machineId: connection.record.id, instanceId: hello.instanceId, instanceSequence: hello.instanceSequence });
      return;
    }
    if (!hello.publicKeyDerBase64) throw new Error("This machine must introduce its signing key.");
    if (connection.record.deviceId && connection.record.deviceId !== hello.deviceId) {
      throw new Error("The machine's enrolled device identity changed; its history cannot be accepted as the previous machine.");
    }
    const keyChanged = machineSigningKey(connection.record) !== hello.publicKeyDerBase64 || connection.record.deviceId !== hello.deviceId;
    if (typeof hello.instanceSequence === "number") connection.latestInstanceSequence = hello.instanceSequence;
    connection.machineDeviceId = hello.deviceId;
    connection.helloSeen = true;
    if (connection.helloRequestTimer) {
      clearTimeout(connection.helloRequestTimer);
      connection.helloRequestTimer = undefined;
    }
    const { type: _type, ...rest } = hello;
    // A runtime that just started greets before its CLIs have said what they
    // start in: what it said before stays until it says it again.
    const previousStart = connection.record.lastHello?.cliStartDefaults;
    connection.record = {
      ...connection.record,
      deviceId: hello.deviceId,
      lastSeenAt: this.deps.now().toISOString(),
      lastHello: rest.cliStartDefaults || !previousStart || rest.cliModesSupported !== true ? rest : { ...rest, cliStartDefaults: previousStart }
    };
    await this.link.settingsPublication.persistRecord(connection, true);
    if (this.deps.options.desktopDeviceId === connection.pairing.issuer.originId) {
      await this.send(connection, { type: "machine.hello.ack", desktopDeviceId: this.deps.options.desktopDeviceId, appVersion: this.deps.options.appVersion,
        machineId: connection.record.id, machineName: connection.record.name });
      if (keyChanged) this.deps.options.onDevicesChanged?.();
      // A runtime that greets while its turns are held (the new one an update
      // started) holds them too until the update is done.
      this.link.turnHolds.sendTurnHold(connection.record.id);
      // Its settings on the server, sealed for the key it greeted with.
      void this.link.settingsPublication.syncSettings().catch((error: unknown) => {
        void this.deps.debugLogs.write("machine-link.settings.sync-error", { machineId: connection.record.id, message: errorMessage(error) });
      });
    }
    this.link.machineConnections.emitStatus();
    // Machine setup waits for a hello that arrives AFTER it restarted the
    // runtime, and checks the version it reports.
    this.link.machineConnections.emitter.emit("hello", { machineId: connection.record.id, appVersion: hello.appVersion, deviceId: hello.deviceId, solicited: Boolean(connection.activityProbe) });
  }

  /** The bytes of a picture a machine asked for. Answered either way: a
   *  refusal tells the member the picture is unavailable, where silence would
   *  leave it waiting out its turn. Sent in bounded parts. */
  private async answerAttachmentRequest(connection: MachineConnection, body: MachineAttachmentRequestBody): Promise<void> {
    const reply = { type: "machine.attachment.result" as const, requestId: body.requestId,
      conversationId: body.conversationId, attachmentId: body.attachmentId };
    try {
      if (!this.deps.options.readChatAttachment) throw new Error("This desktop cannot read chat pictures.");
      const conversation = await this.conversationLoader?.(body.conversationId);
      if (!conversation || conversation.kind !== "chat") throw new Error("This chat is not on this desktop.");
      const read = await this.deps.options.readChatAttachment({ conversationId: body.conversationId, attachmentId: body.attachmentId });
      const bytes = Buffer.from(read.dataBase64, "base64");
      const parts = Math.max(1, Math.ceil(bytes.length / MACHINE_ATTACHMENT_PART_BYTES));
      for (let part = 0; part < parts; part += 1) {
        const slice = bytes.subarray(part * MACHINE_ATTACHMENT_PART_BYTES, (part + 1) * MACHINE_ATTACHMENT_PART_BYTES);
        await this.send(connection, { ...reply, ok: true, part, parts, dataBase64: slice.toString("base64"),
          ...(part === 0 && read.attachment?.mimeType ? { mediaType: read.attachment.mimeType } : {}),
          ...(part === 0 && read.attachment?.filename ? { fileName: read.attachment.filename } : {}) });
      }
    } catch (error) {
      void this.deps.debugLogs.write("machine-link.attachment.refused", { machineId: connection.record.id,
        conversationId: body.conversationId, attachmentId: body.attachmentId, message: errorMessage(error) });
      await this.send(connection, { ...reply, ok: false, error: errorMessage(error) }).catch(() => undefined);
    }
  }

  emitMemberBackground(event: MachineMemberBackgroundEvent): void {
    for (const listener of this.backgroundListeners) {
      try { listener(event); } catch (error) {
        void this.deps.debugLogs.write("machine-link.background.listener-error", { machineId: event.machineId, message: errorMessage(error) });
      }
    }
  }

  send(connection: MachineConnection, body: MachineLinkMessage): Promise<void> {
    const send = connection.outbound.then(() => this.sendNow(connection, body));
    connection.outbound = send.catch(() => undefined);
    return send;
  }

  private async sendNow(connection: MachineConnection, body: MachineLinkMessage): Promise<void> {
    const to = connection.machineDeviceId;
    if (!to) throw new Error(`${connection.record.name} is not connected.`);
    const envelope: MachineLinkEnvelope = {
      protocol: MACHINE_LINK_PROTOCOL,
      messageId: randomUUID(),
      sentAt: this.deps.now().toISOString(),
      body
    };
    const identity = await this.deps.options.deviceIdentity.getOrCreateDeviceIdentity();
    const signed = signMachineControl(envelope, identity, connection.pairing.rendezvousId, to);
    const peerKey = machineSigningKey(connection.record);
    if (!peerKey) {
      // Only a greeting request may use the enrollment's own seal, before the
      // machine's key is known. Nothing else is included.
      if (body.type !== "machine.hello.request") throw new Error("The machine must introduce its identity first.");
      const ciphertext = await sealChannelPayload(signed, connection.pairing.relaySealKeyBase64);
      await connection.client.sendCiphertext({ logicalMessageId: envelope.messageId, ciphertext, to });
      return;
    }
    const ciphertext = await sealMachinePayload(signed, identity, peerKey, connection.pairing.rendezvousId);
    await connection.client.sendCiphertext({ logicalMessageId: envelope.messageId, ciphertext, to });
  }
}
