import { CLI_PROVIDER_DISPLAY_ORDER, readinessForProvider } from "../../../../shared/cliReadiness";
import { chatSubagentProvidersOf, effectiveSubagentProviders } from "../../../../shared/subagentProviders";
import { subagentReadyHere, type SubagentMainPlace } from "../../../../shared/subagentReadiness";
import type { AgentHealth, AppSettings, ChatProviderKind, Conversation, EffectiveSubagentProvider } from "../../../../shared/types";

// The chat's Agents list where its main session's members run: every CLI
// ready there, less those the chat took out, on Settings' model and effort
// (shared/subagentProviders.ts).

/** The CLIs ready on this device for the main session's members, counted as
 *  the member gate counts them (assertParticipantProvidersReady): production
 *  detection lists every CLI, and an empty list, from a test double that
 *  predates readiness, counts every CLI that is not turned off in Settings. */
export function readySubagentKinds(
  agents: AgentHealth[],
  settings: Pick<AppSettings, "providers" | "cliProviderHosts">,
  main?: Pick<SubagentMainPlace, "kind" | "hostId">
): ChatProviderKind[] {
  const providers = settings.providers ?? [];
  return agents.length === 0
    ? CLI_PROVIDER_DISPLAY_ORDER.filter((kind) => readinessForProvider(kind, [], providers) !== "disabled")
    : subagentReadyHere(agents, providers, settings.cliProviderHosts ?? [], main);
}

/** The chat's agents among the CLIs ready where its members run, with the
 *  model and effort each one's new members run on. */
export function chatSubagentList(
  conversation: Pick<Conversation, "metadata">,
  settings: Pick<AppSettings, "subagentDefaults">,
  ready: readonly ChatProviderKind[],
  cloudRun: boolean
): EffectiveSubagentProvider[] {
  return effectiveSubagentProviders({
    ready,
    defaults: settings.subagentDefaults,
    thread: chatSubagentProvidersOf(conversation.metadata),
    cloudRun
  });
}
