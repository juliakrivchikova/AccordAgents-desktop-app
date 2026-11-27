import type { CreateTerminalRequest, TerminalHostStateEvent, TerminalListResult, TerminalSummary } from "../terminal";
import type {
  CreateMachineRequest, CreateMachineResult, MachineEnrollmentRequest, MachineListResult, MachineTrustedDevicesResult,
  SaveTrustedDeviceRequest, RemoveMachineRequest, MachineInactivityQuestion, AnswerMachineInactivityRequest
} from "../machineLink";
import type {
  MachineInstallRecord, MachineInstallRequest, MachineInstallResult, MachineInstallSnapshot, MachineMirrorBootstrapRequest,
  MachineMirrorBootstrapResult, MachineRuntimePayloadInfo, MachineRuntimeProbe, MachineSshTarget, MachineUpgradeRequest
} from "../machineInstall";
import type { AvatarStudioTurnRequest, AvatarStudioTurnResult, ReadCustomAvatarResult, SaveCustomAvatarRequest } from "../avatarStudio";
import type {
  AgentEnvironmentSnapshot, DeleteAgentEnvironmentVariableRequest, SaveAgentEnvironmentVariableRequest
} from "./agentEnvironment";
import type { AgentDetectionRequest, AgentHealth, CliSignInKind, CliSignInState } from "./agents";
import type {
  ArtifactDiffResult, ArtifactDraftContent, ArtifactDraftSummary, ArtifactDraftView, ArtifactReadResult, ArtifactResult,
  ArtifactSummary, ArtifactsUpdatedEvent, CollectingArtifactReadResult, CreateArtifactRequest, DiffArtifactRequest,
  ListArtifactDraftsRequest, ListArtifactsRequest, PublishArtifactRequest, PublishedArtifactReadResult, ReadArtifactDraftRequest,
  ReadArtifactRequest, RenameArtifactRequest, ReplaceArtifactDraftRequest, ReviseArtifactRequest, SaveArtifactDraftRequest,
  SetArtifactArchivedRequest, SignArtifactRequest, SubmitArtifactDraftRequest, UpdateArtifactAccessRequest,
  UpdateArtifactDraftRosterRequest, WithdrawArtifactDraftRequest
} from "./artifacts";
import type {
  AwsDiskChangeResult, AwsDiskChosenWork, AwsDiskCleanCategory, AwsDiskListing, AwsDiskReport, AwsInstanceProjectProgress,
  AwsInstanceProjects
} from "./awsDisk";
import type {
  AwsWorkerOperationSnapshot, AwsWorkerStartRequest, AwsWorkerStartResult, AwsWorkerStatus, ConnectAwsWorkerRequest,
  SetAwsAutoStopRequest
} from "./awsWorker";
import type {
  AddChatParticipantRequest, ChatPinState, ChatTitleState, ChatViewState, CloseAccordCardRequest, CompactChatParticipantRequest,
  CreateChatConversationRequest, DeleteChatConversationRequest, DismissConversationWarningsRequest,
  DismissTurnFinishedNoteRequest, ReadChatAttachmentRequest, ReadChatAttachmentResult, RemoveChatParticipantRequest,
  RenameChatConversationRequest, RespondToChatAppToolApprovalRequest, RespondToChatChoiceRequest, RespondToChatMentionsRequest,
  RestartChatParticipantRequest, SendChatMessageRequest, SetChatArchivedRequest, SetChatPinnedRequest, SetChatViewRequest,
  StartChatAccordRequest, StartChatAccordResult, ToggleChatReactionRequest, UpdateChatParticipantRuntimeRequest
} from "./chatRequests";
import type { SubagentDefaultUpdate, UpdateChatSubagentProvidersRequest, UpdateChatSubagentProvidersResult } from "./subagentProviders";
import type { ChatSearchRequest, ChatSearchResponse } from "./chatSearch";
import type { CliImportListResult, CliImportRequest, CliImportResult } from "./cliImport";
import type {
  CloudRunsSettingsUpdate, CloudRunWorkerDoctorReport, CloudRunWorkerSettings, CloudRunWorkerSetupProgress,
  CloudRunWorkerTestResult
} from "./cloudRuns";
import type {
  ChatPromptSuggestion, ChatPromptSuggestionsUpdate, ChatRunningMessageTarget, Conversation, ConversationMessagePage,
  ConversationMessagePageRequest, ConversationOpenResult, ConversationSummary, ConversationUpdate
} from "./conversations";
import type {
  FilePreview, FilePreviewChangedEvent, InspectLocalFileRequest, InspectLocalFileResult, OpenLocalFileRequest,
  OpenLocalFileResult, ReadFilePreviewRequest, RepoFileExternalOpenAction, RepoFileOpenAction, UnsavedFileEdit,
  WriteFilePreviewRequest, WriteFilePreviewResult
} from "./files";
import type { ChatBackgroundTask, ChatBackgroundTasksEvent, ReviewProgress } from "./messages";
import type { CreatePhoneInviteRequest, CreatePhoneInviteResult, RevokePhoneInviteResult } from "./phoneInvites";
import type { ChatProviderKind, CliProviderHostUpdate, ProviderKind, ProviderModelCatalog, ProviderSettingsUpdate } from "./providers";
import type {
  GitDiffRequest, GitDiffResult, GitRepoInfo, GitSwitchBranchRequest, RepoFileSearchRequest, RepoFileSearchResult
} from "./repositories";
import type {
  ComposeImplementationPlanRequest, ContinueReviewRequest, PlanDecisionClarificationRequest, PlanItemReviewRequest,
  RecoverImplementationPlanRequest, RetryImplementationPlanSynthesisRequest, ReviewRequest, ReviseImplementationPlanRequest,
  StartReviewResult
} from "./reviews";
import type { ChatBehaviorRuleConfigUpdate, ChatParticipantConfigUpdate, ChatRoleConfigUpdate, ChatSavedPromptConfigUpdate } from "./roles";
import type { AppSettings, ChatPromptContextSettings, ClaudeChromeSetting, NewChatDefaultsUpdate } from "./settings";
import type {
  PluginListRequest, PluginListResult, UserSkillDiagnostics, UserSkillDiagnosticsRequest, UserSkillListRequest,
  UserSkillListResult, UserSkillSearchRequest, UserSkillSearchResult
} from "./skills";
import type { DisableSpeechToTextRequest, SpeechToTextState, TranscribeSpeechRequest, TranscribeSpeechResult } from "./speechToText";

