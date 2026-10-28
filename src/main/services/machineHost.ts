/**
 * Machine link, machine side.
 *
 * A cloud machine is a plain client of the User's server (agreements Д1–Д13):
 * it takes its members' turns from the server, runs them and writes their
 * replies back there (ServerChatLink, ChatService), and it reads the settings
 * the computer published for it there. What is left here is the live control
 * between the computer that set the machine up and the machine, in the
 * machine's room on the server, never stored: its greeting and status (for
 * Settings, updates and power), scheduled scripts the computer manages, a
 * picture a member reads from the computer, background-task labels,
 * next-prompt suggestions and live progress for the computer's window. Live
 * progress also goes to the server for the phone.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MACHINE_LINK_PROTOCOL,
  isMachineLinkEnvelope,
  type MachineAttachmentResultBody,
  type MachineHelloBody,
  type MachineLinkEnvelope,
  type MachineLinkMessage,
  type MachineScriptsOperation,
  type MachineScriptsRequestBody
} from "../../shared/machineLink";
import type { MobilePairingPackage } from "../../shared/mobilePairing";
import type { MachineProgressFrame } from "../../shared/machineProgress";
import type { AgentHealth, ChatBackgroundTasksEvent, ReviewProgress } from "../../shared/types";
import type { NativeRuntimeIdentity } from "../../shared/nativeCommands";
import type { ChatService } from "./chat";
import type { DebugLogService } from "./debugLogs";
import type { DeviceIdentityRecord, StorageService } from "./storage";
import { advanceInstanceSequence } from "./machineTurnOutcome";
import { openChannelPayload, openMachinePayload, sealMachinePayload } from "./machineChannelSealing";
import type { TunnelClient } from "./hubTunnelClient";
import { signMachineControl, verifyMachineControl, machineControlSender } from "./machineControlAuthentication";
import { MachineProgressSender } from "./machineProgressSender";
import { readPosixProcessTableAsync } from "./processTermination";
import { MachineApprovalExecutor } from "./machineApprovalExecutor";
import { MachineChoiceExecutor, MachineMentionExecutor } from "./chatActionNativeClaims";

export interface MachineHostOptions {
  pairing: MobilePairingPackage;
  deviceId: string;
  machineName?: string;
  appVersion: string;
  publicKeyDerBase64: string;
  /** This machine's device identity: what it signs and seals with. */
  identity: () => Promise<DeviceIdentityRecord>;
  /** Opens this machine's room on the User's server (a stand-in in tests). */
  createClient: (pairing: MobilePairingPackage) => TunnelClient;
  /** The machine's own storage (its approval and choice executors). */
  storage: StorageService;
  /** Where this runtime's start counter is kept (hello `instanceSequence`). */
  instancePath?: string;
  now?: () => Date;
  nativeProcessDbPath?: string;
  /** True while another deployment on this host has committed an idle stop. */
  hostStopCommitted?: () => boolean;
  detectProviders?: () => Promise<AgentHealth[]>;
  /** Commits idle accounting once a member's run here has ended. */
  onNativeActivitySettled?: () => Promise<void>;
  idleStopWarning?: () => string | undefined;
  /** The User's automatic-stop switch as this machine has it. */
  autoStopEnabled?: () => boolean | undefined;
  /** The name the enrolling desktop gave this machine, from its greeting. */
  onDesktopMachineName?: (name: string) => void;
  /** What this machine wrote that the User's server has not taken yet. An
   *  idle stop waits for it: a reply must not sleep with the machine. */
  unsentServerWrites?: () => Promise<{ queued: number; lastError?: string } | undefined>;
  /** Posts this machine's members' live progress to the User's server, for
   *  the phone (POST /v1/progress). */
  postProgress?: (frames: MachineProgressFrame[]) => Promise<void>;
  /** Scheduled scripts on this machine, operated by the enrolling desktop. */
  scripts?: {
    handle(operation: MachineScriptsOperation): Promise<unknown>;
    /** True while an enabled script needs this machine awake for its next run,
     *  or a script is running now. */
    keepsHostAwake(): boolean;
    /** How many switched-on scripts keep it awake, for the desktop to show. */
    scheduledCount?(): number;
  };
}

/** How long one part of a picture may take to arrive from the desktop before
 *  the member's read fails. Restarted by every part, so it bounds silence,
 *  not the whole transfer. */
