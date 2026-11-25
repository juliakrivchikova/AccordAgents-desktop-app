import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ConversationKind, ParticipantConfig } from "../../../../shared/types";
import { normalizedExtraReadableDirs } from "../runs/runEnvironment";
import type { CliAgentRunOptions, CliAgentWarmOptions } from "../types";

/** Whether a warm process key was started with Claude in Chrome. */
/** The agent environment version a member process was started with. */
export function warmKeyAgentEnvKey(key: string): string | undefined {
  try {
    const parsed = JSON.parse(key) as { agentEnvKey?: unknown };
    return typeof parsed.agentEnvKey === "string" ? parsed.agentEnvKey : undefined;
  } catch {
    return undefined;
  }
}

export function warmKeyClaudeChrome(key: string): boolean | undefined {
  try {
    const parsed = JSON.parse(key) as { claudeChrome?: unknown; providerKind?: unknown };
    return parsed.providerKind === "claude-code" ? parsed.claudeChrome === true : undefined;
  } catch {
    return undefined;
  }
}

export function warmConversationId(key: string): string | undefined {
  try {
    const value = JSON.parse(key) as { conversationId?: unknown };
    return typeof value?.conversationId === "string" ? value.conversationId : undefined;
  } catch { return undefined; }
}

export function warmAgentKey(
  participant: ParticipantConfig,
  repoPath: string | undefined,
  kind: ConversationKind,
  options: CliAgentRunOptions
): string {
  return JSON.stringify({
    conversationId: options.warm?.conversationId,
    participantId: options.warm?.participantId,
    providerKind: participant.kind,
    model: participant.model ?? "",
    reasoningEffort: participant.reasoningEffort ?? "",
    repoPath: repoPath ?? "",
    kind,
    extraReadableDirs: normalizedExtraReadableDirs(options.extraReadableDirs),
    agentEnvKey: options.agentEnvKey ?? "",
    // Switching Claude in Chrome starts the member's next turn in a new
    // process, as a changed model does.
    ...(options.claudeChrome ? { claudeChrome: true } : {}),
    codexConfigOverrides: participant.codexConfigOverrides ?? [],
    contextKey: options.warm?.contextKey ?? ""
  });
}

export function warmAgentScopeKey(warm: CliAgentWarmOptions): string {
  return `${warm.conversationId}:${warm.participantId}`;
}

export function waitForProcessClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function withoutWarm(options: CliAgentRunOptions): CliAgentRunOptions {
  const { warm: _warm, ...next } = options;
  return next;
}
