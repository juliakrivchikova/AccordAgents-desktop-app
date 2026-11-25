import { Fragment, useState } from "react";
import { Switch } from "@/components/ui/switch";

import type {
  AgentHealth,
  ChatProviderKind,
  NewChatDefaults,
  NewChatDefaultsUpdate,
  CliProviderHost,
  CliProviderHostUpdate,
  ChatPromptContextSettings,
  MobileControlSettings,
  ProviderKind,
  ProviderSettings,
  RepoFileExternalOpenAction,
  RepoFileOpenAction
} from "../../../shared/types";
import { BetaUpdatesRow } from "./beta-updates-row";
import { SpeechToTextRow } from "./speech-to-text-row";
import { ClaudeChromeRow } from "./claude-chrome-row";
import { DevicePairingSection } from "./device-pairing-section";
import { HubServerSection } from "./hub-server-section";
import { MachinesSection } from "./machines-section";
import { deriveAgentReadiness } from "../../../shared/cliReadiness";
import { EXTERNAL_OPEN_OPTIONS, FILE_OPEN_OPTIONS, FileOpenDropdown } from "./file-open-dropdown";
import { ProviderHostEditorDialog, ProviderHostRows, type ProviderHostEditorState } from "./provider-hosts-section";
import {
  AUTO_WATCH_WAKE_LIMIT_HELP,
  AutoWatchWakeLimitControl,
  CliAgentRunTimeoutControl,
  PARTICIPANT_REQUEST_DEPTH_HELP,
  PARTICIPANT_REQUEST_PROMPT_MAX_HELP,
  ParticipantRequestDepthControl,
  ParticipantRequestPromptMaxControl,
  PromptContextControl
} from "./general-settings-controls";
import { NewChatDefaultsRows, providerDisplayLabel } from "./new-chat-defaults-rows";

const SHOW_MACHINES_SETTINGS = false;

const CLI_ICON_URLS: Partial<Record<ProviderKind, string>> = {
  "codex-cli": new URL("../../assets/codex-cli.svg", import.meta.url).href,
  "claude-code": new URL("../../assets/claude-avatar.png", import.meta.url).href,
  "gemini-cli": new URL("../../assets/antigravity-logo.png", import.meta.url).href
};


