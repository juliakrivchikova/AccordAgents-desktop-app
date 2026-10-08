import { useState } from "react";
import type { AwsWorkerStatus } from "../../../shared/types";
import { AwsWaiting } from "./aws-dialog";
import type { AwsMachineRuntime } from "./use-aws-machine-runtime";
import { cleanError } from "./aws-shared";
import { Row } from "./aws-row";

/** "the machine's disk is full" reads as a sentence end in "failed: …". */
export function updateFailureText(target: string | undefined, reason: string | undefined): string {
  const cause = (reason ?? "").trim().replace(/^Runtime (update|setup) failed:\s*/i, "").replace(/\.+$/, "");
  const lead = target ? `The update to ${target} failed` : "The last update failed";
  if (!cause) return `${lead}.`;
  // "The update failed: npm…", but "…failed: SSH…" keeps its capitals.
  const first = cause.length > 1 && cause[1] === cause[1].toLowerCase() ? cause[0].toLowerCase() : cause[0];
  return `${lead}: ${first}${cause.slice(1)}.`;
}

/**
 * The program this desktop runs on the instance: which version it is, an
 * update in progress, waiting, or failed (with its cause and a retry), and
 * whether it is connected to this computer.
 */
export function AwsProgramSection(props: {
  status: AwsWorkerStatus;
  runtime: AwsMachineRuntime;
  onStatus: (status: AwsWorkerStatus) => void;
}): JSX.Element {
  const { status, runtime } = props;
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string>();
  const running = status.state === "running";
  const version = runtime.runningVersion;
  const title = version ? `Version ${version}` : runtime.machine ? "Version unknown" : "Not installed yet";
  const retry = async (): Promise<void> => {
    if (!runtime.machine) return;
    setRetrying(true);
    setRetryError(undefined);
    try { props.onStatus(await window.consensus.reconnectAwsMachine(runtime.machine.id)); }
    catch (cause) { setRetryError(cleanError(cause)); }
    finally { setRetrying(false); }
  };

  let versionRow: JSX.Element;
  if (!running) {
    versionRow = <Row title={title} desc={runtime.machine ? "Starts with the instance." : "Installed when a member first works in the cloud."} />;
  } else if (retrying || runtime.runtime?.state === "updating") {
    versionRow = <Row title={title} desc={<AwsWaiting>{runtime.runtime?.state === "updating" ? runtime.runtime.text : "Retrying the update…"}</AwsWaiting>} />;
  } else if (runtime.runtime?.state === "failed") {
    versionRow = (
      <Row title={title} testId="aws-program-version"
        error={[updateFailureText(runtime.desktopVersion, runtime.failure ?? runtime.runtime.text), retryError].filter(Boolean).join(" ")}
        action={runtime.machine ? { label: "Retry update", onClick: () => void retry(), testId: "aws-program-retry" } : undefined} />
    );
  } else if (runtime.runtime?.state === "pending") {
    versionRow = <Row title={title} testId="aws-program-version"
      desc={runtime.desktopVersion ? `Update to ${runtime.desktopVersion} waits until no agent is working; it installs by itself.` : runtime.runtime.text} />;
  } else {
    versionRow = <Row title={title} testId="aws-program-version"
      desc={runtime.machine ? "Up to date. Updates install by themselves when no agent is working." : "Installed when a member first works in the cloud."} />;
  }

  const connection = !running ? undefined
    : runtime.link?.connected ? { desc: "Connected to this computer." }
      : runtime.unavailable ? { error: "The connection could not be checked." }
        : !runtime.loaded ? { desc: <AwsWaiting>Checking the connection…</AwsWaiting> }
          : runtime.machine ? { desc: <AwsWaiting>Reconnecting to this computer…</AwsWaiting> }
            : { desc: "Not set up yet. It sets itself up when you choose this instance in a member's settings." };
  return (
    <section className="gen-section">
      <h2 className="gen-section-title gen-section-title-solo">Cloud program</h2>
      <div className="gen-card">
        {versionRow}
        {connection ? (
          <>
            <div className="gen-card-divider" />
            <Row title="Connection" testId="aws-cloud-run-readiness" desc={connection.desc}
              error={[connection.error, status.machineProblem].filter(Boolean).join(" ") || undefined} />
          </>
        ) : null}
      </div>
    </section>
  );
}