export interface AppBridge {
  getAppVersion(): Promise<string>;
  /** Whether the window is in full screen, where macOS hides its traffic lights. */
  isFullScreen(): Promise<boolean>;
  onFullScreenChanged(callback: (fullScreen: boolean) => void): () => void;
  openExternal(url: string): Promise<void>;
  inspectLocalFile(request: InspectLocalFileRequest): Promise<InspectLocalFileResult>;
  openLocalFile(request: OpenLocalFileRequest): Promise<OpenLocalFileResult>;
  setRepoFileOpenPreference(action: RepoFileOpenAction | null): Promise<AppSettings>;
  /** null: ask every time for a file the side panel does not show. */
  setRepoFileExternalOpenPreference(action: RepoFileExternalOpenAction | null): Promise<AppSettings>;
  readFilePreview(request: ReadFilePreviewRequest): Promise<FilePreview>;
  writeFilePreview(request: WriteFilePreviewRequest): Promise<WriteFilePreviewResult>;
  watchFilePreview(request: ReadFilePreviewRequest): Promise<void>;
  unwatchFilePreview(realPath: string): Promise<void>;
  /** Releases the protocol tokens of a file the panel no longer shows. */
  releaseFilePreview(realPath: string): Promise<void>;
  onFilePreviewChanged(callback: (event: FilePreviewChangedEvent) => void): () => void;
  saveUnsavedFileEdit(edit: UnsavedFileEdit): Promise<void>;
  clearUnsavedFileEdit(realPath: string): Promise<void>;
  listUnsavedFileEdits(): Promise<UnsavedFileEdit[]>;
  /** The main process asks the window to save every open panel file before it closes or quits. */
  onFlushFileEdits(callback: (requestId: string) => void): () => void;
  fileEditsFlushed(requestId: string): void;
  setBetaUpdates(enabled: boolean): Promise<AppSettings>;
  setChatShowMemberActions(shown: boolean): Promise<AppSettings>;
  /** Off takes effect at once; on applies from the next launch. */
  setCrashReports(enabled: boolean): Promise<AppSettings>;
  dismissCrashReportsNotice(): Promise<AppSettings>;
  /** Whether this window was opened with reports running, so the renderer
   *  starts its half of the SDK only then. */
  readonly crashReportsActive: boolean;
  setCliAgentRunTimeoutMs(timeoutMs: number): Promise<AppSettings>;
  setChatParticipantRequestMaxDepth(maxDepth: number): Promise<AppSettings>;
  setChatParticipantRequestPromptMaxChars(maxChars: number): Promise<AppSettings>;
  setChatAutoWatchWakeLimit(limit: number): Promise<AppSettings>;
  setChatPromptContext(settings: ChatPromptContextSettings): Promise<AppSettings>;
  saveCloudRunsSettings(update: CloudRunsSettingsUpdate): Promise<AppSettings>;
  testCloudRunWorker(request?: CloudRunWorkerSettings): Promise<CloudRunWorkerTestResult>;
  diagnoseCloudRunWorker(request?: CloudRunWorkerSettings): Promise<CloudRunWorkerDoctorReport>;
  /** `signIn`: sign in only this provider; without it every enabled
   *  provider must be signed in, as before. */
  setupCloudRunWorker(request?: CloudRunWorkerSettings, options?: { signIn?: "codex-cli" | "claude-code" | "none" }): Promise<CloudRunWorkerDoctorReport>;
  getCloudRunSetupProgress(): Promise<CloudRunWorkerSetupProgress | null>;
  submitCloudRunAuthCode(request: { requestId: string; code: string }): Promise<void>;
  cancelCloudRunAuth(requestId: string): Promise<void>;
  isCloudRunAuthActive(requestId: string): Promise<boolean>;
  onCloudRunSetupProgress(callback: (progress: CloudRunWorkerSetupProgress) => void): () => void;
  getAwsWorkerBootstrapCommand(region: string, recoveryOperationId?: string): Promise<string>;
  connectAwsWorker(request: ConnectAwsWorkerRequest): Promise<AwsWorkerStatus>;
  startAwsWorker(request: AwsWorkerStartRequest): Promise<AwsWorkerStartResult>;
  onAwsWorkerProgress(callback: (progress: AwsWorkerOperationSnapshot) => void): () => void;
  getAwsWorkerStatus(): Promise<AwsWorkerStatus>;
  /** The automatic-stop switch; returns the status it leads to. */
  setAwsAutoStop(request: SetAwsAutoStopRequest): Promise<AwsWorkerStatus>;
  /** Sets the program on the instance's cloud machine up again, the way
   *  choosing Cloud run does, so it can stop the instance by itself. */
  reconnectAwsMachine(machineId?: string): Promise<AwsWorkerStatus>;
  /** The running instance's disk, measured on it (a slow, low-priority pass)
   *  or the last measurement when it is recent; never starts the instance. */
  getAwsInstanceDisk(options?: { refresh?: boolean }): Promise<AwsDiskReport>;
  cleanAwsInstanceDisk(category: AwsDiskCleanCategory): Promise<AwsDiskChangeResult>;
  /** A folder on the instance, largest first. "@runs" and "@mirrors" name the
   *  cloud run files and the project copies; nothing means the home folder. */
  listAwsInstanceFiles(path?: string): Promise<AwsDiskListing>;
  /** Removes only what the instance itself confirms is safe at that moment.
   *  `withWork` names the chosen project copies the User deletes with their
   *  members' work, with the kinds of work she saw on each; a copy that
   *  holds any other kind by then stays. */
  deleteAwsInstanceFiles(paths: string[], options?: { withWork?: AwsDiskChosenWork }): Promise<AwsDiskChangeResult>;
  /** Settings → AWS → Projects: the project copies on the instance and this
   *  computer's projects that could be added. */
  listAwsInstanceProjects(): Promise<AwsInstanceProjects>;
  /** Copies one of this computer's projects to the instance; resolves when
   *  the copy is there. A copy already there is kept as it is. */
  addAwsInstanceProject(localPath: string): Promise<void>;
  /** Stops a copy `addAwsInstanceProject` is making; nothing half-copied stays. */
  cancelAwsInstanceProjectAdd(localPath: string): Promise<void>;
  onAwsInstanceProjectProgress(callback: (progress: AwsInstanceProjectProgress) => void): () => void;
  stopAwsWorker(): Promise<AwsWorkerStatus>;
  deleteAwsWorker(): Promise<AwsWorkerStatus>;
  getAgentEnvironment(): Promise<AgentEnvironmentSnapshot>;
  saveAgentEnvironmentVariable(request: SaveAgentEnvironmentVariableRequest): Promise<AgentEnvironmentSnapshot>;
  deleteAgentEnvironmentVariable(request: DeleteAgentEnvironmentVariableRequest): Promise<AgentEnvironmentSnapshot>;
  /** Reads this computer's variables again and brings the automatic ones in step. */
  refreshAgentEnvironment(): Promise<AgentEnvironmentSnapshot>;
  saveCliProviderHost(update: CliProviderHostUpdate): Promise<AppSettings>;
  deleteCliProviderHost(id: string): Promise<AppSettings>;
  getSettings(): Promise<AppSettings>;
  setAssistantProviderKind(kind: ChatProviderKind): Promise<AppSettings>;
  setNewChatDefaults(update: NewChatDefaultsUpdate): Promise<AppSettings>;
  setSubagentDefault(update: SubagentDefaultUpdate): Promise<AppSettings>;
  updateProviderSettings(update: ProviderSettingsUpdate): Promise<AppSettings>;
  saveChatRoleConfig(update: ChatRoleConfigUpdate): Promise<AppSettings>;
  archiveChatRoleConfig(id: string): Promise<AppSettings>;
  saveChatBehaviorRuleConfig(update: ChatBehaviorRuleConfigUpdate): Promise<AppSettings>;
  deleteChatBehaviorRuleConfig(id: string): Promise<AppSettings>;
  saveChatSavedPromptConfig(update: ChatSavedPromptConfigUpdate): Promise<AppSettings>;
  deleteChatSavedPromptConfig(id: string): Promise<AppSettings>;
  saveChatParticipantConfig(update: ChatParticipantConfigUpdate): Promise<AppSettings>;
  runAvatarStudioTurn(request: AvatarStudioTurnRequest): Promise<AvatarStudioTurnResult>;
  cancelAvatarStudioTurn(studioId: string): Promise<void>;
  closeAvatarStudio(studioId: string): Promise<void>;
  saveCustomAvatar(request: SaveCustomAvatarRequest): Promise<AppSettings>;
  readCustomAvatar(id: string): Promise<ReadCustomAvatarResult>;
  deleteChatParticipantConfig(id: string): Promise<AppSettings>;
  updateLastRepoPath(repoPath: string): Promise<AppSettings>;
  /** `hostId`: list the models of a member on that added provider when its
   *  CLI's list depends on the credential (Antigravity on a Gemini API key). */
  listProviderModels(kind: ProviderKind, hostId?: string): Promise<ProviderModelCatalog>;
  detectAgents(request?: AgentDetectionRequest): Promise<AgentHealth[]>;
  /** Runs the CLI's own sign-in on this computer (`claude auth login`,
   *  `codex login`); a second start while one runs returns that one. */
  startCliSignIn(kind: CliSignInKind): Promise<CliSignInState>;
  listCliSignIns(): Promise<CliSignInState[]>;
  submitCliSignInCode(request: { requestId: string; code: string }): Promise<void>;
  cancelCliSignIn(requestId: string): Promise<void>;
  onCliSignInUpdated(callback: (state: CliSignInState) => void): () => void;
  openTerminal(): Promise<void>;
  /** The terminal panel. Output and input go over a MessagePort the window
   *  gets after connectTerminals(); these only manage the terminals. */
  listTerminals(): Promise<TerminalListResult>;
  createTerminal(request?: CreateTerminalRequest): Promise<TerminalSummary>;
  killTerminal(terminalId: string): Promise<void>;
  connectTerminals(): Promise<boolean>;
  restartTerminals(): Promise<TerminalListResult>;
  terminalWorkspaceRoot(repoPath?: string): Promise<string | null>;
  /** The path of a file dropped on a terminal ("" when it has none). */
  terminalPathForFile(file: unknown): string;
  onTerminalHostState(callback: (event: TerminalHostStateEvent) => void): () => void;
  selectRepoDirectory(): Promise<string | undefined>;
  inspectRepo(repoPath: string): Promise<GitRepoInfo>;
  /** Switches a folder to one of its own branches (`git switch`); rejects
   *  with git's words when it refuses. Returns the folder as it is after. */
  switchGitBranch(request: GitSwitchBranchRequest): Promise<GitRepoInfo>;
  getDiff(request: GitDiffRequest): Promise<GitDiffResult>;
  searchRepoFiles(request: RepoFileSearchRequest): Promise<RepoFileSearchResult[]>;
  searchUserSkills(request: UserSkillSearchRequest): Promise<UserSkillSearchResult>;
  getUserSkillDiagnostics(request?: UserSkillDiagnosticsRequest): Promise<UserSkillDiagnostics>;
  listUserSkills(request?: UserSkillListRequest): Promise<UserSkillListResult>;
  listPlugins(request?: PluginListRequest): Promise<PluginListResult>;
  refreshPlugins(request?: PluginListRequest): Promise<PluginListResult>;
  listConversations(): Promise<ConversationSummary[]>;
  searchChats(request: ChatSearchRequest): Promise<ChatSearchResponse>;
  /** The User's own CLI threads on this computer (docs/design/cli-import/plan.md). */
  listCliImportThreads(): Promise<CliImportListResult>;
  /** Each thread as a chat that goes on in its CLI session; a thread a chat
   *  already holds is not imported again (that chat is returned). */
  importCliThreads(request: CliImportRequest): Promise<CliImportResult>;
  getConversation(id: string): Promise<Conversation | undefined>;
  openConversation(id: string, limit?: number): Promise<ConversationOpenResult | undefined>;
  listConversationMessages(request: ConversationMessagePageRequest): Promise<ConversationMessagePage>;
  /** The member's message that is in progress right now, searched in the
   *  whole chat (an open chat holds only its latest page). */
  findRunningParticipantMessage(conversationId: string, participantId: string): Promise<ChatRunningMessageTarget | undefined>;
  saveDecisionSelections(conversationId: string, selections: Record<string, string>): Promise<Conversation | undefined>;
  saveDecisionResolutions(conversationId: string, resolutions: Record<string, boolean>): Promise<Conversation | undefined>;
  savePlanItemReview(request: PlanItemReviewRequest): Promise<Conversation | undefined>;
  createChatConversation(request: CreateChatConversationRequest): Promise<StartReviewResult>;
  renameChatConversation(request: RenameChatConversationRequest): Promise<ChatTitleState | undefined>;
  setChatArchived(request: SetChatArchivedRequest): Promise<Conversation | undefined>;
  setChatPinned(request: SetChatPinnedRequest): Promise<ChatPinState | undefined>;
  setChatView(request: SetChatViewRequest): Promise<ChatViewState | undefined>;
  deleteChatConversation(request: DeleteChatConversationRequest): Promise<boolean>;
  startChatAccord(request: StartChatAccordRequest): Promise<StartChatAccordResult>;
  dismissConversationWarnings(request: DismissConversationWarningsRequest): Promise<Conversation | undefined>;
  addChatParticipant(request: AddChatParticipantRequest): Promise<Conversation | undefined>;
  updateChatParticipantRuntime(request: UpdateChatParticipantRuntimeRequest): Promise<Conversation | undefined>;
  /** A change to the chat's Agents list (side panel), for this chat only. */
  updateChatSubagentProviders(request: UpdateChatSubagentProvidersRequest): Promise<UpdateChatSubagentProvidersResult>;
  removeChatParticipant(request: RemoveChatParticipantRequest): Promise<Conversation | undefined>;
  compactChatParticipant(request: CompactChatParticipantRequest): Promise<StartReviewResult>;
  getClaudeChromeSetting(): Promise<ClaudeChromeSetting>;
  setClaudeChromeEnabledByDefault(enabled: boolean): Promise<ClaudeChromeSetting>;
  /** The chat itself arrives as a snapshot update; nothing is returned, so a
   *  large chat is not sent twice. */
  restartChatParticipant(request: RestartChatParticipantRequest): Promise<void>;
  sendChatMessage(request: SendChatMessageRequest): Promise<StartReviewResult>;
  readChatAttachment(request: ReadChatAttachmentRequest): Promise<ReadChatAttachmentResult>;
  toggleChatReaction(request: ToggleChatReactionRequest): Promise<Conversation | undefined>;
  dismissTurnFinishedNote(request: DismissTurnFinishedNoteRequest): Promise<void>;
  closeAccordCard(request: CloseAccordCardRequest): Promise<void>;
  respondToChatMentions(request: RespondToChatMentionsRequest): Promise<StartReviewResult>;
  respondToChatChoice(request: RespondToChatChoiceRequest): Promise<StartReviewResult>;
  respondToChatAppToolApproval(request: RespondToChatAppToolApprovalRequest): Promise<Conversation | undefined>;
  /** A one-time code a phone pairs with the User's server by. */
  createPhoneInvite(request?: CreatePhoneInviteRequest): Promise<CreatePhoneInviteResult>;
  /** Revokes a phone code: unused, it stops working; used, its phone is removed. */
  revokePhoneInvite(request: { inviteId: string }): Promise<RevokePhoneInviteResult>;
  /** The User's own hub: what is set up, the command that creates its server,
   *  and the installation from the line that command prints. */
  getHubSetupState(): Promise<import("../hubSetup").HubSetupState>;
  /** Urgent alerts on the User's server: Settings → Alerts, and closing an
   *  alert's card (shared/urgentAlerts.ts). */
  urgentAlertRequest(request: import("../urgentAlerts").UrgentAlertUserRequest): Promise<import("../urgentAlerts").HubAlertResult<unknown>>;
  getHubSetupCommand(request: import("../hubSetup").HubSetupCommandRequest): Promise<import("../hubSetup").HubSetupCommandResult>;
  installHub(request: import("../hubSetup").HubInstallRequest): Promise<import("../hubSetup").HubSetupState>;
  onHubSetupProgress(callback: (state: import("../hubSetup").HubSetupState) => void): () => void;
  /** Speech to text: dictation recognized on this computer by a downloaded
   *  Whisper model. Off until the User turns it on in General settings. */
  getSpeechToTextState(): Promise<SpeechToTextState>;
  /** Turns it on and downloads the model, or resumes an interrupted download. */
  enableSpeechToText(): Promise<SpeechToTextState>;
  /** Stops a download in progress, removes what was downloaded, turns it off. */
  cancelSpeechToTextDownload(): Promise<SpeechToTextState>;
  disableSpeechToText(request: DisableSpeechToTextRequest): Promise<SpeechToTextState>;
  /** The key held to dictate while the app is in front. */
  setSpeechToTextHoldKey(holdKey: import("../speechToText").SpeechHoldKey): Promise<SpeechToTextState>;
  /** Starts loading the speech model as she begins to dictate; returns at once. */
  prepareSpeechToText(): Promise<void>;
  /** Recognizes one recording, or one piece of a long one (16 kHz mono
   *  16-bit WAV), optionally given the text before it and its language. */
  transcribeSpeech(request: TranscribeSpeechRequest): Promise<TranscribeSpeechResult>;
  /** Asks the system for the microphone; false when it is refused or off. */
  requestMicrophoneAccess(): Promise<boolean>;
  onSpeechToTextState(callback: (state: SpeechToTextState) => void): () => void;
  startReview(request: ReviewRequest): Promise<StartReviewResult>;
  continueReview(request: ContinueReviewRequest): Promise<StartReviewResult>;
  askPlanDecisionClarification(request: PlanDecisionClarificationRequest): Promise<StartReviewResult>;
  composeImplementationPlan(request: ComposeImplementationPlanRequest): Promise<StartReviewResult>;
  retryImplementationPlanSynthesis(request: RetryImplementationPlanSynthesisRequest): Promise<StartReviewResult>;
  recoverImplementationPlan(request: RecoverImplementationPlanRequest): Promise<StartReviewResult>;
  reviseImplementationPlan(request: ReviseImplementationPlanRequest): Promise<StartReviewResult>;
  cancelReview(runId: string): Promise<void>;
  /** Send now on a message waiting behind the member's running reply `runId`
   *  (the CLI's send-now): the one waiting as `waitingRunId`, or every one. */
  sendNowChatRun(runId: string, waitingRunId?: string): Promise<void>;
  listArtifacts(request: ListArtifactsRequest): Promise<ArtifactResult<ArtifactSummary[]>>;
  readArtifact(request: ReadArtifactRequest): Promise<ArtifactResult<ArtifactReadResult>>;
  diffArtifactVersions(request: DiffArtifactRequest): Promise<ArtifactResult<ArtifactDiffResult>>;
  createArtifact(request: CreateArtifactRequest): Promise<ArtifactResult<ArtifactReadResult>>;
  reviseArtifact(request: ReviseArtifactRequest): Promise<ArtifactResult<ArtifactReadResult>>;
  renameArtifact(request: RenameArtifactRequest): Promise<ArtifactResult<ArtifactSummary>>;
  signArtifact(request: SignArtifactRequest): Promise<ArtifactResult<ArtifactSummary>>;
  updateArtifactAccess(request: UpdateArtifactAccessRequest): Promise<ArtifactResult<ArtifactSummary>>;
  setArtifactArchived(request: SetArtifactArchivedRequest): Promise<ArtifactResult<ArtifactSummary>>;
  listArtifactDrafts(request: ListArtifactDraftsRequest): Promise<ArtifactResult<ArtifactDraftView[]>>;
  readArtifactDraft(request: ReadArtifactDraftRequest): Promise<ArtifactResult<ArtifactDraftContent>>;
  saveArtifactDraft(request: SaveArtifactDraftRequest): Promise<ArtifactResult<ArtifactDraftContent>>;
  submitArtifactDraft(request: SubmitArtifactDraftRequest): Promise<ArtifactResult<ArtifactDraftContent>>;
  replaceArtifactDraft(request: ReplaceArtifactDraftRequest): Promise<ArtifactResult<ArtifactDraftContent>>;
  withdrawArtifactDraft(request: WithdrawArtifactDraftRequest): Promise<ArtifactResult<ArtifactDraftSummary>>;
  updateArtifactDraftRoster(request: UpdateArtifactDraftRosterRequest): Promise<ArtifactResult<CollectingArtifactReadResult>>;
  publishArtifact(request: PublishArtifactRequest): Promise<ArtifactResult<PublishedArtifactReadResult>>;
  onArtifactsUpdated(callback: (event: ArtifactsUpdatedEvent) => void): () => void;
  // Scheduled scripts on this desktop.
  listScripts(): Promise<import("../scripts").ScheduledScriptSummary[]>;
  getScriptRevision(request: import("../scripts").GetScriptRevisionRequest): Promise<import("../scripts").ScriptRevisionContent>;
  getScriptRuns(request: import("../scripts").ScriptIdRequest): Promise<import("../scripts").ScriptRunRow[]>;
  setScriptSecret(request: import("../scripts").SetScriptSecretRequest): Promise<import("../scripts").ScheduledScriptSummary>;
  deleteScriptSecret(request: import("../scripts").DeleteScriptSecretRequest): Promise<import("../scripts").ScheduledScriptSummary>;
  setScriptEnabled(request: import("../scripts").SetScriptEnabledRequest): Promise<import("../scripts").ScheduledScriptSummary>;
  runScriptNow(request: import("../scripts").ScriptIdRequest): Promise<void>;
  deleteScript(request: import("../scripts").ScriptIdRequest): Promise<void>;
  releaseHeldScriptMessages(request: import("../scripts").ScriptIdRequest): Promise<void>;
  discardHeldScriptMessages(request: import("../scripts").ScriptIdRequest): Promise<void>;
  onScriptsUpdated(callback: (event: import("../scripts").ScriptsUpdatedEvent) => void): () => void;
  // Members' long-term memory on the User's server (Settings → Memory: look and delete only).
  listMemoryNotes(request: import("../memory").MemorySettingsListRequest): Promise<import("../memory").MemorySettingsListResult>;
  readMemoryNote(request: import("../memory").MemoryNoteIdRequest): Promise<import("../memory").MemoryResult<import("../memory").MemoryNote>>;
  deleteMemoryNote(request: import("../memory").MemoryNoteIdRequest): Promise<import("../memory").MemoryResult<{ deleted: boolean }>>;
  // Search by meaning (Settings → General): the User's OpenAI key, kept on her server.
  getSemanticSearchSettings(): Promise<import("../memory").SemanticSettingsResult>;
  setSemanticSearchKey(request: { key: string }): Promise<import("../memory").MemoryResult<import("../memory").SemanticSettingsView>>;
  removeSemanticSearchKey(): Promise<import("../memory").MemoryResult<import("../memory").SemanticSettingsView>>;
  // Machines transport: machines that host participants.
  listMachines(): Promise<MachineListResult>;
  getCloudRunPreparation(request: Pick<import("../cloudRunPreparation").PrepareCloudRunRequest, "provider" | "instanceId">): Promise<import("../cloudRunPreparation").CloudRunPreparationState | undefined>;
  prepareCloudRun(request: import("../cloudRunPreparation").PrepareCloudRunRequest): Promise<import("../cloudRunPreparation").PrepareCloudRunResult>;
  onCloudRunPreparationProgress(callback: (snapshot: import("../cloudRunPreparation").CloudRunPreparationState) => void): () => void;
  createMachine(request: CreateMachineRequest): Promise<CreateMachineResult>;
  removeMachine(request: RemoveMachineRequest): Promise<MachineListResult>;
  machineEnrollment(request: MachineEnrollmentRequest): Promise<CreateMachineResult>;
  onMachinesUpdated(callback: (result: MachineListResult) => void): () => void;
  /** Machines the User is asked about because they stopped being used. */
  listMachineInactivityQuestions(): Promise<MachineInactivityQuestion[]>;
  answerMachineInactivity(request: AnswerMachineInactivityRequest): Promise<MachineInactivityQuestion[]>;
  onMachineInactivityQuestions(callback: (questions: MachineInactivityQuestion[]) => void): () => void;
  // Machines transport: installing and upgrading the runtime on a machine.
  // This is the only SSH path to a machine; messaging always goes through
  // the User's server.
  probeMachineInstall(request: { machineId: string; target: MachineSshTarget }): Promise<MachineRuntimeProbe>;
  installMachine(request: MachineInstallRequest): Promise<MachineInstallResult>;
  upgradeMachine(request: MachineUpgradeRequest): Promise<MachineInstallResult>;
  bootstrapMachineProjectMirror(request: MachineMirrorBootstrapRequest): Promise<MachineMirrorBootstrapResult>;
  listMachineInstalls(): Promise<MachineInstallRecord[]>;
  listTrustedDevices(): Promise<MachineTrustedDevicesResult>;
  trustDevice(request: SaveTrustedDeviceRequest): Promise<MachineTrustedDevicesResult>;
  untrustDevice(deviceId: string): Promise<MachineTrustedDevicesResult>;
  /** What runtime this desktop would install on a machine, or why it cannot. */
  machineRuntimePayload(): Promise<MachineRuntimePayloadInfo>;
  onMachineInstallProgress(callback: (snapshot: MachineInstallSnapshot) => void): () => void;
  onReviewProgress(callback: (progress: ReviewProgress) => void): () => void;
  onConversationDeleted(callback: (conversationId: string) => void): () => void;
  onConversationUpdated(callback: (conversation: ConversationUpdate) => void): () => void;
  /** The next-prompt suggestions on offer in a chat (newest first). */
  getChatPromptSuggestions(conversationId: string): Promise<ChatPromptSuggestion[]>;
  onChatPromptSuggestions(callback: (update: ChatPromptSuggestionsUpdate) => void): () => void;
  /** Live background work of the chat's members, by member id. */
  getChatBackgroundTasks(conversationId: string): Promise<Record<string, ChatBackgroundTask[]>>;
  /** Members of the chat whose background tasks keep them on the environment
   *  variables their process started with (ChatBackgroundTasksEvent). */
  getChatEnvironmentPending(conversationId: string): Promise<string[]>;
  onChatBackgroundTasks(callback: (event: ChatBackgroundTasksEvent) => void): () => void;
  /** The plan usage of the members' CLI accounts: this computer's, and each
   *  machine's as it put them on the User's server. */
  getPlanUsage(): Promise<import("./planUsage").PlanUsageView>;
  refreshPlanUsage(request: import("./planUsage").PlanUsageRefreshRequest): Promise<import("./planUsage").PlanUsageRefreshResult>;
  onPlanUsageChanged(callback: (view: import("./planUsage").PlanUsageView) => void): () => void;
}
