import { applyChatAccessOptionById } from "../../../../shared/chatAccessModes";
import type { ChatParticipant, Conversation } from "../../../../shared/types";
import { effectiveChatAgentPermissionsForProvider, normalizeChatAgentMode } from "../../../../shared/agentPermissions";
import {
  CLAUDE_PERMISSION_MODE_LABELS, CLAUDE_PERMISSION_MODE_TIMEOUT_MS, CliAgentRunner, claudePermissionModeRank,
  isClaudePermissionMode, type ClaudePermissionMode
} from "../../cliAgents";
import { chatParticipants, claudeMemberMode, participantForRun } from "../members/identity";
import { addConversationWarning, createChatMessage } from "../store/messages";
import type { ChatAppMcpTokenGrant } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** Claude Code's tools that edit files (a once-only grant of file edits
 *  answers one of them; ChatService.takeClaudeOnceEdit). */
const CLAUDE_FILE_EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Claude Code's permission mode of each member: saved, followed and applied to its live CLI. */
export class ClaudeModes {
  /** Claude Code's permission mode each member in Claude Code's own mode that
   *  runs here is in as its chat was last saved on this device, by
   *  `conversationId:participantId` (noteSavedClaudeMemberModes). */
  readonly savedClaudeMemberModes = new Map<string, ClaudePermissionMode>();
  /** A mode Claude Code moved a member to itself (a plan she approved), by
   *  `conversationId:participantId`, until the member's saved mode follows
   *  it (followClaudeCliMode): a save from before does not switch it back. */
  private readonly cliMovedClaudeModes = new Map<string, ClaudePermissionMode>();
  /** Claude Code's own modes: runs holding a once-only grant of file edits
   *  not used yet (by run id: the grant's approvals). */
  readonly claudeOnceEditGrants = new Map<string, string[]>();

  constructor(
    private readonly chat: Pick<ChatModules, "activeRuns" | "appMcpGrants" | "host" | "permissionRequests" | "runCancel" | "store">,
    private readonly deps: Pick<ChatDependencies, "appMcp" | "cliRunner" | "debugLogs">
  ) {}

