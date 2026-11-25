import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { AgentContextUsage, ParticipantConfig } from "../../../../shared/types";
import { antigravityStartAccessFromText } from "../../../../shared/cliStartDefaults";
import { buildAgentContextUsage, contextWindowForModel } from "../../../../shared/agentContext";
import {
  extractGeminiLogConversationId, geminiTranscriptPathForConversation, geminiUserSettings, geminiUserSettingsPath,
  type GeminiExecInvocation, parseGeminiTranscriptActivity
} from "../../geminiExec";
import { textWithAgentMessageBoundary } from "../codex/appServerText";
import { emitLiveOutput, reportSessionId } from "../runs/outputText";
import { parseJsonRecord, readOptionalFile } from "../runs/records";
import type { CliAgentRunOptions } from "../types";

// Gemini 3.x models served through Antigravity share a 1M-token context window;
// used when no model is configured so the context indicator still renders.
const GEMINI_DEFAULT_CONTEXT_WINDOW_TOKENS = 1_048_576;

/** The mode agy starts in as the User's settings.json saves it (its
 *  `agentMode`); none when nothing is saved or the file cannot be read. */
export async function antigravityStartAccess(): Promise<string | undefined> {
  try {
    return antigravityStartAccessFromText(await readFile(geminiUserSettingsPath(homedir()), "utf8"));
  } catch {
    // No file, or one that cannot be read: nothing saved that the app can see.
    return undefined;
  }
}

// Polls the per-run glog file until the conversation id appears, then tails
// the conversation's brain transcript (executed tool steps) and emits coarse
// activity events. Resumed sessions prime past pre-existing transcript lines
// so only this turn's steps surface.
export function startGeminiRunTail(
  logFilePath: string,
  initialSessionId: string | undefined,
  options: CliAgentRunOptions
): { stop: () => void } {
  let sessionId: string | undefined;
  let transcriptPath: string | undefined;
  let transcriptPrimed = false;
  let transcriptLinesSeen = 0;
  let scanning = false;

  const adoptSessionId = (id: string): void => {
    if (sessionId === id) {
      return;
    }
    sessionId = id;
    transcriptPath = geminiTranscriptPathForConversation(homedir(), id);
    transcriptPrimed = false;
    transcriptLinesSeen = 0;
    reportSessionId(options.onSessionId, id);
  };
  if (initialSessionId) {
    adoptSessionId(initialSessionId);
  }

  const scan = async (): Promise<void> => {
    if (scanning) {
      return;
    }
    scanning = true;
    try {
      // Keep watching the log even after an id is known: a resume miss can
      // restart the run under a fresh conversation id.
      const found = extractGeminiLogConversationId(await readOptionalFile(logFilePath));
      if (found && found !== sessionId) {
        adoptSessionId(found);
      }
      if (!transcriptPath || !options.onOutput) {
        return;
      }
      const content = await readOptionalFile(transcriptPath);
      if (!content) {
        return;
      }
      const lines = content.split("\n");
      // The trailing segment is either "" (file ends with \n) or a partial
      // line still being written; both are excluded from the complete count.
      const completeCount = Math.max(lines.length - 1, 0);
      if (!transcriptPrimed) {
        transcriptPrimed = true;
        transcriptLinesSeen = initialSessionId && sessionId === initialSessionId ? completeCount : 0;
      }
      for (let index = transcriptLinesSeen; index < completeCount; index += 1) {
        const activity = parseGeminiTranscriptActivity(lines[index] ?? "");
        if (activity) {
          emitLiveOutput(options.onOutput, "tool", `${activity.label}\n`, undefined, {
            activityKind: activity.kind,
            activityStatus: "started"
          });
        }
      }
      transcriptLinesSeen = Math.max(transcriptLinesSeen, completeCount);
    } finally {
      scanning = false;
    }
  };

  const interval = setInterval(() => {
    void scan();
  }, 300);
  interval.unref();
  void scan();
  return {
    stop: (): void => {
      clearInterval(interval);
    }
  };
}