const ATTACHMENT_PART_TIMEOUT_MS = 120_000;
/** One run changes several things at once; the desktop hears about them together. */
const SCRIPTS_CHANGED_COALESCE_MS = 250;
/** How far the desktop's clock may be ahead of this machine's when it dates a request. */
const SCRIPTS_REQUEST_CLOCK_SKEW_MS = 30_000;
/** How often a running member's text goes to the server for the phone. */
const SERVER_PROGRESS_TEXT_FLUSH_MS = 1_000;
/** How often it goes to the computer's window (as a local member's does). */
const LIVE_PROGRESS_TEXT_FLUSH_MS = 100;
/** Runs whose progress is sent at once, at most (the oldest stop). */
const PROGRESS_RUNS_MAX = 32;

function changesScripts(operation: MachineScriptsOperation): boolean {
  return operation.op !== "list" && operation.op !== "revision" && operation.op !== "runs";
}

interface MachineAttachmentBytes { dataBase64: string; mediaType?: string; fileName?: string }

interface MachineAttachmentWaiter {
  resolve: (value: MachineAttachmentBytes) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  timeoutMs: number;
  chunks: Map<number, Buffer>;
  parts?: number;
  mediaType?: string;
  fileName?: string;
}

type HostChat = Pick<ChatService, "respondToChoice" | "respondToAppToolApproval" | "respondToMentions"> &
  Partial<Pick<ChatService, "activeParticipantRuns" | "liveRunIds" | "onParticipantRunSettled" | "conversationIdForRun" | "setPromptSuggestionForwarder" |
    "onBackgroundTasksChanged" | "localBackgroundTasks" | "setCardAppliers">>;

export class MachineHostService {
  private readonly client: TunnelClient;
  private readonly now: () => Date;
  private readonly seenMessageIds = new Set<string>();
  /** Changes when this runtime starts: the desktop tells a restart from a reconnect by it. */
  private readonly instanceId = randomUUID();
  private readonly instanceStartedAt = new Date().toISOString();
  /** Monotonic start counter; undefined when it could not be read or
   *  advanced reliably (never published then). */
  private readonly instanceSequence?: number;
  private inbound: Promise<void> = Promise.resolve();
  /** Outbound sends leave in call order. */
  private outbound: Promise<void> = Promise.resolve();
  private desktopDeviceId?: string;
  /** What the room last said of the enrolling desktop, as it said it. */
  private desktopInRoom = false;
  private closed = false;
  private draining = false;
  private idleFenced = false;
  /** The desktop asked this machine to take no new turns until then (its
   *  runtime is about to be replaced). */
  private heldUntil?: number;
  private heldTimer?: ReturnType<typeof setTimeout>;
  private uncertainIdleRelease?: () => void;
  private unsubscribeRunSettled?: () => void;
  private unsubscribeBackgroundTasks?: () => void;
  /** requestId -> whoever is waiting for those picture bytes. */
  private readonly pendingAttachments = new Map<string, MachineAttachmentWaiter>();
  /** Live progress of each run, to the computer's window (in the room) and
   *  to the server (for the phone): one stream each per run. */
  private readonly roomProgress = new Map<string, MachineProgressSender<void>>();
  private readonly serverProgress = new Map<string, MachineProgressSender<void>>();
  private scriptsChangedTimer?: ReturnType<typeof setTimeout>;
  /** Script operations run one at a time, in order, off the inbound chain. */
  private scriptsQueue: Promise<void> = Promise.resolve();
  private readonly approvalExecutor: MachineApprovalExecutor;
  private readonly choiceExecutor: MachineChoiceExecutor;
  private readonly mentionExecutor: MachineMentionExecutor;

