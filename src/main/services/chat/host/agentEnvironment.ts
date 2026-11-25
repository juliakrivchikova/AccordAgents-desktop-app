import type {
  AgentHealth, ChatMessage, ChatParticipant, CliProviderHost, ChatParticipantSession, ChatProviderKind, Conversation,
  ProviderModelCatalog
} from "../../../../shared/types";
import { cliProviderHostForParticipant, cliProviderHostRunConfig, cliProviderHostRunVersion } from "../../../../shared/cliProviderHosts";
import { normalizeChatAppToolCapabilities } from "../../../../shared/appTools";
import { CliAgentRunner, type CliAgentRoleOptions } from "../../cliAgents";
import { SettingsService } from "../../settings";
import { agentReadinessReason, cliProviderMetadata, readinessForParticipant } from "../../../../shared/cliReadiness";
import { CHAT_ADMINISTRATOR_ROLE_ID, GENERIC_PARTICIPANT_ROLE_ID } from "../constants";
import { behaviorRuleSnapshotsForParticipant, roleInstructionsWithBehaviorRules, roleRuntimeName } from "../members/roleRuntime";
import type { ChatMemberAccess, ResolvedChatParticipantRole } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** What a member's CLI is started with: environment, provider host, resolved role, and which providers are ready. */
export class AgentEnvironment {
  constructor(
    private readonly chat: Pick<ChatModules, "memberSessions">,
    private readonly deps: Pick<ChatDependencies, "cliRunner" | "debugLogs" | "settings">
  ) {}

  private async manualAgentEnvironmentForRun(): Promise<{ env: NodeJS.ProcessEnv; version: string }> {
    const settings = this.deps.settings as Partial<Pick<SettingsService, "getManualAgentEnvironment">>;
    if (typeof settings.getManualAgentEnvironment !== "function") {
      return { env: {}, version: "" };
    }
    return settings.getManualAgentEnvironment();
  }

  /** Host binding for a member on an added provider, with the key decrypted for
   *  the run. `problem` is a finished sentence for the pending message when the
   *  member cannot start (provider removed, key missing, wrong CLI). */
  private async participantHostBinding(
    participant: Pick<ChatParticipant, "kind" | "handle" | "hostId" | "hostLabel">
  ): Promise<{ host: CliProviderHost; apiKey: string } | { problem: string } | undefined> {
    const hostId = participant.hostId?.trim();
    if (!hostId) {
      return undefined;
    }
    const settings = this.deps.settings as Partial<Pick<SettingsService, "getCliProviderHostSecret">>;
    if (typeof settings.getCliProviderHostSecret !== "function") {
      return undefined;
    }
    const secret = await settings.getCliProviderHostSecret.call(this.deps.settings, hostId);
    const label = secret?.host.label ?? participant.hostLabel ?? "its provider";
    if (!secret || secret.host.cli !== participant.kind) {
      return { problem: `@${participant.handle} cannot start: ${label} was removed from Settings. Bind the member to another provider or add ${label} again` };
    }
    if (!secret.apiKey) {
      return { problem: `@${participant.handle} cannot start: ${label} has no API key. Add one under Local CLI setup in Settings` };
    }
    return { host: secret.host, apiKey: secret.apiKey };
  }

  /** Settings → Environment plus, for a member on an added provider, what makes
   *  its CLI talk to that provider. Local runs and compaction take this same map
   *  (and the remote `extraEnv` will, once such members can run remotely), so
   *  the member behaves identically wherever it runs. */
  async agentEnvironmentForParticipant(
    participant: ChatParticipant,
    model: string | undefined
  ): Promise<{ env: NodeJS.ProcessEnv; settingsEnv: NodeJS.ProcessEnv; version: string; codexConfigOverrides?: string[]; geminiSettings?: Record<string, unknown>; problem?: string }> {
    const manual = await this.manualAgentEnvironmentForRun();
    const binding = await this.participantHostBinding(participant);
    if (!binding) {
      return { ...manual, settingsEnv: manual.env };
    }
    if ("problem" in binding) {
      return { ...manual, settingsEnv: manual.env, problem: binding.problem };
    }
    const runConfig = cliProviderHostRunConfig(binding.host, binding.apiKey, model);
    return {
      env: { ...manual.env, ...runConfig.env },
      settingsEnv: manual.env,
      version: `${manual.version}|${cliProviderHostRunVersion(binding.host, model)}`,
      codexConfigOverrides: runConfig.codexConfigOverrides,
      geminiSettings: runConfig.geminiSettings
    };
  }

