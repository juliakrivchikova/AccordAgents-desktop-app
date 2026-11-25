import type { Conversation, ConversationKind, ParticipantConfig } from "../../../../shared/types";
import type { CliSessionContext } from "./types";

interface CliAgentSessionMetadata {
  key: string;
  participantId: string;
  participantKind: ParticipantConfig["kind"];
  participantLabel: string;
  sessionId: string;
  updatedAt: string;
}

export function asArbiterParticipant(arbiter: ParticipantConfig, kind: ConversationKind = "code-review"): ParticipantConfig {
  const role = kind === "implementation-plan" ? "planner" : "arbiter";
  return { ...arbiter, id: `arbiter:${arbiter.id}`, label: `${arbiter.label} (${role})` };
}

export function isCliParticipant(participant: ParticipantConfig): boolean {
  return participant.kind === "codex-cli" || participant.kind === "claude-code" || participant.kind === "gemini-cli";
}

export function participantSessionKey(participant: ParticipantConfig): string {
  return `participant:${participant.kind}:${participant.id}`;
}

export function arbiterSessionKey(arbiter: ParticipantConfig): string {
  return `arbiter:${arbiter.kind}:${arbiter.id}`;
}

export function cliSessionContext(conversation: Conversation, warnings: string[], sessionKey: string): CliSessionContext {
  return { conversation, warnings, sessionKey };
}

function cliAgentSessionsFromMetadata(conversation: Conversation): CliAgentSessionMetadata[] {
  const value = conversation.metadata.cliAgentSessions;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is CliAgentSessionMetadata => {
    const candidate = item as Partial<CliAgentSessionMetadata>;
    return (
      typeof candidate.key === "string" &&
      typeof candidate.participantId === "string" &&
      typeof candidate.participantKind === "string" &&
      typeof candidate.participantLabel === "string" &&
      typeof candidate.sessionId === "string" &&
      typeof candidate.updatedAt === "string"
    );
  });
}

export function cliAgentSessionId(conversation: Conversation, key: string): string | undefined {
  return cliAgentSessionsFromMetadata(conversation).find((session) => session.key === key)?.sessionId;
}

export function upsertCliAgentSession(conversation: Conversation, key: string, participant: ParticipantConfig, sessionId: string): void {
  const sessions = cliAgentSessionsFromMetadata(conversation).filter((session) => session.key !== key);
  sessions.push({
    key,
    participantId: participant.id,
    participantKind: participant.kind,
    participantLabel: participant.label,
    sessionId,
    updatedAt: new Date().toISOString()
  });
  conversation.metadata = { ...conversation.metadata, cliAgentSessions: sessions };
}
