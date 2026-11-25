/** A member's removal request before the targets are resolved against the chat. */
export interface ParticipantRemovalInput {
  reason?: string;
  /** operationNumber: where the member put it in its request, for errors. */
  targets: Array<{ participantId?: string; handle?: string; operationNumber?: number }>;
}