  constructor(
    private readonly chat: HostChat,
    private readonly debugLogs: Pick<DebugLogService, "write">,
    private readonly options: MachineHostOptions
  ) {
    this.now = options.now ?? (() => new Date());
    const sequence = this.nextInstanceSequence();
    this.instanceSequence = sequence.sequence;
    if (sequence.error) void this.debugLogs.write("machine-host.instance.unavailable", { message: sequence.error });
    const pairing = options.pairing;
    // A machine meets its devices on the User's server, nowhere else.
    if (!pairing.hubUrl) throw new Error("This machine's enrollment does not name the User's server; set it up again from the desktop (Cloud run in a member's settings).");
    this.client = options.createClient(pairing);
    // The User's answers to cards of members here arrive from the User's
    // server; these apply each once (agreement Д9). Only the desktop that
    // set this machine up shows a script's code, so only its answer
    // approves a script that installs code.
    this.choiceExecutor = new MachineChoiceExecutor({
      storage: options.storage, chat,
      progress: (progress, conversationId) => this.noteProgressFor(conversationId, progress),
      runtimeIdentity: () => this.getRuntimeIdentity(), nativeProcessDbPath: options.nativeProcessDbPath,
      canApply: () => this.canApplyNativeEffects()
    });
    this.approvalExecutor = new MachineApprovalExecutor({
      storage: options.storage, chat,
      progress: (progress, conversationId) => this.noteProgressFor(conversationId, progress),
      runtimeIdentity: () => this.getRuntimeIdentity(), nativeProcessDbPath: options.nativeProcessDbPath,
      canApply: () => this.canApplyNativeEffects(),
      codeApprover: () => pairing.issuer.originId
    });
    this.mentionExecutor = new MachineMentionExecutor({
      storage: options.storage, chat,
      progress: (progress, conversationId) => this.noteProgressFor(conversationId, progress),
      runtimeIdentity: () => this.getRuntimeIdentity(),
      canApply: () => this.canApplyNativeEffects()
    });
    const appliers = { approval: this.approvalExecutor, choice: this.choiceExecutor, mention: this.mentionExecutor };
    this.chat.setCardAppliers?.(async () => appliers);
    this.client.on("peer", (event) => {
      if (event.type === "ready") {
        // Own link (re)established: greet the desktop again even if it is
        // the same one. A room without it means it is away.
        const desktop = event.peers.find((peer) => peer.deviceId === pairing.issuer.originId);
        this.desktopInRoom = Boolean(desktop);
        if (desktop) this.setDesktop(desktop.deviceId, { announce: true });
        else this.desktopAway("not-in-room");
      } else if (event.type === "peer-connected" && event.peer.deviceId === pairing.issuer.originId) {
        this.desktopInRoom = true;
        this.setDesktop(event.peer.deviceId, { announce: true });
      } else if (event.type === "peer-disconnected" && event.peer.deviceId === pairing.issuer.originId) {
        this.desktopInRoom = false;
        this.desktopAway("left");
      }
    });
    // While this machine's own link is down, nothing is known of the desktop.
    this.client.on("state", (state) => {
      if (state === "connected") return;
      this.desktopInRoom = false;
      this.desktopAway("own-link");
    });
    this.client.on("message", (message) => {
      this.inbound = this.inbound
        .then(() => this.handleMessage(message.ciphertext))
        .catch((error) => { void this.debugLogs.write("machine-host.message.error", { message: errorMessage(error) }); });
    });
    this.client.on("error", (error) => { void this.debugLogs.write("machine-host.tunnel.error", { message: error.message }); });
    this.unsubscribeRunSettled = this.chat.onParticipantRunSettled?.(async () => {
      await this.options.onNativeActivitySettled?.();
    });
    // Members hosted here show their background work on the desktop too.
    this.unsubscribeBackgroundTasks = this.chat.onBackgroundTasksChanged?.((event) => this.sendMemberBackground(event));
    // The desktop decides whether a member's next-prompt suggestion is still
    // on offer; with no desktop connected there is nobody to offer it to.
    this.chat.setPromptSuggestionForwarder?.((suggestion) => {
      if (this.closed) return;
      void this.send({
        type: "machine.turn.suggestion",
        conversationId: suggestion.conversationId,
        runId: suggestion.runId,
        participantId: suggestion.participantId,
        suggestion: suggestion.text
      }).catch((error) => {
        void this.debugLogs.write("machine-host.suggestion.not-sent", { runId: suggestion.runId, message: errorMessage(error) });
      });
    });
  }

  async start(): Promise<void> {
    this.closed = false;
    await this.client.connect().catch((error) => {
      void this.debugLogs.write("machine-host.connect.retrying", { message: errorMessage(error) });
    });
  }

  close(): void {
    this.failAllAttachments("The machine runtime is closing; this picture was not fetched.");
    this.closed = true;
    for (const sender of [...this.roomProgress.values(), ...this.serverProgress.values()]) sender.close();
    this.roomProgress.clear();
    this.serverProgress.clear();
    this.unsubscribeRunSettled?.();
    this.chat.setPromptSuggestionForwarder?.(undefined);
    this.unsubscribeBackgroundTasks?.();
    this.unsubscribeBackgroundTasks = undefined;
    if (this.scriptsChangedTimer) clearTimeout(this.scriptsChangedTimer);
    if (this.heldTimer) clearTimeout(this.heldTimer);
    this.client.close();
  }

