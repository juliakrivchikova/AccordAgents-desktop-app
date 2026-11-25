import { registerAppIpc } from "./appIpc";
import { registerTerminalIpc } from "./terminalIpc";
import { registerSettingsIpc } from "./settingsIpc";
import { registerFilesIpc } from "./filesIpc";
import { registerCloudRunsIpc } from "./cloudRunsIpc";
import { registerAvatarIpc } from "./avatarIpc";
import { registerAgentsIpc } from "./agentsIpc";
import { registerGitIpc } from "./gitIpc";
import { registerSkillsIpc } from "./skillsIpc";
import { registerConversationsIpc } from "./conversationsIpc";
import { registerReviewsIpc } from "./reviewsIpc";
import { registerChatIpc } from "./chatIpc";
import { registerScriptsIpc } from "./scriptsIpc";
import { registerChatCardsIpc } from "./chatCardsIpc";
import { registerMachinesIpc } from "./machinesIpc";
import { registerHubIpc } from "./hubIpc";
import { registerSpeechIpc } from "./speechIpc";
import { registerArtifactsIpc } from "./artifactsIpc";
import type { DesktopApp } from "../desktopApp";

/** Answers everything the window asks of the main process. */
export function registerIpc(desktopApp: DesktopApp): void {
  registerAppIpc(desktopApp);
  registerTerminalIpc(desktopApp);
  registerSettingsIpc(desktopApp);
  registerFilesIpc(desktopApp);
  registerCloudRunsIpc(desktopApp);
  registerAvatarIpc(desktopApp);
  registerAgentsIpc(desktopApp);
  registerGitIpc(desktopApp);
  registerSkillsIpc(desktopApp);
  registerConversationsIpc(desktopApp);
  registerReviewsIpc(desktopApp);
  registerChatIpc(desktopApp);
  registerScriptsIpc(desktopApp);
  registerChatCardsIpc(desktopApp);
  registerMachinesIpc(desktopApp);
  registerHubIpc(desktopApp);
  registerSpeechIpc(desktopApp);
  registerArtifactsIpc(desktopApp);
}
