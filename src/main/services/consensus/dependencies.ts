import type { Conversation } from "../../../shared/types";
import { CliAgentRunner } from "../cliAgents";
import { DebugLogService } from "../debugLogs";
import { GitService } from "../git";
import { ProviderRunner } from "../providers";
import { StorageService } from "../storage";

/** What the review service is given by the app. */
export interface ConsensusDependencies {
  readonly git: GitService;
  readonly storage: StorageService;
  readonly providerRunner: ProviderRunner;
  readonly cliRunner: CliAgentRunner;
  readonly debugLogs: DebugLogService;
  readonly onConversationSnapshot?: (conversation: Conversation) => void;
}
