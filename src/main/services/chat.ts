import type { CliStartDefaultsByKind } from "../../shared/cliStartDefaults";
import type { ForkToNewChatMachineSupport } from "../../shared/forkToNewChat";
import type { ImportedThread } from "./chat/conversations/chatImports";
import type { CliModesMachineSupport } from "../../shared/chatAccessModes";
import { randomUUID } from "node:crypto";
import type { HubNewChatOptions } from "../../shared/hubProtocol";
import type { ChatServerLink, ChatServerQueue } from "./chatServerOps";
import type { HubFeedEntry, HubOp, HubTurn } from "../../shared/hubOps";
import type { ChatCardAppliers } from "./chatCards";
import type { HubOpOutcome } from "./hubOpsClient";
import type { MachineSessionMoveTarget } from "../../shared/memberSessionMove";
import type {
  AgentContextUsage, AddChatParticipantRequest, ChatBackgroundTask, ChatBackgroundTasksEvent, ChatImageAttachment, ChatMessage, ChatParticipant,
  ChatParticipantActivitySnapshot, ChatParticipantConfig, ChatParticipantInput, CliProviderHost, ChatPermissionRequestToolResult,
  ChatProviderKind, ChatRosterAvailableOptions, CompactChatParticipantRequest, RestartChatParticipantRequest, Conversation,
  ConversationSummary, ConversationUpdate, ChatPromptSuggestion, ChatPromptSuggestionsUpdate, CreateChatConversationRequest,
  DeleteChatConversationRequest, DismissConversationWarningsRequest, ReadChatAttachmentRequest, RenameChatConversationRequest,
  SetChatArchivedRequest, SetChatPinnedRequest, SetChatViewRequest, RespondToChatAppToolApprovalRequest,
  RespondToChatChoiceRequest, RespondToChatMentionsRequest, SendChatMessageRequest, StartChatAccordRequest, StartChatAccordResult,
  StartReviewResult, ToggleChatReactionRequest, CloseAccordCardRequest, DismissTurnFinishedNoteRequest,
  UpdateChatParticipantRuntimeRequest, UpdateChatSubagentProvidersRequest, UpdateChatSubagentProvidersResult, RemoveChatParticipantRequest
} from "../../shared/types";
import type { ArtifactNoteLinks } from "./artifactClient";
import type { DeviceEventBlobReference } from "../../shared/deviceEventBlobs";
import type { ChatMemberPromptSuggestion } from "./chatPromptSuggestions";
import { CliAgentRunner } from "./cliAgents";
import type { ScriptChatInfo } from "./scripts";
import { DebugLogService } from "./debugLogs";
import { SettingsService } from "./settings";
import { StorageService } from "./storage";
import { UserSkillsService } from "./userSkills";
import type { MemoryServerAccess } from "./memoryTools";
import type { UserSkillRunContext } from "./userSkills";
import type { MachineMemberRestartSupport } from "../../shared/memberRestart";
import type { ChatAppToolApprovalDecisionEvent } from "./chat/approvals/approvalDecisions";
import type { ChatChoiceExecutionGuard } from "./chat/choices/choiceAnswers";
import { userSkillRunContext } from "./chat/choices/mentions";
import type { SelfCompactionEnd } from "./chat/compaction/selfCompactionMarks";
import type { MachineLinkPort } from "./chat/host/bodyTransport";
import type { CloudRunAwsResolver, CloudRunDoctorProbe } from "./chat/host/machineSupport";
import type { ParticipantMoveApplied } from "./chat/members/chatMembers";
import type { ChatParticipantRun } from "./chat/runs/activeRuns";
import type { RemoteTurns } from "./chat/server/remoteTurns";
import type { ServerChat } from "./chat/server/serverChat";
import type { ChatScriptHost } from "./chat/tools/scheduledTasks";
import type {
  ChatAppMcpActor, ChatAppMcpGateway, ChatApprovalExecutionGuard, ChatDispatchReplyContext, ProgressCallback
} from "./chat/types";
import type { AccordCollectionOrigin } from "./chat/accord/chatAccord";
import { createChatModules, type ChatModules } from "./chat/modules";

export { REPLIES_REPAIRED_KEY } from "./chat/runs/interruptions";
export { TASK_REPLY_PROMPT_MAX_CHARS, TASK_REPLIES_PROMPT_MAX_CHARS } from "./chat/requests/delegationGroups";
export type { ChatScriptHost } from "./chat/tools/scheduledTasks";
export type { ChatAppToolApprovalDecisionEvent } from "./chat/approvals/approvalDecisions";
export type { ChatApprovalExecutionGuard } from "./chat/types";
export { type ChatChoiceExecutionGuard, ChatChoicePersistenceError } from "./chat/choices/choiceAnswers";
export type { MachineLinkPort } from "./chat/host/bodyTransport";
export type { ChatParticipantRun } from "./chat/runs/activeRuns";

/** The chats of the app, as the rest of it sees them. The work is done by the parts in ./chat. */
export class ChatService {
  private readonly modules: ChatModules;

  constructor(
    storage: StorageService,
    settings: SettingsService,
    cliRunner: CliAgentRunner,
    debugLogs: DebugLogService,
    appMcp?: ChatAppMcpGateway,
    onConversationSnapshot?: (conversation: Conversation, update: ConversationUpdate) => void,
    userSkills?: UserSkillsService,
    onReviewProgress?: ProgressCallback,
    onInterruptedRunsRecovered?: (
      conversation: Conversation,
      messages: ChatMessage[]
    ) => void
  ) {
    this.modules = createChatModules({ storage, settings, cliRunner, debugLogs, appMcp, onConversationSnapshot, userSkills, onReviewProgress, onInterruptedRunsRecovered });
  }

