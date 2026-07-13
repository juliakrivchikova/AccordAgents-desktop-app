import { useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  RefreshCw,
  Settings,
  Terminal
} from "lucide-react";

import type {
  AgentHealth,
  AgentReadinessState,
  AppSettings,
  ChatProviderKind
} from "../../../shared/types";
import {
  CLI_PROVIDER_DISPLAY_ORDER,
  cliProviderMetadata,
  deriveAgentReadiness,
  providerEnabled
} from "../../../shared/cliReadiness";

export function CliReadinessSetupPanel(props: {
  agents: AgentHealth[];
  settings: AppSettings;
  checking: boolean;
  onRefresh: () => Promise<AgentHealth[]>;
  onProviderReady: (kind: ChatProviderKind) => void;
  onOpenSettings: () => void;
}): JSX.Element {
  const [expandedKind, setExpandedKind] = useState<ChatProviderKind | undefined>();
  const [copiedValue, setCopiedValue] = useState<string | undefined>();
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
  const checking = props.checking || refreshing;

  async function copyCommand(command: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      setActionError(undefined);
      setCopiedValue(command);
      window.setTimeout(() => setCopiedValue((current) => current === command ? undefined : current), 1600);
    } catch {
      setActionError("Could not copy the command. Open the official guide instead.");
    }
  }

  async function checkAgain(kind: ChatProviderKind): Promise<void> {
    setRefreshing(true);
    setActionError(undefined);
    try {
      const agents = await props.onRefresh();
      const health = agents.find((agent) => agent.kind === kind);
      if (deriveAgentReadiness(health, providerEnabled(props.settings.providers, kind)) === "ready") {
        props.onProviderReady(kind);
      }
    } catch {
      setActionError("Could not check CLI readiness. Try again.");
    } finally {
      setRefreshing(false);
    }
  }

  async function refreshAll(): Promise<void> {
    setRefreshing(true);
    setActionError(undefined);
    try {
      await props.onRefresh();
    } catch {
      setActionError("Could not check CLI readiness. Try again.");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section className="cli-readiness-panel" data-testid="cli-readiness-panel">
      <div className="cli-readiness-heading">
        <div>
          <h2>Set up a CLI provider</h2>
          <p>AccordAgents uses a CLI already installed and signed in on this Mac. Choose any provider below.</p>
        </div>
        <button
          type="button"
          className="cli-readiness-secondary"
          disabled={checking}
          onClick={() => void refreshAll()}
        >
          <RefreshCw className={checking ? "spin" : undefined} size={15} aria-hidden />
          Check again
        </button>
      </div>

      <div className="cli-readiness-grid">
        {CLI_PROVIDER_DISPLAY_ORDER.map((kind) => {
          const metadata = cliProviderMetadata(kind);
          const health = props.agents.find((agent) => agent.kind === kind);
          const readiness = deriveAgentReadiness(health, providerEnabled(props.settings.providers, kind));
          const expanded = expandedKind === kind;
          return (
            <article className={`cli-readiness-card ${expanded ? "is-expanded" : ""}`} key={kind} data-provider-kind={kind}>
              <div className="cli-readiness-card-header">
                <div>
                  <h3>{metadata.label}</h3>
                  <span className={`cli-readiness-status is-${readiness}`}>
                    {health?.checking && readiness !== "checking" ? `${readinessLabel(readiness)} · Checking` : readinessLabel(readiness)}
                  </span>
                </div>
                <button
                  type="button"
                  className="cli-readiness-secondary"
                  onClick={() => setExpandedKind((current) => current === kind ? undefined : kind)}
                >
                  {expanded ? "Close" : actionLabel(readiness)}
                </button>
              </div>

              {expanded && (
                <div className="cli-readiness-steps">
                  {readiness === "disabled" ? (
                    <>
                      <p>This provider is disabled in AccordAgents.</p>
                      <button type="button" className="cli-readiness-primary" onClick={props.onOpenSettings}>
                        <Settings size={15} aria-hidden /> Enable in Settings
                      </button>
                    </>
                  ) : readiness === "ready" ? (
                    <p className="cli-readiness-ready"><Check size={15} aria-hidden /> Ready to use.</p>
                  ) : (
                    <>
                      {readiness === "not-detected" && (
                        <SetupCommand
                          label="Install"
                          command={health?.platform === "darwin" ? metadata.installCommandByPlatform.darwin : undefined}
                          copiedValue={copiedValue}
                          onCopy={copyCommand}
                        />
                      )}
                      {(readiness === "sign-in-required" || readiness === "could-not-verify") && (
                        <SetupCommand
                          label={readiness === "sign-in-required" ? "Sign in" : "Try sign-in"}
                          command={metadata.loginCommand}
                          copiedValue={copiedValue}
                          onCopy={copyCommand}
                        />
                      )}
                      <div className="cli-readiness-actions">
                        <button type="button" className="cli-readiness-secondary" onClick={() => void window.consensus.openTerminal().catch(() => setActionError("Could not open Terminal."))}>
                          <Terminal size={15} aria-hidden /> Open Terminal
                        </button>
                        <button type="button" className="cli-readiness-secondary" onClick={() => void window.consensus.openExternal(metadata.guideUrl).catch(() => setActionError("Could not open the official guide."))}>
                          <ExternalLink size={15} aria-hidden /> Official guide
                        </button>
                        <button type="button" className="cli-readiness-primary" disabled={checking} onClick={() => void checkAgain(kind)}>
                          <RefreshCw className={checking ? "spin" : undefined} size={15} aria-hidden /> Check again
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {actionError && <p className="inline-error cli-readiness-error">{actionError}</p>}
      <p className="cli-readiness-note">Commands are copied only when you choose Copy. AccordAgents never installs software or signs in for you.</p>
    </section>
  );
}

function SetupCommand(props: {
  label: string;
  command?: string;
  copiedValue?: string;
  onCopy: (command: string) => Promise<void>;
}): JSX.Element {
  if (!props.command) {
    return <p>Open the official guide for setup instructions on this platform.</p>;
  }
  return (
    <div className="cli-readiness-command">
      <strong>{props.label}</strong>
      <code>{props.command}</code>
      <button type="button" aria-label={`Copy ${props.label.toLowerCase()} command`} onClick={() => void props.onCopy(props.command as string)}>
        {props.copiedValue === props.command ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        {props.copiedValue === props.command ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function readinessLabel(readiness: AgentReadinessState): string {
  switch (readiness) {
    case "not-detected": return "Not detected";
    case "failed-to-run": return "Failed to run";
    case "sign-in-required": return "Sign-in required";
    case "could-not-verify": return "Could not verify";
    case "ready": return "Ready";
    case "disabled": return "Disabled";
    case "checking": return "Checking";
  }
}

function actionLabel(readiness: AgentReadinessState): string {
  if (readiness === "ready") return "Details";
  if (readiness === "disabled") return "Enable";
  if (readiness === "sign-in-required") return "Sign in";
  if (readiness === "not-detected") return "Set up";
  return "Troubleshoot";
}
