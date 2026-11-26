import { CLI_PROVIDER_DISPLAY_ORDER, readinessForProvider, readyProviderKinds } from "../../../../shared/cliReadiness";
import { chatSubagentProvidersOf, effectiveSubagentProviders } from "../../../../shared/subagentProviders";
import type { AgentHealth, AppSettings, ChatProviderKind, Conversation, EffectiveSubagentProvider } from "../../../../shared/types";

// The chat's Agents list where its main session's members run (this computer,
// or the machine this code runs on): every CLI ready here, less those the chat
// took out, on Settings' model and effort (shared/subagentProviders.ts).

/** The CLIs ready here, counted as the member gate counts them
 *  (assertParticipantProvidersReady): production detection lists every CLI,
 *  and an empty list, from a test double that predates readiness, counts every
 *  CLI that is not turned off in Settings. */
export function readySubagentKinds(agents: AgentHealth[], settings: Pick<AppSettings, "providers">): ChatProviderKind[] {
  const providers = settings.providers ?? [];
  return agents.length === 0
    ? CLI_PROVIDER_DISPLAY_ORDER.filter((kind) => readinessForProvider(kind, [], providers) !== "disabled")
    : readyProviderKinds(agents, providers);
}

/** The chat's agents, with the model and effort each one's new members run on. */
export function chatSubagentList(
  conversation: Pick<Conversation, "metadata">,
  settings: Pick<AppSettings, "providers" | "subagentDefaults">,
  agents: AgentHealth[],
  cloudRun: boolean
): EffectiveSubagentProvider[] {
  return effectiveSubagentProviders({
    ready: readySubagentKinds(agents, settings),
    defaults: settings.subagentDefaults,
    thread: chatSubagentProvidersOf(conversation.metadata),
    cloudRun
  });
}
