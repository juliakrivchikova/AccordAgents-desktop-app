import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deriveAgentReadiness } from "../../shared/cliReadiness";
import type { AgentHealth, ChatMessage, Conversation } from "../../shared/types";
import { chatViewFor, isChatViewMode } from "../../shared/mainSession";
import {
  USAGE_EXISTING_INSTALL,
  USAGE_MILESTONES,
  USAGE_PROVIDER_FAMILIES,
  USAGE_ASSISTANT_ROLE_ID,
  USAGE_BUILTIN_ROLE_IDS,
  USAGE_ISO_WEEK_PATTERN,
  USAGE_PROVIDER_FIRST_USED,
  USAGE_WEEKLY_SNAPSHOT,
  usageIsoWeek,
  usageMemberFamilies,
  usageMultiRoleChat,
  usageRoleChosen,
  usageSignalAttributes,
  usageWeeklySnapshotAttributes,
  type UsageInstallCohort,
  type UsageMilestone,
  type UsageOs,
  type UsageProviderFamily,
  type UsageSignalAttributes,
  type UsageSignalExtra,
  type UsageSignalName,
  type UsageChatView,
  type UsageWeeklySnapshot
} from "../../shared/usageSignals";

/** Which signals this installation has sent, so none is sent twice. Outside
 *  the SDK's own folder: turning reports off empties that folder, and the
 *  steps sent before stay sent. */
export const USAGE_MILESTONES_FILE = "usage-milestones.json";

/** The chat database every launch of the app creates in its profile. */
const CHAT_DATABASE_FILE = "accordagents.sqlite3";

/** Whether an earlier launch used this profile: its chat database is there.
 *  Read before anything of this launch writes to the profile; an
 *  installation first seen by the usage signals is new only when it was not. */
export function usageProfileUsedBefore(userDataDir: string): boolean {
  return existsSync(path.join(userDataDir, CHAT_DATABASE_FILE));
}

interface UsageMilestonesState {
  version: 1;
  cohort: UsageInstallCohort;
  /** An existing installation's steps were looked up once: what it had
   *  already done counts as sent without being sent. */
  historyChecked: boolean;
  reached: Partial<Record<UsageMilestone, string>>;
  families: Partial<Record<UsageProviderFamily, string>>;
  /** The User turned reports off at this time; the next launch with them on
   *  counts steps only from then, so nothing done while they were off is
   *  ever sent. */
  pausedAt?: string;
  /** Steps count from here (set when reports came back on); the first
   *  launch otherwise. */
  countFrom?: string;
  /** The version of the feature list whose earlier use was looked up
   *  (installations that started reporting before a feature signal existed
   *  have not: what they had used is recorded as sent, not sent). */
  featureHistoryVersion?: number;
  /** Features count from here on an installation that was already
   *  reporting when feature signals came: what its chats and documents show
   *  from before is not a first use. */
  featuresFrom?: string;
  /** The ISO week the last weekly snapshot was sent for. */
  snapshotWeek?: string;
}

/** Which features an installation had already used before it could report
 *  them, read from what it keeps. */
/** The version of the list of features whose earlier use is looked up;
 *  raised when a feature signal is added, so installations look again. */
export const USAGE_FEATURE_HISTORY_VERSION = 2;

export interface UsageFeatureHistory {
  customRole: boolean;
  memberRoleChanged: boolean;
  multiRoleChat: boolean;
  behaviorRule: boolean;
  document: boolean;
  scheduledTask: boolean;
  memoryNote: boolean;
  phonePaired: boolean;
  urgentAlerts: boolean;
}

/** What an installation that was in use before these signals had already
 *  done, read cheaply from what it keeps (never by reading its messages). */
export interface UsageHistory {
  hasChat: boolean;
  /** Provider families of the members in its chats. */
  families: UsageProviderFamily[];
  /** A chat had members a person added of two provider families. */
  mixedFamilies: boolean;
  /** A document for several signers (an Accord's) exists. */
  accordStarted: boolean;
  /** Such a document is signed by all of them. */
  accordSigned: boolean;
  hasMachine: boolean;
}

export interface UsageInstallFacts {
  os: UsageOs;
  appVersion: string;
  locale: string;
  teamDevice: boolean;
}

