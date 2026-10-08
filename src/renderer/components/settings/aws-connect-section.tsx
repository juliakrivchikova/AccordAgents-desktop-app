import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AwsCommandBox, AwsDialog } from "./aws-dialog";
import { ADMIN_COMMAND_TEXT, AwsPasteField, WorkerProgress } from "./aws-shared";
import type { AwsWorkerControl } from "./use-aws-worker-control";

/**
 * No instance yet: one switch, the way automatic stop is turned on. Turning
 * it on opens what connecting needs: the region, the setup command to run
 * once with an AWS administrator account, and the box for its result. With
 * keys already saved (the instance was deleted) it only creates the instance.
 */
export function AwsConnectSection(props: { control: AwsWorkerControl; hasCredentials: boolean }): JSX.Element {
  const c = props.control;
  const [open, setOpen] = useState(false);
  const starting = c.busy && c.action === "setup" || c.showProgress;
  const failed = c.feedback?.failed && c.feedback.action === "setup" ? c.feedback.message : undefined;
  useEffect(() => { if (open && !props.hasCredentials && !c.command) void c.loadCommand(c.region); }, [open]);
  const spec = c.baseSpec;
  return (
    <section className="gen-section" data-testid="aws-worker-connect">
      <div className="gen-card">
        <div className="gen-row">
          <div className="gen-row-text">
            <div className="gen-row-title">AWS instance</div>
            <div className="gen-row-desc">Run cloud members on your own AWS instance. AWS bills it while it runs.</div>
            {failed && !open ? <div className="gen-row-error" role="alert">Connecting failed: {failed}</div> : null}
          </div>
          <label className="toggle">
            <input type="checkbox" aria-label="AWS instance" data-testid="aws-instance-switch" checked={open || starting}
              disabled={starting} onChange={(event) => setOpen(event.target.checked)} />
            <span />
          </label>
        </div>
      </div>
      <AwsDialog
        open={open}
        title={props.hasCredentials ? "Create the AWS instance" : "Connect AWS"}
        testId="aws-connect-dialog"
        busy={starting}
        onClose={() => setOpen(false)}
        description={props.hasCredentials
          ? `The app creates a ${spec.instanceType} instance with a ${spec.rootVolumeSizeGb} GiB disk in your AWS account; you can change both later.`
          : `The app creates a ${spec.instanceType} instance with a ${spec.rootVolumeSizeGb} GiB disk in your AWS account; you can change both later. ${ADMIN_COMMAND_TEXT}, then paste its result here.`}
        actions={<>
          <Button type="button" variant="outline" size="sm" disabled={starting} onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="button" size="sm" data-testid="aws-worker-connect-start" disabled={starting || !c.canStart}
            onClick={() => void c.start(undefined, spec, "setup")}>
            {starting ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}
            {starting ? "Starting…" : props.hasCredentials ? "Create and start" : "Connect and start"}
          </Button>
        </>}
      >
        {props.hasCredentials ? null : (
          <>
            <label className="gen-aws-field">
              <span>Region</span>
              <input className="gen-input" aria-label="AWS region" value={c.region} disabled={starting}
                onChange={(event) => c.setRegion(event.target.value)}
                onBlur={() => void c.loadCommand(c.region)} />
            </label>
            <AwsCommandBox command={c.command} error={c.commandError} label="Copy AWS setup command" testId="aws-worker-command" />
            <AwsPasteField value={c.blob} disabled={starting} onChange={c.setBlob} />
          </>
        )}
        {starting && c.currentOperation ? <WorkerProgress operation={c.currentOperation} /> : null}
        {failed ? <div className="gen-row-error" role="alert">{failed}</div> : null}
      </AwsDialog>
    </section>
  );
}
