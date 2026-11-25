import { stat } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, ChatParticipant, Conversation } from "../../../../shared/types";
import { chatParticipantHome, chatParticipantHomeUnassignedMessage } from "../../../../shared/chatParticipantHome";
import { chatParticipants } from "../members/identity";
import { stableJson } from "../store/messages";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** Which device runs this chat service (the computer or a machine), whose members it runs, and where the chats' project folders are on it. */
export class ChatHost {
  /** Set inside a machine runtime: the desktop's record id for this machine. */
  hostMachineId?: string;
  machineRuntime = false;
  /** Machine side: where the computer's projects live here, by the
   *  computer's path (from the settings it published for this machine). */
  private machineProjects: Record<string, string> = {};

  constructor(
    private readonly chat: Pick<ChatModules, "serverLink" | "store">,
    private readonly deps: Pick<ChatDependencies, "storage">
  ) {}

  /** Machines transport, machine side: members whose home is this id are
   *  this runtime's own (swept, resumed, and run here like local ones). */
  setHostMachineId(machineId: string | undefined): void {
    this.machineRuntime = true;
    this.hostMachineId = machineId;
  }

  /** A replicated roster is context, not authority to use another host's CLI. */
  ownsParticipant(participant: ChatParticipant): boolean {
    const home = chatParticipantHome(participant);
    return this.machineRuntime
      ? Boolean(this.hostMachineId && home.kind === "machine" && home.machineId === this.hostMachineId)
      : home.kind === "this-machine";
  }

  assertOwnsParticipant(participant: ChatParticipant): void {
    if (this.ownsParticipant(participant)) return;
    if (chatParticipantHome(participant).kind === "unassigned") {
      throw new Error(chatParticipantHomeUnassignedMessage(participant.handle));
    }
    throw new Error(`@${participant.handle} belongs to another machine; no local session was started.`);
  }

  /** Machine side: where the computer's projects live on this machine. */
  setMachineProjects(projects: Record<string, string>): void {
    this.machineProjects = { ...projects };
  }

  /** Machine side: a chat's project folder here, as the computer's settings
   *  for this machine say now (before a member works in it). */
  async refreshMachineRepository(conversationId: string): Promise<void> {
    if (!this.hostMachineId) return;
    const conversation = await this.deps.storage.getConversation(conversationId);
    if (!conversation || conversation.kind !== "chat") return;
    const recorded = conversation.metadata.machineRepository as { sourcePath?: string } | undefined;
    const sourcePath = recorded?.sourcePath ?? conversation.repoPath;
    if (!sourcePath) return;
    await this.chat.store.withChatMutation(conversation, async () => {
      const before = stableJson({ repository: conversation.metadata.machineRepository ?? null, repoPath: conversation.repoPath ?? null });
      this.localizeRepoPath(conversation, sourcePath);
      if (stableJson({ repository: conversation.metadata.machineRepository ?? null, repoPath: conversation.repoPath ?? null }) === before) return;
      await this.chat.store.saveConversation(conversation, { emitChanges: false });
    });
  }

  /** Why the member cannot start in a folder that is gone, instead of the
   *  process error that reads as a missing CLI. On a cloud machine that is
   *  the machine's copy of the project, deleted on the instance. */
  async missingRunFolder(conversation: Conversation, runPath: string): Promise<{ reason: string; machineCopy: boolean; copyOf?: string } | undefined> {
    let notFolder = false;
    try {
      if ((await stat(runPath)).isDirectory()) return undefined;
      notFolder = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
    }
    const sourcePath = (conversation.metadata.machineRepository as { sourcePath?: unknown } | undefined)?.sourcePath;
    if (this.hostMachineId && typeof sourcePath === "string" && sourcePath.trim()) {
      return { reason: `the copy of ${path.basename(sourcePath)} on this cloud machine is missing`, machineCopy: true, copyOf: sourcePath };
    }
    return { reason: notFolder ? `${runPath} is not a folder` : `the folder ${runPath} does not exist`, machineCopy: false };
  }

  /** The machine to send a Stop to when this copy cannot name the run's member.
   *  Only answered when the chat leaves no doubt: exactly one member lives on a
   *  machine, so the run can only be that machine's. The phone's own Stop makes
   *  the same call for the same reason (`machineRunForCancel`). */
  soleMachineMemberHome(conversation: Conversation): string | undefined {
    const homes = new Set(chatParticipants(conversation)
      .map((member) => member.homeMachineId)
      .filter((home): home is string => Boolean(home) && home !== this.hostMachineId));
    return homes.size === 1 ? [...homes][0] : undefined;
  }

  /** Machine side: records where a chat's project lives here before a turn
   *  runs in it. Device-local; never part of the chat's shared state. */
  async applyMachineRepository(conversationId: string, repository: { sourcePath: string; paths: Record<string, string> } | undefined): Promise<void> {
    if (!repository || !this.hostMachineId) return;
    const conversation = await this.deps.storage.getConversation(conversationId);
    if (!conversation || conversation.kind !== "chat") return;
    await this.chat.store.withChatMutation(conversation, async () => {
      const before = stableJson({ repository: conversation.metadata.machineRepository ?? null, repoPath: conversation.repoPath ?? null });
      conversation.metadata = { ...conversation.metadata, machineRepository: repository };
      this.localizeRepoPath(conversation, repository.sourcePath);
      if (stableJson({ repository: conversation.metadata.machineRepository ?? null, repoPath: conversation.repoPath ?? null }) === before) return;
      await this.chat.store.saveConversation(conversation, { emitChanges: false });
    });
  }

  /** On a machine the stored path is this machine's copy of the project; the
   *  desktop's path is kept as the project's identity. */
  localizeRepoPath(conversation: Conversation, desktopRepoPath: string | undefined): void {
    if (!this.hostMachineId) return;
    if (!desktopRepoPath) {
      delete conversation.repoPath;
      return;
    }
    const current = conversation.metadata.machineRepository as { sourcePath?: string; paths?: Record<string, string> } | undefined;
    let paths = current?.sourcePath === desktopRepoPath && current.paths ? current.paths : {};
    // Where the computer said this project lives here wins.
    const published = this.machineProjects[desktopRepoPath];
    if (published) paths = { ...paths, [this.hostMachineId]: published };
    conversation.metadata = { ...conversation.metadata, machineRepository: { sourcePath: desktopRepoPath, paths } };
    conversation.repoPath = paths[this.hostMachineId] ?? desktopRepoPath;
  }

  /** Whether this device writes this message on the server: one it wrote
   *  there, or a new one it may write (a member's only where it runs, Д4).
   *  Never a placeholder for a member that runs elsewhere. */
  mayWriteOnServer(conversation: Conversation, message: ChatMessage): boolean {
    const queue = this.chat.serverLink.serverQueue();
    if (!queue || message.metadata?.serverPlaceholder) return false;
    const writer = message.metadata?.serverWriter;
    if (typeof writer === "string") return writer === queue.deviceId();
    if (message.role !== "participant") return true;
    const participant = chatParticipants(conversation).find((item) => item.id === message.participantId);
    return Boolean(participant) && this.runsHere(participant!);
  }

  /** Whether a member runs on this device (Д4): a machine runs the members
   *  homed on it; the computer runs every member without a machine. */
  runsHere(participant: Pick<ChatParticipant, "homeMachineId" | "cloudRun">): boolean {
    if (this.machineRuntime) return Boolean(this.hostMachineId) && participant.homeMachineId === this.hostMachineId;
    return !participant.homeMachineId && !participant.cloudRun;
  }
}
