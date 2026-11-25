import type { HubFeedEntry, HubOpResult } from "../../shared/hubOps";
import type { ChatMessage, Conversation } from "../../shared/types";

/** One accepted operation, as the server's other parts hear of it. */
export interface HubOpApplied {
  deviceId: string;
  entry: HubFeedEntry;
  /** The chat after the operation (absent for a deleted chat and for turns). */
  conversation?: Conversation;
  /** The message as it was before an update. */
  previous?: ChatMessage;
}

export class HubOpsRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type Rejection = { rejected: string };

export type Outcome =
  | { result: HubOpResult; applied?: HubOpApplied };
