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
