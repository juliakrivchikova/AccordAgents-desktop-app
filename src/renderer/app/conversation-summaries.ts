import type { Conversation, ConversationSummary } from "../../shared/types";
import type { ProjectSessionGroup } from "../components/shell";
import { NO_PROJECT_GROUP_KEY } from "./constants";

export function buildProjectSessionGroups(summaries: ConversationSummary[]): ProjectSessionGroup[] {
  const groups = new Map<string, ProjectSessionGroup>();

  for (const summary of summaries) {
    if (summary.archived) {
      continue;
    }
    const projectPath = normalizeProjectPath(summary.repoPath);
    const key = projectPath ?? NO_PROJECT_GROUP_KEY;
    const existing = groups.get(key);
    if (existing) {
      existing.sessions.push(summary);
      if (conversationTimeValue(summary.updatedAt) > conversationTimeValue(existing.updatedAt)) {
        existing.updatedAt = summary.updatedAt;
      }
      continue;
    }
    groups.set(key, {
      key,
      label: projectPath ? projectLabelForPath(projectPath) : "No project",
      repoPath: projectPath,
      updatedAt: summary.updatedAt,
      sessions: [summary],
      isNoProject: !projectPath
    });
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      sessions: [...group.sessions].sort(compareConversationSummaries)
    }))
    .sort((left, right) => {
      if (left.isNoProject !== right.isNoProject) {
        return left.isNoProject ? 1 : -1;
      }
      const timeDelta = conversationTimeValue(right.updatedAt) - conversationTimeValue(left.updatedAt);
      return timeDelta || left.label.localeCompare(right.label);
    });
}

export function normalizeProjectPath(repoPath: string | undefined): string | undefined {
  const trimmed = repoPath?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.replace(/[\\/]+$/g, "");
  return normalized || trimmed;
}

export function upsertConversationSummary(summaries: ConversationSummary[], conversation: Conversation): ConversationSummary[] {
  const nextSummary = summaryFromConversation(conversation);
  return [
    nextSummary,
    ...summaries.filter((summary) => summary.id !== conversation.id)
  ].sort(compareConversationSummaries);
}

export function compareConversationSummaries(left: ConversationSummary, right: ConversationSummary): number {
  const timeDelta = conversationTimeValue(right.updatedAt) - conversationTimeValue(left.updatedAt);
  return timeDelta || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
}

export function conversationTimeValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function projectLabelForPath(repoPath: string): string {
  const parts = repoPath.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? repoPath;
}

function summaryFromConversation(conversation: Conversation): ConversationSummary {
  const activeRunIds = conversation.metadata?.activeRunIds;
  const hasActiveRuns = Array.isArray(activeRunIds) && activeRunIds.length > 0;
  const running = Boolean(hasActiveRuns || conversation.metadata?.running);
  return {
    id: conversation.id,
    title: conversation.title,
    kind: conversation.kind,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    repoPath: conversation.repoPath,
    running,
    archived: conversation.metadata?.archived === true
  };
}
