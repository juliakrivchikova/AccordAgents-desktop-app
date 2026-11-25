import { forkToNewChatLocalProviders, forkToNewChatReasonInChat, type ForkToNewChatOffer } from "../../../../shared/forkToNewChat";
import { MAIN_SESSION_HANDLE, MAIN_SESSION_ROLE_ID } from "../../../../shared/mainSession";
import {
  newChatProjects, newChatProviderOffer, participantConfigUsage, participantConfigUsageCount, type NewChatMemberOption,
  type NewChatProviderOffer
} from "../../../../shared/newChat";
import {
  mainSessionProviderKey, mainSessionProviderOptions, type MainSessionProviderOption
} from "../../../../shared/mainSessionProviders";
import { normalizedChatAvatarId } from "../../../../shared/chatAvatarCatalog";
import type { HubNewChatOptions } from "../../../../shared/hubProtocol";
import type {
  AgentHealth, AppSettings, ChatParticipant, Conversation, ConversationSummary, CreateChatConversationRequest,
  ProviderModelCatalog
} from "../../../../shared/types";
import { normalizeChatReasoningEffort, reasoningEffortOptionsForProvider } from "../../../../shared/reasoningEffort";
import { cliProviderHostDefaultModelLabel, cliProviderHostModelCatalog } from "../../../../shared/cliProviderHosts";
import { newChatMemberPermissions, normalizeChatAgentMode, normalizeChatAgentPermissions } from "../../../../shared/agentPermissions";
import { assistantSubstituteNote, resolveAssistantProviderKind } from "../../../../shared/cliReadiness";
import { CHAT_ADMINISTRATOR_ROLE_ID } from "../constants";
import { assertParticipantProvidersReady, normalizeParticipantPermissionsForRole } from "../members/identity";
import { newChatBlockedReason } from "../store/titles";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** How long the phone's New chat offer keeps a provider's model list before
 *  reading it again (in the background), and how soon a failed read is tried
 *  again. */
const MAIN_SESSION_CATALOG_FRESH_MS = 10 * 60_000;

const MAIN_SESSION_CATALOG_RETRY_MS = 60_000;
const WORKFLOW_MANAGER_ROLE_ID = "workflow-manager";

/** What New chat offers: projects, members, providers and their models. */
export class NewChatOffers {
  /** Told when a provider's model list read in the background changed what
   *  the phone's New chat offers (main.ts publishes the catalog again). */
  onNewChatOffersChanged?: () => void;
  private readonly mainSessionCatalogs = new Map<string, { catalog?: ProviderModelCatalog; readAt: number; failedAt?: number; reading?: Promise<void> }>();

  constructor(
    private readonly chat: Pick<ChatModules, "agentEnvironment" | "creation" | "machineSupport">,
    private readonly deps: Pick<ChatDependencies, "cliRunner" | "settings">
  ) {}