export function GeneralSettingsSection(props: {
  providers: ProviderSettings[];
  cliProviderHosts: CliProviderHost[];
  saveCliProviderHost: (update: CliProviderHostUpdate) => Promise<void>;
  deleteCliProviderHost: (id: string) => Promise<void>;
  agents: AgentHealth[];
  assistantProviderKind?: ChatProviderKind;
  newChatDefaults?: NewChatDefaults;
  repoFileOpenAction?: RepoFileOpenAction;
  repoFileExternalOpenAction?: RepoFileExternalOpenAction;
  betaUpdates: boolean;
  crashReports: boolean;
  cliAgentRunTimeoutMs: number;
  chatParticipantRequestMaxDepth: number;
  chatParticipantRequestPromptMaxChars: number;
  chatAutoWatchWakeLimit: number;
  chatPromptContext: ChatPromptContextSettings;
  mobileControl?: MobileControlSettings;
  updateProvider: (provider: ProviderSettings, patch: { enabled?: boolean }) => Promise<void>;
  setAssistantProviderKind: (kind: ChatProviderKind) => Promise<void>;
  setNewChatDefaults: (update: NewChatDefaultsUpdate) => Promise<void>;
  setRepoFileOpenPreference: (action: RepoFileOpenAction | null) => Promise<void>;
  setRepoFileExternalOpenPreference: (action: RepoFileExternalOpenAction | null) => Promise<void>;
  setBetaUpdates: (enabled: boolean) => Promise<void>;
  setCrashReports: (enabled: boolean) => Promise<void>;
  setCliAgentRunTimeoutMs: (timeoutMs: number) => Promise<void>;
  setChatParticipantRequestMaxDepth: (maxDepth: number) => Promise<void>;
  setChatParticipantRequestPromptMaxChars: (maxChars: number) => Promise<void>;
  setChatAutoWatchWakeLimit: (limit: number) => Promise<void>;
  setChatPromptContext: (settings: ChatPromptContextSettings) => Promise<void>;
}): JSX.Element {
  const [hostEditor, setHostEditor] = useState<ProviderHostEditorState | undefined>();
  const readyCount = props.providers.filter(
    (provider) => deriveAgentReadiness(
      props.agents.find((agent) => agent.kind === provider.kind),
      provider.enabled
    ) === "ready"
  ).length + props.cliProviderHosts.filter(
    (host) => host.hasApiKey && deriveAgentReadiness(props.agents.find((agent) => agent.kind === host.cli)) === "ready"
  ).length;
  const totalCount = props.providers.length + props.cliProviderHosts.length;
  return (
    <>
      <section className="gen-section">
        <div className="gen-section-head">
          <h2 className="gen-section-title">Local CLI setup</h2>
          <span className="gen-section-meta">{readyCount} of {totalCount} ready</span>
        </div>
        <div className="gen-card">
          <ProviderHostEditorDialog
            editor={hostEditor}
            hosts={props.cliProviderHosts}
            onSave={props.saveCliProviderHost}
            onDelete={props.deleteCliProviderHost}
            onClose={() => setHostEditor(undefined)}
          />
          {props.providers.map((provider, index) => {
            const health = props.agents.find((agent) => agent.kind === provider.kind);
            const iconUrl = CLI_ICON_URLS[provider.kind];
            const displayLabel = providerDisplayLabel(provider);
            return (
              <Fragment key={provider.kind}>
                {index > 0 && <div className="gen-card-divider" />}
                <div className="gen-cli-row" data-provider-kind={provider.kind}>
                  <span className={`gen-cli-icon gen-cli-icon-${provider.kind}${provider.kind === "claude-code" ? " gen-cli-icon-full" : ""}`}>
                    {iconUrl ? <img src={iconUrl} alt="" /> : null}
                  </span>
                  <div className="gen-cli-text">
                    <div className="gen-cli-name">{displayLabel}</div>
                    <div className="gen-cli-sub">{healthLine(provider.enabled, health)}</div>
                  </div>
                  <Switch
                    data-testid={`provider-toggle-${provider.kind}`}
                    checked={provider.enabled}
                    onChange={(event) => void props.updateProvider(provider, { enabled: event.target.checked })}
                  />
                </div>
              </Fragment>
            );
          })}
          <ProviderHostRows
            hosts={props.cliProviderHosts}
            agents={props.agents}
            onAdd={() => setHostEditor({ type: "create" })}
            onEdit={(host) => setHostEditor({ type: "edit", host })}
          />
          <ClaudeChromeRow />
        </div>
      </section>

      <section className="gen-section" data-testid="new-chats-section">
        <h2 className="gen-section-title gen-section-title-solo">New chats</h2>
        <div className="gen-card">
          <NewChatDefaultsRows
            providers={props.providers}
            agents={props.agents}
            assistantProviderKind={props.assistantProviderKind}
            newChatDefaults={props.newChatDefaults}
            setAssistantProviderKind={props.setAssistantProviderKind}
            setNewChatDefaults={props.setNewChatDefaults}
          />
        </div>
      </section>

      <section className="gen-section">
        <h2 className="gen-section-title gen-section-title-solo">General</h2>
        <div className="gen-card">
          <div className="gen-row">
            <div className="gen-row-text">
              <div className="gen-row-title">Default file open destination</div>
              <div className="gen-row-desc">
                What happens when you click an inside-workspace file reference in chat.
              </div>
            </div>
            <FileOpenDropdown options={FILE_OPEN_OPTIONS} action={props.repoFileOpenAction ?? null} ariaLabel="Default file open destination" onChange={props.setRepoFileOpenPreference} />
          </div>
          <div className="gen-card-divider" />
          <div className="gen-row">
            <div className="gen-row-text">
              <div className="gen-row-title">Open files outside the side panel</div>
              <div className="gen-row-desc">
                The side panel’s Open button, and files the panel does not show (spreadsheets, archives, installers).
              </div>
            </div>
            <FileOpenDropdown
              options={EXTERNAL_OPEN_OPTIONS}
              action={props.repoFileExternalOpenAction ?? null}
              ariaLabel="Open files outside the side panel"
              onChange={async (action) => {
                await props.setRepoFileExternalOpenPreference(action === "open" || action === "intellij-idea" ? action : null);
              }}
            />
          </div>
          <SpeechToTextRow />
          <BetaUpdatesRow enabled={props.betaUpdates} onChange={props.setBetaUpdates} />
          <div className="gen-card-divider" />
          <div className="gen-row">
            <div className="gen-row-text">
              <div className="gen-row-title">Crash and usage reports</div>
              <div className="gen-row-desc">
                Send error reports (the error, the app version and your operating system) and usage statistics to Sentry: active installs, operating system and language, which supported CLIs are set up, which first steps you have reached (like your first chat), which features you use (like roles and documents), how many members and roles you have, and which model providers you connect. Each record carries a random ID kept on this computer, so records of one installation can be tied together. Usage statistics never include your messages, code, file names or keys; in error reports, file paths, links and secrets are masked and error text is cut to 300 characters. Turning on applies on next restart.
              </div>
            </div>
            <Switch
              data-testid="crash-reports-toggle"
              checked={props.crashReports}
              onChange={(event) => void props.setCrashReports(event.target.checked)}
            />
          </div>
          <div className="gen-card-divider" />
          <div className="gen-row">
            <div className="gen-row-text">
              <div className="gen-row-title">Run timeout</div>
              <div className="gen-row-desc">Automatically stop an agent run after this many hours.</div>
            </div>
            <CliAgentRunTimeoutControl timeoutMs={props.cliAgentRunTimeoutMs} onChange={props.setCliAgentRunTimeoutMs} />
          </div>
          <div className="gen-card-divider" />
          <div className="gen-row">
            <div className="gen-row-text">
              <div className="gen-row-title">Prompt context</div>
              <div className="gen-row-desc">
                Automatically include unseen chat messages when an agent starts. Set Thread and Timeline to Off or 0 to send only the message that started the run.
              </div>
            </div>
            <PromptContextControl settings={props.chatPromptContext} onChange={props.setChatPromptContext} />
          </div>
          <div className="gen-card-divider" />
          <div className="gen-row">
            <div className="gen-row-text">
              <div className="gen-row-title" title={AUTO_WATCH_WAKE_LIMIT_HELP}>Auto-watch run limit</div>
              <div className="gen-row-desc">
                {AUTO_WATCH_WAKE_LIMIT_HELP}
              </div>
            </div>
            <AutoWatchWakeLimitControl
              limit={props.chatAutoWatchWakeLimit}
              onChange={props.setChatAutoWatchWakeLimit}
            />
          </div>
          <div className="gen-card-divider" />
          <div className="gen-row">
            <div className="gen-row-text">
              <div className="gen-row-title" title={PARTICIPANT_REQUEST_DEPTH_HELP}>Member request depth</div>
              <div className="gen-row-desc">
                {PARTICIPANT_REQUEST_DEPTH_HELP} Use 1 to prevent requested members from asking others.
              </div>
            </div>
            <ParticipantRequestDepthControl
              maxDepth={props.chatParticipantRequestMaxDepth}
              onChange={props.setChatParticipantRequestMaxDepth}
            />
          </div>
          <div className="gen-card-divider" />
          <div className="gen-row">
            <div className="gen-row-text">
              <div className="gen-row-title" title={PARTICIPANT_REQUEST_PROMPT_MAX_HELP}>Member request prompt limit</div>
              <div className="gen-row-desc">
                {PARTICIPANT_REQUEST_PROMPT_MAX_HELP}
              </div>
            </div>
            <ParticipantRequestPromptMaxControl
              maxChars={props.chatParticipantRequestPromptMaxChars}
              onChange={props.setChatParticipantRequestPromptMaxChars}
            />
          </div>
        </div>
      </section>

      <HubServerSection />

      <DevicePairingSection mobileControl={props.mobileControl} />

      {SHOW_MACHINES_SETTINGS && <MachinesSection />}
    </>
  );
}


function healthLine(enabled: boolean, health: AgentHealth | undefined): string {
  const readiness = deriveAgentReadiness(health, enabled);
  const status = readiness === "not-detected"
    ? "Not detected"
    : readiness === "failed-to-run"
      ? "Failed to run"
      : readiness === "sign-in-required"
        ? "Sign-in required"
        : readiness === "could-not-verify"
          ? "Could not verify"
          : readiness === "disabled"
            ? "Disabled"
            : readiness === "checking"
              ? "Checking"
              : "Ready";
  const stable = health?.version && readiness === "ready" ? `${status} · ${health.version}` : status;
  const base = health?.checking && readiness !== "checking" ? `${stable} · Checking` : stable;
  const syncIssue = appSkillSyncIssueLine(health?.appSkillSync);
  return syncIssue ? `${base} · ${syncIssue}` : base;
}

function appSkillSyncIssueLine(sync: AgentHealth["appSkillSync"]): string | undefined {
  if (!sync || sync.status === "not-installed" || sync.status === "synced" || sync.status === "skipped") {
    return undefined;
  }
  if (sync.status === "collision") {
    return sync.message ?? "App skill collision";
  }
  return sync.message ?? "App skill sync failed";
}