  /** Retires every warm process of one member in this chat (and the
   *  background tasks it carries) instead of leaving it until the idle
   *  timeout: when its provider went away and the process still holds the old
   *  key, or when the member left the chat. Never throws; a failed close is
   *  logged. */
  async closeWarmAgentsForParticipant(
    conversationId: string,
    participantId: string,
    reason: "provider-binding-changed" | "member-removed" | "user-restart" = "provider-binding-changed"
  ): Promise<void> {
    const runner = this.deps.cliRunner as Partial<Pick<CliAgentRunner, "closeWarmAgents">>;
    if (typeof runner.closeWarmAgents !== "function") {
      return;
    }
    try {
      await runner.closeWarmAgents.call(this.deps.cliRunner, conversationId, participantId, reason);
    } catch (error) {
      void this.deps.debugLogs.write("chat.warm-agents.close-error", {
        conversationId,
        participantId,
        reason,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async safeCliModelCatalog(kind: ChatProviderKind, configuredModel?: string): Promise<ProviderModelCatalog | undefined> {
    const runner = this.deps.cliRunner as CliAgentRunner & {
      listModelCatalog?: (providerKind: ChatProviderKind, configuredModel?: string) => Promise<ProviderModelCatalog>;
    };
    if (typeof runner.listModelCatalog !== "function") {
      return undefined;
    }
    try {
      return await runner.listModelCatalog(kind, configuredModel);
    } catch (error) {
      return {
        kind,
        models: [],
        authoritative: false,
        fetchedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  cliRoleOptions(
    conversation: Conversation,
    participant: ChatParticipant,
    session: ChatParticipantSession,
    access: ChatMemberAccess,
    workspacePath: string,
    promptFallbackPrompt: string
  ): CliAgentRoleOptions {
    return {
      name: roleRuntimeName(participant, session),
      description: `${session.roleLabel} participant @${participant.handle} in AccordAgents Chat.`,
      instructions: this.chat.memberSessions.sessionInstructions(conversation, participant, session, access, workspacePath),
      promptFallbackPrompt
    };
  }

  async resolvedRoleForParticipantOrThrow(participant: ChatParticipant): Promise<ResolvedChatParticipantRole> {
    const role = await this.resolvedRoleForParticipant(participant);
    if (role) {
      return role;
    }
    // Hardening: a missing role (deleted/stale/imported reference) must not crash the
    // participant's turn. Fall back to the generic built-in role and warn so the orphaned
    // reference is visible in logs. Archived roles still resolve normally (they remain in
    // settings), so only genuinely-absent ids reach this fallback.
    if (participant.roleConfigId !== GENERIC_PARTICIPANT_ROLE_ID) {
      const fallback = await this.resolvedRoleForParticipant(participant, GENERIC_PARTICIPANT_ROLE_ID);
      if (fallback) {
        console.warn(
          `[chat] Role "${participant.roleConfigId}" for @${participant.handle} is missing; falling back to "${GENERIC_PARTICIPANT_ROLE_ID}".`
        );
        return fallback;
      }
    }
    throw new Error(`Unknown role for @${participant.handle}.`);
  }

  async resolvedRoleForParticipant(
    participant: ChatParticipant,
    roleConfigId: string = participant.roleConfigId
  ): Promise<ResolvedChatParticipantRole | undefined> {
    const settings = await this.deps.settings.getPublicSettings();
    const role = settings.chatRoleConfigs.find((item) => item.id === roleConfigId);
    if (!role) {
      return undefined;
    }
    const behaviorRules = behaviorRuleSnapshotsForParticipant(participant, settings.chatBehaviorRules ?? []);
    return {
      id: role.id,
      label: role.label,
      version: role.version,
      appToolCapabilities: normalizeChatAppToolCapabilities(role.appToolCapabilities),
      participantDefaults: role.participantDefaults,
      instructions: roleInstructionsWithBehaviorRules(role.instructions, behaviorRules),
      behaviorRules
    };
  }

  async recordSuccessfulAssistantProviderForMessages(
    conversation: Conversation,
    participant: ChatParticipant,
    messages: ChatMessage[]
  ): Promise<void> {
    if (
      participant.roleConfigId !== CHAT_ADMINISTRATOR_ROLE_ID ||
      !messages.some((message) => message.status === "done" && message.content.trim())
    ) {
      return;
    }
    await this.recordSuccessfulAssistantProvider(conversation, participant.kind);
  }

  private async recordSuccessfulAssistantProvider(
    conversation: Conversation,
    kind: ChatProviderKind
  ): Promise<void> {
    if (conversation.metadata.activationProviderKind) {
      return;
    }
    if (await this.recordSuccessfulChatProvider(kind)) {
      conversation.metadata = {
        ...conversation.metadata,
        activationProviderKind: kind
      };
    }
  }

  private async recordSuccessfulChatProvider(kind: ChatProviderKind): Promise<boolean> {
    const writer = (this.deps.settings as SettingsService & {
      recordSuccessfulChatProvider?: (providerKind: ChatProviderKind) => Promise<void>;
    }).recordSuccessfulChatProvider;
    if (typeof writer === "function") {
      try {
        await writer.call(this.deps.settings, kind);
        return true;
      } catch (error) {
        void this.deps.debugLogs.write("chat.provider-preference.persist-failed", {
          kind,
          error: error instanceof Error ? error.message : String(error)
        }).catch(() => undefined);
      }
    }
    return false;
  }

  /** Why a member's failed first turn on this computer failed, when its CLI
   *  (or added provider) is not ready here (checked afresh), in the words New
   *  chat uses. Undefined when it is ready, or when readiness cannot be told
   *  (the run's own error then says what went wrong). */
  async firstTurnProviderProblem(participant: ChatParticipant): Promise<string | undefined> {
    let agents: AgentHealth[];
    try {
      agents = await this.deps.cliRunner.detectAgents({ trigger: "submit" });
    } catch {
      return undefined;
    }
    if (agents.length === 0) return undefined;
    const settings = await this.deps.settings.getPublicSettings();
    const host = cliProviderHostForParticipant(participant.kind, participant.hostId?.trim() || undefined, settings.cliProviderHosts ?? []);
    if (participant.hostId?.trim() && !host) return undefined; // participantHostBinding says it.
    const state = readinessForParticipant({ kind: participant.kind, host }, agents, settings.providers ?? []);
    if (state === "ready" || state === "checking" || state === "could-not-verify") return undefined;
    const label = host?.label ?? cliProviderMetadata(participant.kind).label;
    const reason = agentReadinessReason(state, label) ?? `${label} is not ready.`;
    return `@${participant.handle} cannot start on this computer: ${reason} Fix it in Settings → Local CLI setup, or start the chat on another provider.`;
  }

  /** Every CLI's readiness, or with `kinds` only those CLIs checked (each
   *  one's fresh result reused; the rest as last read). */
  async detectAgentsForReadiness(
    trigger?: "submit",
    kinds?: readonly ChatProviderKind[]
  ): Promise<AgentHealth[]> {
    try {
      const request = trigger ? { trigger } : undefined;
      return kinds ? await this.deps.cliRunner.detectAgentKinds(kinds, request) : await this.deps.cliRunner.detectAgents(request);
    } catch {
      throw new Error("Could not verify CLI readiness. Check again and retry.");
    }
  }
}
