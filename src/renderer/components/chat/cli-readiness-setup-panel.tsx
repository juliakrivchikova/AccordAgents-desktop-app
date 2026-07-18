import { useEffect, useRef, useState } from "react";
import {
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  RefreshCw,
  Settings,
  ShieldCheck,
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
  onOpenSettings: () => void;
}): JSX.Element {
  const [expandedKind, setExpandedKind] = useState<ChatProviderKind | undefined>(
    () => defaultExpandedProviderKind(props.agents, props.settings)
  );
  const didResolveInitialExpansionRef = useRef(expandedKind !== undefined);
  const [copiedValue, setCopiedValue] = useState<string | undefined>();
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
  const checking = props.checking || refreshing;

  useEffect(() => {
    if (didResolveInitialExpansionRef.current) {
      return;
    }
    const nextExpandedKind = defaultExpandedProviderKind(props.agents, props.settings);
    if (!nextExpandedKind) {
      return;
    }
    didResolveInitialExpansionRef.current = true;
    setExpandedKind((current) => current ?? nextExpandedKind);
  }, [props.agents, props.settings]);

  function toggleProvider(kind: ChatProviderKind): void {
    didResolveInitialExpansionRef.current = true;
    setExpandedKind((current) => current === kind ? undefined : kind);
  }

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
          <h2>Connect a CLI provider</h2>
          <p>AccordAgents uses a CLI you've already installed and signed in on this Mac.</p>
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
            <article className={`cli-readiness-card is-${kind} ${expanded ? "is-expanded" : ""}`} key={kind} data-provider-kind={kind}>
              <div className="cli-readiness-card-header">
                <ProviderIcon kind={kind} label={metadata.label} />
                <div className="cli-readiness-provider-copy">
                  <h3>{metadata.label}</h3>
                  <span className={`cli-readiness-status is-${readiness}`}>
                    <span className="cli-readiness-status-dot" aria-hidden="true" />
                    <span>{readinessStatusLabel(readiness, health)}</span>
                    {health?.checking && readiness !== "checking" && <span> · Checking</span>}
                  </span>
                </div>
                <button
                  type="button"
                  className="cli-readiness-toggle"
                  aria-label={`${expanded ? "Hide" : "Set up"} ${metadata.label}`}
                  aria-expanded={expanded}
                  title={expanded ? "Hide" : "Set up"}
                  onClick={() => toggleProvider(kind)}
                >
                  {expanded ? <ChevronUp size={17} aria-hidden /> : <ChevronDown size={17} aria-hidden />}
                </button>
              </div>

              {expanded && (
                <CliReadinessDetails
                  kind={kind}
                  metadata={metadata}
                  health={health}
                  readiness={readiness}
                  copiedValue={copiedValue}
                  onCopy={copyCommand}
                  onOpenSettings={props.onOpenSettings}
                  onError={setActionError}
                />
              )}
            </article>
          );
        })}
      </div>
      {actionError && <p className="inline-error cli-readiness-error">{actionError}</p>}
      <p className="cli-readiness-note">
        <ShieldCheck size={15} aria-hidden />
        <span>Commands are copied only when you choose <strong>Copy</strong>. AccordAgents never installs software or signs in for you.</span>
      </p>
    </section>
  );
}

function ProviderIcon(props: {
  kind: ChatProviderKind;
  label: string;
}): JSX.Element {
  return (
    <span className="cli-readiness-provider-icon" role="img" aria-label={props.label}>
      {props.kind === "gemini-cli"
        ? <span className="cli-readiness-antigravity-mark" aria-hidden="true" />
        : props.kind === "codex-cli"
          ? <CodexGlyph />
          : <span className="cli-readiness-claude-mark" aria-hidden="true" />}
    </span>
  );
}

