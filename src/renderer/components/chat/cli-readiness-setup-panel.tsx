import { useState, type ReactNode } from "react";
import { ArrowSquareOutIcon, ArrowsClockwiseIcon, GearSixIcon, ShieldCheckIcon, TerminalIcon } from "@phosphor-icons/react";

import type {
  AgentHealth,
  AgentReadinessState,
  AppSettings,
  ChatProviderKind,
  CliSignInKind,
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
import { Button } from "@/components/ui/button";
import { useDelayedFlag } from "@/components/ui/delayed";
import { Spinner } from "@/components/ui/spinner";
import { CopyButton } from "../primitives";
import { CliSignInStep, useCliSignIns } from "./cli-sign-in-step";
import { ProviderIcon } from "./provider-icon";

type ProviderMetadata = ReturnType<typeof cliProviderMetadata>;
type OnError = (message: string | undefined) => void;

/**
 * The New chat screen while no CLI is ready: one list, a row per CLI with its
 * state and its next step as one button at the row's end, and the Terminal
 * way under it (the User chose this layout, 2026-11-27).
 */
export function CliReadinessSetupPanel(props: {
  agents: AgentHealth[];
  settings: AppSettings;
  checking: boolean;
  onRefresh: () => Promise<AgentHealth[]>;
  onOpenSettings: () => void;
}): JSX.Element {
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
  const checking = props.checking || refreshing;
  // Disabled at once; the spinner only for a check that takes a while.
  const showSpinner = useDelayedFlag(checking);
  const { signIns, checkingAfterSignIn } = useCliSignIns(refreshAll);

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
        <h2>Connect a CLI</h2>
        <Button variant="ghost" size="xs" disabled={checking} onClick={() => void refreshAll()}>
          {showSpinner ? <Spinner size={14} /> : <ArrowsClockwiseIcon aria-hidden />}
          Check again
        </Button>
      </div>
      <p className="cli-readiness-hint">AccordAgents works through the CLIs installed and signed in on this computer.</p>
      <ul className="cli-readiness-list">
        {CLI_PROVIDER_DISPLAY_ORDER.map((kind) => {
          const health = props.agents.find((agent) => agent.kind === kind);
          const readiness = deriveAgentReadiness(health, providerEnabled(props.settings.providers, kind));
          return (
            <CliReadinessRow
              key={kind}
              kind={kind}
              metadata={cliProviderMetadata(kind)}
              health={health}
              readiness={readiness}
              signIn={isCliSignInKind(kind) ? signIns[kind] : undefined}
              checkingAfterSignIn={isCliSignInKind(kind) && Boolean(checkingAfterSignIn[kind])}
              onOpenSettings={props.onOpenSettings}
              onError={setActionError}
            />
          );
        })}
      </ul>
      {actionError && <p className="inline-error cli-readiness-error">{actionError}</p>}
      <p className="cli-readiness-note">
        <ShieldCheckIcon aria-hidden />
        <span>AccordAgents never installs software. Sign in runs the CLI's own sign-in, and the CLI keeps your credentials.</span>
      </p>
    </section>
  );
}

interface CliReadinessRowProps {
  kind: ChatProviderKind;
  metadata: ProviderMetadata;
  health?: AgentHealth;
  readiness: AgentReadinessState;
  signIn?: CliSignInState;
  checkingAfterSignIn: boolean;
  onOpenSettings: () => void;
  onError: OnError;
}

/** One CLI's row: what its state allows now, and nothing it does not. */
const CliReadinessRow = (props: CliReadinessRowProps): JSX.Element => {
  const { kind, metadata, readiness } = props;
  const row = (action?: ReactNode, detail?: ReactNode): JSX.Element => (
    <RowFrame kind={kind} label={metadata.label} status={<RowStatus readiness={readiness} health={props.health} />} action={action}>
      {detail}
    </RowFrame>
  );
  const terminal = <OpenTerminalButton look="action" onError={props.onError} />;
  const terminalLink = <OpenTerminalButton look="link" onError={props.onError} />;
  const guide = <GuideButton look="link" url={metadata.guideUrl} onError={props.onError} />;

  if (readiness === "ready" || readiness === "checking") return row();
  if (readiness === "disabled") {
    return row(<Button variant="outline" size="sm" onClick={props.onOpenSettings}><GearSixIcon aria-hidden />Enable in Settings</Button>);
  }

  const platform = props.health?.platform;
  const installCommand = isCliTerminalPlatform(platform) ? metadata.installCommandByPlatform[platform] : undefined;
  if (!isCliTerminalPlatform(platform) || (readiness === "not-detected" && !installCommand)) {
    return row(<GuideButton look="action" url={metadata.guideUrl} onError={props.onError} />, <span>No setup steps for this computer here; the guide has them.</span>);
  }
  if (readiness === "failed-to-run") {
    return row(terminal, <><span>Found, but it could not run. Check it in Terminal.</span>{guide}</>);
  }
  if (readiness === "not-detected") {
    return row(terminal, (
      <>
        <span>Install in Terminal: <Command command={installCommand ?? ""} label="install" /></span>
        {guide}
        <p>{postInstallStep(kind)}</p>
      </>
    ));
  }

  // Signed out, or its sign-in could not be checked: Claude Code and Codex
  // sign in from here, Antigravity only from Terminal.
  const tryOnly = readiness === "could-not-verify";
  const login = <Command command={metadata.loginCommand} label={tryOnly ? "try sign-in" : "sign-in"} />;
  const appSignIn: CliSignInKind | undefined = isCliSignInKind(kind) ? kind : undefined;
  if (!appSignIn) {
    return row(terminal, <><span>{tryOnly ? <>Try {login} in Terminal; sign in if it asks.</> : <>Run {login} in Terminal to sign in.</>}</span>{guide}</>);
  }
  return (
    <CliSignInStep kind={appSignIn} label={metadata.label} signIn={props.signIn} checkingAfterSignIn={props.checkingAfterSignIn} onError={props.onError}>
      {({ action, progress }) => row(action, (
        <>
          {progress}
          <span>Terminal: {login}</span>
          {terminalLink}
          {guide}
        </>
      ))}
    </CliSignInStep>
  );
};

