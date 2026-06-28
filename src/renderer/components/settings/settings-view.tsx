import type {
  AgentHealth,
  AppSettings,
  ChatBehaviorRuleConfigUpdate,
  ChatParticipantConfigUpdate,
  ChatRoleConfigUpdate,
  ChatSavedPromptConfigUpdate,
  CloudRunsSettingsUpdate,
  ProviderSettings,
  RepoFileOpenAction
} from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { IconButton } from "../primitives";
import { SidebarPanelIcon } from "../shell/sidebar-panel-icon";
import { ParticipantsSettingsScreen } from "./participants-settings-screen";
import { RolesSettingsSection } from "./roles-settings-section";
import { GeneralSettingsSection } from "./general-settings-section";
import { BehaviorRuleSettingsSection } from "./behavior-rules-settings-section";
import { SavedPromptsSettingsSection } from "./saved-prompts-settings-section";
import { X } from "lucide-react";

export type SettingsSection = "general" | "roles" | "behavior-rules" | "saved-prompts" | "participants";

export function SettingsView(props: {
  section: SettingsSection;
  settings: AppSettings;
  agents: AgentHealth[];
  updateProvider: (provider: ProviderSettings, patch: { enabled?: boolean }) => Promise<void>;
  saveChatRoleConfig: (update: ChatRoleConfigUpdate) => Promise<void>;
  archiveChatRoleConfig: (id: string) => Promise<void>;
  saveChatBehaviorRuleConfig: (update: ChatBehaviorRuleConfigUpdate) => Promise<void>;
  deleteChatBehaviorRuleConfig: (id: string) => Promise<void>;
  saveChatSavedPromptConfig: (update: ChatSavedPromptConfigUpdate) => Promise<void>;
  deleteChatSavedPromptConfig: (id: string) => Promise<void>;
  saveChatParticipantConfig: (update: ChatParticipantConfigUpdate) => Promise<void>;
  deleteChatParticipantConfig: (id: string) => Promise<void>;
  setRepoFileOpenPreference: (action: RepoFileOpenAction | null) => Promise<void>;
  setCliAgentRunTimeoutMs: (timeoutMs: number) => Promise<void>;
  saveCloudRunsSettings: (update: CloudRunsSettingsUpdate) => Promise<void>;
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  onClose: () => void;
}): JSX.Element {
  const title = props.section === "general"
    ? "General"
    : props.section === "roles"
      ? "Roles"
      : props.section === "behavior-rules"
        ? "Rules"
        : props.section === "saved-prompts" ? "Prompts" : "Participants";
  const sectionClass = props.section === "participants"
    ? "settings-view-participants"
    : props.section === "roles"
      ? "settings-view-roles"
      : "";
  return (
    <section className={`settings-view ${sectionClass}`}>
      <div className={`settings-view-inner ${props.section === "participants" ? "settings-view-inner-participants" : ""}`}>
        <div className="settings-view-head">
          <div className="settings-view-head-lead">
            {props.sidebarCollapsed && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Show sidebar"
                aria-label="Show sidebar"
                aria-controls="app-sidebar"
                aria-expanded="false"
                data-testid="sidebar-expand-toggle"
                onClick={props.onExpandSidebar}
              >
                <SidebarPanelIcon />
                <span className="sr-only">Show sidebar</span>
              </Button>
            )}
            <h1>{title}</h1>
          </div>
          <IconButton
            size="sm"
            icon={X}
            label="Close settings"
            tooltip="Close settings"
            variant="outline"
            onClick={props.onClose}
          />
        </div>
        {props.section === "roles" && (
          <RolesSettingsSection
            settings={props.settings}
            onSave={props.saveChatRoleConfig}
            onArchive={props.archiveChatRoleConfig}
          />
        )}
        {props.section === "participants" && (
          <ParticipantsSettingsScreen
            settings={props.settings}
            agents={props.agents}
            onSave={props.saveChatParticipantConfig}
            onDelete={props.deleteChatParticipantConfig}
          />
        )}
        {props.section === "behavior-rules" && (
          <BehaviorRuleSettingsSection
            settings={props.settings}
            onSave={props.saveChatBehaviorRuleConfig}
            onDelete={props.deleteChatBehaviorRuleConfig}
          />
        )}
        {props.section === "saved-prompts" && (
          <SavedPromptsSettingsSection
            settings={props.settings}
            onSave={props.saveChatSavedPromptConfig}
            onDelete={props.deleteChatSavedPromptConfig}
          />
        )}
        {props.section === "general" && (
          <GeneralSettingsSection
            providers={props.settings.providers}
            agents={props.agents}
            repoFileOpenAction={props.settings.repoFileOpenAction}
            cliAgentRunTimeoutMs={props.settings.cliAgentRunTimeoutMs}
            cloudRuns={props.settings.cloudRuns}
            updateProvider={props.updateProvider}
            setRepoFileOpenPreference={props.setRepoFileOpenPreference}
            setCliAgentRunTimeoutMs={props.setCliAgentRunTimeoutMs}
            saveCloudRunsSettings={props.saveCloudRunsSettings}
          />
        )}
      </div>
    </section>
  );
}
