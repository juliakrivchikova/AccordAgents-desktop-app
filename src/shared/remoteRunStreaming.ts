import type { ChatAgentActivityEvent, ChatRemoteRunStatus } from "./types";

export function isRemoteRunProviderPendingMessage(input: {
  isStreaming: boolean;
  appMessageSource?: string;
  remoteRunStatus?: ChatRemoteRunStatus;
}): boolean {
  return input.isStreaming && (
    input.appMessageSource === "remote-run-provider-output" ||
    input.appMessageSource === "remote-run-provider" ||
    Boolean(input.remoteRunStatus)
  );
}

export function remoteRunStreamingContent(input: {
  isStreaming: boolean;
  appMessageSource?: string;
  remoteRunStatus?: ChatRemoteRunStatus;
  livePartialContent?: string;
  displayContent: string;
}): string | undefined {
  if (input.livePartialContent != null) {
    return input.livePartialContent;
  }
  return isRemoteRunProviderPendingMessage(input) ? input.displayContent : undefined;
}

export function remoteRunStreamingStartedAt(messageCreatedAt: string, remoteRunStatus?: ChatRemoteRunStatus): string {
  if (!remoteRunStatus) {
    return messageCreatedAt;
  }
  if (remoteRunStatus.phase === "processing-request") {
    return remoteRunStatus.processingStartedAt ?? remoteRunStatus.startedAt;
  }
  return remoteRunStatus.startedAt;
}

export function remoteRunStreamingActivityEvents(input: {
  isStreaming: boolean;
  appMessageSource?: string;
  remoteRunStatus?: ChatRemoteRunStatus;
  liveActivityEvents?: ChatAgentActivityEvent[];
  persistedActivityEvents?: ChatAgentActivityEvent[];
}): ChatAgentActivityEvent[] {
  if (input.liveActivityEvents !== undefined) {
    return input.liveActivityEvents;
  }
  return isRemoteRunProviderPendingMessage(input) ? input.persistedActivityEvents ?? [] : [];
}