const RowFrame = (props: { kind: ChatProviderKind; label: string; status: ReactNode; action?: ReactNode; children?: ReactNode }): JSX.Element => (
  <li className="cli-readiness-row" data-provider-kind={props.kind}>
    <div className="cli-readiness-row-main">
      <ProviderIcon className="chat-provider-icon is-large" kind={props.kind} label={props.label} />
      <div className="cli-readiness-row-text">
        <h3>{props.label}</h3>
        {props.status}
      </div>
      {props.action}
    </div>
    {props.children && <div className="cli-readiness-row-detail">{props.children}</div>}
  </li>
);

const STATUS: Record<AgentReadinessState, { tone: "ok" | "warning" | "danger" | "muted"; label: string }> = {
  "ready": { tone: "ok", label: "Ready" },
  "sign-in-required": { tone: "warning", label: "Not signed in" },
  "could-not-verify": { tone: "warning", label: "Could not verify sign-in" },
  "failed-to-run": { tone: "danger", label: "Failed to run" },
  "not-detected": { tone: "muted", label: "Not detected" },
  "disabled": { tone: "muted", label: "Disabled" },
  "checking": { tone: "muted", label: "Checking" }
};

const RowStatus = (props: { readiness: AgentReadinessState; health?: AgentHealth }): JSX.Element => {
  const { tone, label } = STATUS[props.readiness];
  const installed = props.readiness === "sign-in-required" && props.health?.installed;
  return (
    <span className={`cli-readiness-status is-${tone}`}>
      <span className="cli-readiness-status-dot" aria-hidden="true" />
      {installed ? "Installed, not signed in" : label}
      {props.health?.checking && props.readiness !== "checking" && ", checking"}
    </span>
  );
};

const Command = (props: { command: string; label: string }): JSX.Element => (
  <span className="cli-readiness-command">
    <code>{props.command}</code>
    <CopyButton text={props.command} label={`Copy ${props.label} command`} size="xs" />
  </span>
);

/** A row's next step at its end, or a quiet link in the line under it. */
type Look = "action" | "link";

const LookButton = (props: { look: Look; onClick: () => void; children: ReactNode }): JSX.Element => (
  props.look === "action"
    ? <Button variant="outline" size="sm" onClick={props.onClick}>{props.children}</Button>
    : <Button variant="link" size="xs" className="h-auto p-0 text-ui-12 text-ui-text-3 hover:text-ui-text [&_svg]:hidden" onClick={props.onClick}>{props.children}</Button>
);

const OpenTerminalButton = (props: { look: Look; onError: OnError }): JSX.Element => (
  <LookButton look={props.look} onClick={() => void window.consensus.openTerminal().catch(() => props.onError("Could not open Terminal."))}>
    <TerminalIcon aria-hidden />Open Terminal
  </LookButton>
);

const GuideButton = (props: { look: Look; url: string; onError: OnError }): JSX.Element => (
  <LookButton look={props.look} onClick={() => void window.consensus.openExternal(props.url).catch(() => props.onError("Could not open the official guide."))}>
    <ArrowSquareOutIcon aria-hidden />Official guide
  </LookButton>
);

function postInstallStep(kind: ChatProviderKind): string {
  if (kind === "gemini-cli") return "Then open Antigravity and sign in; it is found by itself.";
  if (kind === "codex-cli") return "Then sign in with codex; it is found by itself.";
  return "Then sign in from Terminal.";
}