export interface UsageMilestonesOptions {
  userDataDir: string;
  /** Whether this profile had been used before this launch: decided before
   *  anything of this launch wrote to it. */
  profileUsedBefore: boolean;
  /** Hands one signal to the reporting SDK; false when reports are off. */
  send(name: UsageSignalName, attributes: UsageSignalAttributes): boolean;
  /** Read once the app is ready (the system language is known only then). */
  installFacts(): UsageInstallFacts;
  readHistory(): Promise<UsageHistory>;
  readFeatureHistory(): Promise<UsageFeatureHistory>;
  /** This week's numbers (members, roles), read when one is due. */
  readWeeklySnapshot(week: string): Promise<UsageWeeklySnapshot>;
  /** Whether a document for several signers was made since `since`,
   *  whether one got the last of its signatures since then, and whether a
   *  document for fewer signers (outside an Accord) was made since then. */
  readDocuments(since: string, plainSince: string): Promise<{ started: boolean; signed: boolean; plain: boolean }>;
  log?(event: string, payload: Record<string, unknown>): void;
  now?(): Date;
}

type PendingSignal =
  | { kind: "milestone"; milestone: UsageMilestone; extra?: UsageSignalExtra }
  | { kind: "family"; family: UsageProviderFamily };

const STANDALONE_ACCORD_TOKEN = /(^|\s)\/accord\b/i;


type UsageMember = { kind?: unknown; hostId?: unknown; hostVendor?: unknown; roleConfigId?: unknown };

/** The provider families of the members a person added to a chat (the
 *  Assistant is in every chat, so it does not make a chat mixed). */
function addedMemberFamilies(members: ReadonlyArray<UsageMember | null | undefined>): Set<UsageProviderFamily> {
  return usageMemberFamilies(members.filter((member) => member?.roleConfigId !== USAGE_ASSISTANT_ROLE_ID));
}

/** The view each active chat is shown in (StorageService
 *  .listChatViewsWithUserMessagesSince), read as the chat's own switch reads
 *  it: a chat without a main session is classic, one whose view is unset is
 *  in the sessions view (every new chat opens there). */
export function usageActiveChatViews(
  chats: ReadonlyArray<{ mainSessionParticipantId?: string; chatView?: string }>
): UsageChatView[] {
  return chats.map((chat) => chatViewFor({
    mainSessionParticipantId: chat.mainSessionParticipantId,
    chatView: isChatViewMode(chat.chatView) ? chat.chatView : undefined,
    participants: chat.mainSessionParticipantId ? [{ id: chat.mainSessionParticipantId }] : []
  }));
}

/** How far before an installation's first launch a chat or message made on
 *  another device (the phone, a machine) still counts as made after it: the
 *  devices' clocks may differ a little. */
const CLOCK_SKEW_MS = 60_000;

function madeSince(createdAt: unknown, since: number): boolean {
  if (!Number.isFinite(since)) return true;
  const at = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
  return Number.isFinite(at) && at >= since;
}

/** The facts a chat update shows about the first steps. Only the messages
 *  the update carries are looked at, never the whole history, and only what
 *  was made since `since` counts as a step: a chat or reply this computer
 *  copied from the User's server (an older chat, or one from before this
 *  installation) is not a first step here. Its members still say which
 *  provider families the installation uses. */