  /** Stops this machine's members and waits until nothing of theirs runs
   *  here. What their runs wrote last (replies, the turns' ends) is queued for
   *  the server by then; the caller lets it go before the link closes. */
  async shutdown(stopProviders: () => Promise<void>, closeLink = true): Promise<void> {
    this.draining = true;
    await stopProviders();
    while (this.approvalExecutor.hasActiveWork() || this.choiceExecutor.hasActiveWork() || this.mentionExecutor.hasActiveWork() || (this.chat.activeParticipantRuns?.().length ?? 0) ||
        (this.chat.liveRunIds?.().length ?? 0)) {
      // A turn may still be preparing its workspace when shutdown begins.
      // Close an executor created by that preparation before waiting again.
      await stopProviders();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    for (const sender of this.serverProgress.values()) await sender.finish().catch(() => undefined);
    await this.outbound;
    if (closeLink) this.close();
  }

  /** False while this machine stops (drained for a shutdown or an idle
   *  stop): a turn the server asks of a member here then waits there for the
   *  next start instead of being taken by a runtime that is going away. */
  takesNewWork(): boolean {
    const held = this.heldUntil !== undefined && this.now().getTime() < this.heldUntil;
    return !this.closed && !this.draining && !this.idleFenced && !held && !this.options.hostStopCommitted?.();
  }

  /** At most this long per hold: a desktop that stops sending it never keeps
   *  the machine from working. */
  private static readonly HOLD_MAX_MS = 30 * 60_000;

  private holdTurns(until: string, reason: string): void {
    const at = Date.parse(until);
    const now = this.now().getTime();
    if (!Number.isFinite(at) || at <= now) return this.releaseTurns("expired");
    this.heldUntil = Math.min(at, now + MachineHostService.HOLD_MAX_MS);
    if (this.heldTimer) clearTimeout(this.heldTimer);
    this.heldTimer = setTimeout(() => this.releaseTurns("lapsed"), this.heldUntil - now);
    this.heldTimer.unref?.();
    void this.debugLogs.write("machine-host.turns.held", { reason, until: new Date(this.heldUntil).toISOString() });
  }

  private releaseTurns(reason: string): void {
    if (this.heldTimer) clearTimeout(this.heldTimer);
    this.heldTimer = undefined;
    if (this.heldUntil === undefined) return;
    this.heldUntil = undefined;
    void this.debugLogs.write("machine-host.turns.released", { reason });
    this.fenceLifted();
  }

  /** False once this machine is draining or fenced for an idle stop. */
  canApplyNativeEffects(): boolean {
    return !this.draining && !this.idleFenced && !this.closed;
  }

  /** Installed before start() when this boot retained an uncertain AWS Stop. */
  retainIdleFence(): void { this.idleFenced = true; }

  publishPowerStatus(): Promise<void> { return this.sendHello(); }

  isDesktopConnected(): boolean {
    return Boolean(this.desktopDeviceId);
  }

  /** All work of this runtime: members running, scripts that keep it awake,
   *  and anything it wrote that the server has not taken yet. */
  async hasWorkForIdleStop(): Promise<boolean> {
    // An enabled scheduled script must find the machine awake at its next
    // due time. This vetoes idle stop only; it is not a run, so the desktop's
    // update gate (hello run ids) does not wait for it.
    if (this.options.scripts?.keepsHostAwake()) return true;
    if (this.closed || this.draining || this.approvalExecutor.hasActiveWork() || this.choiceExecutor.hasActiveWork() || this.mentionExecutor.hasActiveWork() ||
        (this.chat.activeParticipantRuns?.().length ?? 0) > 0 || (this.chat.liveRunIds?.().length ?? 0) > 0) return true;
    const unsent = await this.options.unsentServerWrites?.().catch(() => ({ queued: 1 }));
    return (unsent?.queued ?? 0) > 0;
  }

  /** Fences new work, then lets the idle stop commit only if nothing came in
   *  meanwhile. */
  async prepareIdleStop(request: {
    bootId: string; uptimeMs: number; idleSinceMs: number;
    fenceNative(): (() => void) | undefined;
    stopProviders(): Promise<void>;
    commitHostStop?(prepareLocal: () => Promise<boolean>): Promise<boolean>;
  }): Promise<(() => Promise<void>) | undefined> {
    if (this.idleFenced || await this.hasWorkForIdleStop()) return undefined;
    if (this.idleFenced) return undefined;
    this.idleFenced = true;
    let releaseNative: (() => void) | undefined;
    let committed = false;
    try {
      await this.inbound;
      // A script request already taken (switching one on) is part of what
      // decides whether this machine may stop.
      await this.scriptsQueue;
      if (await this.hasWorkForIdleStop()) return undefined;
      releaseNative = request.fenceNative();
      if (!releaseNative) return undefined;
      const prepareLocal = () => this.options.storage.machinePower().tryFence(request.bootId, request.uptimeMs, randomUUID(), request.idleSinceMs);
      committed = await (request.commitHostStop ? request.commitHostStop(prepareLocal) : prepareLocal());
      if (!committed) return undefined;
      return () => this.shutdown(request.stopProviders, false);
    } catch (error) {
      // An uncertain file/SQLite result is not permission to reopen native
      // work after a durable fence might have committed.
      committed = Boolean(await this.options.storage.machinePower().stopFence(request.bootId).catch(() => "unconfirmed"));
      if (committed) this.uncertainIdleRelease = releaseNative;
      throw error;
    } finally {
      if (!committed) {
        releaseNative?.();
        this.idleFenced = false;
        this.fenceLifted();
      }
    }
  }

  /** A failed fence read is recoverable without restarting the runtime. */
  async recoverIdleFence(bootId: string): Promise<boolean> {
    if (await this.options.storage.machinePower().stopFence(bootId)) return true;
    this.uncertainIdleRelease?.();
    this.uncertainIdleRelease = undefined;
    this.idleFenced = false;
    this.fenceLifted();
    return false;
  }

  private readonly fenceListeners: Array<() => void> = [];

  /** The idle fence is gone: turns that waited on the server are taken now. */
  onFenceLifted(listener: () => void): void {
    this.fenceListeners.push(listener);
  }

  private fenceLifted(): void {
    for (const listener of this.fenceListeners) {
      try { listener(); } catch { /* a listener never breaks the fence */ }
    }
  }

  /** This runtime, as a durable claim names its owner. */
  nativeRuntimeIdentity(): Promise<NativeRuntimeIdentity> {
    return this.getRuntimeIdentity();
  }

  private runtimeIdentity?: Promise<NativeRuntimeIdentity>;

  private getRuntimeIdentity(): Promise<NativeRuntimeIdentity> {
    const identity = this.runtimeIdentity ??= (async () => {
      const identity = (await readPosixProcessTableAsync())?.get(process.pid);
      if (!identity) throw new Error("This runtime's process identity could not be verified.");
      return { runtimeId: this.instanceId, pid: identity.pid, startedAt: identity.startedAt };
    })();
    void identity.catch(() => { if (this.runtimeIdentity === identity) this.runtimeIdentity = undefined; });
    return identity;
  }

  // --- pictures -------------------------------------------------------------

  /**
   * The bytes of a picture this chat carries, from the desktop that holds it.
   * The picture arrives in parts; the wait is bounded per part, so a desktop
   * that stops answering fails the read rather than leaving the member waiting
   * for the rest of its turn.
   */
  async requestAttachment(conversationId: string, attachmentId: string, timeoutMs = ATTACHMENT_PART_TIMEOUT_MS): Promise<MachineAttachmentBytes> {
    const requestId = randomUUID();
    const pending = new Promise<MachineAttachmentBytes>((resolve, reject) => {
      const waiter: MachineAttachmentWaiter = {
        resolve, reject, timeoutMs, chunks: new Map(),
        timer: setTimeout(() => this.failAttachment(requestId, "The desktop did not answer with this picture in time."), timeoutMs)
      };
      waiter.timer.unref?.();
      this.pendingAttachments.set(requestId, waiter);
    });
    try {
      await this.send({ type: "machine.attachment.request", requestId, conversationId, attachmentId });
    } catch (error) {
      this.failAttachment(requestId, errorMessage(error));
    }
    return pending;
  }

  private failAttachment(requestId: string, message: string): void {
    const waiter = this.pendingAttachments.get(requestId);
    if (!waiter) return;
    this.pendingAttachments.delete(requestId);
    clearTimeout(waiter.timer);
    waiter.reject(new Error(message));
  }

  private failAllAttachments(message: string): void {
    for (const requestId of [...this.pendingAttachments.keys()]) this.failAttachment(requestId, message);
  }

  private receiveAttachmentPart(body: MachineAttachmentResultBody): void {
    const waiter = this.pendingAttachments.get(body.requestId);
    if (!waiter) return;
    if (!body.ok || typeof body.dataBase64 !== "string") {
      this.failAttachment(body.requestId, body.error ?? "The desktop could not read this picture.");
      return;
    }
    const parts = Number.isInteger(body.parts) && (body.parts as number) > 0 ? (body.parts as number) : 1;
    const part = Number.isInteger(body.part) && (body.part as number) >= 0 ? (body.part as number) : 0;
    if (part >= parts) return;
    waiter.parts = parts;
    waiter.chunks.set(part, Buffer.from(body.dataBase64, "base64"));
    if (body.mediaType) waiter.mediaType = body.mediaType;
    if (body.fileName) waiter.fileName = body.fileName;
    if (waiter.chunks.size < parts) {
      // Progress: the bound restarts with every part that arrives.
      clearTimeout(waiter.timer);
      waiter.timer = setTimeout(() => this.failAttachment(body.requestId, "The desktop stopped sending this picture."), waiter.timeoutMs);
      waiter.timer.unref?.();
      return;
    }
    this.pendingAttachments.delete(body.requestId);
    clearTimeout(waiter.timer);
    const ordered = Array.from({ length: parts }, (_, index) => waiter.chunks.get(index) as Buffer);
    waiter.resolve({
      dataBase64: Buffer.concat(ordered).toString("base64"),
      ...(waiter.mediaType ? { mediaType: waiter.mediaType } : {}),
      ...(waiter.fileName ? { fileName: waiter.fileName } : {})
    });
  }

  // --- the desktop in the room ----------------------------------------------

  private desktopAway(reason: "left" | "not-in-room" | "own-link"): void {
    if (!this.desktopDeviceId) return;
    const deviceId = this.desktopDeviceId;
    this.desktopDeviceId = undefined;
    void this.debugLogs.write("machine-host.desktop.away", { deviceId, reason });
    this.failAllAttachments("The desktop went away before answering with this picture.");
    // The next streams to it start whole.
    for (const sender of this.roomProgress.values()) sender.close();
    this.roomProgress.clear();
  }

  private setDesktop(deviceId: string | undefined, options: { announce?: boolean } = {}): void {
    if (!deviceId) return;
    const changed = this.desktopDeviceId !== deviceId;
    this.desktopDeviceId = deviceId;
    if (changed || options.announce) {
      // A desktop that (re)connected missed what was streamed meanwhile: its
      // runs' next frames start whole.
      for (const sender of this.roomProgress.values()) sender.close();
      this.roomProgress.clear();
      void this.debugLogs.write("machine-host.hello.sending", { reason: options.announce ? "link-ready" : "desktop-changed", deviceId });
      void this.sendHello().catch((error) => {
        void this.debugLogs.write("machine-host.hello.error", { message: errorMessage(error) });
      });
    }
  }

  private async sendHello(to?: string): Promise<void> {
    let providers: MachineHelloBody["providers"] = [];
    try {
      const agents = await this.options.detectProviders?.();
      providers = (agents ?? []).map((agent) => ({
        kind: agent.kind,
        installed: agent.installed,
        ...(agent.version ? { version: agent.version } : {})
      }));
    } catch {
      providers = [];
    }
    const unsent = await this.options.unsentServerWrites?.().catch(() => undefined);
    await this.send({
      type: "machine.hello",
      deviceId: this.options.deviceId,
      machineName: this.options.machineName ?? os.hostname(),
      appVersion: this.options.appVersion,
      platform: `${process.platform}-${process.arch}`,
      providers,
      publicKeyDerBase64: this.options.publicKeyDerBase64,
      activeRunIds: [...new Set([...(this.chat.activeParticipantRuns?.() ?? []).map((run) => run.runId), ...(this.chat.liveRunIds?.() ?? [])])],
      instanceId: this.instanceId,
      instanceStartedAt: this.instanceStartedAt,
      ...(typeof this.instanceSequence === "number" ? { instanceSequence: this.instanceSequence } : {}),
      ...(unsent && unsent.queued > 0 && unsent.lastError
        ? { unsentWarning: `${unsent.queued} change${unsent.queued === 1 ? "" : "s"} from this machine ha${unsent.queued === 1 ? "s" : "ve"} not reached your server yet: ${unsent.lastError}` }
        : {}),
      ...(this.options.idleStopWarning?.() ? { idleStopWarning: this.options.idleStopWarning() } : {}),
      ...(typeof this.options.autoStopEnabled?.() === "boolean" ? { autoStopEnabled: this.options.autoStopEnabled() } : {}),
      ...(this.options.scripts ? {
        scriptsSupported: true,
        keepAwake: this.options.scripts.keepsHostAwake(),
        keepAwakeScripts: this.options.scripts.scheduledCount?.() ?? 0
      } : {})
    }, to);
    // A desktop that (re)connects learns what is running in the background now.
    this.sendMemberBackgroundSnapshot(to);
  }

  private sendMemberBackgroundSnapshot(to?: string): void {
    if (this.closed || !this.chat.localBackgroundTasks) return;
    void this.send({
      type: "machine.member.background.snapshot",
      members: this.chat.localBackgroundTasks().map((event) => ({
        conversationId: event.conversationId,
        participantId: event.participantId,
        labels: event.labels
      }))
    }, to).catch((error) => {
      void this.debugLogs.write("machine-host.background.snapshot-not-sent", { message: errorMessage(error) });
    });
  }

  private sendMemberBackground(event: ChatBackgroundTasksEvent, to?: string): void {
    if (this.closed) return;
    void this.send({
      type: "machine.member.background",
      conversationId: event.conversationId,
      participantId: event.participantId,
      labels: event.labels
    }, to).catch((error) => {
      void this.debugLogs.write("machine-host.background.not-sent", { participantId: event.participantId, message: errorMessage(error) });
    });
  }

  // --- live progress --------------------------------------------------------

  /** A member's progress here, as the machine's ChatService reports it: to
   *  the computer's window live (in the room) and to the server for the phone.
   *  Nothing keeps it once the run is over. */
  noteNativeProgress(progress: ReviewProgress): void {
    const conversationId = this.chat.conversationIdForRun?.(progress.runId)
      ?? this.chat.activeParticipantRuns?.().find((run) => run.runId === progress.runId)?.conversationId;
    if (conversationId) this.noteProgressFor(conversationId, progress);
  }

  private noteProgressFor(conversationId: string, progress: ReviewProgress): void {
    if (this.closed || !progress.agentProgress) return;
    const terminal = progress.phase === "done" || progress.phase === "error" || progress.phase === "cancelled" || progress.agentProgress.state === "finished";
    if (this.desktopDeviceId) {
      this.noteStream(this.roomProgress, conversationId, progress, terminal, LIVE_PROGRESS_TEXT_FLUSH_MS, (frame) => this.send(frame));
    }
    if (this.options.postProgress) {
      const post = this.options.postProgress;
      this.noteStream(this.serverProgress, conversationId, progress, terminal, SERVER_PROGRESS_TEXT_FLUSH_MS, (frame) => post([frame]));
    }
  }

  private noteStream(streams: Map<string, MachineProgressSender<void>>, conversationId: string, progress: ReviewProgress, terminal: boolean,
    textFlushMs: number, publish: (frame: MachineProgressFrame) => Promise<void>): void {
    let sender = streams.get(progress.runId);
    if (!sender) {
      if (terminal) return;
      const runId = progress.runId;
      const created: MachineProgressSender<void> = new MachineProgressSender<void>({
        conversationId,
        textFlushMs,
        publish,
        stored: async () => undefined,
        onError: (error) => {
          // Live progress is not caught up later: this stream stops, and the
          // next update starts a new one the receiver takes whole.
          created.close();
          if (streams.get(runId) === created) streams.delete(runId);
          void this.debugLogs.write("machine-host.progress.not-sent", { runId, message: errorMessage(error) });
        },
        onRecovered: () => undefined
      });
      sender = created;
      streams.set(runId, sender);
      while (streams.size > PROGRESS_RUNS_MAX) {
        const [oldest, stale] = streams.entries().next().value as [string, MachineProgressSender<void>];
        stale.close();
        streams.delete(oldest);
      }
    }
    sender.note(progress);
    if (terminal) {
      const finished = sender;
      streams.delete(progress.runId);
      void finished.finish().catch(() => undefined);
    }
  }

  // --- scheduled scripts ----------------------------------------------------

  /** Tell the desktop the scripts changed, so its Settings and cards refresh.
   *  Best effort and coalesced: a desktop that is away asks again when it
   *  reconnects. */
  noteScriptsChanged(): void {
    if (!this.desktopDeviceId || this.closed || this.scriptsChangedTimer) return;
    this.scriptsChangedTimer = setTimeout(() => {
      this.scriptsChangedTimer = undefined;
      if (!this.desktopDeviceId || this.closed) return;
      void this.send({ type: "machine.scripts.changed" }).catch(() => undefined);
    }, SCRIPTS_CHANGED_COALESCE_MS);
    this.scriptsChangedTimer.unref?.();
  }

  /** One desktop request on this machine's scripts, always answered. A
   *  request made for an earlier run of this runtime is refused, so a frame
   *  kept and replayed after a restart changes nothing. */
  private answerScriptsRequest(body: MachineScriptsRequestBody, replyTo: string | undefined): void {
    const fail = (error: string): MachineLinkMessage => ({ type: "machine.scripts.result", requestId: body.requestId, ok: false, error });
    const answer = async (): Promise<void> => {
      const scripts = this.options.scripts;
      const expiresAt = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : Number.NaN;
      let reply: MachineLinkMessage;
      if (!scripts) {
        reply = fail("This machine runtime does not host scheduled scripts; upgrade it.");
      } else if (body.instanceId !== this.instanceId) {
        reply = fail("The machine restarted since this was asked; try again.");
      } else if (!Number.isFinite(expiresAt) || this.now().getTime() > expiresAt + SCRIPTS_REQUEST_CLOCK_SKEW_MS) {
        // The desktop has stopped waiting for it: doing it now would be a
        // change the User was told did not happen.
        reply = fail("This request is too old; nothing was changed.");
      } else if (changesScripts(body.operation) && (this.idleFenced || this.options.hostStopCommitted?.())) {
        reply = fail("The machine is stopping after being idle; try again when it is awake.");
      } else {
        try {
          reply = { type: "machine.scripts.result", requestId: body.requestId, ok: true, result: await scripts.handle(body.operation) };
        } catch (error) {
          reply = fail(errorMessage(error));
        }
      }
      await this.send(reply, replyTo).catch(() => undefined);
    };
    if (!changesScripts(body.operation)) {
      // Reads need no order.
      void answer().catch(() => undefined);
      return;
    }
    const run = this.scriptsQueue.then(answer);
    this.scriptsQueue = run.catch(() => undefined);
  }

  // --- the room -------------------------------------------------------------

  private async handleMessage(ciphertext: string): Promise<void> {
    // Content is sealed to these two identities; the room capability grants no reading.
    const payload = await this.openHomeFrame(ciphertext);
    if (!isMachineLinkEnvelope(payload) || this.seenMessageIds.has(payload.messageId)) return;
    const from = machineControlSender(payload);
    const issuer = this.options.pairing.issuer;
    if (from !== issuer.originId || !verifyMachineControl(payload, {
      from, to: this.options.deviceId, room: this.options.pairing.rendezvousId, publicKeyDerBase64: issuer.publicKeyDerBase64
    })) {
      throw new Error("This machine answers only the desktop that set it up, with its signature.");
    }
    this.seenMessageIds.add(payload.messageId);
    if (this.seenMessageIds.size > 10_000) {
      const first = this.seenMessageIds.values().next().value;
      if (first) this.seenMessageIds.delete(first);
    }
    await this.handleBody(payload.body, from);
  }

  private async openHomeFrame(ciphertext: string): Promise<unknown> {
    const header = JSON.parse(ciphertext) as { senderPublicKeyDerBase64?: unknown };
    if (!header.senderPublicKeyDerBase64) {
      // The desktop's first word, before it knows this machine's key: only a
      // request to be greeted, sealed with the enrollment's key.
      const bootstrap = await openChannelPayload<unknown>(ciphertext, this.options.pairing.relaySealKeyBase64);
      if (isMachineLinkEnvelope(bootstrap) && bootstrap.body.type === "machine.hello.request") return bootstrap;
      throw new Error("Only a greeting request may be sealed with the enrollment's key.");
    }
    return openMachinePayload(ciphertext, await this.options.identity(), [this.options.pairing.issuer.publicKeyDerBase64], this.options.pairing.rendezvousId);
  }

  private async handleBody(body: MachineLinkMessage, replyTo: string): Promise<void> {
    void this.debugLogs.write("machine-host.message", { type: body.type });
    switch (body.type) {
      case "machine.hello.ack":
        // Applied in order, maybe after the desktop left or this machine's
        // link dropped: it counts as here only while the room says so.
        if (this.desktopInRoom) this.desktopDeviceId = body.desktopDeviceId || this.desktopDeviceId;
        if (body.machineName?.trim()) this.options.onDesktopMachineName?.(body.machineName.trim());
        return;
      case "machine.member.background.request":
        this.sendMemberBackgroundSnapshot(replyTo);
        return;
      case "machine.hello.request":
        // A (re)started desktop asks to be greeted.
        if (this.desktopInRoom) this.setDesktop(this.options.pairing.issuer.originId, { announce: true });
        return;
      case "machine.attachment.result":
        this.receiveAttachmentPart(body);
        return;
      case "machine.turns.hold":
        this.holdTurns(body.until, body.reason);
        return;
      case "machine.turns.release":
        this.releaseTurns("released");
        return;
      case "machine.scripts.request":
        this.answerScriptsRequest(body, replyTo);
        return;
      default:
        return;
    }
  }

  private send(body: MachineLinkMessage, to?: string): Promise<void> {
    const run = this.outbound.then(() => this.sendNow(body, to));
    this.outbound = run.then(() => undefined, () => undefined);
    return run;
  }

  private async sendNow(body: MachineLinkMessage, recipient?: string): Promise<void> {
    if (this.closed) return;
    const to = recipient ?? this.desktopDeviceId;
    if (!to) throw new Error("The desktop is not connected.");
    const envelope: MachineLinkEnvelope = {
      protocol: MACHINE_LINK_PROTOCOL,
      messageId: randomUUID(),
      sentAt: this.now().toISOString(),
      body
    };
    const identity = await this.options.identity();
    const signed = signMachineControl(envelope, identity, this.options.pairing.rendezvousId, to);
    const ciphertext = await sealMachinePayload(signed, identity, this.options.pairing.issuer.publicKeyDerBase64, this.options.pairing.rendezvousId);
    await this.client.sendCiphertext({ logicalMessageId: envelope.messageId, ciphertext, to });
  }

  private nextInstanceSequence(): { sequence?: number; error?: string } {
    const file = this.options.instancePath;
    if (!file) return { sequence: Date.now() };
    return advanceInstanceSequence({
      read: () => readFileSync(file, "utf8"),
      write: (content) => {
        mkdirSync(path.dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, content, "utf8");
        renameSync(temp, file);
      },
      now: () => Date.now()
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