  activeParticipantRuns(): ChatParticipantRun[] {
    return this.modules.activeRuns.activeParticipantRuns();
  }

  /** Every run alive here: members' turns and the runs that carry no member
   *  bubble, such as a compaction. Restarting the app kills all of them. */
  liveRunIds(): string[] {
    return this.modules.activeRuns.liveRunIds();
  }

  /** Turns the server asked of members here that this device took and that
   *  are not over: from before they become a run (reading the chat,
   *  preparing the machine) to their end. */
  serverTurnsStarting(): number {
    return this.modules.serverTurns.serverTurnsStarting();
  }

  onParticipantRunSettled(listener: (run: ChatParticipantRun) => Promise<void> | void): () => void {
    return this.modules.activeRuns.onParticipantRunSettled(listener);
  }

  settledParticipantRunResult(run: ChatParticipantRun): Promise<{ messages: ChatMessage[]; warnings: string[]; contextUsage?: AgentContextUsage }> {
    return this.modules.activeRuns.settledParticipantRunResult(run);
  }

  setMemoryAccess(access: () => MemoryServerAccess | undefined): void {
    this.modules.memberSessions.setMemoryAccess(access);
  }

  /** Machines transport, machine side: members whose home is this id are
   *  this runtime's own (swept, resumed, and run here like local ones). */
  setHostMachineId(machineId: string | undefined): void {
    this.modules.host.setHostMachineId(machineId);
  }

  /** Machines transport: participants whose home is an enrolled machine run
   *  there through the machine link; the desktop keeps the pending bubble,
   *  progress, and the final messages exactly as for a local participant. */
  setCloudRunPreparation(prepare: NonNullable<RemoteTurns["prepareCloudSelection"]>): void {
    this.modules.remoteTurns.setCloudRunPreparation(prepare);
  }

  setMachineProjectPreparation(prepare: NonNullable<RemoteTurns["prepareMachineProject"]>): void {
    this.modules.remoteTurns.setMachineProjectPreparation(prepare);
  }

  setMachineProjectMissingHandler(handler: NonNullable<ServerChat["machineProjectMissing"]>): void {
    this.modules.serverChat.setMachineProjectMissingHandler(handler);
  }

  setMachineLink(link: MachineLinkPort | undefined): void {
    this.modules.bodyTransport.setMachineLink(link);
  }

  /** Desktop: where changes to a chat's next-prompt suggestions are pushed. */
  setPromptSuggestionsListener(listener: ((update: ChatPromptSuggestionsUpdate) => void) | undefined): void {
    this.modules.promptSuggestions.setPromptSuggestionsListener(listener);
  }

  /** Machines transport, machine side: hands a member's next-prompt
   *  suggestion to the desktop, which decides whether it is still on offer. */
  setPromptSuggestionForwarder(forwarder: ((suggestion: ChatMemberPromptSuggestion) => void) | undefined): void {
    this.modules.promptSuggestions.setPromptSuggestionForwarder(forwarder);
  }

  listPromptSuggestions(conversationId: string): ChatPromptSuggestion[] {
    return this.modules.promptSuggestions.listPromptSuggestions(conversationId);
  }

  /** A member's CLI predicted the User's next prompt after the reply of
   *  `runId`: kept on the desktop, forwarded there from a machine. `sourceMachineId`
   *  names the machine it came from; without it, the CLI ran here. */
  receiveMemberPromptSuggestion(suggestion: ChatMemberPromptSuggestion, sourceMachineId?: string): void {
    this.modules.promptSuggestions.receiveMemberPromptSuggestion(suggestion, sourceMachineId);
  }

  /** Told when a member's connector was connected through the sign-in card
   *  (the computer's usage signals; a machine's runtime sets none). */
  setConnectorSignedInObserver(observer: (() => void) | undefined): void {
    this.modules.connectorSignIns.setConnectorSignedInObserver(observer);
  }

  /** Scheduled scripts on this host; absent where they are not available. */
  setScriptHost(host: ChatScriptHost | undefined): void {
    this.modules.scheduledTasks.setScriptHost(host);
  }

  /** Machine side: what must happen before a turn the server asked of a
   *  member here starts (see serverTurnPreparation). */
  setServerTurnPreparation(prepare: ((turn: HubTurn) => Promise<boolean>) | undefined): void {
    this.modules.serverTurns.setServerTurnPreparation(prepare);
  }

  /** Desktop side: why a machine cannot take turns right now, if it cannot. */
  setMachineWaitReason(reason: ((machineId: string) => string | undefined) | undefined): void {
    this.modules.remoteTurns.setMachineWaitReason(reason);
  }

  /** Desktop side: whether a machine's runtime restarts its members (its hello). */
  setMachineMemberRestartSupport(support: ((machineId: string) => MachineMemberRestartSupport) | undefined): void {
    this.modules.machineSupport.setMachineMemberRestartSupport(support);
  }

  /** Desktop side: see machineSessionMove. */
  setMachineSessionMove(lookup: ((target: { machineId?: string; instanceId?: string }) => MachineSessionMoveTarget) | undefined): void {
    this.modules.machineSupport.setMachineSessionMove(lookup);
  }

  /** Desktop side: see machineForkToNewChatSupport. */
  setMachineForkToNewChatSupport(lookup: ((machineId: string) => ForkToNewChatMachineSupport) | undefined): void {
    this.modules.machineSupport.setMachineForkToNewChatSupport(lookup);
  }

  /** What each CLI on a machine starts a new session in with that machine's
   *  own config (its last hello): the phone's New chat starts a main session
   *  that runs there in it. */
  setMachineCliStartDefaults(lookup: ((machineId: string) => CliStartDefaultsByKind | undefined) | undefined): void {
    this.modules.machineSupport.setMachineCliStartDefaults(lookup);
  }

