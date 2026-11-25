import path from "node:path";
import { app } from "electron";
import type { AgentDetectionRequest, AgentHealth } from "../../shared/types";
import { MAIN_DIRECTORY } from "../mainDirectory";
import type { DesktopApp } from "./desktopApp";

export function appSkillsSourceRoot(): string {
  return app.isPackaged
    ? path.join(MAIN_DIRECTORY, "appSkills")
    : path.join(process.cwd(), "src/main/appSkills");
}

export async function detectAgentsWithAppSkills(desktopApp: DesktopApp, request?: AgentDetectionRequest): Promise<AgentHealth[]> {
  const agents = await desktopApp.cliAgentRunner.detectAgents(request);
  if (request?.trigger === "focus" || request?.trigger === "submit") {
    const cached = agents.map((agent) => ({
      ...agent,
      appSkillSync: desktopApp.appSkillsService.statusForAgent(agent)
    }));
    if (cached.every((agent) => agent.appSkillSync)) {
      await desktopApp.settingsService.ensureAssistantProviderDefault(cached);
      return cached;
    }
  }
  const reconciled: AgentHealth[] = await desktopApp.appSkillsService.reconcileAgents(agents).catch((error): AgentHealth[] => {
    void desktopApp.debugLogService.write("app-skills-detect-sync-error", {
      error: error instanceof Error ? error.message : String(error)
    });
    return agents.map((agent) => ({
      ...agent,
      appSkillSync: agent.installed
        ? { status: "error", skillCount: 0, updatedAt: new Date().toISOString(), message: "App skill sync failed." }
        : { status: "not-installed", skillCount: 0, updatedAt: new Date().toISOString() }
    }));
  });
  await desktopApp.settingsService.ensureAssistantProviderDefault(reconciled);
  return reconciled;
}
