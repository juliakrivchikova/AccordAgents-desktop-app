import type { AgentDetectionRequest, PluginListRequest, UserSkillSummary } from "../../../shared/types";
import type { DesktopApp } from "../desktopApp";
import { USER_SKILL_SEARCH_MAX_LIMIT } from "../../services/userSkills";

export function normalizeAgentDetectionRequest(value: unknown): AgentDetectionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Partial<AgentDetectionRequest>;
  const trigger = record.trigger === "initial" || record.trigger === "focus" || record.trigger === "manual" ||
    record.trigger === "submit" || record.trigger === "provider-enabled" || record.trigger === "service"
    ? record.trigger
    : undefined;
  return { force: record.force === true, trigger };
}

export async function resolvePluginListRequest(desktopApp: DesktopApp, request?: PluginListRequest): Promise<{
  request: PluginListRequest;
  skills?: UserSkillSummary[];
}> {
  const conversationId = typeof request?.conversationId === "string" ? request.conversationId : undefined;
  const query = typeof request?.query === "string" ? request.query : "";
  const content = typeof request?.content === "string" ? request.content : "";
  const limit = typeof request?.limit === "number" ? request.limit : undefined;
  if (conversationId) {
    const conversation = await desktopApp.storageService.getConversation(conversationId);
    if (!conversation || conversation.kind !== "chat") {
      return {
        request: { conversationId, query, content, limit },
        skills: []
      };
    }
    const skills = await desktopApp.userSkillsService.search(
      { conversationId: conversation.id, query, content, limit: USER_SKILL_SEARCH_MAX_LIMIT },
      desktopApp.chatService.userSkillRunContext(conversation, content)
    );
    return {
      request: { conversationId, repoPath: conversation.repoPath, query, content, limit },
      skills: skills.skills
    };
  }
  const repoPath = typeof request?.repoPath === "string" ? request.repoPath : undefined;
  const participants = Array.isArray(request?.participants) ? request.participants : undefined;
  if (participants) {
    const skills = await desktopApp.userSkillsService.search(
      { repoPath, participants, query, content, limit: USER_SKILL_SEARCH_MAX_LIMIT },
      await desktopApp.chatService.prospectiveUserSkillRunContext({
        repoPath,
        participants,
        assistantProviderKind: request?.assistantProviderKind,
        content
      })
    );
    return {
      request: { repoPath, participants, assistantProviderKind: request?.assistantProviderKind, query, content, limit },
      skills: skills.skills
    };
  }
  return {
    request: { repoPath, query, content, limit }
  };
}
