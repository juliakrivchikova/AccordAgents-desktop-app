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
  ChatProviderKind,
  CliSignInState
} from "../../../shared/types";
import {
  CLI_PROVIDER_DISPLAY_ORDER,
  cliProviderMetadata,
  deriveAgentReadiness,
  isCliSignInKind,
  isCliTerminalPlatform,
  providerEnabled
} from "../../../shared/cliReadiness";
import { IconButton } from "../primitives";
import { CliSignInStep, useCliSignIns } from "./cli-sign-in-step";
import { ProviderIcon } from "./provider-icon";

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
  const { signIns, checkingAfterSignIn } = useCliSignIns(refreshAll);

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
          <p>AccordAgents uses a CLI you've already installed and signed in on this computer.</p>
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
                <IconButton
                  className="cli-readiness-toggle"
                  label={`${expanded ? "Hide" : "Set up"} ${metadata.label}`}
                  icon={expanded ? ChevronUp : ChevronDown}
                  aria-expanded={expanded}
                  onClick={() => toggleProvider(kind)}
                />
              </div>

              {expanded && (
                <CliReadinessDetails
                  kind={kind}
                  metadata={metadata}
                  health={health}
                  readiness={readiness}
                  copiedValue={copiedValue}
                  signIn={isCliSignInKind(kind) ? signIns[kind] : undefined}
                  checkingAfterSignIn={isCliSignInKind(kind) && Boolean(checkingAfterSignIn[kind])}
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
        <span>AccordAgents never installs software. <strong>Sign in</strong> runs the CLI's own sign-in; the CLI keeps your credentials.</span>
      </p>
    </section>
  );
}

function CliReadinessDetails(props: {
  kind: ChatProviderKind;
  metadata: ReturnType<typeof cliProviderMetadata>;
  health?: AgentHealth;
  readiness: AgentReadinessState;
  copiedValue?: string;
  signIn?: CliSignInState;
  checkingAfterSignIn: boolean;
  onCopy: (command: string) => Promise<void>;
  onOpenSettings: () => void;
  onError: (message: string | undefined) => void;
}): JSX.Element {
  const platform = props.health?.platform;
  const supportedPlatform = isCliTerminalPlatform(platform);
  const installCommand = supportedPlatform ? props.metadata.installCommandByPlatform[platform] : undefined;

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

  if (!supportedPlatform || (props.readiness === "not-detected" && !installCommand)) {
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

  // Claude Code and Codex sign in from here; Antigravity only from its app.
  const appSignIn = isCliSignInKind(props.kind) ? props.kind : undefined;
  const tryOnly = props.readiness === "could-not-verify";
  return (
    <div className="cli-readiness-steps">
      <SetupStep number={1} done>Install the CLI in Terminal</SetupStep>
      <SetupStep number={2}>
        {appSignIn ? (tryOnly ? "Try signing in with your browser" : "Sign in with your browser") : tryOnly ? "Try sign-in from Terminal" : "Sign in from Terminal"}
      </SetupStep>
      {appSignIn && (
        <CliSignInStep kind={appSignIn} label={props.metadata.label} signIn={props.signIn} checkingAfterSignIn={props.checkingAfterSignIn} onError={props.onError} />
      )}
      {appSignIn && <p className="cli-sign-in-fallback">Or in Terminal:</p>}
      <SetupCommand
        command={props.metadata.loginCommand}
        copiedValue={props.copiedValue}
        label={tryOnly ? "try sign-in" : "sign-in"}
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
      <IconButton
        size="xs"
        label={`Copy ${props.label} command`}
        tooltip={props.copiedValue === props.command ? "Copied" : "Copy"}
        icon={props.copiedValue === props.command ? Check : Copy}
        onClick={() => void props.onCopy(props.command as string)}
      />
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
