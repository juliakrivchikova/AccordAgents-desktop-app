import { newClaudeWarmReply } from "../claude/replies";
import { cliParts } from "./cliParts";

/** Drives the warm Claude line router directly: one process state, replies
 *  added as if written to the CLI, and every line the fixture "prints". */
export function makeClaudeWarmHarness(runner: any, options: { lifecycle?: boolean } = {}) {
  const written: Array<Record<string, unknown>> = [];
  const state = {
    replies: [] as any[],
    active: undefined as any,
    stepActive: false,
    lifecycleSupported: options.lifecycle ?? false,
    backgroundTasks: new Map<string, string>(),
    backgroundTaskLabels: new Map<string, string>(),
    backgroundTaskOrigins: new Map<string, unknown>(),
    backgroundTaskStartedAt: new Map<string, string>(),
    finishedTaskIds: new Set<string>(),
    pendingNotices: [] as unknown[],
    cancelRequests: new Map<string, unknown>(),
    controlWaiters: new Map<string, (response: unknown) => void>(),
    lastTaskEventAt: 0,
    selfResumeExpectedUntil: 0,
    interruptTarget: undefined as unknown,
    interruptRequestId: undefined as string | undefined,
    onSelfResumedTurn: undefined as ((turn: any) => void) | undefined,
    toolContext: {} as Record<string, unknown>
  };
  const flags = { unusable: false, settled: 0 };
  const hooks = {
    write: (message: Record<string, unknown>) => written.push(message),
    settled: () => { flags.settled += 1; },
    flush: () => undefined,
    markUnusable: () => { flags.unusable = true; },
    markUnusableIfIdle: () => {
      if (state.replies.length === 0 && state.backgroundTasks.size === 0) {
        flags.unusable = true;
      }
    }
  };
  const participant = { id: "p1", label: "Agent", kind: "claude-code" };
  let commands = 0;
  const addReply = (overrides: Record<string, unknown> = {}) => {
    const outputs: Array<{ kind: string; text: string; cumulative?: string; activityKind?: string; activityStatus?: string; activityItemId?: string }> = [];
    const resolved: any[] = [];
    const rejected: Error[] = [];
    commands += 1;
    const reply = newClaudeWarmReply({
      commandUuid: `cmd-${commands}`,
      written: true,
      onOutput: (event: any) => outputs.push(event),
      resolve: (result: unknown) => resolved.push(result),
      reject: (error: Error) => rejected.push(error),
      ...overrides
    });
    state.replies.push(reply);
    return { reply, outputs, resolved, rejected };
  };
  const send = (event: Record<string, unknown>): void => cliParts(runner).claudeProcess.handleClaudeWarmLine(
    JSON.stringify(event),
    participant,
    undefined,
    state,
    hooks
  );
  return { state, hooks, written, flags, participant, addReply, send };
}