export function chatUsageFacts(
  conversation: Pick<Conversation, "kind" | "metadata" | "createdAt">,
  messages: ReadonlyArray<ChatMessage> | undefined,
  since?: string,
  /** Where feature uses count from (`since` when absent). */
  featureSince?: string
): {
  chat: boolean;
  /** Made since `since`. */
  newChat: boolean;
  /** Made since `featureSince`. */
  newChatForFeatures: boolean;
  /** Every member's family, the Assistant's too. */
  families: UsageProviderFamily[];
  /** The families of the members a person added. */
  addedFamilies: UsageProviderFamily[];
  reply: boolean;
  memberRequest: boolean;
  accordStarted: boolean;
  /** Members a person added have different roles. */
  multiRole: boolean;
  /** A member has a role someone chose (not the app's default). */
  roleChosen: boolean;
  /** A person's message used a skill. */
  skill: boolean;
} {
  if (conversation.kind !== "chat") {
    return { chat: false, newChat: false, newChatForFeatures: false, families: [], addedFamilies: [], reply: false, memberRequest: false, accordStarted: false, multiRole: false, roleChosen: false, skill: false };
  }
  const sinceMs = since ? Date.parse(since) : Number.NaN;
  const featureSinceMs = featureSince ? Date.parse(featureSince) : sinceMs;
  const participants = Array.isArray(conversation.metadata?.participants) ? conversation.metadata.participants : [];
  const families = usageMemberFamilies(participants);
  const assistantIds = new Set(participants.filter((member) => member?.roleConfigId === USAGE_ASSISTANT_ROLE_ID).map((member) => member.id));
  const roles = new Map((messages ?? []).map((message) => [message.id, message.role]));
  let reply = false;
  let memberRequest = false;
  let accordStarted = false;
  let skill = false;
  for (const message of messages ?? []) {
    if (!madeSince(message.createdAt, sinceMs)) continue;
    if (message.role === "participant" && message.status === "done" && !message.metadata?.terminalReason && typeof message.content === "string" && message.content.trim()) {
      // The Assistant's reply counts only when it answers a person's message,
      // not when it posts on its own (a watch, a script, another member).
      const fromAssistant = Boolean(message.participantId && assistantIds.has(message.participantId));
      if (!fromAssistant || roles.get(message.metadata?.sourceMessageId ?? "") === "user") reply = true;
    }
    if (message.metadata?.participantRequest) {
      memberRequest = true;
    }
    if (message.role === "user" && isAccordStart(message)) {
      accordStarted = true;
    }
    // A skill a person used; an Accord (its launcher adds the mention on its
    // own) has its own steps.
    if (message.role === "user" && madeSince(message.createdAt, featureSinceMs) &&
      (message.metadata?.skillMentions ?? []).some((mention) => mention.frontmatterName !== "accord")) {
      skill = true;
    }
  }
  return {
    chat: true,
    newChat: madeSince(conversation.createdAt, sinceMs),
    newChatForFeatures: madeSince(conversation.createdAt, featureSinceMs),
    families: [...families],
    addedFamilies: [...addedMemberFamilies(participants)],
    reply,
    memberRequest,
    accordStarted,
    multiRole: usageMultiRoleChat(participants),
    roleChosen: participants.some((member) => usageRoleChosen(member?.roleConfigId)),
    skill
  };
}