function CliReadinessDetails(props: {
  kind: ChatProviderKind;
  metadata: ReturnType<typeof cliProviderMetadata>;
  health?: AgentHealth;
  readiness: AgentReadinessState;
  copiedValue?: string;
  onCopy: (command: string) => Promise<void>;
  onOpenSettings: () => void;
  onError: (message: string | undefined) => void;
}): JSX.Element {
  const supportedPlatform = props.health?.platform === "darwin";
  const installCommand = supportedPlatform ? props.metadata.installCommandByPlatform.darwin : undefined;

  if (props.readiness === "disabled") {
    return (
      <div className="cli-readiness-steps">
        <p>This provider is disabled in AccordAgents.</p>
        <button type="button" className="cli-readiness-settings-action" onClick={props.onOpenSettings}>
          <Settings size={15} aria-hidden /> Enable in Settings
        </button>
      </div>
    );
  }

  if (props.readiness === "ready") {
    return (
      <div className="cli-readiness-steps">
        <p className="cli-readiness-ready"><Check size={15} aria-hidden /> Ready to use.</p>
      </div>
    );
  }

  if (!supportedPlatform) {
    return (
      <div className="cli-readiness-steps">
        <p>Open the official guide for setup instructions on this platform.</p>
        <button
          type="button"
          className="cli-readiness-settings-action"
          onClick={() => void window.consensus.openExternal(props.metadata.guideUrl).catch(() => props.onError("Could not open the official guide."))}
        >
          <ExternalLink size={15} aria-hidden /> Official guide
        </button>
      </div>
    );
  }

  if (props.readiness === "failed-to-run") {
    return (
      <div className="cli-readiness-steps">
        <p>The CLI was found, but AccordAgents could not run it. Open Terminal to check the command, then use the official guide if it still fails.</p>
        <CliReadinessActionButtons guideUrl={props.metadata.guideUrl} onError={props.onError} />
      </div>
    );
  }

  if (props.readiness === "not-detected") {
    return (
      <div className="cli-readiness-steps">
        <SetupStep number={1}>Install the CLI in Terminal</SetupStep>
        <SetupCommand
          command={installCommand}
          copiedValue={props.copiedValue}
          label="install"
          onCopy={props.onCopy}
        />
        <SetupStep number={2}>{postInstallStepLabel(props.kind)}</SetupStep>
        <CliReadinessActionButtons guideUrl={props.metadata.guideUrl} onError={props.onError} />
      </div>
    );
  }

  return (
    <div className="cli-readiness-steps">
      <SetupStep number={1} done>Install the CLI in Terminal</SetupStep>
      <SetupStep number={2}>
        {props.readiness === "could-not-verify" ? "Try sign-in from Terminal" : "Sign in from Terminal"}
      </SetupStep>
      <SetupCommand
        command={props.metadata.loginCommand}
        copiedValue={props.copiedValue}
        label={props.readiness === "could-not-verify" ? "try sign-in" : "sign-in"}
        onCopy={props.onCopy}
      />
      <CliReadinessActionButtons guideUrl={props.metadata.guideUrl} onError={props.onError} />
    </div>
  );
}

function CliReadinessActionButtons(props: {
  guideUrl: string;
  onError: (message: string | undefined) => void;
}): JSX.Element {
  return (
    <div className="cli-readiness-detail-actions">
      <button
        type="button"
        className="cli-readiness-detail-action"
        onClick={() => void window.consensus.openTerminal().catch(() => props.onError("Could not open Terminal."))}
      >
        <Terminal size={15} aria-hidden /> Open Terminal
      </button>
      <button
        type="button"
        className="cli-readiness-detail-action"
        onClick={() => void window.consensus.openExternal(props.guideUrl).catch(() => props.onError("Could not open the official guide."))}
      >
        <ExternalLink size={15} aria-hidden /> Official guide
      </button>
    </div>
  );
}

function SetupStep(props: {
  children: string;
  done?: boolean;
  number: number;
}): JSX.Element {
  return (
    <div className="cli-readiness-step">
      <span className="cli-readiness-step-number">{props.number}</span>
      <span>{props.children}</span>
      {props.done && <CheckCheck className="cli-readiness-step-done" size={17} aria-label="Done" />}
    </div>
  );
}

function SetupCommand(props: {
  command?: string;
  copiedValue?: string;
  label: string;
  onCopy: (command: string) => Promise<void>;
}): JSX.Element {
  if (!props.command) {
    return <p>Open the official guide for setup instructions on this platform.</p>;
  }
  return (
    <div className="cli-readiness-command">
      <code><span aria-hidden="true">$</span> {props.command}</code>
      <button type="button" aria-label={`Copy ${props.label} command`} title="Copy command" onClick={() => void props.onCopy(props.command as string)}>
        {props.copiedValue === props.command ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </button>
    </div>
  );
}

function readinessStatusLabel(readiness: AgentReadinessState, health: AgentHealth | undefined): JSX.Element | string {
  switch (readiness) {
    case "not-detected": return "Not detected";
    case "failed-to-run": return "Failed to run";
    case "sign-in-required": return <>{health?.installed ? "Installed · " : ""}<strong>sign-in required</strong></>;
    case "could-not-verify": return "Could not verify";
    case "ready": return "Ready";
    case "disabled": return "Disabled";
    case "checking": return "Checking";
  }
}

function postInstallStepLabel(kind: ChatProviderKind): string {
  if (kind === "gemini-cli") return "Open Antigravity and sign in — then it's detected automatically.";
  if (kind === "codex-cli") return "Sign in with codex — then it's detected automatically.";
  return "Sign in from Terminal";
}

function defaultExpandedProviderKind(agents: AgentHealth[], settings: AppSettings): ChatProviderKind | undefined {
  return CLI_PROVIDER_DISPLAY_ORDER.find((kind) => {
    const readiness = deriveAgentReadiness(
      agents.find((agent) => agent.kind === kind),
      providerEnabled(settings.providers, kind)
    );
    return readiness === "sign-in-required" || readiness === "could-not-verify" || readiness === "failed-to-run";
  });
}

function CodexGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="cli-readiness-codex-gradient" x1="12" x2="12" y1="0" y2="24" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--provider-setup-codex-gradient-top)" />
          <stop offset=".5" stopColor="var(--provider-setup-codex-gradient-mid)" />
          <stop offset="1" stopColor="var(--provider-setup-codex-gradient-bottom)" />
        </linearGradient>
      </defs>
      <path
        fill="url(#cli-readiness-codex-gradient)"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
      />
    </svg>
  );
}