  /** Desktop side: whether a machine runs Codex's Full Access and Plan mode
   *  (its last hello), for the phone's New chat offer and before a turn is
   *  asked of it (machineCliModesRefusal). */
  setMachineCliModesSupport(lookup: ((machineId: string) => CliModesMachineSupport) | undefined): void {
    this.modules.machineSupport.setMachineCliModesSupport(lookup);
  }

  /** Desktop side: see beforeRemoteTurn and machineProjectReady. */
  setRemoteTurnPreparation(preparation: {
    beforeRemoteTurn?: (machineId: string) => Promise<void>;
    machineProjectReady?: (machineId: string, repoPath: string) => Promise<boolean>;
  } | undefined): void {
    this.modules.remoteTurns.setRemoteTurnPreparation(preparation);
  }

  /** Machine side: where the computer's projects live on this machine. */
  setMachineProjects(projects: Record<string, string>): void {
    this.modules.host.setMachineProjects(projects);
  }

  /** Machine side: a chat's project folder here, as the computer's settings
   *  for this machine say now (before a member works in it). */
  refreshMachineRepository(conversationId: string): Promise<void> {
    return this.modules.host.refreshMachineRepository(conversationId);
  }

  setCloudRunAwsService(service: CloudRunAwsResolver): void {
    this.modules.machineSupport.setCloudRunAwsService(service);
  }

  setCloudRunDoctorService(service: CloudRunDoctorProbe): void {
    this.modules.machineSupport.setCloudRunDoctorService(service);
  }

  setArtifactCleanup(handler: (conversationId: string) => Promise<void>): void {
    this.modules.deletion.setArtifactCleanup(handler);
  }

  setCodexApprovalWaitMsForTests(timeoutMs: number): void {
    this.modules.codexApprovals.setCodexApprovalWaitMsForTests(timeoutMs);
  }

  onAppToolApprovalDecision(listener: (event: ChatAppToolApprovalDecisionEvent) => Promise<void> | void): () => void {
    return this.modules.approvalDecisions.onAppToolApprovalDecision(listener);
  }

  hydrateContextUsage(conversation: Conversation): Promise<Conversation> {
    return this.modules.contextMeter.hydrateContextUsage(conversation);
  }