function isAccordStart(message: ChatMessage): boolean {
  if (message.metadata?.skillMentions?.some((mention) => mention.frontmatterName === "accord")) {
    return true;
  }
  if (typeof message.content !== "string" || !/\/accord/i.test(message.content)) return false;
  const outsideCode = message.content.replace(/```[\s\S]*?```/g, "").replace(/`[^`\r\n]*`/g, "");
  return STANDALONE_ACCORD_TOKEN.test(outsideCode);
}

/** An existing installation's history from its chats' members, its
 *  documents and its machines. */
export function usageHistoryFrom(
  chats: ReadonlyArray<ReadonlyArray<UsageMember>>,
  documents: { started: boolean; signed: boolean },
  machineCount: number
): UsageHistory {
  const families = new Set<UsageProviderFamily>();
  let mixedFamilies = false;
  for (const members of chats) {
    for (const family of usageMemberFamilies(members)) families.add(family);
    if (addedMemberFamilies(members).size >= 2) mixedFamilies = true;
  }
  return {
    hasChat: chats.length > 0,
    families: [...families],
    mixedFamilies,
    accordStarted: documents.started,
    accordSigned: documents.signed,
    hasMachine: machineCount > 0
  };
}

/** Which features an existing installation had already used, from what it
 *  keeps: its chats' members, its saved members and roles, documents,
 *  scheduled tasks, memory notes and paired phones. */
export function usageFeatureHistoryFrom(input: {
  /** Each source is undefined when it could not be read: a feature it
   *  would show then counts as used before, so nothing old is sent as new. */
  chats?: ReadonlyArray<ReadonlyArray<UsageMember & { behaviorRuleCount?: number }>>;
  roles?: ReadonlyArray<{ id: string; builtIn?: boolean; archivedAt?: string }>;
  savedMembers?: ReadonlyArray<{ roleConfigId?: string; behaviorRuleIds?: string[] }>;
  plainDocument?: boolean;
  /** Scheduled tasks the User approved (a proposal no one approved is not
   *  one). */
  approvedScheduledTasks?: number;
  memoryNotes?: number;
  phones?: number;
  urgentAlerts?: boolean;
}): UsageFeatureHistory {
  const chatMembers = input.chats?.flat();
  const savedMembers = input.savedMembers;
  const usedOrUnknown = (known: boolean | undefined) => known === undefined || known;
  return {
    // A role made and later deleted was still made.
    customRole: usedOrUnknown(input.roles?.some((role) => !role.builtIn && !USAGE_BUILTIN_ROLE_IDS.has(role.id))),
    memberRoleChanged: !savedMembers || !chatMembers ||
      savedMembers.some((member) => usageRoleChosen(member.roleConfigId)) ||
      chatMembers.some((member) => usageRoleChosen(member?.roleConfigId)),
    multiRoleChat: usedOrUnknown(input.chats?.some((members) => usageMultiRoleChat(members))),
    behaviorRule: !savedMembers || !chatMembers ||
      savedMembers.some((member) => (member.behaviorRuleIds?.length ?? 0) > 0) ||
      chatMembers.some((member) => (member?.behaviorRuleCount ?? 0) > 0),
    document: usedOrUnknown(input.plainDocument),
    scheduledTask: usedOrUnknown(input.approvedScheduledTasks === undefined ? undefined : input.approvedScheduledTasks > 0),
    memoryNote: usedOrUnknown(input.memoryNotes === undefined ? undefined : input.memoryNotes > 0),
    phonePaired: usedOrUnknown(input.phones === undefined ? undefined : input.phones > 0),
    urgentAlerts: usedOrUnknown(input.urgentAlerts)
  };
}

/**
 * The once-per-installation usage signals. Exists only in a launch with
 * reports on; a signal counts as sent only once the SDK has taken it, so
 * with reports turned off mid-launch nothing is sent and nothing is counted.
 * Each check that a signal is due, its sending and its record happen in one
 * turn of the event loop, so two callers never both send it.
 */
export class UsageMilestones {
  private state?: UsageMilestonesState;
  private facts?: UsageInstallFacts;
  /** Signals seen while an existing installation's history is being read:
   *  they are sent afterwards unless the history shows them done already. */
  private pending?: Map<string, PendingSignal>;
  private documentsReading = false;
  private documentsAgain = false;
  private snapshotReading = false;
  /** Whether Telegram alerts read as connected last time this launch. */
  private urgentAlertTelegramConnected?: boolean;

  constructor(private readonly options: UsageMilestonesOptions) {}

  /** Starts the signals for this launch (after the app is ready). */
  async start(): Promise<void> {
    if (this.facts) return;
    this.facts = this.options.installFacts();
    const stored = this.readState();
    if (stored === "unreadable") {
      return;
    }
    if (stored) {
      this.state = stored;
      if (stored.pausedAt) {
        // Back on after the User had turned reports off.
        delete stored.pausedAt;
        stored.countFrom = this.stamp();
        this.writeState();
      }
    } else {
      const cohort: UsageInstallCohort = this.options.profileUsedBefore ? "existing" : "new";
      const opening = cohort === "new" ? "first_launch" : USAGE_EXISTING_INSTALL;
      if (!this.options.send(opening, usageSignalAttributes(opening, this.context(cohort)))) {
        return;
      }
      this.state = {
        version: 1,
        cohort,
        historyChecked: cohort === "new",
        ...(cohort === "new" ? { featureHistoryVersion: USAGE_FEATURE_HISTORY_VERSION } : {}),
        reached: { first_launch: this.stamp() },
        families: {}
      };
      this.writeState();
    }
    if (!this.state.historyChecked || (this.state.featureHistoryVersion ?? 0) < USAGE_FEATURE_HISTORY_VERSION) {
      await this.checkHistory();
    }
    await this.sendWeeklySnapshotIfDue();
  }

  /** Sends this week's snapshot once, if it has not gone yet (checked at
   *  start and then now and again while the app stays open). */
  async sendWeeklySnapshotIfDue(): Promise<void> {
    const state = this.state;
    if (!state || this.pending || this.snapshotReading) return;
    const week = usageIsoWeek(this.options.now?.() ?? new Date());
    if (state.snapshotWeek === week) return;
    this.snapshotReading = true;
    try {
      const snapshot = await this.options.readWeeklySnapshot(week);
      // Turned off, or another week's snapshot went, while it was read.
      if (this.state !== state || state.snapshotWeek === week) return;
      if (!this.options.send(USAGE_WEEKLY_SNAPSHOT, usageWeeklySnapshotAttributes(this.context(), snapshot))) return;
      state.snapshotWeek = week;
      this.writeState();
    } catch (error) {
      this.log("usage.snapshot.read-failed", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.snapshotReading = false;
    }
  }

  /** The User turned reports off: nothing more is looked at or sent in this
   *  launch, and what happens until they are back on never counts. */
  pause(): void {
    this.pending = undefined;
    // The record is marked even when this launch had stopped looking at it
    // (its history could not be read).
    const stored = this.state ? undefined : this.readState();
    const state = this.state ?? (stored && stored !== "unreadable" ? stored : undefined);
    this.state = undefined;
    if (!state) return;
    state.pausedAt = this.stamp();
    this.writeState(state);
  }

  /** The moment steps count from: the first launch, a minute early for other
   *  devices' clocks; or exactly when reports came back on, since everything
   *  before that moment was made while they were off. */
  private countingSince(): string | undefined {
    if (this.state?.countFrom) return this.state.countFrom;
    const from = this.state?.reached.first_launch;
    const at = from ? Date.parse(from) : Number.NaN;
    return Number.isFinite(at) ? new Date(at - CLOCK_SKEW_MS).toISOString() : undefined;
  }

  /** The moment feature uses count from: the same, or later on an
   *  installation that was reporting before feature signals came. */
  private featureSince(): string | undefined {
    const since = this.countingSince();
    const from = this.state?.featuresFrom;
    if (!from) return since;
    return !since || Date.parse(from) > Date.parse(since) ? from : since;
  }

  /** A step reached; sent the first time only. */
  reach(milestone: UsageMilestone, extra?: UsageSignalExtra): void {
    if (!this.state || this.state.reached[milestone]) return;
    if (this.pending) {
      if (!this.pending.has(milestone)) this.pending.set(milestone, { kind: "milestone", milestone, ...(extra ? { extra } : {}) });
      return;
    }
    if (!this.options.send(milestone, usageSignalAttributes(milestone, this.context(), extra))) return;
    this.state.reached[milestone] = this.stamp();
    this.writeState();
  }

  /** Members on these provider families exist; each family is sent once. */
  useFamilies(families: Iterable<UsageProviderFamily>): void {
    if (!this.state) return;
    for (const family of families) {
      if (this.state.families[family]) continue;
      if (this.pending) {
        this.pending.set(`family:${family}`, { kind: "family", family });
        continue;
      }
      if (!this.options.send(USAGE_PROVIDER_FIRST_USED, usageSignalAttributes(USAGE_PROVIDER_FIRST_USED, this.context(), { provider_family: family }))) return;
      this.state.families[family] = this.stamp();
      this.writeState();
    }
  }

  /** A chat changed on this computer (made here, on the phone or on a
   *  machine): its members and the messages the change carries. */
  observeConversation(conversation: Pick<Conversation, "kind" | "metadata" | "createdAt">, messages: ReadonlyArray<ChatMessage> | undefined): void {
    if (!this.state || conversation.kind !== "chat") return;
    const reached = this.state.reached;
    // Once every step a message can show is done, the messages are not read.
    const facts = chatUsageFacts(
      conversation,
      reached.first_reply && reached.first_member_request && reached.first_accord_started && reached.skill_invoked ? undefined : messages,
      this.countingSince(),
      this.featureSince()
    );
    this.useFamilies(facts.families);
    if (facts.newChat) {
      this.reach("first_chat");
      if (facts.addedFamilies.length >= 2) this.reach("second_model");
    }
    if (facts.newChatForFeatures) {
      if (facts.multiRole) this.reach("multi_role_chat");
      if (facts.roleChosen) this.reach("member_role_changed");
    }
    if (facts.skill) this.reach("skill_invoked");
    if (facts.reply) this.reach("first_reply");
    if (facts.memberRequest) this.reach("first_member_request");
    if (facts.accordStarted) this.reach("first_accord_started");
  }

  /** What Settings → Alerts asked the server and got: urgent alerts set up
   *  on this computer are a phone saved, or Telegram newly connected (it
   *  connects only once Start is pressed in Telegram, which the next read of
   *  the settings shows; a setup made earlier never reads as a change). */
  observeUrgentAlertRequest(action: string, result: { ok: boolean; value?: unknown }): void {
    if (!result.ok) return;
    if (action === "phone.save") {
      this.reach("urgent_alert_set_up");
      return;
    }
    if (action !== "settings") return;
    const view = result.value as { telegram?: { connected?: unknown } } | undefined;
    const connected = view?.telegram?.connected === true;
    if (this.urgentAlertTelegramConnected === false && connected) this.reach("urgent_alert_set_up");
    this.urgentAlertTelegramConnected = connected;
  }

  /** The CLIs were checked: the first time one is ready, which ones are. */
  observeAgents(agents: ReadonlyArray<AgentHealth>): void {
    if (!this.state || this.state.reached.cli_ready) return;
    const ready = (kind: AgentHealth["kind"]) => agents.some((agent) => agent.kind === kind && deriveAgentReadiness(agent) === "ready");
    const extra: UsageSignalExtra = {
      claude_code_ready: ready("claude-code"),
      codex_ready: ready("codex-cli"),
      antigravity_ready: ready("gemini-cli")
    };
    if (extra.claude_code_ready || extra.codex_ready || extra.antigravity_ready) {
      this.reach("cli_ready", extra);
    }
  }

  /** A chat's documents changed: looks whether an Accord's document now
   *  exists or is signed by all its signers (one read at a time). */
  observeDocuments(): void {
    const reached = this.state?.reached;
    if (!reached || (reached.first_accord_started && reached.first_accord_signed && reached.document_created)) return;
    if (this.documentsReading) {
      this.documentsAgain = true;
      return;
    }
    const since = this.countingSince();
    if (!since) return;
    this.documentsReading = true;
    void this.options.readDocuments(since, this.featureSince() ?? since).then((documents) => {
      if (documents.started) this.reach("first_accord_started");
      if (documents.signed) this.reach("first_accord_signed");
      if (documents.plain) this.reach("document_created");
    }, (error: unknown) => {
      this.log("usage.documents.read-failed", { message: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      this.documentsReading = false;
      if (this.documentsAgain) {
        this.documentsAgain = false;
        this.observeDocuments();
      }
    });
  }

  /** An existing installation: what it had already done is recorded as sent,
   *  without sending it; whatever happened meanwhile is sent afterwards if it
   *  is new. A history that cannot be read is tried again next launch. */
  private async checkHistory(): Promise<void> {
    const state = this.state;
    if (!state) return;
    this.pending = new Map();
    try {
      const stamp = this.stamp();
      const done = (milestone: UsageMilestone) => {
        state.reached[milestone] ??= stamp;
      };
      if ((state.featureHistoryVersion ?? 0) < USAGE_FEATURE_HISTORY_VERSION) {
        const features = await this.options.readFeatureHistory();
        if (features.customRole) done("custom_role_created");
        if (features.memberRoleChanged) done("member_role_changed");
        if (features.multiRoleChat) done("multi_role_chat");
        if (features.behaviorRule) done("behavior_rule_attached");
        if (features.document) done("document_created");
        if (features.scheduledTask) done("scheduled_task_created");
        if (features.memoryNote) done("memory_note_written");
        if (features.phonePaired) done("phone_paired");
        if (features.urgentAlerts) done("urgent_alert_set_up");
        // The terminal, dictation, file previews, connector sign-ins and
        // skills leave nothing to read back: their first use from now on is
        // sent, marked with the installation's cohort.
        // Features count from the first look only; a later look (a new
        // feature in the list) does not move it.
        if (state.featureHistoryVersion === undefined) state.featuresFrom ??= stamp;
        state.featureHistoryVersion = USAGE_FEATURE_HISTORY_VERSION;
      }
      if (state.historyChecked) {
        this.writeState();
      } else {
        await this.checkFirstStepHistory(state, done);
      }
    } catch (error) {
      this.log("usage.history.read-failed", { message: error instanceof Error ? error.message : String(error) });
      this.pending = undefined;
      // Until it is read, nothing more is sent this launch: a step done
      // long ago must not be sent as new.
      this.state = undefined;
      return;
    }
    const pending = this.pending;
    this.pending = undefined;
    // Reports turned off while the history was read: nothing more goes.
    if (!pending || !this.state) return;
    for (const signal of pending.values()) {
      if (signal.kind === "milestone") this.reach(signal.milestone, signal.extra);
      else this.useFamilies([signal.family]);
    }
  }

  /** The first steps an existing installation had already taken. */
  private async checkFirstStepHistory(state: UsageMilestonesState, done: (milestone: UsageMilestone) => void): Promise<void> {
    const history = await this.options.readHistory();
    const stamp = this.stamp();
    if (history.hasChat) {
      // A chat in use means the CLIs worked and members answered; replies
      // and member requests are not looked up one by one (that would mean
      // reading every message of a profile that can hold gigabytes).
      done("cli_ready");
      done("first_chat");
      done("first_reply");
    }
    if (history.mixedFamilies) done("second_model");
    if (history.accordStarted) {
      done("first_accord_started");
      // An Accord's facilitator asks the other members through member
      // requests, so a document for several signers means one was made.
      done("first_member_request");
    }
    if (history.accordSigned) done("first_accord_signed");
    if (history.hasMachine) done("first_cloud_machine");
    for (const family of history.families) state.families[family] ??= stamp;
    state.historyChecked = true;
    this.writeState();
  }

  private context(cohort = this.state?.cohort ?? "new") {
    // Set by start() before any state exists, so before anything is sent.
    const facts = this.facts as UsageInstallFacts;
    return { os: facts.os, appVersion: facts.appVersion, locale: facts.locale, cohort, teamDevice: facts.teamDevice };
  }

  private stamp(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private file(): string {
    return path.join(this.options.userDataDir, USAGE_MILESTONES_FILE);
  }

  /** The stored record; undefined when there is none yet, "unreadable" when
   *  it exists but cannot be read now (then nothing is sent this launch,
   *  rather than starting the installation over). */
  private readState(): UsageMilestonesState | "unreadable" | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.file(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      this.log("usage.state.read-failed", { code: (error as NodeJS.ErrnoException).code ?? "unknown" });
      return "unreadable";
    }
    try {
      const parsed = JSON.parse(raw) as Partial<UsageMilestonesState>;
      if (parsed.version !== 1 || (parsed.cohort !== "new" && parsed.cohort !== "existing")) {
        throw new Error("Unknown usage milestones file.");
      }
      const reached: UsageMilestonesState["reached"] = {};
      for (const milestone of USAGE_MILESTONES) {
        const at = parsed.reached?.[milestone];
        if (typeof at === "string") reached[milestone] = at;
      }
      const families: UsageMilestonesState["families"] = {};
      for (const family of USAGE_PROVIDER_FAMILIES) {
        const at = parsed.families?.[family];
        if (typeof at === "string") families[family] = at;
      }
      // Steps count from the first launch; a record without one starts now.
      reached.first_launch ??= this.stamp();
      const moment = (value: unknown) => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined);
      const pausedAt = moment(parsed.pausedAt);
      const countFrom = moment(parsed.countFrom);
      return {
        version: 1,
        cohort: parsed.cohort,
        historyChecked: parsed.historyChecked === true,
        ...(typeof parsed.featureHistoryVersion === "number" && Number.isInteger(parsed.featureHistoryVersion) ? { featureHistoryVersion: parsed.featureHistoryVersion } : {}),
        ...(moment(parsed.featuresFrom) ? { featuresFrom: moment(parsed.featuresFrom) } : {}),
        reached,
        families,
        ...(pausedAt ? { pausedAt } : {}),
        ...(countFrom ? { countFrom } : {}),
        ...(typeof parsed.snapshotWeek === "string" && USAGE_ISO_WEEK_PATTERN.test(parsed.snapshotWeek) ? { snapshotWeek: parsed.snapshotWeek } : {})
      };
    } catch (error) {
      // A file this launch cannot read (damaged, or from a newer version):
      // treated as an existing installation whose history is read again, so
      // nothing it had done is sent as new.
      this.log("usage.state.unreadable", { message: error instanceof Error ? error.message : String(error) });
      return { version: 1, cohort: "existing", historyChecked: false, reached: { first_launch: this.stamp() }, families: {} };
    }
  }

  private writeState(state = this.state): void {
    if (!state) return;
    const file = this.file();
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      mkdirSync(this.options.userDataDir, { recursive: true });
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, file);
    } catch (error) {
      rmSync(temporary, { force: true });
      // This launch still remembers what it sent; a later launch may send a
      // step again, which the reports count once per installation anyway.
      this.log("usage.state.write-failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  private log(event: string, payload: Record<string, unknown>): void {
    try {
      this.options.log?.(event, payload);
    } catch {
      // Logging never breaks the signals.
    }
  }
}
