import { useEffect } from "react";
import type { CloudRunsSettings } from "../../../shared/types";
import { AwsConnectSection } from "./aws-connect-section";
import { AwsWaiting } from "./aws-dialog";
import { AwsDiskSection } from "./aws-disk-section";
import { AwsInstanceSection } from "./aws-instance-section";
import { AwsProgramSection } from "./aws-program-section";
import { Row } from "./aws-row";
import { AwsSetupSection } from "./aws-setup-section";
import { AwsStatusSection } from "./aws-status-section";
import { clearAwsAttention, publishAwsAttention } from "./use-aws-attention";
import { useAwsMachineRuntime } from "./use-aws-machine-runtime";
import { useAwsWorkerControl } from "./use-aws-worker-control";

/**
 * Settings → AWS: the instance, the program on it, the instance itself, its
 * disk and what the agents need on it, as sections like General's. Problems
 * show in the section they belong to; the page checks things by itself.
 */
export function AwsSettingsPage(props: { settings: CloudRunsSettings; onDeleted: () => Promise<void> }): JSX.Element {
  const control = useAwsWorkerControl(props.settings, props.onDeleted);
  const runtime = useAwsMachineRuntime(control.status);
  const status = control.status;
  const programFailed = runtime.runtime?.state === "failed";
  useEffect(() => { publishAwsAttention("program", status?.state === "running" && programFailed); }, [status?.state, programFailed]);
  useEffect(() => { if (status && !status.configured) clearAwsAttention(); }, [status]);
  if (!status) {
    return (
      <section className="gen-section">
        <div className="gen-card">
          <Row title="AWS instance" desc={control.monitor.error ? undefined : <AwsWaiting>Checking the instance…</AwsWaiting>} error={control.monitor.error} />
        </div>
      </section>
    );
  }
  if (!control.configured) return <AwsConnectSection control={control} hasCredentials={props.settings.hasAwsCredentials} />;
  return (
    <div className="gen-aws-page" data-testid="machine-instance-settings">
      <AwsStatusSection control={control} />
      <AwsProgramSection status={status} runtime={runtime} onStatus={control.monitor.accept} />
      <AwsInstanceSection control={control} />
      <AwsDiskSection control={control} />
      <AwsSetupSection running={status.state === "running"} instanceId={control.actual?.instanceId ?? status.handle?.instanceId} />
    </div>
  );
}
