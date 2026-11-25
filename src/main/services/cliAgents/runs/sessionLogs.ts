import { homedir } from "node:os";
import path from "node:path";
import { visitLinesFromEnd } from "../../linesFromEnd";
import type { AgentContextUsage, ParticipantConfig } from "../../../../shared/types";
import { buildAgentContextUsage, contextWindowForModel } from "../../../../shared/agentContext";
import {
  claudeCanonicalModelId, claudeContextWindowFromResult, claudeMainThreadContext, codexContextFromEvent, isClaudeCompactBoundary,
  type CliContextReading
} from "../../cliContextUsage";
import { commandEnvironment } from "../../command";
import { codexContextUsage } from "../codex/execOutput";
import { SESSION_LOG_RETRIES } from "../constants";
import { delay, findFileByName, findFileByNameMatch } from "./records";
import type { CliModules } from "../modules";

const SESSION_LOG_RETRY_MS = 80;

/** The window Claude Code reported for a model (a result's `modelUsage`, or
 *  the member's stored usage), used for that model's session-log reading. */
interface ClaudeKnownContextWindow {
  contextWindowTokens: number;
  model?: string;
}

/** How full a member's context is, from the CLI's own session log. */
export class SessionLogs {
  constructor(private readonly cli: Pick<CliModules, "geminiRuns">) {}

  /**
   * Reads the latest context usage from the CLI's own session log.
   *
   * By default a missing log is retried for a moment, because right after a turn
   * or a compaction the CLI may not have written it yet. `waitForLog: false`
   * reads once: opening a chat refreshes usage for every session it holds, and
   * the logs of old sessions are gone for good (Claude Code deletes them after
   * its cleanup period), so waiting there only delayed every open.
   */
  async contextUsageForSession(
    participant: ParticipantConfig,
    sessionId: string | undefined,
    options: { waitForLog?: boolean; known?: AgentContextUsage } = {}
  ): Promise<AgentContextUsage | undefined> {
    if (!sessionId) {
      return undefined;
    }
    const attempts = options.waitForLog === false ? 1 : SESSION_LOG_RETRIES;
    if (participant.kind === "codex-cli") {
      return this.extractCodexSessionLogContextUsageWithRetry(sessionId, participant, attempts);
    }
    if (participant.kind === "claude-code") {
      // The window the CLI reported for this model at the member's last
      // turn: Claude's session log names none.
      // Only a window the CLI reported: one an older build stored came from
      // the map or from another model's entry.
      const known = options.known?.source === "claude-code" && options.known.windowFromCli
        ? { contextWindowTokens: options.known.contextWindowTokens, model: options.known.model }
        : undefined;
      return this.extractClaudeSessionLogContextUsageWithRetry(sessionId, participant, attempts, known);
    }
    if (participant.kind === "gemini-cli") {
      return this.cli.geminiRuns.geminiSessionUsage.get(sessionId);
    }
    return undefined;
  }

