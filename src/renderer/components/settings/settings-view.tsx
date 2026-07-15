import { type ReactNode, useState } from "react";
import type {
  AgentEnvironmentSnapshot,
  AgentHealth,
  AppSettings,
  ChatBehaviorRuleConfigUpdate,
  ChatParticipantConfigUpdate,
  ChatProviderKind,
  ChatPromptContextSettings,
  ChatRoleConfigUpdate,
  ChatSavedPromptConfigUpdate,
  CloudRunsSettingsUpdate,
  DeleteAgentEnvironmentVariableRequest,
  PluginCatalogItem,
  ProviderSettings,
  RepoFileOpenAction,
  SaveAgentEnvironmentVariableRequest
} from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { IconButton } from "../primitives";
import { SidebarPanelIcon } from "../shell/sidebar-panel-icon";
import { ParticipantsSettingsScreen } from "./participants-settings-screen";
import { RolesSettingsSection } from "./roles-settings-section";
import { GeneralSettingsSection } from "./general-settings-section";
import { BehaviorRuleSettingsSection } from "./behavior-rules-settings-section";
import { SavedPromptsSettingsSection } from "./saved-prompts-settings-section";
import { EnvironmentSettingsSection } from "./environment-settings-section";
import { PluginsSettingsSection } from "./plugins/plugins-settings-section";
import { X } from "lucide-react";

export type SettingsSection = "general" | "environment" | "roles" | "behavior-rules" | "saved-prompts" | "participants" | "plugins";

export function SettingsView(props: {
  section: SettingsSection;
  settings: AppSettings;
  agents: AgentHealth[];
  updateProvider: (provider: ProviderSettings, patch: { enabled?: boolean }) => Promise<void>;
  setAssistantProviderKind: (kind: ChatProviderKind) => Promise<void>;
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
  setChatParticipantRequestMaxDepth: (maxDepth: number) => Promise<void>;
  setChatParticipantRequestPromptMaxChars: (maxChars: number) => Promise<void>;
  setChatAutoWatchWakeLimit: (limit: number) => Promise<void>;
  setChatPromptContext: (settings: ChatPromptContextSettings) => Promise<void>;
  saveCloudRunsSettings: (update: CloudRunsSettingsUpdate) => Promise<void>;
  getAgentEnvironment: () => Promise<AgentEnvironmentSnapshot>;
  saveAgentEnvironmentVariable: (request: SaveAgentEnvironmentVariableRequest) => Promise<AgentEnvironmentSnapshot>;
  deleteAgentEnvironmentVariable: (request: DeleteAgentEnvironmentVariableRequest) => Promise<AgentEnvironmentSnapshot>;
  onTryPluginInChat: (plugin: PluginCatalogItem) => void;
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  onClose: () => void;
}): JSX.Element {
  const [pluginHeaderAction, setPluginHeaderAction] = useState<ReactNode>();
  const title = props.section === "general"
    ? "General"
    : props.section === "environment"
      ? "Environment"
      : props.section === "roles"
        ? "Roles"
        : props.section === "behavior-rules"
          ? "Rules"
          : props.section === "saved-prompts"
            ? "Prompts"
            : props.section === "plugins" ? "Plugins & Skills" : "Members";
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
          <div className="settings-view-head-actions">
            {props.section === "plugins" && pluginHeaderAction}
            <IconButton
              size="sm"
              icon={X}
              label="Close settings"
              tooltip="Close settings"
              variant="ghost"
              onClick={props.onClose}
            />
          </div>
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
        {props.section === "environment" && (
          <EnvironmentSettingsSection
            getAgentEnvironment={props.getAgentEnvironment}
            saveAgentEnvironmentVariable={props.saveAgentEnvironmentVariable}
            deleteAgentEnvironmentVariable={props.deleteAgentEnvironmentVariable}
          />
        )}
        {props.section === "plugins" && (
          <PluginsSettingsSection
            repoPath={props.settings.lastRepoPath}
            onTryPluginInChat={props.onTryPluginInChat}
            onHeaderActionChange={setPluginHeaderAction}
          />
        )}
        {props.section === "general" && (
          <GeneralSettingsSection
            providers={props.settings.providers}
            agents={props.agents}
            assistantProviderKind={props.settings.assistantProviderKind}
            repoFileOpenAction={props.settings.repoFileOpenAction}
            cliAgentRunTimeoutMs={props.settings.cliAgentRunTimeoutMs}
            chatParticipantRequestMaxDepth={props.settings.chatParticipantRequestMaxDepth}
            chatParticipantRequestPromptMaxChars={props.settings.chatParticipantRequestPromptMaxChars}
            chatAutoWatchWakeLimit={props.settings.chatAutoWatchWakeLimit}
            chatPromptContext={props.settings.chatPromptContext}
            updateProvider={props.updateProvider}
            setAssistantProviderKind={props.setAssistantProviderKind}
            setRepoFileOpenPreference={props.setRepoFileOpenPreference}
            setCliAgentRunTimeoutMs={props.setCliAgentRunTimeoutMs}
            setChatParticipantRequestMaxDepth={props.setChatParticipantRequestMaxDepth}
            setChatParticipantRequestPromptMaxChars={props.setChatParticipantRequestPromptMaxChars}
            setChatAutoWatchWakeLimit={props.setChatAutoWatchWakeLimit}
            setChatPromptContext={props.setChatPromptContext}
            cloudRuns={props.settings.cloudRuns}
            saveCloudRunsSettings={props.saveCloudRunsSettings}
          />
        )}
      </div>
    </section>
  );
}