  createConversation(request: CreateChatConversationRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<StartReviewResult> {
    return this.modules.creation.createConversation(request, signal, progress);
  }

  /** A chat made from a CLI thread of the User's own, going on in that CLI
   *  session (docs/design/cli-import/plan.md). */
  importCliThread(thread: ImportedThread, folder?: string): Promise<Conversation> {
    return this.modules.imports.createImportedConversation(thread, folder);
  }

  /**
   * What the phone's New chat offers, as this computer's New chat screen
   * does (the User, 2026-10-29): its projects (the folders its chats are in,
   * newest first), the folder a new chat starts in, the main session and
   * every saved member as this computer would add them, and why none could
   * be started now. The phone puts the chat
   * together from these (src/shared/newChat) and writes it to the User's
   * server.
   */
  newChatOptions(summaries: ConversationSummary[]): Promise<HubNewChatOptions | undefined> {
    return this.modules.newChatOffers.newChatOptions(summaries);
  }

  /** Waits for the model lists being read in the background (tests). */
  settleNewChatModelCatalogsForTests(): Promise<void> {
    return this.modules.newChatOffers.settleNewChatModelCatalogsForTests();
  }

  renameConversation(request: RenameChatConversationRequest): Promise<Conversation | undefined> {
    return this.modules.list.renameConversation(request);
  }

  setArchived(request: SetChatArchivedRequest): Promise<Conversation | undefined> {
    return this.modules.list.setArchived(request);
  }

  /** Pins a chat to the top of the chat list, or unpins it. The User's own
   *  ordering, shared through her server like the archive state; allowed
   *  while members run. It is not activity in the chat, so `updatedAt` stays
   *  and the chat keeps its place among the recent ones. */
  setPinned(request: SetChatPinnedRequest): Promise<Conversation | undefined> {
    return this.modules.list.setPinned(request);
  }

  /** The User's switch of the chat's view (shared/mainSession.ts): shared
   *  through her server like the pin. A chat without a main session has one
   *  view only. */
  /**
   * Members of a sessions-view chat made before the title of their task was
   * kept with them (ChatParticipant.taskTitle) get it once, from the chat's
   * whole stored history, so the view names them however much of the chat a
   * device has loaded: the newest title the main session gave a task of
   * theirs (their delegation), else their first task's first line
   * (sessionsTaskTitle). Never a handle: a member that never had a task keeps
   * none, and the view names it "Agent". Done once per chat
   * (metadata.sessionsTaskTitlesBackfilled); members added later get theirs
   * when they are made. `opened`: the chat as just opened, read only to
   * decide whether there is anything to do.
   */
  backfillSessionsTaskTitles(opened: Pick<Conversation, "id" | "kind" | "metadata">): Promise<void> {
    return this.modules.titles.backfillSessionsTaskTitles(opened);
  }

  setChatView(request: SetChatViewRequest): Promise<Conversation | undefined> {
    return this.modules.list.setChatView(request);
  }

  deleteConversation(request: DeleteChatConversationRequest): Promise<boolean> {
    return this.modules.deletion.deleteConversation(request);
  }

  setConversationDeletedHandler(handler: (conversation: Pick<Conversation, "id" | "metadata">) => Promise<unknown>): void {
    this.modules.deletion.setConversationDeletedHandler(handler);
  }

  reconcileDeletedConversationArtifacts(): Promise<void> {
    return this.modules.deletion.reconcileDeletedConversationArtifacts();
  }

  dismissConversationWarnings(request: DismissConversationWarningsRequest): Promise<Conversation | undefined> {
    return this.modules.list.dismissConversationWarnings(request);
  }

  addParticipant(request: AddChatParticipantRequest): Promise<Conversation | undefined> {
    return this.modules.members.addParticipant(request);
  }

  updateParticipantRuntime(request: UpdateChatParticipantRuntimeRequest, moved?: ParticipantMoveApplied): Promise<Conversation | undefined> {
    return this.modules.members.updateParticipantRuntime(request, moved);
  }

  /** A change to the chat's Agents list (its side panel), for this chat only. */
  updateSubagentProviders(request: UpdateChatSubagentProvidersRequest): Promise<UpdateChatSubagentProvidersResult> {
    return this.modules.members.updateSubagentProviders(request);
  }

  removeParticipant(request: RemoveChatParticipantRequest): Promise<Conversation | undefined> {
    return this.modules.members.removeParticipant(request);
  }

  compactParticipant(
    request: CompactChatParticipantRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback,
    /** How it ended here (a member's own compaction goes on from it). */
    onEnded?: (end: SelfCompactionEnd) => void
  ): Promise<StartReviewResult> {
    return this.modules.compaction.compactParticipant(request, signal, progress, onEnded);
  }

  /**
   * The User restarts a member's CLI process (the members list): the live
   * process and the background tasks it carries end now, and the member's
   * next turn starts a new process that resumes the same session with what
   * is configured then (MCP servers, keys, Claude in Chrome), as quitting
   * the dedicated CLI and resuming the session does. Only while the member
   * is not answering: the button is off then, and a turn that started
   * meanwhile refuses it where the member runs. Background tasks are stopped
   * only when the User agreed to it. A member on a machine is restarted
   * there, as a turn of that member on the User's server, like its
   * compaction. Gemini starts a new process for every message: it has
   * nothing to restart. One restart of a member at a time.
   */
  restartParticipant(request: RestartChatParticipantRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<void> {
    return this.modules.memberRestart.restartParticipant(request, signal, progress);
  }

  syncSavedParticipantAvatar(
    previous: Pick<ChatParticipantConfig, "handle" | "kind"> | undefined,
    next: Pick<ChatParticipantConfig, "id" | "handle" | "kind" | "avatarId" | "hostId" | "model">
  ): Promise<void> {
    return this.modules.members.syncSavedParticipantAvatar(previous, next);
  }

  syncSavedParticipantConfig(
    previous: Pick<ChatParticipantConfig, "handle" | "kind"> | undefined,
    next: Pick<ChatParticipantConfig, "id" | "handle" | "kind" | "avatarId" | "behaviorRuleIds" | "hostId" | "model">,
    options: { behaviorRules?: boolean } = {}
  ): Promise<void> {
    return this.modules.members.syncSavedParticipantConfig(previous, next, options);
  }

  removeBehaviorRuleFromChatParticipants(ruleId: string): Promise<void> {
    return this.modules.members.removeBehaviorRuleFromChatParticipants(ruleId);
  }

  userSkillRunContext(conversation: Conversation, content: string, context?: ChatDispatchReplyContext): UserSkillRunContext {
    return userSkillRunContext(conversation, content, context);
  }

  prospectiveUserSkillRunContext(request: {
    repoPath?: string;
    participants?: ChatParticipantInput[];
    assistantProviderKind?: ChatProviderKind;
    content?: string;
  }): Promise<UserSkillRunContext> {
    return this.modules.messageSending.prospectiveUserSkillRunContext(request);
  }

  requestRosterChangeFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    return this.modules.rosterTools.requestRosterChangeFromTool(actor, rawRequest);
  }

  requestPermissionChangeFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<ChatPermissionRequestToolResult> {
    return this.modules.permissionRequests.requestPermissionChangeFromTool(actor, rawRequest);
  }

  /** Claude Code's permission prompt (`--permission-prompt-tool`): a card
   *  the call waits on, up to APP_TOOL_PERMISSION_WAIT_MS (the CLI is told
   *  to wait that long, cliAgents claudeMcpConfigJson). `abandoned` aborts
   *  when the CLI gives up on the call (its connection closes): the card is
   *  then expired, so the User is never offered an answer nobody reads. */
  requestToolPermissionFromTool(actor: ChatAppMcpActor, rawRequest: unknown, abandoned?: AbortSignal): Promise<Record<string, unknown>> {
    return this.modules.toolPermissions.requestToolPermissionFromTool(actor, rawRequest, abandoned);
  }

  /** A member asks the User to sign in to (or reconnect) an MCP server its
   *  task needs (src/shared/connectorSignIn.ts). The call waits for the User
   *  as a permission card does. The sign-in address comes from the member's
   *  own CLI, and after "Done" the server is reconnected in the member's live
   *  process, so its tools are there for the rest of the same reply. The card
   *  stays open (its server card too) until what came of it is recorded. */
  requestConnectorSignInFromTool(actor: ChatAppMcpActor, rawRequest: unknown, abandoned?: AbortSignal): Promise<Record<string, unknown>> {
    return this.modules.connectorSignIns.requestConnectorSignInFromTool(actor, rawRequest, abandoned);
  }

  requestParticipantsFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    return this.modules.participantRequests.requestParticipantsFromTool(actor, rawRequest);
  }

