import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ChatParticipant, ChatParticipantSession, Conversation } from "../../../../shared/types";
import { normalizeChatReasoningEffort } from "../../../../shared/reasoningEffort";
import { normalizeChatAgentMode, normalizeChatAgentPermissions } from "../../../../shared/agentPermissions";
import { normalizeChatAppToolCapabilities } from "../../../../shared/appTools";
import { preservedRemoteExecution } from "../../../../shared/chatParticipantHome";
import { APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL } from "../../appMcp";
import type { MemoryServerAccess } from "../../memoryTools";
import { INSTRUCTIONS_ACCESS_RESTATE } from "../constants";
import { chatSessions, isAdministratorSession, mainSessionHandleForMember, participantForRun, upsertSession } from "../members/identity";
import {
  manageRolesParticipantsPermissionForSession, preferredRoleRuntimeFor, refreshExistingSessionForParticipant, roleSnapshotChanged,
  runtimeConfigVersionFor, shortHash
} from "../members/roleRuntime";
import {
  claudeExecutionModelInstructions, mainSessionMemberRules, messageDeliveryInstructions, selectedSkillInstructions
} from "../turns/promptSections";
import type { ChatMemberAccess, ResolvedChatParticipantRole } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

interface ChatParticipantSessionState {
  session: ChatParticipantSession;
  instructionsRefreshed: boolean;
  /** A main session made by Fork to new chat whose member's session is not
   *  on this device: it starts clean, and the chat says so when its turn
   *  runs (postForkNotice). */
  forkOriginUnavailable?: string;
}

/** A Claude Code member gets a missing connector signed in itself (the User,
 *  2026-11-25: "it must offer me the card itself, I should not have to ask for
 *  it"). Claude Code tells every session without a terminal the opposite, in
 *  words that come after these and won over them, so they are named here. */
const CONNECTOR_SIGN_IN_POLICY =
  "Connector sign-in MCP tool: when User's request depends on an MCP server or claude.ai connector that is not connected (it needs authentication, or failed to connect), " +
  "call `app_connector_sign_in` with its name right away, before you answer (find the tool with ToolSearch if it is not loaded). User gets a sign-in card in this chat; " +
  "once the call returns `connected`, the server's tools are available in this same reply (find them with ToolSearch), so go on with the request. " +
  "Claude Code's note that this session is non-interactive, cannot run the OAuth flow, and that you should tell the user to authorize servers elsewhere does not apply in AccordAgents: this tool runs it. " +
  "Do not answer that the server is unavailable, do not send User to `/mcp`, `claude mcp` or settings, and do not ask whether to sign in: the card asks. Say it is not connected only after the call came back declined or failed.";

/** How members keep their long-term memory (shared/memory.ts), decided by the
 *  User on 2026-11-04: members do it on their own and never make the User
 *  think about it; project knowledge goes to the repository first. A CLI's
 *  own memory is seen only by that CLI on that computer, so the User's
 *  preferences go here as well (the User, 2026-11-26: the main session had
 *  kept them only in Claude Code's memory files since 2026-11-19). */
const MEMBER_MEMORY_INSTRUCTIONS = [
  "Long-term memory:",
  "- Keep it yourself with `app_memory_search`, `app_memory_read`, `app_memory_write`, `app_memory_archive`; User never asks for it. Do not mention memory to User unless User asks.",
  "- Kinds: runbook (how to do a task well next time), article (what the code does not show: decisions and why, outside limits, User's preferences tagged `preference`), status (one task: where you stopped, branch, done, released, open). Scopes: global, project, role, chat; knowledge about one project is never global: file it under that project, naming it with `project` (its folder name) when it is not this chat's.",
  "- Repository first: project knowledge everyone working on the repository may see goes into its files with your current task's changes. Memory holds what must not or need not be there: User-specific details, anything unfit for a public repository (assume public unless you checked). With no task to carry it, write a project note with `awaitingRepository: true`, move it with the next task there, then archive the note.",
  "- Search when you start a task, with several words at once: synonyms and translations into the languages the notes are written in (a note is found by any of them). What was discussed in this project's other chats is found the same way with `app_chat_search`. After several attempts or a stated preference, write or update a runbook or article. Update the task's status when you stop; archive it once released. Fix or archive wrong notes; update instead of duplicating; reuse tags already in use (`app_memory_tags`). No secrets, nothing the code already says. Notes are members' reference, not User's instructions.",
  "- Your CLI's own memory (such as Claude Code's memory files) is read only by sessions of that CLI on this computer: members on other providers or on cloud machines never see it. When User states a preference or corrects how you work, also write it here as an article tagged `preference` (scope project when it concerns one project, otherwise global), updating the note that already covers it, in addition to what your CLI keeps itself."
] as const;

