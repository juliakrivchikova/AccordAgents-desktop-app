import { ipcMain } from "electron";
import type { PluginListRequest, UserSkillDiagnosticsRequest, UserSkillListRequest, UserSkillSearchRequest } from "../../../shared/types";
import { resolvePluginListRequest } from "./pluginRequests";
import type { DesktopApp } from "../desktopApp";

export function registerSkillsIpc(desktopApp: DesktopApp): void {
  ipcMain.handle("skills:search", async (_event, request: UserSkillSearchRequest) => {
    const conversationId = typeof request?.conversationId === "string" ? request.conversationId : "";
    const content = typeof request?.content === "string" ? request.content : "";
    if (conversationId) {
      const conversation = await desktopApp.storageService.getConversation(conversationId);
      if (!conversation || conversation.kind !== "chat") {
        return {
          target: { participantIds: [], providerKinds: [], hasClearTargets: false },
          skills: []
        };
      }
      return desktopApp.userSkillsService.search(
        {
          conversationId: conversation.id,
          query: typeof request?.query === "string" ? request.query : "",
          content,
          limit: typeof request?.limit === "number" ? request.limit : undefined
        },
        desktopApp.chatService.userSkillRunContext(conversation, content)
      );
    }
    return desktopApp.userSkillsService.search(
      {
        query: typeof request?.query === "string" ? request.query : "",
        repoPath: typeof request?.repoPath === "string" ? request.repoPath : undefined,
        participants: Array.isArray(request?.participants) ? request.participants : [],
        content,
        limit: typeof request?.limit === "number" ? request.limit : undefined
      },
      await desktopApp.chatService.prospectiveUserSkillRunContext({
        repoPath: typeof request?.repoPath === "string" ? request.repoPath : undefined,
        participants: Array.isArray(request?.participants) ? request.participants : [],
        assistantProviderKind: request?.assistantProviderKind,
        content
      })
    );
  });

  ipcMain.handle("skills:diagnostics", async (_event, request?: UserSkillDiagnosticsRequest) => {
    const conversationId = typeof request?.conversationId === "string" ? request.conversationId : "";
    const conversation = conversationId ? await desktopApp.storageService.getConversation(conversationId) : undefined;
    return desktopApp.userSkillsService.diagnostics(
      conversation?.kind === "chat" ? conversation.repoPath : undefined,
      conversation?.kind === "chat" ? desktopApp.chatService.userSkillRunContext(conversation, "") : undefined
    );
  });

  ipcMain.handle("skills:list-all", (_event, request?: UserSkillListRequest) => {
    return desktopApp.userSkillsService.listAll({
      repoPath: typeof request?.repoPath === "string" ? request.repoPath : undefined,
      query: typeof request?.query === "string" ? request.query : undefined,
      limit: typeof request?.limit === "number" ? request.limit : undefined
    });
  });

  ipcMain.handle("plugins:list", async (_event, request?: PluginListRequest) => {
    const resolved = await resolvePluginListRequest(desktopApp, request);
    return desktopApp.pluginService.list(resolved.request, resolved.skills);
  });

  ipcMain.handle("plugins:refresh", async (_event, request?: PluginListRequest) => {
    const resolved = await resolvePluginListRequest(desktopApp, request);
    return desktopApp.pluginService.refresh(resolved.request, resolved.skills);
  });
}