  /**
   * Claude Code's permission mode belongs to the session: when a save changes
   * the mode a member in Claude Code's own mode runs in on this device (the
   * User's menu here, her change on another device reaching this one, an
   * approved file-edit right, the main session's mode it is held to), its
   * live process switches now, in the reply running too, as Shift+Tab
   * switches it in the CLI. Every save passes here once it is written,
   * whichever path made it, in the order the chat's saves are written.
   */
  noteSavedClaudeMemberModes(conversation: Conversation): void {
    if (conversation.kind !== "chat") return;
    try {
      const prefix = `${conversation.id}:`;
      const kept = new Set<string>();
      for (const member of chatParticipants(conversation)) {
        const mode = this.chat.host.runsHere(member) ? claudeMemberMode(conversation, member) : undefined;
        if (!mode) continue;
        const key = `${prefix}${member.id}`;
        kept.add(key);
        // The CLI moved this member's mode itself and the save that follows
        // it has not landed: a save still carrying the old mode does not
        // switch the process back (followClaudeCliMode).
        const moved = this.cliMovedClaudeModes.get(key);
        if (moved !== undefined && moved !== mode) continue;
        if (moved !== undefined) this.cliMovedClaudeModes.delete(key);
        const before = this.savedClaudeMemberModes.get(key);
        this.savedClaudeMemberModes.set(key, mode);
        if (before !== undefined && before !== mode) void this.applyClaudeMemberMode(conversation, member, before, mode);
      }
      for (const key of Array.from(this.savedClaudeMemberModes.keys())) {
        if (key.startsWith(prefix) && !kept.has(key)) this.savedClaudeMemberModes.delete(key);
      }
    } catch (error) {
      void this.deps.debugLogs.write("chat.member-mode.note-failed", {
        conversationId: conversation.id,
        message: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined);
    }
  }

  /**
   * Claude Code moved a member's mode itself: a plan the User approved moves
   * it to the mode she picked, as the CLI's own dialog does. The member's
   * mode follows the CLI (the User, 2026-11-22): saved as its mode, so its
   * next message runs in it, without being switched back to Plan, and every
   * device shows it. The process is in it already: from now on a message
   * goes in without switching it, and a save from before the switch does
   * not switch it back.
   */
  followClaudeCliMode(conversationId: string, participantId: string, mode: ClaudePermissionMode): void {
    const key = `${conversationId}:${participantId}`;
    const before = this.savedClaudeMemberModes.get(key);
    if (before === mode) return;
    this.savedClaudeMemberModes.set(key, mode);
    this.cliMovedClaudeModes.set(key, mode);
    void this.saveClaudeCliMode(conversationId, participantId, before, mode).finally(() => {
      if (this.cliMovedClaudeModes.get(key) === mode) this.cliMovedClaudeModes.delete(key);
    });
  }

  /** The member's saved mode becomes the mode the CLI moved to (its file-edit
   *  right telling Manual from Accept edits, every other right kept), through
   *  the member settings' own save. A mode she picked meanwhile wins: the
   *  process is switched to hers instead. */
  private async saveClaudeCliMode(conversationId: string, participantId: string, before: ClaudePermissionMode | undefined, mode: ClaudePermissionMode): Promise<void> {
    const audit = { conversationId, participantId, from: before ?? null, to: mode };
    try {
      const conversation = { id: conversationId, kind: "chat", messages: [], metadata: {} } as unknown as Conversation;
      const outcome = await this.chat.store.withSavedChat(conversation, async () => {
        const member = chatParticipants(conversation).find((participant) => participant.id === participantId);
        // As it runs (a member the main session made is held to its mode).
        const saved = member ? claudeMemberMode(conversation, member) : undefined;
        if (!member || !saved) return "gone" as const;
        if (saved === mode) return "same" as const;
        if (before !== undefined && saved !== before) return { changed: member, to: saved };
        const next = applyChatAccessOptionById("claude-code", mode, member.permissions);
        conversation.metadata = {
          ...conversation.metadata,
          participants: chatParticipants(conversation).map((participant) =>
            participant.id === participantId ? { ...participant, agentMode: next.agentMode, permissions: next.permissions } : participant)
        };
        conversation.updatedAt = new Date().toISOString();
        await this.chat.store.saveConversation(conversation);
        // The app tool grant of its live process leaves the old mode too, for
        // the rest of the turn (its permission cards go by the mode).
        const updated = chatParticipants(conversation).find((participant) => participant.id === participantId);
        if (updated) this.grantLiveMemberMode(conversation, updated);
        return "saved" as const;
      });
      if (typeof outcome === "object") {
        // She picked another mode meanwhile: hers is the member's mode.
        this.cliMovedClaudeModes.delete(`${conversationId}:${participantId}`);
        this.savedClaudeMemberModes.set(`${conversationId}:${participantId}`, outcome.to);
        void this.applyClaudeMemberMode(conversation, outcome.changed, mode, outcome.to);
      }
      await this.deps.debugLogs.write("chat.member-mode.followed-cli", { ...audit, outcome: typeof outcome === "object" ? "user-changed" : outcome });
    } catch (error) {
      await this.deps.debugLogs.write("chat.member-mode.follow-cli-failed", {
        ...audit,
        message: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined);
    }
  }

  /** Sends the member's new mode to its live Claude Code process, answering
   *  or idle (`set_permission_mode`). No live process: its next turn starts
   *  in the saved mode. Not switched: the saved mode stays, and the member's
   *  next message switches its process first (cliAgents
   *  alignClaudePermissionMode). */
  private async applyClaudeMemberMode(conversation: Conversation, member: ChatParticipant, before: ClaudePermissionMode, mode: ClaudePermissionMode): Promise<void> {
    const runner = this.deps.cliRunner as Partial<Pick<CliAgentRunner, "memberClaudeControl" | "memberClaudePermissionMode">>;
    if (!runner.memberClaudeControl) return;
    const key = `${conversation.id}:${member.id}`;
    const audit = { conversationId: conversation.id, participantId: member.id, from: before, to: mode };
    const runsNow = (): ClaudePermissionMode | undefined => runner.memberClaudePermissionMode?.call(this.deps.cliRunner, conversation.id, member.id);
    let reason: string | undefined;
    let actual: ClaudePermissionMode | undefined;
    // A mode the CLI reports that is none of its four: taken as wider.
    let unknownMode: string | undefined;
    try {
      const answer = await runner.memberClaudeControl.call(this.deps.cliRunner, conversation.id, member.id, { subtype: "set_permission_mode", mode }, CLAUDE_PERMISSION_MODE_TIMEOUT_MS);
      if (!answer) return;
      const reported = typeof answer.mode === "string" ? answer.mode : mode;
      if (reported === mode) {
        this.grantLiveMemberMode(conversation, member);
        await this.deps.debugLogs.write("chat.member-mode.applied", audit);
        return;
      }
      if (isClaudePermissionMode(reported)) actual = reported;
      else unknownMode = reported;
    } catch (error) {
      reason = (error instanceof Error ? error.message : String(error)).replace(/[.\s]+$/, "");
      actual = runsNow();
    }
    await this.deps.debugLogs.write("chat.member-mode.apply-failed", { ...audit, runs: actual ?? null, message: reason ?? null }).catch(() => undefined);
    // She picked yet another mode meanwhile: that one is being set now.
    if (this.savedClaudeMemberModes.get(key) !== mode) return;
    const name = `@${member.handle}`;
    const label = CLAUDE_PERMISSION_MODE_LABELS[mode];
    const runs = actual && actual !== mode ? CLAUDE_PERMISSION_MODE_LABELS[actual] : unknownMode;
    const said = reason !== undefined
      ? `Claude Code did not switch ${name} to ${label}: ${reason}.`
      : `Claude Code switched ${name} to ${runs ?? "another mode"} instead of ${label}.`;
    if (unknownMode !== undefined || (actual && actual !== mode && claudePermissionModeRank(actual) > claudePermissionModeRank(mode))) {
      // Its process stays in a wider mode than hers: her mode stays the
      // member's (never written back up) and its app tools go by it now; its
      // next message switches the process first or is refused (cliAgents
      // alignClaudePermissionMode), a reply it starts on its own is aligned
      // first or stopped (alignSelfStartedClaudeReply), and a reply it is
      // writing now is stopped rather than go on wider.
      this.grantLiveMemberMode(conversation, member);
      const stopped = this.stopClaudeMemberReplies(conversation, member.id);
      this.postMemberModeNotice(conversation.id, `${said} ${stopped ? `Its reply was stopped so it does not go on in ${runs}; its` : "Its"} next message switches it to ${label} first.`);
      return;
    }
    this.postMemberModeNotice(conversation.id, `${said}${reason !== undefined && runs ? ` ${name} stays in ${runs}.` : ""}`);
    // The CLI runs a narrower mode than hers (its account has no auto mode,
    // say): the member's mode is what its CLI runs, its menu shows it.
    if (actual && actual !== mode) this.followClaudeCliMode(conversation.id, member.id, actual);
  }

  /** Stops the member's replies its CLI is writing on this device, as its
   *  Stop does; whether one was. A turn still waiting in the app goes in
   *  later and switches the process first (alignClaudePermissionMode). */
  private stopClaudeMemberReplies(conversation: Conversation, participantId: string): boolean {
    const pendingById = new Map(conversation.messages.map((message) => [message.id, message]));
    const runIds: string[] = [];
    for (const [runId, meta] of this.chat.activeRuns.chatRunMeta) {
      if (meta.conversationId !== conversation.id || meta.participantId !== participantId || !this.chat.activeRuns.chatRunControllers.has(runId)) continue;
      const pending = meta.pendingMessageId ? pendingById.get(meta.pendingMessageId) : undefined;
      if (pending?.metadata?.turnQueued || pending?.metadata?.queuedBehind) continue;
      runIds.push(runId);
    }
    for (const runId of runIds) this.chat.runCancel.cancelRun(runId);
    return runIds.length > 0;
  }

  /** A reply the member's CLI started on its own (a background task ended):
   *  its process runs a wider mode than the member's (a lowered mode it did
   *  not take) is switched first; true when it could not be (the reply is
   *  then stopped). */
  async alignSelfStartedClaudeReply(conversation: Conversation, participant: ChatParticipant): Promise<boolean> {
    const runner = this.deps.cliRunner as Partial<Pick<CliAgentRunner, "memberClaudeControl" | "memberClaudePermissionMode">>;
    const own = claudeMemberMode(conversation, participant);
    const runs = runner.memberClaudePermissionMode?.call(this.deps.cliRunner, conversation.id, participant.id);
    if (!own || !runs || !runner.memberClaudeControl || claudePermissionModeRank(runs) <= claudePermissionModeRank(own)) return false;
    const audit = { conversationId: conversation.id, participantId: participant.id, from: runs, to: own };
    try {
      const answer = await runner.memberClaudeControl.call(this.deps.cliRunner, conversation.id, participant.id, { subtype: "set_permission_mode", mode: own }, CLAUDE_PERMISSION_MODE_TIMEOUT_MS);
      if (answer && (typeof answer.mode !== "string" || answer.mode === own)) {
        this.grantLiveMemberMode(conversation, participant);
        await this.deps.debugLogs.write("chat.member-mode.self-started-aligned", audit);
        return false;
      }
    } catch {
      // Said below.
    }
    await this.deps.debugLogs.write("chat.member-mode.self-started-stopped", audit).catch(() => undefined);
    this.postMemberModeNotice(conversation.id,
      `@${participant.handle} started a reply on its own in ${CLAUDE_PERMISSION_MODE_LABELS[runs]}, and Claude Code did not switch it to ${CLAUDE_PERMISSION_MODE_LABELS[own]}: the reply was stopped.`);
    return true;
  }

  /** What became of a member's mode, said in the chat: a line every device
   *  has (it goes to her server with the chat) and, on this device, a chat
   *  warning, as fork notices are said (postForkNotice). */
  private postMemberModeNotice(conversationId: string, text: string): void {
    void (async () => {
      const conversation = await this.chat.store.requireChat(conversationId);
      await this.chat.store.withChatMutation(conversation, async () => {
        addConversationWarning(conversation, text);
        conversation.messages.push(createChatMessage("system", text, undefined, { threadId: "system" }));
        conversation.updatedAt = new Date().toISOString();
        this.chat.store.queueSnapshot(conversation);
      });
    })().catch((error) => {
      void this.deps.debugLogs.write("chat.member-mode.notice-failed", {
        conversationId,
        message: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined);
    });
  }

  /** Takes a run's once-only grant of file edits for one file edit Claude
   *  Code asks about (Edit, Write, MultiEdit, NotebookEdit): true once, then
   *  that run asks again. */
  takeClaudeOnceEdit(runId: string | undefined, requester: ChatParticipant, toolName: string): boolean {
    if (!runId || requester.kind !== "claude-code" || !CLAUDE_FILE_EDIT_TOOLS.has(toolName)) return false;
    if (!this.claudeOnceEditGrants.has(runId)) return false;
    this.claudeOnceEditGrants.delete(runId);
    void this.deps.debugLogs.write("chat.permissions.once-edit-used", { runId, participantId: requester.id, toolName }).catch(() => undefined);
    return true;
  }

  /** After a turn that ran in another mode by a once-only grant: the member's
   *  live process back in the member's own mode (as saved now). */
  async restoreClaudeMemberMode(conversationId: string, participantId: string, read: ClaudePermissionMode): Promise<void> {
    const runner = this.deps.cliRunner as Partial<Pick<CliAgentRunner, "memberClaudeControl" | "memberClaudePermissionMode">>;
    const own = this.savedClaudeMemberModes.get(`${conversationId}:${participantId}`) ?? read;
    const runs = runner.memberClaudePermissionMode?.call(this.deps.cliRunner, conversationId, participantId);
    if (!runner.memberClaudeControl || !runs || runs === own) return;
    const audit = { conversationId, participantId, from: runs, to: own };
    try {
      if (await runner.memberClaudeControl.call(this.deps.cliRunner, conversationId, participantId, { subtype: "set_permission_mode", mode: own }, CLAUDE_PERMISSION_MODE_TIMEOUT_MS)) {
        await this.deps.debugLogs.write("chat.member-mode.restored", audit);
      }
    } catch (error) {
      // The member's next message switches its process first (cliAgents
      // alignClaudePermissionMode).
      await this.deps.debugLogs.write("chat.member-mode.restore-failed", {
        ...audit,
        message: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined);
    }
  }

  /** The app tool grant of the member's live process follows its new mode at
   *  once: its permission cards and the policies they apply go by the mode. */
  private grantLiveMemberMode(conversation: Conversation, member: ChatParticipant): void {
    const key = `${conversation.id}:${member.id}`;
    const previous = this.chat.appMcpGrants.lastAppMcpGrants.get(key);
    const token = this.chat.appMcpGrants.appMcpTokens.get(key);
    if (!previous || !token || !this.deps.appMcp?.updateToken) return;
    const agentMode = normalizeChatAgentMode(participantForRun(conversation, member).agentMode);
    const grant: ChatAppMcpTokenGrant = {
      ...previous,
      agentMode,
      runPermissions: effectiveChatAgentPermissionsForProvider(member.kind, agentMode, this.chat.permissionRequests.participantPermissionsForRun(conversation, member))
    };
    const updated = this.deps.appMcp.updateToken(token, grant);
    if (updated) {
      this.chat.appMcpGrants.appMcpConnections.set(key, updated);
      this.chat.appMcpGrants.lastAppMcpGrants.set(key, grant);
    }
  }
}
