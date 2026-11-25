import type { ChatAgentActivityEvent } from "../../../../shared/types";

/** Orders a Claude Code member's overlapping messages into its CLI. */
export interface ClaudeWriteGate {
  /** Settles once every earlier message of the member reached its CLI. */
  previous: Promise<void>;
  markWritten: () => void;
}

export interface ChatActivityAccumulator {
  events: ChatAgentActivityEvent[];
  sequence: number;
  label?: string;
  omittedCount: number;
}
