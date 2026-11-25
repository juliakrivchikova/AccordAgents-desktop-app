import type {
  ChatAgentMode, ChatAgentPermissions, ChatProviderKind, ConversationKind, GitDiffMode, ParticipantConfig
} from "../../../../shared/types";
import {
  effectiveChatAgentPermissionsForProvider, normalizeChatAgentMode, normalizeChatAgentPermissions
} from "../../../../shared/agentPermissions";
import { agentEnvironmentKeyValidationError, filterAllowedAgentEnvironment } from "../../../../shared/agentEnvironment";
import type { ParticipantRunResult } from "../../providers";
import { CODEX_APP_SERVER_MCP_TOKEN_ENV } from "../constants";
import type { CliAgentRunOptions, CliAgentTurnImages } from "../types";

/** A transport with no image input names the message's pictures after its
 *  text, for the app's attachment tools. */
export function promptWithImageFallback(prompt: string, images: CliAgentTurnImages | undefined): string {
  if (!images?.items.length || !images.fallbackText) return prompt;
  return prompt ? `${prompt}\n\n${images.fallbackText}` : images.fallbackText;
}

function appMcpEnvFor(options: CliAgentRunOptions): NodeJS.ProcessEnv | undefined {
  if (!options.appMcp) {
    return undefined;
  }
  return {
    [CODEX_APP_SERVER_MCP_TOKEN_ENV]: options.appMcp.token
  };
}

export function agentRunEnv(options: CliAgentRunOptions): NodeJS.ProcessEnv | undefined {
  const manualEnv: NodeJS.ProcessEnv = filterAllowedAgentEnvironment(options.agentEnv);
  // A variable the User deleted is not inherited from this computer either.
  for (const [key, value] of Object.entries(options.agentEnv ?? {})) {
    if (value === undefined && !agentEnvironmentKeyValidationError(key)) manualEnv[key] = undefined;
  }
  const appMcpEnv = appMcpEnvFor(options);
  if (Object.keys(manualEnv).length === 0 && !appMcpEnv) {
    return undefined;
  }
  return {
    ...manualEnv,
    ...(appMcpEnv ?? {})
  };
}

export function withAppMcpClientStatus(
  result: ParticipantRunResult,
  participant: ParticipantConfig,
  options: CliAgentRunOptions
): ParticipantRunResult {
  const warning = appMcpClientWarning(participant, options);
  if (!warning) {
    return result;
  }
  return {
    ...result,
    appMcpClientFailed: true,
    warnings: [
      ...(result.warnings ?? []),
      warning
    ]
  };
}

function appMcpClientWarning(participant: ParticipantConfig, options: CliAgentRunOptions): string | undefined {
  const appMcp = options.appMcp;
  if (!appMcp?.clientGenerationId || !appMcp.clientStatus) {
    return undefined;
  }
  const status = appMcp.clientStatus(appMcp.clientGenerationId);
  if (!status) {
    return `${participant.label}: app tools did not load for this run; the AccordAgents MCP bridge may be unreachable or stale.`;
  }
  if (status.errored) {
    return `${participant.label}: app tools reported an MCP connection error; the AccordAgents MCP bridge will be refreshed.`;
  }
  if (!status.initialized || !status.listedTools) {
    return `${participant.label}: app tools did not finish MCP setup; the AccordAgents MCP bridge may be unreachable or stale.`;
  }
  if (!status.requiredToolsPresent) {
    const missing = status.missingToolNames.slice(0, 3).join(", ");
    return `${participant.label}: app tools loaded without required tools${missing ? ` (${missing})` : ""}; the AccordAgents MCP bridge will be refreshed.`;
  }
  return undefined;
}

export function agentModeForRun(kind: ConversationKind, options: CliAgentRunOptions): ChatAgentMode {
  return kind === "chat" ? normalizeChatAgentMode(options.agentMode) : "plan";
}

export function permissionsForRun(
  providerKind: ChatProviderKind | undefined,
  mode: ChatAgentMode,
  options: CliAgentRunOptions
): ChatAgentPermissions {
  return effectiveChatAgentPermissionsForProvider(providerKind, mode, normalizeChatAgentPermissions(options.permissions));
}

export function repoPathForRun(repoPath: string | undefined, diffMode: GitDiffMode | undefined, kind: ConversationKind): string | undefined {
  if (!repoPath) {
    return undefined;
  }
  return kind === "code-review" || kind === "implementation-plan" || kind === "chat" || Boolean(diffMode) ? repoPath : undefined;
}

export function normalizedExtraReadableDirs(dirs: string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const dir of dirs ?? []) {
    const trimmed = dir.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}
