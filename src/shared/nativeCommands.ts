/** A command is accepted durably before any provider input is written.
 * Claimed commands are never retried merely because their runtime disappeared. */
export interface NativeCommand {
  commandId: string;
  eventId: string;
  conversationId: string;
  participantId: string;
  runId: string;
  terminalEventId: string;
  phase: "queued" | "claimed" | "finished";
  runtimeId?: string;
  executorGeneration?: number;
  cancelled: boolean;
}

export interface NativeRuntimeIdentity {
  runtimeId: string;
  pid: number;
  startedAt: string;
}

export interface NativeSessionExecutor extends NativeRuntimeIdentity {
  conversationId: string;
  participantId: string;
  generation: number;
  released: boolean;
}