export function startGeminiGoalRunTail(
  logFilePath: string,
  initialSessionId: string | undefined,
  initialTranscriptLines: number,
  options: CliAgentRunOptions,
  onFinalResponse: (content: string) => void
): { stop: () => void; sessionId: () => string | undefined } {
  let sessionId = initialSessionId;
  let transcriptPath = initialSessionId
    ? geminiTranscriptPathForConversation(homedir(), initialSessionId)
    : undefined;
  let transcriptLinesSeen = initialSessionId ? initialTranscriptLines : 0;
  let scanning = false;
  let stopped = false;
  let candidate: string | undefined;
  let lastEmittedCandidate = "";
  let emittedText = "";

  const adoptSessionId = (id: string): void => {
    const normalized = id.toLowerCase();
    if (sessionId === normalized) {
      return;
    }
    sessionId = normalized;
    transcriptPath = geminiTranscriptPathForConversation(homedir(), normalized);
    transcriptLinesSeen = 0;
    candidate = undefined;
    lastEmittedCandidate = "";
    reportSessionId(options.onSessionId, normalized);
  };
  if (initialSessionId) {
    reportSessionId(options.onSessionId, initialSessionId);
  }

  const scan = async (): Promise<void> => {
    if (scanning || stopped) {
      return;
    }
    scanning = true;
    try {
      const found = extractGeminiLogConversationId(await readOptionalFile(logFilePath));
      if (found) {
        adoptSessionId(found);
      }
      if (!transcriptPath) {
        return;
      }
      const content = await readOptionalFile(transcriptPath);
      if (!content) {
        return;
      }
      const lines = content.split("\n");
      const completeCount = Math.max(lines.length - 1, 0);
      for (let index = transcriptLinesSeen; index < completeCount; index += 1) {
        const line = lines[index] ?? "";
        const activity = parseGeminiTranscriptActivity(line);
        if (activity) {
          emitLiveOutput(options.onOutput, "tool", `${activity.label}\n`, undefined, {
            activityKind: activity.kind,
            activityStatus: "started"
          });
        }
        const record = parseJsonRecord(line);
        if (!record) {
          continue;
        }
        if (
          record.type === "PLANNER_RESPONSE" &&
          record.status === "DONE" &&
          typeof record.content === "string" &&
          record.content.trim()
        ) {
          candidate = record.content.trim();
          if (candidate !== lastEmittedCandidate) {
            lastEmittedCandidate = candidate;
            emittedText = emittedText
              ? textWithAgentMessageBoundary(emittedText, candidate)
              : candidate;
            emitLiveOutput(options.onOutput, "text", `${candidate}\n`, emittedText);
          }
          onFinalResponse(candidate);
        }
      }
      transcriptLinesSeen = Math.max(transcriptLinesSeen, completeCount);
    } finally {
      scanning = false;
    }
  };

  const interval = setInterval(() => {
    void scan();
  }, 250);
  interval.unref();
  void scan();
  return {
    stop: (): void => {
      stopped = true;
      clearInterval(interval);
    },
    sessionId: (): string | undefined => sessionId
  };
}

export function completeLineCount(content: string): number {
  if (!content) {
    return 0;
  }
  const lines = content.split("\n");
  return Math.max(lines.length - 1, 0);
}

export function antigravityDescendantPids(rootPid: number | undefined): number[] {
  if (!rootPid) {
    return [];
  }
  try {
    const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]) }));
    const descendants: number[] = [];
    const queue = [rootPid];
    while (queue.length > 0) {
      const parent = queue.shift() as number;
      for (const row of rows) {
        if (row.ppid === parent && !descendants.includes(row.pid)) {
          descendants.push(row.pid);
          queue.push(row.pid);
        }
      }
    }
    return descendants.reverse();
  } catch {
    return [];
  }
}

export function antigravityToolDescendantPids(rootPid: number | undefined): number[] {
  const descendants = antigravityDescendantPids(rootPid);
  return descendants.length > 1 ? descendants.slice(0, -1) : [];
}

export function geminiContextUsage(totalTokens: number | undefined, participant: ParticipantConfig): AgentContextUsage | undefined {
  return buildAgentContextUsage({
    usedTokens: totalTokens,
    contextWindowTokens:
      contextWindowForModel(participant.kind, participant.model) ?? GEMINI_DEFAULT_CONTEXT_WINDOW_TOKENS,
    source: "gemini-cli",
    model: participant.model
  });
}

/** The User's own agy settings, read for each run as agy reads them. */
export async function readGeminiUserSettings(): Promise<ReturnType<typeof geminiUserSettings>> {
  try {
    return geminiUserSettings(await readFile(geminiUserSettingsPath(homedir()), "utf8"));
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? geminiUserSettings(undefined) : { readable: false };
  }
}

/** The run's session settings go in its own folder, not on the command
 *  line, where any process on the computer could read the User's rules. */
export async function writeGeminiSessionSettings(invocation: GeminiExecInvocation): Promise<void> {
  const index = invocation.args.indexOf("--settings");
  const at = index >= 0 ? invocation.args[index + 1] : undefined;
  if (invocation.settings && at && !at.startsWith("{")) {
    await writeFile(at, JSON.stringify(invocation.settings), { encoding: "utf8", mode: 0o600 });
  }
}
