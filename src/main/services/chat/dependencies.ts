import type { ChatMessage, Conversation, ConversationUpdate } from "../../../shared/types";
import { CliAgentRunner } from "../cliAgents";
import { DebugLogService } from "../debugLogs";
import { SettingsService } from "../settings";
import { StorageService } from "../storage";
import { UserSkillsService } from "../userSkills";
import type { ChatAppMcpGateway, ProgressCallback } from "./types";

/** What the chat service is given by the app. */
export interface ChatDependencies {
  readonly storage: StorageService;
  readonly settings: SettingsService;
  readonly cliRunner: CliAgentRunner;
  readonly debugLogs: DebugLogService;
  readonly appMcp?: ChatAppMcpGateway;
  readonly onConversationSnapshot?: (conversation: Conversation, update: ConversationUpdate) => void;
  readonly userSkills?: UserSkillsService;
  readonly onReviewProgress?: ProgressCallback;
  /** W-C: an interrupted run has no terminal snapshot of its own — nothing
   *  finished, the process died. Recovery is the only thing that can tell a
   *  paired phone the run is over, so it is published explicitly here rather
   *  than left to a conversation snapshot, whose first-delivery guard would
   *  suppress it at exactly the moment it matters (process start). */
  readonly onInterruptedRunsRecovered?: (
    conversation: Conversation,
    messages: ChatMessage[]
  ) => void;
}