  async extractCodexSessionLogContextUsageWithRetry(
    sessionId: string | undefined,
    participant: ParticipantConfig,
    attempts = SESSION_LOG_RETRIES
  ): Promise<AgentContextUsage | undefined> {
    if (!sessionId) {
      return undefined;
    }
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const usage = await this.extractCodexSessionLogContextUsage(sessionId, participant);
      if (usage || attempt === attempts - 1) {
        return usage;
      }
      await delay(SESSION_LOG_RETRY_MS);
    }
    return undefined;
  }

  /** The rollout's latest token count with usage in it, read from the end
   *  (a compaction's own count, Codex's estimate of the new history, is the
   *  latest one right after it). */
  private async extractCodexSessionLogContextUsage(
    sessionId: string,
    participant: ParticipantConfig
  ): Promise<AgentContextUsage | undefined> {
    const filePath = await this.findCodexSessionLogPath(sessionId);
    if (!filePath) {
      return undefined;
    }
    let reading: CliContextReading | undefined;
    await visitLinesFromEnd(filePath, (line) => {
      if (!line.includes("token_count")) {
        return false;
      }
      try {
        const found = codexContextFromEvent(JSON.parse(line) as unknown);
        if (found?.usedTokens) {
          reading = found;
          return true;
        }
      } catch {
        // A partial line at the end of a rollout being written.
      }
      return false;
    });
    return codexContextUsage(reading, participant);
  }

  async extractClaudeSessionLogContextUsageWithRetry(
    sessionId: string | undefined,
    participant: ParticipantConfig,
    attempts = SESSION_LOG_RETRIES,
    knownWindow?: ClaudeKnownContextWindow | number | { resultEvent: unknown }
  ): Promise<AgentContextUsage | undefined> {
    if (!sessionId) {
      return undefined;
    }
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const usage = await this.extractClaudeSessionLogContextUsage(sessionId, participant, knownWindow);
      if (usage || attempt === attempts - 1) {
        return usage;
      }
      await delay(SESSION_LOG_RETRY_MS);
    }
    return undefined;
  }

  /** The context of the session's last main-thread model call, as the CLI's
   *  own /context reads it after a resume. The log names no window: the one
   *  the CLI reported for this model (`knownWindow`, from a result or the
   *  member's stored usage) wins over the map. */
  private async extractClaudeSessionLogContextUsage(
    sessionId: string,
    participant: ParticipantConfig,
    knownWindow?: ClaudeKnownContextWindow | number | { resultEvent: unknown }
  ): Promise<AgentContextUsage | undefined> {
    const filePath = await this.findClaudeSessionLogPath(sessionId);
    if (!filePath) {
      return undefined;
    }
    // The newest usage wins, so the log is read from its end: opening a chat used to
    // read and parse every line of logs that reach 120 MB, blocking the app for half a
    // second per open.
    let reading: CliContextReading | undefined;
    await visitLinesFromEnd(filePath, (line) => {
      if (!line.trim()) {
        return false;
      }
      try {
        const event = JSON.parse(line) as unknown;
        // A compaction boundary resets the conversation: usage recorded before it
        // is stale (pre-compact), so meeting one first means there is no usage
        // yet and we never report the old, larger context after a /compact.
        if (isClaudeCompactBoundary(event)) {
          return true;
        }
        reading = claudeMainThreadContext(event);
        return reading !== undefined;
      } catch {
        // Ignore partial or diagnostic lines in Claude's local session log.
        return false;
      }
    });
    if (!reading) {
      return undefined;
    }
    const model = reading.model ?? participant.model;
    const known: ClaudeKnownContextWindow | undefined = typeof knownWindow === "number"
      ? { contextWindowTokens: knownWindow }
      : knownWindow && "resultEvent" in knownWindow
        ? (() => {
            const window = claudeContextWindowFromResult(knownWindow.resultEvent, model);
            return window ? { contextWindowTokens: window } : undefined;
          })()
        : knownWindow;
    const knownApplies = known && (!known.model || !model || claudeCanonicalModelId(known.model) === claudeCanonicalModelId(model));
    return buildAgentContextUsage({
      usedTokens: reading.usedTokens,
      contextWindowTokens: (knownApplies ? known.contextWindowTokens : undefined) ?? contextWindowForModel(participant.kind, model),
      source: "claude-code",
      model,
      windowFromCli: Boolean(knownApplies)
    });
  }

  private async findClaudeSessionLogPath(sessionId: string): Promise<string | undefined> {
    // Where the CLI keeps them: CLAUDE_CONFIG_DIR when set (cliConfigStamp).
    const configDir = commandEnvironment().CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), ".claude");
    return findFileByName(path.join(configDir, "projects"), `${sessionId}.jsonl`, 5);
  }

  private async findCodexSessionLogPath(sessionId: string): Promise<string | undefined> {
    return findFileByNameMatch(
      path.join(commandEnvironment().CODEX_HOME?.trim() || path.join(homedir(), ".codex"), "sessions"),
      (fileName) => fileName.endsWith(".jsonl") && fileName.includes(sessionId),
      6
    );
  }
}