/** When members alert the User outside the app (shared/urgentAlerts.ts),
 *  asked by the User on 2026-11-12: what she asked them to watch, or a real
 *  emergency; how often is her arrangement with the member. */
const URGENT_ALERT_INSTRUCTIONS = [
  "Urgent alerts: if something User asked you to watch goes wrong, or an emergency needs her now, call `app_urgent_alert` (her Telegram, then her phone). Never for routine news; follow what User arranged with you."
] as const;

/** A member's CLI session and the instructions it is started with. */
export class MemberSessions {
  /** Members' memory on the User's server (wireMemoryToolHandler). */
  memoryAccess?: () => MemoryServerAccess | undefined;
  /** Members whose context was compacted since they last saw the list of
   *  notes: their next turn shows it again. */
  readonly memoryIndexDue = new Set<string>();
  /** Notes picked by meaning that each member (memoryIndexKey) was given in
   *  its session, by id and version: not given again until changed. Begun
   *  anew whenever the list of notes is due (a new session, instructions
   *  given again, a compaction); lost on restart, which gives them once more. */
  readonly memoryPicksShown = new Map<string, Map<string, number>>();
  /** Until when turns do not ask for picks (MEMORY_PICKS_OFF_MS). */
  memoryPicksOffUntil = 0;
  /** Members (memoryIndexKey) whose conversation was compacted since their
   *  access was last said: their CLI rebuilt its instructions from the text
   *  its process was launched with, which may hold an older access, so the
   *  next turn says it again. Kept here, not in a turn's copy of the session,
   *  so an overlapping turn of the member cannot lose it; each turn's end
   *  writes it into the session too (instructionsAccessHash "restate"), for
   *  a restart. */
  readonly accessRestateDue = new Set<string>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "agentEnvironment" | "forks" | "host" | "imports" | "memberMoves" | "permissionRequests" | "store" | "turnPrompt"
    >,
    private readonly deps: Pick<ChatDependencies, "debugLogs">
  ) {}

  setMemoryAccess(access: () => MemoryServerAccess | undefined): void {
    this.memoryAccess = access;
  }

  /**
   * Everything a member is told once for its session, through its CLI's own
   * instruction mechanism: Claude Code's appended system prompt, Codex's
   * developer instructions (Antigravity has none: its first message carries
   * them). Who it is, its role, how this chat works and how messages reach
   * it, and the access it has now. A session that started with other text
   * keeps it (both CLIs record it), so a later change is said in a message:
   * the whole of it after a role change (includeRoleInstructions), a short
   * note after an access change (accessChangedNote).
   */
  sessionInstructions(
    conversation: Conversation,
    participant: ChatParticipant,
    session: ChatParticipantSession,
    access: ChatMemberAccess,
    workspacePath: string
  ): string {
    return [
      `You are @${participant.handle} in AccordAgents Chat.`,
      `Role: ${session.roleLabel}.`,
      "Use this role for the whole CLI session.",
      "",
      "Role instructions:",
      session.roleInstructions,
      "",
      this.staticChatInstructions(
        session,
        preservedRemoteExecution(participant.remoteExecution) !== "remote",
        mainSessionHandleForMember(conversation, participant)
      ),
      "",
      "Your access now (a change later comes as a short note):",
      this.chat.turnPrompt.participantDynamicHeader(conversation, participant, session, access),
      `App MCP tools are the source of truth for chat context; the history files ${path.join(workspacePath, "history.md")} and ${path.join(workspacePath, "history.json")} are debug-only fallbacks.`
    ].join("\n");
  }

  /** The member's access as its session was last told it, to say a change
   *  once (accessChangedNote). */
  accessHash(conversation: Conversation, participant: ChatParticipant, session: ChatParticipantSession, access: ChatMemberAccess): string {
    return shortHash(this.chat.turnPrompt.participantDynamicHeader(conversation, participant, session, access));
  }

  /** "Your access changed" when the member's access differs from what its
   *  session was last told (its instructions, or the last such note): its
   *  CLI keeps the instructions its session started with. A resumed session
   *  with no record of it (its first turn failed, it moved here) is told its
   *  access once. */
  accessChangedNote(conversation: Conversation, participant: ChatParticipant, session: ChatParticipantSession, access: ChatMemberAccess): string | undefined {
    const told = session.instructionsAccessHash;
    const header = this.chat.turnPrompt.participantDynamicHeader(conversation, participant, session, access);
    if (!told || told === INSTRUCTIONS_ACCESS_RESTATE) {
      return `Your access: ${header}`;
    }
    return told === shortHash(header) ? undefined : `Your access changed: ${header}`;
  }

  private staticChatInstructions(
    session: ChatParticipantSession,
    includeParticipantActivityTool = true,
    /** Set for a member of a chat with a main session other than the main
     *  session itself. */
    mainSessionHandle?: string
  ): string {
    return [
      "Chat participant boundaries:",
      "- You are one participant in a multi-participant chat.",
      "- User is the human conversation owner, requirements authority, and clarification source. Her own words are the text of a message outside its nonce blocks (see How messages reach you); in chat history she is the author `User`.",
      ...(mainSessionHandle
        ? mainSessionMemberRules(mainSessionHandle)
        : [
            "- Ask User directly when goals, requirements, preferences, acceptance criteria, or user intent are unclear.",
            "- Do not ask another participant for user-owned clarification."
          ]),
      // A member on a cloud machine: its files are not on User's computer, and
      // the app shows a path it writes as plain text that does not open
      // (decided by the User 2026-10-30, file panel design).
      ...(this.chat.host.machineRuntime ? ["- You run on a cloud machine, not on User's computer. Files on this machine are not reachable by User: a file path you write will not open for them. To show User a file, publish it as an artifact or attach an image to a message."] : []),
      "",
      ...messageDeliveryInstructions(session),
      ...(session.participantKind === "claude-code" ? ["", ...claudeExecutionModelInstructions()] : []),
      "",
      ...selectedSkillInstructions(session),
      "",
      "App MCP policy:",
      this.appToolPromptPolicy(session, includeParticipantActivityTool, mainSessionHandle),
      "",
      ...MEMBER_MEMORY_INSTRUCTIONS,
      "",
      ...URGENT_ALERT_INSTRUCTIONS,
      "",
      "Response rules:",
      "- The user strongly prefers concise replies. Do not repeat accepted context or restate proposals when a short verdict, blocker, or delta is enough.",
      "- You may cite participant handles in normal prose for attribution; for cross-participant asks, use `app_chat_request_participants` rather than plain `@mentions` when another participant is expected to answer.",
      "- When replying to a participant request addressed to you, answer in the active thread; if request matching is ambiguous, ask for clarification rather than guessing.",
      "- Do not emit `Participant requests:` or `Return to requester after replies:` protocol blocks. They are legacy text and are not the current dispatch mechanism.",
      "- When a participant request MCP call returns `pending_approval` or `running`, end your turn unless User explicitly asked you to continue without that answer or an active skill gives you work that does not need it. The app will return control to you when replies or errors arrive.",
      "- Do not repeatedly poll participant request status in the same turn. Use the status tool only to recover a previous request after a timeout, interruption, approval delay, or resumed session.",
      ...(session.participantKind === "claude-code" ? ["- Claude Code only: do not use provider-native interactive question, user-input, or structured-question tools to ask User to choose. In AccordAgents Chat, ask choices only by emitting the `User choice:` block format described below."] : []),
      `- ${mainSessionHandle ? `Only when @${mainSessionHandle} asked you to put a question to User and User` : "When User"} must pick one option before you can continue, include one dedicated \`User choice:\` block after your explanation. Format it as lines \`T: short title\`, \`Q: question\`, \`O1: option label | optional description\`, \`O2: option label | optional description\`, and optionally \`R: O1\`. Use at least two options. Ask at most one user choice in a message.`,
      "- The UI also lets User write a custom answer instead of choosing your suggestions. After User confirms, the app will send the selected option or custom answer back to you in this chat.",
      "- Answer in the active thread. Do not assume a mentioned participant has answered until their reply appears in the transcript.",
      "- Answer only in this chat message. Do not mention ExitPlanMode, plan files, tool availability, or recording/writing outside the chat unless User directly asks about those mechanics.",
      "- If you make a decision, arbitration, plan, or summary, include it in this reply. Do not say it is posted above or recorded elsewhere unless you cite the exact existing chat message.",
      "- When you change files in this turn, summarize the changed files and how you verified them in this chat reply."
    ].join("\n");
  }

  private appToolPromptPolicy(
    session: ChatParticipantSession,
    includeParticipantActivityTool = true,
    mainSessionHandle?: string
  ): string {
    // Given once, for the whole CLI session (--agents): a Claude Code member
    // in its CLI's own mode changes its mode in the same process (Shift+Tab),
    // so nothing here depends on it; each turn's prompt says the mode.
    const claudeOwnMode = session.participantKind === "claude-code" && normalizeChatAgentPermissions(session.participantPermissions).cliApprovals === true;
    const agentMode = claudeOwnMode ? "default" : normalizeChatAgentMode(session.participantAgentMode);
    const canRequestPermissions = this.chat.permissionRequests.canRequestPermissionChanges(session);
    const manageRolesParticipantsPermission = manageRolesParticipantsPermissionForSession(session);
    const permissionPolicyLines = canRequestPermissions
      ? isAdministratorSession(session)
        ? [
            "Permission MCP tool: `app_permissions_request_change` is available when Chat Assistant needs approval for web access or another explicitly user-requested non-default capability.",
            "Do not use permission requests for repository access, file editing, or shell commands by default. For code or repository tasks, first suggest adding a generic participant; proceed only if User explicitly asks Chat Assistant to handle it and enables the needed participant permissions."
          ]
        : agentMode === "auto" || agentMode === "full-access"
        ? [
            "Permission MCP tool: `app_permissions_request_change` is available when this participant needs approval for blocked capabilities.",
            "In Auto-review and Full Access modes, repo read, workspace write, web, and shell commands all run under the provider's native auto review (in Codex's Full Access, without any review or asking). Do not call `app_permissions_request_change` for these, and do not request shellRules; shell decisions are handled by native auto. Portable repo/web/edit requests return already_granted if called anyway. Only genuinely out-of-preset capabilities need a request, for example `{ \"kind\": \"providerNative\", \"provider\": \"claude-code\", \"allowedTools\": [\"mcp__server__tool\"], \"reason\": \"Need this Claude Code tool.\" }` for Claude-native tool grants or `{ \"kind\": \"githubApp\", \"repository_full_name\": \"owner/repo\", \"permissions\": [\"contents:write\", \"pull_requests:write\"], \"reason\": \"Need to push a branch and open a PR.\" }` for GitHub App repository permissions. After a permission MCP call, inspect the status: pending_user_approval means it is awaiting User approval; already_granted means the capability is available."
          ]
        : [
            "Permission MCP tool: `app_permissions_request_change` is available when this participant needs approval for blocked capabilities.",
            "Required permission workflow: if the current task needs a blocked capability, call `app_permissions_request_change` before answering that the work cannot be done. Use `{ \"kind\": \"portable\", \"permissions\": [\"repoRead\"], \"reason\": \"Need to inspect the referenced repository files.\" }` for repository reads, `{ \"kind\": \"portable\", \"permissions\": [\"webAccess\"], \"reason\": \"Need live web lookup to answer User's trademark question.\" }` for web access, `{ \"kind\": \"portable\", \"permissions\": [\"workspaceWrite\"], \"reason\": \"Need to edit files for the requested change.\" }` for file edits, `{ \"kind\": \"shellRules\", \"rules\": [{ \"action\": \"allow\", \"match\": \"prefix\", \"pattern\": \"git diff\" }], \"reason\": \"Need to inspect diffs.\" }` for shell rules, `{ \"kind\": \"providerNative\", \"provider\": \"claude-code\", \"allowedTools\": [\"mcp__server__tool\"], \"reason\": \"Need this Claude Code tool.\" }` for Claude-native tool grants, or `{ \"kind\": \"githubApp\", \"repository_full_name\": \"owner/repo\", \"permissions\": [\"contents:write\", \"pull_requests:write\"], \"reason\": \"Need to push a branch and open a PR.\" }` for GitHub App repository permissions.",
            "After a permission MCP call, inspect the returned status. If the result is pending_user_approval, say only that the permission request is awaiting User approval; do not claim the permission was granted until the tool result or a later app message confirms approval."
          ]
      : [
          "Permission changes are not directly available to this participant. If the current task needs a blocked capability, explain the specific capability needed before refusing."
        ];
    const readOnlyChatTools = [
      "app_chat_get_context",
      "app_chat_get_participants",
      ...(includeParticipantActivityTool ? [APP_CHAT_GET_PARTICIPANT_ACTIVITY_TOOL] : []),
      "app_chat_read_messages",
      "app_chat_list_attachments",
      "app_chat_read_attachment"
    ];
    const lines = [
      "App MCP tools: use the connected `accord_agents` MCP server for app-managed requests. Do not try to change app state by editing files, shelling out, or asking User in prose when an app MCP tool exists.",
      `Read-only chat MCP tools: ${readOnlyChatTools.map((tool) => `\`${tool}\``).join(", ")}. Prefer them over history files for roster, authoritative member activity, thread, messages, and screenshots.`,
      "Reaction MCP tool: `app_chat_react` adds or toggles an emoji reaction on a specific message. To react, call it with the message `id` from `app_chat_read_messages` and an allowed emoji.",
      "Send-message MCP tool: `app_chat_send_message` posts immediately into your current reply; use only for mid-turn visibility, not normal replies. It can attach PNG/JPEG/WebP with `attachments: [{ \"kind\": \"image\", \"sourcePath\": \"path.png\" }]` from image paths inside the selected repository when repoRead is granted.",
      "To look at a picture from an earlier message or another member's, call `app_chat_read_attachment` with its attachment ID (`app_chat_list_attachments` lists them, the current message's included). To save a picture into the repository, call `app_chat_export_attachment` with its attachment ID and a repo-relative `targetPath` (needs workspaceWrite).",
      "Participant request MCP tools: use `app_chat_request_participants` to ask participants; `app_chat_get_participant_request_status` recovers replies. JSON: `{ \"requests\": [{ \"target\": \"codex\", \"prompt\": \"Concrete question\", \"reason\": \"Optional reason\" }] }`.",
      ...(mainSessionHandle
        ? [`Questions for User go to the main session: \`{ "requests": [{ "target": "${mainSessionHandle}", "prompt": "Concrete question" }] }\`; its answer comes back to you in a fresh turn.`]
        : []),
      "Participant request statuses include `pending_approval`, `running`, `answered`, `completed`, `failed`, `denied`, and `interrupted`. User may need to approve before targets run; chat grants are scoped to this requester and target.",
      "With the default `resumeRequester: true`, the call returns at once and replies arrive in a fresh auto-resumed requester turn, so end your turn as described above. Use `resumeRequester: false` (with an optional `timeoutMs` wait) only when you need completed replies inline in the same turn.",
      ...(session.participantKind === "claude-code" ? [CONNECTOR_SIGN_IN_POLICY] : []),
      ...permissionPolicyLines
    ];
    if (manageRolesParticipantsPermission === "deny") {
      return [
        ...lines,
        "Roster management app tools are not available to this participant."
      ].join("\n");
    }
    const roleParticipantWorkflowLines = manageRolesParticipantsPermission === "allow"
      ? [
          "For a new member whose role does not exist, call `app_roles_request_change` first. When it returns `status: \"auto_applied\"`, use the returned `createdRoleRefs[].roleConfigId` as the member `roleConfigId` in the following `app_participants_request_change` call.",
          "`draftRoleRef` is only for pending grouped-review role responses; do not use a draft ref after an auto-applied role change.",
          "The app validates proposed role and member changes. With this role's current policy, valid non-escalating role/member changes are auto-applied and written with an audit system message. Any change that grants or raises role/member management permission creates a User review card."
        ]
      : [
          "For a new member whose role does not exist, call `app_roles_request_change` first. The response includes `createdRoleRefs`; use the returned `draftRoleRef` as the member `roleConfigId` in the following `app_participants_request_change` call so the app can show one grouped review card.",
          "The app validates proposed role and member changes and creates a User review card before anything is written."
        ];
    return [
      ...lines,
      "App tools: `app_roles_describe_options` and `app_participants_describe_options` are available for read-only discovery of roles, saved member presets, current chat members, CLI providers, model catalogs, reasoning-effort options, defaults, usage counts, and validation rules.",
      "Call the describe tools first when you need exact role IDs, saved participant IDs, provider availability, model IDs, reasoning-effort options, configured models, or handle constraints.",
      "App tools: `app_roles_request_change` is available for proposed role creation, custom-role editing, or deleting unused custom roles with `archive_role`. Use `create_role` when no built-in role fits. Do not edit or delete built-in roles.",
      "App tools: `app_participants_request_change` is available for User-requested member changes. Use `add_existing_participant_to_chat` for a matching saved member preset, or `add_new_participant_to_chat` with `saveAsPreset` for a new chat member.",
      "To take a member out of this chat when User asks, call `app_participants_request_change` with `remove_participant_from_chat` and that member's `participantId` or `handle`. A removal follows the same policy as an addition and takes effect only after your turn ends and no member is running; the outcome is posted to the chat. The Chat Assistant and the last member cannot be removed.",
      "Do not choose roles marked archived for new members; archived roles are kept only so existing saved/current references remain understandable.",
      ...roleParticipantWorkflowLines,
      "`app_roster_request_change` is legacy compatibility only; do not use it for the v1 member setup flow."
    ].join("\n");
  }

  persistParticipantSessionId(
    conversation: Conversation,
    session: ChatParticipantSession,
    sessionId: string
  ): void {
    const nextSessionId = sessionId.trim();
    if (!nextSessionId || session.sessionId === nextSessionId) {
      return;
    }
    if (session.forkFrom && nextSessionId === session.forkFrom.sessionId) {
      // A fork's copy has an id of its own; the source's is never its.
      void this.deps.debugLogs.write("chat.session.fork-source-id-refused", {
        conversationId: conversation.id,
        participantId: session.participantId
      });
      return;
    }
    const now = new Date().toISOString();
    session.sessionId = nextSessionId;
    // The fork is made: from now on the member resumes its own session.
    delete session.forkFrom;
    session.updatedAt = now;
    void this.chat.store.withChatMutation(conversation, async () => {
      upsertSession(conversation, session);
      conversation.updatedAt = now;
      this.chat.store.queueSnapshot(conversation);
    }).catch((error) => {
      void this.deps.debugLogs.write("chat.session.persist-failed", {
        conversationId: conversation.id,
        participantId: session.participantId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  async sessionForParticipant(conversation: Conversation, member: ChatParticipant): Promise<ChatParticipantSessionState> {
    // A session it was handed when it moved here is taken first.
    await this.chat.memberMoves.takeSessionHandoff(conversation, member);
    // Its launch settings as it runs this turn (a member the main session
    // made never above the main session's).
    const participant = participantForRun(conversation, member);
    const existing = chatSessions(conversation).find((session) => session.participantId === participant.id);
    const runtimeConfigVersion = runtimeConfigVersionFor(participant);
    if (existing) {
      const resolvedRole = await this.chat.agentEnvironment.resolvedRoleForParticipant(participant, existing.roleConfigId);
      if (!resolvedRole) {
        void this.deps.debugLogs.write("chat.session.role-snapshot-refresh-skipped", {
          conversationId: conversation.id,
          participantId: participant.id,
          roleConfigId: existing.roleConfigId
        });
      }
      return {
        session: refreshExistingSessionForParticipant(existing, participant, resolvedRole, runtimeConfigVersion),
        instructionsRefreshed: Boolean(resolvedRole && roleSnapshotChanged(existing, resolvedRole)) || existing.runtimeConfigVersion !== runtimeConfigVersion
      };
    }
    const role = await this.chat.agentEnvironment.resolvedRoleForParticipant(participant);
    const session = await this.newSessionForParticipant(participant, role, runtimeConfigVersion);
    const forkOriginUnavailable = await this.chat.forks.startFromForkOrigin(conversation, participant, session);
    this.chat.imports.startFromImportOrigin(conversation, participant, session);
    return {
      session,
      instructionsRefreshed: false,
      ...(forkOriginUnavailable ? { forkOriginUnavailable } : {})
    };
  }

  async newSessionForParticipant(
    participant: ChatParticipant,
    knownRole?: ResolvedChatParticipantRole,
    knownRuntimeConfigVersion?: number
  ): Promise<ChatParticipantSession> {
    const role = knownRole ?? await this.chat.agentEnvironment.resolvedRoleForParticipantOrThrow(participant);
    const runtimeConfigVersion = knownRuntimeConfigVersion ?? runtimeConfigVersionFor(participant);
    return {
      participantId: participant.id,
      sessionId: "",
      executionSessionId: randomUUID(),
      roleConfigId: role.id,
      roleConfigVersion: role.version,
      roleAppToolCapabilities: normalizeChatAppToolCapabilities(role.appToolCapabilities),
      roleParticipantDefaults: role.participantDefaults,
      roleRuntime: preferredRoleRuntimeFor(participant),
      participantKind: participant.kind,
      participantModel: participant.model?.trim() || undefined,
      participantReasoningEffort: normalizeChatReasoningEffort(participant.reasoningEffort, participant.kind),
      participantBehaviorRules: role.behaviorRules,
      participantAgentMode: normalizeChatAgentMode(participant.agentMode),
      participantPermissions: normalizeChatAgentPermissions(participant.permissions),
      runtimeConfigVersion,
      appMcpClientGeneration: 0,
      roleLabel: role.label,
      roleInstructions: role.instructions,
      updatedAt: new Date().toISOString()
    };
  }
}
