import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deriveAgentReadiness } from "../../shared/cliReadiness";
import type { AgentHealth, ChatMessage, Conversation } from "../../shared/types";
import {
  USAGE_EXISTING_INSTALL,
  USAGE_MILESTONES,
  USAGE_PROVIDER_FAMILIES,
  USAGE_PROVIDER_FIRST_USED,
  usageMemberFamilies,
  usageSignalAttributes,
  type UsageInstallCohort,
  type UsageMilestone,
  type UsageOs,
  type UsageProviderFamily,
  type UsageSignalAttributes,
  type UsageSignalExtra,
  type UsageSignalName
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
  /** Whether a document for several signers was made since `since`, and
   *  whether one got the last of its signatures since then. */
  readDocuments(since: string): Promise<{ started: boolean; signed: boolean }>;
  log?(event: string, payload: Record<string, unknown>): void;
  now?(): Date;
}

type PendingSignal =
  | { kind: "milestone"; milestone: UsageMilestone; extra?: UsageSignalExtra }
  | { kind: "family"; family: UsageProviderFamily };

const STANDALONE_ACCORD_TOKEN = /(^|\s)\/accord\b/i;

/** The Assistant, which every chat has without anyone adding it. */
const ASSISTANT_ROLE_CONFIG_ID = "administrator";

type UsageMember = { kind?: unknown; hostId?: unknown; hostVendor?: unknown; roleConfigId?: unknown };

/** The provider families of the members a person added to a chat (the
 *  Assistant is in every chat, so it does not make a chat mixed). */
function addedMemberFamilies(members: ReadonlyArray<UsageMember | null | undefined>): Set<UsageProviderFamily> {
  return usageMemberFamilies(members.filter((member) => member?.roleConfigId !== ASSISTANT_ROLE_CONFIG_ID));
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
  since?: string
): {
  chat: boolean;
  /** Made since `since`. */
  newChat: boolean;
  /** Every member's family, the Assistant's too. */
  families: UsageProviderFamily[];
  /** The families of the members a person added. */
  addedFamilies: UsageProviderFamily[];
  reply: boolean;
  memberRequest: boolean;
  accordStarted: boolean;
} {
  if (conversation.kind !== "chat") {
    return { chat: false, newChat: false, families: [], addedFamilies: [], reply: false, memberRequest: false, accordStarted: false };
  }
  const sinceMs = since ? Date.parse(since) : Number.NaN;
  const participants = Array.isArray(conversation.metadata?.participants) ? conversation.metadata.participants : [];
  const families = usageMemberFamilies(participants);
  const assistantIds = new Set(participants.filter((member) => member?.roleConfigId === ASSISTANT_ROLE_CONFIG_ID).map((member) => member.id));
  const roles = new Map((messages ?? []).map((message) => [message.id, message.role]));
  let reply = false;
  let memberRequest = false;
  let accordStarted = false;
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
  }
  return {
    chat: true,
    newChat: madeSince(conversation.createdAt, sinceMs),
    families: [...families],
    addedFamilies: [...addedMemberFamilies(participants)],
    reply,
    memberRequest,
    accordStarted
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
        reached: { first_launch: this.stamp() },
        families: {}
      };
      this.writeState();
    }
    if (!this.state.historyChecked) {
      await this.checkHistory();
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
      reached.first_reply && reached.first_member_request && reached.first_accord_started ? undefined : messages,
      this.countingSince()
    );
    this.useFamilies(facts.families);
    if (facts.newChat) {
      this.reach("first_chat");
      if (facts.addedFamilies.length >= 2) this.reach("second_model");
    }
    if (facts.reply) this.reach("first_reply");
    if (facts.memberRequest) this.reach("first_member_request");
    if (facts.accordStarted) this.reach("first_accord_started");
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
    if (!this.state || (this.state.reached.first_accord_started && this.state.reached.first_accord_signed)) return;
    if (this.documentsReading) {
      this.documentsAgain = true;
      return;
    }
    const since = this.countingSince();
    if (!since) return;
    this.documentsReading = true;
    void this.options.readDocuments(since).then((documents) => {
      if (documents.started) this.reach("first_accord_started");
      if (documents.signed) this.reach("first_accord_signed");
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
      const history = await this.options.readHistory();
      const stamp = this.stamp();
      const done = (milestone: UsageMilestone) => {
        state.reached[milestone] ??= stamp;
      };
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

  private context(cohort = this.state?.cohort ?? "new") {
    // Set by start() before any state exists, so before anything is sent.
    const facts = this.facts as UsageInstallFacts;
    return { os: facts.os, appVersion: facts.appVersion, locale: facts.locale, cohort };
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
        reached,
        families,
        ...(pausedAt ? { pausedAt } : {}),
        ...(countFrom ? { countFrom } : {})
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