  /** Why this member (as it runs now) cannot be forked to a new chat, in the
   *  words the menus show (forkToNewChatUnavailableReason). */
  forkToNewChatRefusal(
    source: Conversation,
    running: ChatParticipant,
    agents: AgentHealth[],
    settings: Pick<AppSettings, "providers" | "cliProviderHosts">
  ): string | undefined {
    return forkToNewChatReasonInChat({
      participant: running,
      conversation: source,
      agents,
      providers: settings.providers ?? [],
      hosts: settings.cliProviderHosts ?? [],
      machineSupport: (machineId) => this.chat.machineSupport.machineForkToNewChatSupport?.(machineId) ?? "unknown"
    });
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
  async newChatOptions(summaries: ConversationSummary[]): Promise<HubNewChatOptions | undefined> {
    const agents = await this.chat.agentEnvironment.detectAgentsForReadiness("submit");
    await this.deps.settings.ensureAssistantProviderDefault(agents);
    const settings = await this.deps.settings.ensureGenericChatParticipantSeeds(agents);
    const assistantKind = resolveAssistantProviderKind({ agents, providers: settings.providers, explicitKind: settings.assistantProviderKind });
    const unavailable = newChatBlockedReason(agents, settings, assistantKind);
    // With no provider ready for the main session, the phone shows why, as
    // this computer's New chat does, and starts nothing.
    let mainSession: ChatParticipant | undefined;
    try {
      // As a chat in a project has it (most phone chats are); the phone's
      // newChatParticipants takes repository reading away for a chat without one.
      // Started as Settings → General → New chats says (the model, effort,
      // mode, machine and compaction right travel with it to the phone).
      [mainSession] = await this.chat.creation.ensureMainSessionParticipant([], assistantKind, { hasProject: true, newChatDefaults: true });
    } catch (error) {
      if (!unavailable) throw error;
    }
    if (!mainSession && unavailable) {
      mainSession = { id: MAIN_SESSION_ROLE_ID, handle: MAIN_SESSION_HANDLE, roleConfigId: MAIN_SESSION_ROLE_ID, kind: settings.assistantProviderKind ?? "codex-cli" } as ChatParticipant;
    }
    if (!mainSession) return undefined;
    const usage = participantConfigUsage(summaries);
    const members: NewChatMemberOption[] = [];
    // A member on a machine runs there whoever starts the chat: the phone
    // starts it straight on the machine (the server asks the machine for its
    // turns and wakes it), so it is told which machine and what projects that
    // machine has. A Cloud run member's machine is the one on the AWS
    // instance this computer uses, as its own Cloud run preparation finds it.
    const machines = await Promise.resolve().then(() => this.deps.settings.listMachines()).catch(() => []);
    const installs = await Promise.resolve().then(() => this.deps.settings.listMachineInstalls()).catch(() => []);
    const cloudInstanceId = settings.cloudRuns?.awsHandle?.instanceId;
    for (const config of settings.chatParticipantConfigs) {
      // The Assistant's own presets are not offered (isChatAssistantParticipant),
      // nor one with the main session's role (a chat makes its own).
      if (config.roleConfigId === CHAT_ADMINISTRATOR_ROLE_ID || config.roleConfigId === MAIN_SESSION_ROLE_ID ||
        config.handle.trim().replace(/^@/, "").toLowerCase() === "admin") continue;
      // As the computer's New chat makes a saved member's draft
      // (chatParticipantConfigToDraft).
      const input: CreateChatConversationRequest["participants"][number] = {
        participantConfigId: config.id,
        handle: config.handle,
        roleConfigId: config.roleConfigId,
        behaviorRuleIds: config.behaviorRuleIds,
        kind: config.kind,
        model: config.model,
        reasoningEffort: normalizeChatReasoningEffort(config.reasoningEffort, config.kind),
        avatarId: normalizedChatAvatarId(config.kind, config.avatarId, config.id || config.handle),
        hostId: config.hostId?.trim() || undefined,
        agentMode: normalizeChatAgentMode(config.agentMode),
        permissions: normalizeChatAgentPermissions(config.permissions),
        remoteExecution: config.remoteExecution,
        homeMachineId: config.homeMachineId || undefined,
        cloudRun: config.cloudRun,
        skipToolchainPreflight: config.skipToolchainPreflight === true,
        autoWatch: config.roleConfigId === WORKFLOW_MANAGER_ROLE_ID || config.autoWatchEnabled === true
      };
      let participant: ChatParticipant | undefined;
      let reason: string | undefined;
      // The machine it runs on: its own, or for Cloud run the machine on the
      // AWS instance this computer uses, found as Cloud run's own preparation
      // finds it (the instance, then the setup that put the program there).
      // Why it cannot go straight to a machine: only a phone that starts the
      // chat there reads it (machineUnavailable); one from before hands the
      // chat to this computer, which prepares the machine, as it always did.
      let machineReason: string | undefined;
      let machineId = input.homeMachineId;
      if (input.cloudRun && !input.homeMachineId) {
        if (input.cloudRun.instanceId && input.cloudRun.instanceId !== cloudInstanceId) {
          machineReason = "This machine belongs to a different AWS instance. Select Cloud run to use the instance currently shown in Settings.";
        } else if (cloudInstanceId) {
          machineId = machines.find((item) => item.awsInstanceId === cloudInstanceId)?.id
            ?? installs.find((record) => record.target?.hostKeyAlias === `accordagents-${cloudInstanceId}`)?.machineId;
        }
        if (!machineReason && !machineId) machineReason = "Its cloud machine is not set up yet. Set it up in Settings → AWS on your computer.";
      }
      // The server asks a machine for its turns only once the machine is one
      // of its devices; until then nothing would answer from the phone.
      if (!machineReason && machineId && !machines.find((item) => item.id === machineId)?.deviceId) {
        machineReason = "Its machine is not connected to your server yet. Open Settings → Machines on your computer.";
      }
      const install = machineId ? installs.find((record) => record.machineId === machineId) : undefined;
      const projects = install ? Object.keys(install.projects ?? {}) : undefined;
      if (!reason) try {
        [participant] = await this.chat.creation.validateParticipants([input], [], true);
        assertParticipantProvidersReady([input], agents, settings.providers, settings.cliProviderHosts ?? []);
      } catch (error) {
        // Offered, and why it cannot be added, as the computer's screen shows it.
        reason = error instanceof Error ? error.message : String(error);
      }
      const shown = participant ?? { id: config.id, handle: config.handle, roleConfigId: config.roleConfigId, kind: config.kind, avatarId: input.avatarId,
        homeMachineId: input.homeMachineId, ...(input.cloudRun ? { cloudRun: input.cloudRun } : {}) };
      // Named by its preset, not a fresh id: the phone gives each its own id
      // (newChatParticipants), and an unchanged offer is not published again.
      // The machine travels beside the member, not in it: a phone from before
      // this sends a Cloud run member's chat to this computer, which prepares
      // the machine (and copies the project) as before.
      members.push({ configId: config.id, participant: { ...shown, id: config.id }, uses: participantConfigUsageCount(config, usage),
        ...(reason ? { unavailable: reason } : {}), ...(machineId && !machineReason ? { machineId } : {}),
        ...(machineReason ? { machineUnavailable: machineReason } : {}), ...(projects ? { projects } : {}) });
    }
    const { projects, defaultProject } = newChatProjects(summaries, settings.lastRepoPath);
    const assistantNote = assistantSubstituteNote({ agents, providers: settings.providers, explicitKind: settings.assistantProviderKind });
    // Named by its role, not a fresh id, so an unchanged offer is not
    // published again. A phone from before reads `assistant`: it gets the
    // main session there too, and so makes a main-session chat.
    const offeredMainSession = { ...mainSession, id: MAIN_SESSION_ROLE_ID };
    const mainSessionProviders = unavailable ? [] : await this.newChatProviderOffers(agents, settings);
    const fork = this.forkToNewChatOffer(agents, settings, machines);
    return {
      projects,
      ...(defaultProject ? { defaultProject } : {}),
      mainSession: offeredMainSession,
      assistant: offeredMainSession,
      ...(mainSessionProviders.length > 0 ? { mainSessionProviders } : {}),
      members,
      ...(unavailable ? { unavailable } : {}),
      ...(assistantNote ? { assistantNote } : {}),
      ...(fork ? { fork } : {}),
      // This computer runs Codex's Full Access and Plan mode; each machine as
      // its program says.
      cliModes: { machines: Object.fromEntries(machines.map((machine) => [machine.id, this.chat.machineSupport.machineCliModesSupport?.(machine.id) === "supported"])) },
      // What each machine's CLIs start in with its own config (this
      // computer's are with each provider): a main session the phone starts
      // there starts in it.
      ...this.chat.machineSupport.newChatMachineStartDefaults(machines)
    };
  }

  /**
   * What the phone needs to fork a member to a new chat as this computer
   * does (src/shared/forkToNewChat.ts): why each CLI here cannot run a
   * member now, each machine's program by its last hello, and what the main
   * session's role gives a new main session. Nothing without that role.
   */
  private forkToNewChatOffer(agents: AgentHealth[], settings: AppSettings, machines: ReadonlyArray<{ id: string }>): ForkToNewChatOffer | undefined {
    const role = settings.chatRoleConfigs.find((candidate) => candidate.id === MAIN_SESSION_ROLE_ID);
    if (!role) return undefined;
    return {
      ...forkToNewChatLocalProviders(agents, settings.providers ?? [], settings.cliProviderHosts ?? []),
      machines: Object.fromEntries(machines.map((machine) => [machine.id, this.chat.machineSupport.machineForkToNewChatSupport?.(machine.id) ?? "unknown"])),
      basePermissions: normalizeParticipantPermissionsForRole(role, newChatMemberPermissions(true), true)
    };
  }

  /**
   * What the phone's New chat chip offers for the main session in the
   * sessions view, as this computer's chip lists it (the User, 2026-11-21):
   * every provider it can run on now, with its CLI's models and efforts. A
   * model list that cannot be read in time leaves that provider with its
   * default model only.
   */
  private async newChatProviderOffers(agents: AgentHealth[], settings: AppSettings): Promise<NewChatProviderOffer[]> {
    const options = mainSessionProviderOptions(agents, settings.providers, settings.cliProviderHosts ?? []);
    // Never waits for a model list: each provider is offered with the list
    // it last had (none yet: its default model only), and a list that is
    // due is read in the background; one that changed publishes the offer
    // again (onNewChatOffersChanged).
    return options.map((option) => {
      const catalog = this.cachedMainSessionModelCatalog(option, settings);
      // An added provider runs its CLI with the User's own config too: the
      // mode that CLI starts in is the one its own list says.
      const start = option.hostId ? this.cachedMainSessionModelCatalog({ kind: option.kind, label: option.label }, settings)?.startDefaults : catalog?.startDefaults;
      return newChatProviderOffer({
        ...option,
        vendorDefaultModelLabel: option.hostVendor ? cliProviderHostDefaultModelLabel({ vendor: option.hostVendor }) : undefined,
        catalog,
        providerEfforts: reasoningEffortOptionsForProvider(option.kind),
        ...(start ? { start } : {})
      });
    });
  }

  /** A provider's last model list, read again in the background when due:
   *  a good list after 10 minutes, a failed or empty read (a CLI signed out,
   *  a list that hung) after a minute, a failure never replacing a good list. */
  private cachedMainSessionModelCatalog(option: MainSessionProviderOption, settings: AppSettings, now = Date.now()): ProviderModelCatalog | undefined {
    const key = mainSessionProviderKey(option);
    const entry = this.mainSessionCatalogs.get(key) ?? { readAt: 0 };
    this.mainSessionCatalogs.set(key, entry);
    const due = entry.failedAt !== undefined && entry.failedAt >= entry.readAt
      ? now - entry.failedAt >= MAIN_SESSION_CATALOG_RETRY_MS
      : now - entry.readAt >= MAIN_SESSION_CATALOG_FRESH_MS;
    if (due && !entry.reading) {
      // What the phone is told of it: its models and its start defaults.
      const offered = (catalog: ProviderModelCatalog | undefined): string => JSON.stringify([catalog?.models ?? null, catalog?.startDefaults ?? null]);
      const before = offered(entry.catalog);
      entry.reading = this.mainSessionModelCatalog(option, settings)
        .catch(() => undefined)
        .then((catalog) => {
          if (catalog && catalog.models.length > 0) {
            entry.catalog = catalog;
            entry.readAt = Date.now();
            entry.failedAt = undefined;
          } else {
            entry.failedAt = Date.now();
          }
          if (offered(entry.catalog) !== before) this.onNewChatOffersChanged?.();
        })
        .finally(() => { entry.reading = undefined; });
    }
    return entry.catalog;
  }

  /** Waits for the model lists being read in the background (tests). */
  async settleNewChatModelCatalogsForTests(): Promise<void> {
    await Promise.all(Array.from(this.mainSessionCatalogs.values()).map((entry) => entry.reading));
  }

  /** A provider's model list, as the computer's model pickers read it
   *  (settings:list-provider-models): an added provider's fixed list, an
   *  Antigravity key's own list, else the CLI's. At most 15 seconds (only
   *  ever read in the background, cachedMainSessionModelCatalog). */
  private async mainSessionModelCatalog(option: MainSessionProviderOption, settings: AppSettings): Promise<ProviderModelCatalog | undefined> {
    const read = async (): Promise<ProviderModelCatalog | undefined> => {
      if (option.hostVendor) {
        const fixed = cliProviderHostModelCatalog({ vendor: option.hostVendor, cli: option.kind });
        if (fixed) return fixed;
        if (option.kind === "gemini-cli" && option.hostId) {
          const secret = await this.deps.settings.getCliProviderHostSecret(option.hostId);
          return this.deps.cliRunner.listHostModelCatalog(secret && secret.host.cli === option.kind ? secret : undefined);
        }
      }
      if (typeof this.deps.cliRunner.listModelCatalog !== "function") return undefined;
      const configuredModel = settings.providers.find((provider) => provider.kind === option.kind)?.model;
      return this.deps.cliRunner.listModelCatalog(option.kind, configuredModel, settings.lastRepoPath);
    };
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 15_000); });
    try {
      return await Promise.race([read(), late]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