  /**
   * The main session gives a new member a task (app_chat_delegate_task,
   * docs/main-session.md): the member is added without a card, with nothing
   * beyond the main session's own rights, on the main session's provider,
   * model, mode and machine unless it names others, and its task is asked of
   * it at once as a request from the main session, whose answer comes back in
   * a fresh main-session turn. "fork" starts the member from a copy of the
   * main session's CLI session; where the CLI cannot do that the call says so
   * (fork_unavailable) and nothing is added.
   */
  delegateTaskFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    return this.modules.delegation.delegateTaskFromTool(actor, rawRequest);
  }

  /**
   * The main session starts an Accord (app_chat_start_accord,
   * docs/main-session.md): the same launch as the User's, written as the
   * main session's message. The facilitator defaults to the main session.
   */
  startAccordFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    return this.modules.accord.startAccordFromTool(actor, rawRequest);
  }

  /** The main session compacts another member (app_chat_compact_participant). */
  compactParticipantFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    return this.modules.memberCompaction.compactParticipantFromTool(actor, rawRequest);
  }

  requestSelfCompactionFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    return this.modules.selfCompaction.requestSelfCompactionFromTool(actor, rawRequest);
  }

  participantRequestStatusForTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    return this.modules.participantRequests.participantRequestStatusForTool(actor, rawRequest);
  }

  describeRosterOptionsForTool(actor: ChatAppMcpActor): Promise<ChatRosterAvailableOptions> {
    return this.modules.rosterTools.describeRosterOptionsForTool(actor);
  }

  describeRoleOptionsForTool(actor: ChatAppMcpActor): Promise<Record<string, unknown>> {
    return this.modules.rosterTools.describeRoleOptionsForTool(actor);
  }

  describeParticipantOptionsForTool(actor: ChatAppMcpActor): Promise<Record<string, unknown>> {
    return this.modules.rosterTools.describeParticipantOptionsForTool(actor);
  }

  /** `app_scripts_*` tools. */
  scriptToolFromApp(actor: ChatAppMcpActor, toolName: string, rawRequest: unknown): Promise<Record<string, unknown>> {
    return this.modules.scheduledTasks.scriptToolFromApp(actor, toolName, rawRequest);
  }

  /** For the script service: a chat's title and members, by id. */
  describeChatForScripts(chatId: string): Promise<ScriptChatInfo | undefined> {
    return this.modules.scheduledTasks.describeChatForScripts(chatId);
  }

  /** A scheduled script posts into a chat: the message is authored by the
   *  script (role "script") and starts exactly the members it names, the
   *  way a User message with those mentions does. Each target run gets its
   *  own run id, so Stop works per member as usual. */
  postScriptMessage(input: {
    conversationId: string;
    scriptId: string;
    scriptName: string;
    content: string;
    participantIds: string[];
    progress?: ProgressCallback;
  }): Promise<{ messageId: string; runIds: string[] }> {
    return this.modules.scheduledTasks.postScriptMessage(input);
  }

  requestRoleChangeFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    return this.modules.rosterTools.requestRoleChangeFromTool(actor, rawRequest);
  }

  requestParticipantChangeFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    return this.modules.rosterTools.requestParticipantChangeFromTool(actor, rawRequest);
  }

  /** After a restart nothing of this process runs any more, so decided
   *  removals that were waiting for a turn to end are applied now (a turn
   *  another device still runs keeps them waiting, see memberRemovalMustWait),
   *  and machine members' additions recorded before Д2 are. On the desktop;
   *  a machine resumes only its removals (resumeQueuedMemberRemovals). */
  resumeQueuedRosterChanges(): Promise<void> {
    return this.modules.queuedRosterChanges.resumeQueuedRosterChanges();
  }

  /** On a machine after a restart: its own members' decided removals still
   *  waiting (Д2: the asking member's device makes them). The waiting index
   *  lives only in memory, so without this they would wait forever. */
  resumeQueuedMemberRemovals(): Promise<void> {
    return this.modules.queuedRosterChanges.resumeQueuedMemberRemovals();
  }

  describeChatContextForTool(actor: ChatAppMcpActor): Promise<Record<string, unknown>> {
    return this.modules.chatReadTools.describeChatContextForTool(actor);
  }

  describeChatParticipantsForTool(actor: ChatAppMcpActor): Promise<Record<string, unknown>> {
    return this.modules.chatReadTools.describeChatParticipantsForTool(actor);
  }

  describeChatParticipantActivityForTool(actor: ChatAppMcpActor, rawRequest?: unknown): Promise<ChatParticipantActivitySnapshot> {
    return this.modules.chatReadTools.describeChatParticipantActivityForTool(actor, rawRequest);
  }

  readChatMessagesForTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    return this.modules.chatReadTools.readChatMessagesForTool(actor, rawRequest);
  }

  toggleReaction(request: ToggleChatReactionRequest): Promise<Conversation | undefined> {
    return this.modules.chatPostTools.toggleReaction(request);
  }

  /** The User takes a turn-finished note away. Its removal goes to her
   *  server like any message's, so the note leaves every device; nothing but
   *  a note can be removed this way. */
  dismissTurnFinishedNote(request: DismissTurnFinishedNoteRequest): Promise<void> {
    return this.modules.chatPostTools.dismissTurnFinishedNote(request);
  }

  /** The User's cross on the pinned Accord card: the card folds into a line
   *  at the end of the chat as it stands now (accordProgress.ts). The line
   *  goes to her server like any message, so every device shows it in the
   *  same place; one line per Accord. It is her view of the chat, not news:
   *  the chat keeps its place in her list. */
  closeAccordCard(request: CloseAccordCardRequest): Promise<void> {
    return this.modules.accord.closeAccordCard(request);
  }

  reactToMessageFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    return this.modules.chatPostTools.reactToMessageFromTool(actor, rawRequest);
  }

  // Post a normal participant message authored by the requester. The created message is a
  // `done` message (unlike a run's pending final bubble), so other participants can react to
  // it immediately. Critically, the requester's snapshot is bumped to include the new message
  // so the facilitator can re-read and self-react to it in the same run (publish -> self-✅).
  sendChatMessageFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    return this.modules.chatPostTools.sendChatMessageFromTool(actor, rawRequest);
  }

  // Resolve the artifact-system member identity ("user" | participant handle)
  // for an app MCP actor. Rejects actors that are no longer chat participants.
  artifactActorMember(actor: ChatAppMcpActor): Promise<string> {
    return this.modules.accord.artifactActorMember(actor);
  }

  // The Accord launch a member's turn runs for, when that member is its
  // facilitator: the User's launch message at the root of the turn's thread
  // (or the turn's own trigger). Worked out by the app from its own records,
  // so a member cannot tie a document to an Accord it does not lead.
  accordLaunchMessageIdForActor(actor: ChatAppMcpActor): Promise<string | undefined> {
    return this.modules.accord.accordLaunchMessageIdForActor(actor);
  }

  // Where a member's new draft collection is filed, or why the main session
  // may not create one in this turn (ChatAccord.accordCollectionOrigin).
  accordCollectionOrigin(actor: ChatAppMcpActor): Promise<AccordCollectionOrigin> {
    return this.modules.accord.accordCollectionOrigin(actor);
  }

  // Append a brief artifact note ("@gera revised [Plan](#artifact:id) · v3") to
  // the chat timeline. Notes are system messages flagged with
  // ARTIFACT_NOTE_MESSAGE_SOURCE so the timeline keeps them visible; they carry
  // a link token, never artifact bodies.
  postArtifactChatNote(
    conversationId: string,
    eventId: string,
    content: string,
    links?: ArtifactNoteLinks
  ): Promise<void> {
    return this.modules.accord.postArtifactChatNote(conversationId, eventId, content, links);
  }

  setChatTitleFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    return this.modules.titles.setChatTitleFromTool(actor, rawRequest);
  }

  readChatAttachment(request: ReadChatAttachmentRequest): Promise<{ attachment: ChatImageAttachment; dataBase64: string }> {
    return this.modules.attachments.readChatAttachment(request);
  }

  listChatAttachmentsForTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    return this.modules.chatReadTools.listChatAttachmentsForTool(actor, rawRequest);
  }

  readChatAttachmentForTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    return this.modules.chatReadTools.readChatAttachmentForTool(actor, rawRequest);
  }

  exportChatAttachmentForTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    return this.modules.attachments.exportChatAttachmentForTool(actor, rawRequest);
  }

  respondToAppToolApproval(
    request: RespondToChatAppToolApprovalRequest,
    progress?: ProgressCallback,
    execution?: ChatApprovalExecutionGuard
  ): Promise<Conversation | undefined> {
    return this.modules.approvalDecisions.respondToAppToolApproval(request, progress, execution);
  }

  startAccord(
    request: StartChatAccordRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback,
    runId: string = randomUUID(),
    /** The chat's main session starting it (app_chat_start_accord): the
     *  launch is its message, and the facilitator's leave to ask members is
     *  never more than the main session's own. */
    options: { author?: ChatParticipant } = {}
  ): Promise<StartChatAccordResult> {
    return this.modules.accord.startAccord(request, signal, progress, runId, options);
  }

  hasAcceptedMobileEvent(conversationId: string, eventId: string): Promise<boolean> {
    return this.modules.messageSending.hasAcceptedMobileEvent(conversationId, eventId);
  }

  sendMessage(request: SendChatMessageRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<StartReviewResult> {
    return this.modules.messageSending.sendMessage(request, signal, progress);
  }

  respondToMentions(request: RespondToChatMentionsRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<StartReviewResult> {
    return this.modules.choiceAnswers.respondToMentions(request, signal, progress);
  }

  respondToChoice(request: RespondToChatChoiceRequest, signal?: AbortSignal, progress?: ProgressCallback,
    execution?: ChatChoiceExecutionGuard): Promise<StartReviewResult> {
    return this.modules.choiceAnswers.respondToChoice(request, signal, progress, execution);
  }

  /** Machines transport, machine side: stores a conversation replicated from
   *  the desktop through this service's own mutation queue and snapshot
   *  tracking, so later saves by turns on this machine never collide with
   *  rows written behind the service's back. The caller has already merged
   *  the machine-owned metadata. */
  /**
   * Closes this device's providers for a chat that is being deleted elsewhere,
   * and proves they are gone.
   *
   * Deletion has to leave nothing running against a conversation that no
   * longer exists; a provider held for a chat nobody can open again is a
   * process nobody would ever come looking for.
   */
  closeReplicatedConversationSessions(conversationId: string): Promise<void> {
    return this.modules.deletion.closeReplicatedConversationSessions(conversationId);
  }

  applyReplicatedConversationDeletion(conversationId: string, deletedAt: string): Promise<void> {
    return this.modules.deletion.applyReplicatedConversationDeletion(conversationId, deletedAt);
  }

  reconcileConversationDeletions(): Promise<void> {
    return this.modules.deletion.reconcileConversationDeletions();
  }

  applyReplicatedConversation(
    conversationId: string,
    merge: (existing: Conversation | undefined) => Conversation | undefined
  ): Promise<void> {
    return this.modules.replicatedChats.applyReplicatedConversation(conversationId, merge);
  }

  /** Called by the transport only after the entire copied chat is durable. */
  onReplicatedConversationReady(conversationId: string): void {
    this.modules.replicatedChats.onReplicatedConversationReady(conversationId);
  }

  /** Called with every change of a member's live background tasks. */
  onBackgroundTasksChanged(listener: (event: ChatBackgroundTasksEvent) => void): () => void {
    return this.modules.backgroundTasks.onBackgroundTasksChanged(listener);
  }

  /** The live background tasks of a chat's members, by member id. */
  backgroundTasksForConversation(conversationId: string): Record<string, ChatBackgroundTask[]> {
    return this.modules.backgroundTasks.backgroundTasksForConversation(conversationId);
  }

  /** Every member with live background work here (a machine reports these to
   *  the desktop on reconnect). */
  localBackgroundTasks(): ChatBackgroundTasksEvent[] {
    return this.modules.backgroundTasks.localBackgroundTasks();
  }

  /** A machine reported the live background tasks of a member it hosts. */
  applyMachineBackgroundTasks(machineId: string, event: ChatBackgroundTasksEvent): void {
    this.modules.backgroundTasks.applyMachineBackgroundTasks(machineId, event);
  }

  /** A machine's complete list (sent with its hello or on request): replaces
   *  everything it reported before, so work that ended while the link was
   *  down, or that died with a restarted machine, does not linger. */
  replaceMachineBackgroundTasks(machineId: string, events: ChatBackgroundTasksEvent[]): void {
    this.modules.backgroundTasks.replaceMachineBackgroundTasks(machineId, events);
  }

  /** A provider was removed in Settings: retire every warm process still holding
   *  its key. Bindings stay (members fail visibly on their next turn). */
  retireCliProviderHost(hostId: string): Promise<void> {
    return this.modules.members.retireCliProviderHost(hostId);
  }

  /** A provider was edited in Settings: refresh the name/vendor snapshot on every
   *  chat member bound to it, and give members whose vendor changed a fresh CLI
   *  session (transcripts belong to the backend that produced them). */
  syncCliProviderHost(host: CliProviderHost): Promise<void> {
    return this.modules.members.syncCliProviderHost(host);
  }

  /** W-G(e)/W-I: pairing-lifecycle warnings surface on the paired
   *  conversation — the one place the user looks when the phone goes quiet.
   *  Callers outside the service (the pairing lifecycle lives in main.ts)
   *  get this narrow door instead of the private internals. */
  recordConversationWarning(conversationId: string, warning: string): Promise<void> {
    return this.modules.store.recordConversationWarning(conversationId, warning);
  }

  /**
   * After the server's open cards were first read (resumeServerCards): the
   * choices the User went on past while this device was off are closed.
   * `conversationIds` are the chats that
   * read named; only those holding a waiting choice are opened.
   */
  resumeChoiceExpiry(conversationIds: string[]): Promise<void> {
    return this.modules.choiceExpiry.resumeChoiceExpiry(conversationIds);
  }

  /**
   * Puts on the User's server the pictures these operations name that this
   * device holds, before the operations go: the phone does the same, and
   * every other device (the computer, a machine, the phone) reads a picture
   * from there. A picture is in a message from the message's creation (a
   * later update names the same one), and a chat moving to a server carries
   * its messages whole. A failed put throws, so the operations wait and are
   * tried again with it: a message never reaches the server ahead of its
   * picture.
   */
  putServerPictures(
    ops: readonly HubOp[],
    put: (reference: DeviceEventBlobReference, bytes: Buffer) => Promise<void>,
    alreadyPut: (blobHash: string) => boolean
  ): Promise<void> {
    return this.modules.attachments.putServerPictures(ops, put, alreadyPut);
  }

  cancelRun(runId: string): boolean {
    return this.modules.runCancel.cancelRun(runId);
  }

  /** Which conversation a run belongs to. Live progress carries no conversation
   *  of its own, so whoever forwards it — the phone relay in particular — has to
   *  ask rather than assume: attributing a run to the wrong chat puts one
   *  chat's content inside another. Undefined means "not known here", and the
   *  caller must drop the frame rather than pick a chat. */
  conversationIdForRun(runId: string): string | undefined {
    return this.modules.activeRuns.conversationIdForRun(runId);
  }

  hasActiveRunForConversation(conversationId: string, runId: string): boolean {
    return this.modules.activeRuns.hasActiveRunForConversation(conversationId, runId);
  }

  /** Resolves once every chat save that had started when it was called has
   *  finished (and so has queued what it changed for the User's server). */
  settleChatSaves(): Promise<void> {
    return this.modules.store.settleChatSaves();
  }

  /** Machine side: records where a chat's project lives here before a turn
   *  runs in it. Device-local; never part of the chat's shared state. */
  applyMachineRepository(conversationId: string, repository: { sourcePath: string; paths: Record<string, string> } | undefined): Promise<void> {
    return this.modules.host.applyMachineRepository(conversationId, repository);
  }

  setServerChatReader(reader: ((conversationId: string) => Promise<{ conversation: Conversation; turns: HubTurn[] } | undefined>) | undefined): void {
    this.modules.serverChat.setServerChatReader(reader);
  }

  /** Replaces this device's copy of a chat with the server's (a chat this
   *  device does not hold, one moved to the server, or after the feed
   *  forgot this device's place). Its own bookkeeping on messages stays. */
  reloadChatFromServer(conversationId: string): Promise<void> {
    return this.modules.serverChat.reloadChatFromServer(conversationId);
  }

  /** Applies what the server accepted (from any device, this one included),
   *  in the server's order, to this device's copy. Stored without being sent
   *  back; then members whose turns were asked here start (Д4). */
  applyServerEntries(entries: HubFeedEntry[]): Promise<void> {
    return this.modules.serverChat.applyServerEntries(entries);
  }

  /** Runs, here, a turn the server asked of one of this device's members
   *  (a User's message from any device, a request from a member elsewhere). */
  startServerTurn(turn: HubTurn): Promise<void> {
    return this.modules.serverTurns.startServerTurn(turn);
  }

  /** Moves one chat to the server (the first link, 5.7): sent as this device
   *  holds it, with its saves held meanwhile; what was queued for it is part
   *  of the move. */
  exportChatForServer(conversationId: string, send: (conversation: Conversation) => Promise<void>): Promise<void> {
    return this.modules.store.exportChatForServer(conversationId, send);
  }

  /** After a start or a reconnect: every turn this device took and that
   *  nothing runs any more is closed (it stopped or restarted in the middle
   *  of it), and every turn asked of its members that nobody took yet starts
   *  (the computer or machine was off). */
  resumeServerTurns(): Promise<void> {
    return this.modules.serverTurns.resumeServerTurns();
  }

  /** The app quits (main.ts, before-quit), as a machine drains: no turn the
   *  server asks starts here from now on (it waits there), and no requester
   *  is resumed (its recovery does it at the next start). */
  beginQuit(): void {
    this.modules.appQuit.beginQuit();
  }

  /** The quit did not happen after all (main.ts quitWasCancelled): turns
   *  start and requesters resume again. */
  endQuit(): void {
    this.modules.appQuit.endQuit();
  }

  /** Resolves once no member's turn runs here (each saved how it ended, so
   *  its end is queued for the server), or after `timeoutMs`. A requester
   *  still collecting answers is not waited for (liveRunIds counts it): it
   *  is resumed at the next start. */
  waitForRunsToEnd(timeoutMs: number): Promise<boolean> {
    return this.modules.appQuit.waitForRunsToEnd(timeoutMs);
  }

  /** Quitting, while the members' processes close: a turn of a member here
   *  that has not ended by itself ends now as the next start would close it
   *  (its bubble swept as recoverStaleChatRun does, its turn on the server
   *  finished as interrupted), in one save per chat, so the server hears it
   *  before the link closes. The run's own end comes seconds later (a closed
   *  process is told apart from a missing CLI); a reply that does end after
   *  all still replaces the swept bubble. Returns how many turns it ended. */
  endTurnsForQuit(): Promise<number> {
    return this.modules.appQuit.endTurnsForQuit();
  }

  /** The User's server refused a message this device wrote: the message
   *  says so with the reason, instead of waiting to be sent (Д3). */
  markMessageRefused(conversationId: string, messageId: string, reason: string): Promise<void> {
    return this.modules.serverPlaceholders.markMessageRefused(conversationId, messageId, reason);
  }

  /** Installs (or removes) the link to the User's server (Д1). Without a
   *  link, `parked` is where saves keep queuing what they change for it. */
  setServerLink(link: ChatServerLink | undefined, parked?: ChatServerQueue): void {
    this.modules.serverLink.setServerLink(link, parked);
  }

  /** Whether a member runs on this device (Д4): a machine runs the members
   *  homed on it; the computer runs every member without a machine. */
  runsHere(participant: Pick<ChatParticipant, "homeMachineId" | "cloudRun">): boolean {
    return this.modules.host.runsHere(participant);
  }

  // --- cards a member waits on, on the User's server (Д9) -------------------

  /** Sets what applies the User's answers to this device's members' cards
   *  (the native approval and choice executors). */
  setCardAppliers(appliers: (() => Promise<ChatCardAppliers>) | undefined): void {
    this.modules.serverCards.setCardAppliers(appliers);
  }

  /** The server answered one of this device's operations: for a card, how
   *  it holds it now. A raise it refused is not sent again as it was. */
  noteServerOpAnswered(op: HubOp, outcome: HubOpOutcome): void {
    this.modules.serverCards.noteServerOpAnswered(op, outcome);
  }

  /**
   * After a start or a reconnect: the server's open cards are read. Cards
   * this device holds for its members are raised where the server lacks
   * them (or lacks what they show now) and settled where they are resolved
   * here; answers this device has not applied yet are applied; and the
   * desktop's view of other devices' cards is brought up to date.
   */
  resumeServerCards(options: { messages?: boolean } = {}): Promise<void> {
    return this.modules.serverCardMirrors.resumeServerCards(options);
  }

  /**
   * The User answered a card on this device's screen: the answer is written
   * to the User's server and this resolves once the server accepted it (its
   * refusal is the error). A card raised here is applied here from the feed
   * (exactly once, whoever answered); this waits for that too, a little, so
   * a refusal of this device's own (a script's missing keys) is shown.
   */
  answerServerCard(request: { conversationId: string; cardId: string; answer: Record<string, unknown>; raisedHere: boolean }): Promise<void> {
    return this.modules.serverCards.answerServerCard(request);
  }

  /** The User's answer to an app-tool approval (a permission or a roster
   *  change), from this device's card: written to the User's server. */
  answerAppToolApprovalCard(request: RespondToChatAppToolApprovalRequest): Promise<void> {
    return this.modules.approvalDecisions.answerAppToolApprovalCard(request);
  }

  /** The User's answer to a member's choice, from this device's card. */
  answerChoiceCard(request: RespondToChatChoiceRequest): Promise<void> {
    return this.modules.choiceAnswers.answerChoiceCard(request);
  }

  /** The User's answer to a member's mentions waiting for approval, from
   *  this device's card. Continuing the member after its mentions were all
   *  answered asks nothing of anyone's card: it is a turn of that member,
   *  started here and run where the member runs. */
  answerMentionsCard(request: RespondToChatMentionsRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<StartReviewResult> {
    return this.modules.choiceAnswers.answerMentionsCard(request, signal, progress);
  }

  /** Reads a body from the User's server by its reference (a picture sent
   *  from the phone). */
  setHubBlobReader(reader: ((reference: DeviceEventBlobReference) => Promise<Buffer>) | undefined): void {
    this.modules.bodyTransport.setHubBlobReader(reader);
  }

  /** Puts a body on the User's server and returns its reference. */
  setHubBlobWriter(writer: ((bytes: Buffer) => Promise<DeviceEventBlobReference>) | undefined): void {
    this.modules.bodyTransport.setHubBlobWriter(writer);
  }

  /** Told when a provider's model list, read in the background, changed what New chat offers. */
  set onNewChatOffersChanged(listener: (() => void) | undefined) {
    this.modules.newChatOffers.onNewChatOffersChanged = listener;
  }
}
