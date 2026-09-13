import { useState } from "react";
import type { AwsWorkerActualSpec, AwsWorkerSpec } from "../../../shared/types";
import { AWS_WORKER_INSTANCE_TYPE_OPTIONS, AWS_WORKER_ROOT_VOLUME_SIZE_GB_MAX, AWS_WORKER_ROOT_VOLUME_SIZE_GB_MIN, awsRootVolumeSizeError } from "../../../shared/cloudRuns";

export function AwsWorkerSizeEditor(props: {
  actual?: AwsWorkerActualSpec;
  initial: AwsWorkerSpec;
  busy: boolean;
  error?: string;
  onApply: (spec: AwsWorkerSpec) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  // This is a draft, never a write-through preference for another instance.
  const [base] = useState(props.actual ?? props.initial);
  const [disk, setDisk] = useState(String(base.rootVolumeSizeGb));
  const [instanceType, setInstanceType] = useState(base.instanceType);
  const [submitted, setSubmitted] = useState(false);
  const numeric = Number(disk);
  const invalid = awsRootVolumeSizeError(disk);
  const changedInstance = Boolean(props.actual && props.actual.instanceId !== (base as AwsWorkerActualSpec).instanceId);
  const changedSpec = Boolean(props.actual && (props.actual.rootVolumeSizeGb !== base.rootVolumeSizeGb || props.actual.instanceType !== base.instanceType));
  const shrink = props.actual && numeric < props.actual.rootVolumeSizeGb;
  const error = invalid ?? (shrink ? `This disk is already ${props.actual?.rootVolumeSizeGb} GiB. AWS can increase an existing disk, but cannot shrink it.` : undefined)
    ?? (changedInstance || changedSpec && !submitted ? "The instance changed while you were editing. Cancel and reopen to use its current size." : undefined);
  const differs = instanceType !== base.instanceType || numeric !== base.rootVolumeSizeGb;
  const options = [...new Set([...AWS_WORKER_INSTANCE_TYPE_OPTIONS, base.instanceType])];
  return <div className="gen-row gen-row-stack" data-testid="aws-worker-size-editor">
    <div className="gen-grid-form" data-testid="aws-worker-desired-specs">
      <label className="gen-aws-field"><span>Instance type</span><select className="gen-input" aria-label="AWS worker instance type" disabled={props.busy} value={instanceType} onChange={event => setInstanceType(event.target.value)}>
        {options.map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
      <label className="gen-aws-field"><span>Disk size (GiB)</span><input className="gen-input" type="number" inputMode="numeric" step={1} min={props.actual?.rootVolumeSizeGb ?? AWS_WORKER_ROOT_VOLUME_SIZE_GB_MIN} max={AWS_WORKER_ROOT_VOLUME_SIZE_GB_MAX} aria-label="AWS worker disk size" aria-describedby="aws-disk-size-help" aria-invalid={Boolean(error)} disabled={props.busy} value={disk} onChange={event => setDisk(event.target.value)} /></label>
    </div>
    <div className="gen-row-desc" id="aws-disk-size-help">Whole GiB, for example 40, 41 or 50. This app supports {AWS_WORKER_ROOT_VOLUME_SIZE_GB_MIN}–{AWS_WORKER_ROOT_VOLUME_SIZE_GB_MAX} GiB; the system image may require a larger minimum. Existing disks can only grow. A larger disk costs more.</div>
    {differs && !error ? <div data-testid="aws-worker-size-preview">
      {props.actual ? <>Disk: {base.rootVolumeSizeGb} → {numeric} GiB{instanceType !== base.instanceType ? <> · Instance: {base.instanceType} → {instanceType}</> : null}</> : <>New instance: {instanceType} · {numeric} GiB disk</>}
    </div> : null}
    {error || props.error ? <div role="alert" data-testid="aws-worker-size-error">{error ?? props.error}</div> : null}
    <div className="gen-actions">
      <button type="button" className="gen-pill" data-testid="aws-worker-size-apply" disabled={props.busy || Boolean(error) || !differs} onClick={() => { setSubmitted(true); void props.onApply({ instanceType, rootVolumeSizeGb: numeric }); }}><span className="gen-pill-label">{props.busy ? "Applying…" : "Apply"}</span></button>
      <button type="button" className="gen-pill" disabled={props.busy} onClick={props.onCancel}><span className="gen-pill-label">Cancel</span></button>
    </div>
    {props.busy ? <div className="gen-row-desc">Waiting for AWS and the filesystem to confirm the change; closing this panel does not cancel it.</div> : null}
  </div>;
}
