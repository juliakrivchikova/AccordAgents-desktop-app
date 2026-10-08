import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AWS_WORKER_INSTANCE_TYPE_OPTIONS } from "../../../shared/cloudRuns";
import type { AwsWorkerOperationSnapshot } from "../../../shared/types";
import { AwsCommandBox, AwsConfirmDialog, AwsDialog, AwsWaiting } from "./aws-dialog";
import { Row } from "./aws-row";
import { ADMIN_COMMAND_TEXT, AwsPasteField, CONFIRM_TEXT, instanceTypeSpecs } from "./aws-shared";
import type { AwsWorkerControl } from "./use-aws-worker-control";

const ACCESS_RECHECK_MS = 15_000;
/** While AWS keeps not answering, the page checks access again this often. */
const UNAVAILABLE_RECHECK_MS = 5 * 60_000;

/** The instance itself: its type, whether this app may still manage it in
 *  AWS, and deleting it. Each change opens a dialog that says what happens. */
export function AwsInstanceSection(props: { control: AwsWorkerControl }): JSX.Element {
  const c = props.control;
  const actual = c.actual;
  const [dialog, setDialog] = useState<"type" | "access" | "delete">();
  const checkedAt = useRef<number>();
  const [retryTick, setRetryTick] = useState(0);
  // AWS stopped answering: check access by itself, which is how revoked keys
  // reach recovery. One check per outage, and again only after a while: a
  // check clears the status error while it runs, which must not count as
  // AWS answering again.
  useEffect(() => {
    if (!c.statusUnavailable) {
      if (!c.locked) checkedAt.current = undefined;
      return;
    }
    if (c.locked) return;
    if (checkedAt.current !== undefined && Date.now() - checkedAt.current < UNAVAILABLE_RECHECK_MS) {
      const timer = setTimeout(() => setRetryTick((tick) => tick + 1), UNAVAILABLE_RECHECK_MS - (Date.now() - checkedAt.current));
      return () => clearTimeout(timer);
    }
    checkedAt.current = Date.now();
    void c.start(undefined, c.baseSpec, "check");
  }, [c.statusUnavailable, c.locked, retryTick]);

  const failure = c.authorizationFailure;
  const checking = c.busy && c.action === "check";
  const checkFailed = !failure && c.feedback?.failed && c.feedback.action === "check" ? c.feedback.message : undefined;
  const missing = failure?.missingAwsActions?.length ? failure.missingAwsActions.join(", ") : undefined;
  const typeSpecs = actual ? instanceTypeSpecs(actual.instanceType, actual) : "";

  return (
    <section className="gen-section">
      <div className="gen-section-head">
        <h2 className="gen-section-title">Instance</h2>
        {actual ? <span className="gen-section-meta">{actual.instanceId}</span> : null}
      </div>
      <div className="gen-card">
        <Row title={`Instance type ${actual?.instanceType ?? c.baseSpec.instanceType}`} testId="aws-instance-type"
          desc={`${typeSpecs ? `${typeSpecs}. ` : ""}Changing it replaces the instance with a new one.`}
          action={actual ? { label: "Change type…", onClick: () => setDialog("type"), disabled: c.locked, testId: "aws-instance-type-change" } : undefined} />
        <div className="gen-card-divider" />
        {failure ? (
          <Row title="AWS access" testId="aws-instance-access"
            error={missing ? `This app's AWS access is missing permissions: ${missing}.` : "AWS refuses this app's keys: they were changed or removed in AWS."}
            action={{ label: "Fix access…", onClick: () => setDialog("access"), testId: "aws-worker-authorization-toggle" }} />
        ) : checking ? (
          <Row title="AWS access" testId="aws-instance-access" desc={<AwsWaiting>Checking AWS access…</AwsWaiting>} />
        ) : checkFailed ? (
          <Row title="AWS access" testId="aws-instance-access" error={checkFailed} />
        ) : (
          <Row title="AWS access" testId="aws-instance-access" desc={c.statusUnavailable ? "AWS is not answering right now; checking again by itself." : "This app's keys work."} />
        )}
        <div className="gen-card-divider" />
        <Row title="Delete instance" desc="Removes the instance and its disk with everything on it."
          action={{ label: "Delete…", onClick: () => setDialog("delete"), disabled: c.locked, testId: "aws-instance-delete" }} />
        {c.feedback?.failed && c.feedback.action === "delete" ? <div className="gen-row gen-row-stack"><div className="gen-row-error" role="alert" data-testid="aws-delete-error">Delete failed: {c.feedback.message}</div></div> : null}
      </div>
      <AwsTypeDialog open={dialog === "type"} control={c} onClose={() => setDialog(undefined)} />
      <AwsAccessDialog open={dialog === "access"} control={c} onClose={() => setDialog(undefined)} />
      <AwsConfirmDialog
        open={dialog === "delete"}
        title="Delete the instance?"
        description={CONFIRM_TEXT.delete}
        confirmLabel="Delete instance"
        testId="aws-delete-dialog"
        onClose={() => setDialog(undefined)}
        onConfirm={() => { setDialog(undefined); void c.remove(); }}
      />
    </section>
  );
}

function AwsTypeDialog(props: { open: boolean; control: AwsWorkerControl; onClose: () => void }): JSX.Element {
  const c = props.control;
  const current = c.actual?.instanceType ?? c.baseSpec.instanceType;
  const [type, setType] = useState(current);
  useEffect(() => { if (props.open) setType(current); }, [props.open, current]);
  const stopped = c.status?.state !== "running";
  return (
    <AwsDialog
      open={props.open}
      title="Change instance type"
      testId="aws-type-dialog"
      onClose={props.onClose}
      description={`The app replaces the instance with a new one of the chosen type; the disk keeps its size. Cloud environments, sessions and sign-ins on it are lost.${stopped ? " The new instance starts right away." : ""}`}
      actions={<>
        <Button type="button" variant="outline" size="sm" onClick={props.onClose}>Cancel</Button>
        <Button type="button" size="sm" data-testid="aws-type-apply" disabled={type === current || c.locked}
          onClick={() => { props.onClose(); void c.changeType(type); }}>Replace instance</Button>
      </>}
    >
      <label className="gen-aws-field">
        <span>Type</span>
        <span className="gen-aws-select">
          <select className="gen-input" aria-label="Instance type" value={type} onChange={(event) => setType(event.target.value)}>
            {AWS_WORKER_INSTANCE_TYPE_OPTIONS.map((option) => (
              <option key={option} value={option}>{option} · {instanceTypeSpecs(option)}{option === current ? " (now)" : ""}</option>
            ))}
          </select>
          <ChevronDown size={14} aria-hidden />
        </span>
      </label>
    </AwsDialog>
  );
}

/**
 * AWS refuses the app's keys. When the app's AWS user still exists, an
 * administrator updates its policy once and the dialog notices by itself;
 * otherwise the setup command makes new keys to paste here.
 */
function AwsAccessDialog(props: { open: boolean; control: AwsWorkerControl; onClose: () => void }): JSX.Element {
  const c = props.control;
  // The failure that opened the dialog stays its subject while a check runs:
  // the dialog does not switch between its two kinds mid-way.
  const [shown, setShown] = useState<AwsWorkerOperationSnapshot>();
  useEffect(() => { if (!props.open) setShown(undefined); else if (c.authorizationFailure) setShown(c.authorizationFailure); }, [props.open, c.authorizationFailure]);
  const failure = c.authorizationFailure ?? shown;
  const updatesPolicy = Boolean(failure?.awsPrincipalUserName);
  const { onClose } = props;
  useEffect(() => { if (props.open) void c.loadCommand(c.instanceRegion); }, [props.open]);
  // Closes only when a check or start succeeded: the access came back.
  const succeeded = !c.busy && !c.authorizationFailure && Boolean(c.feedback && !c.feedback.failed)
    && (c.feedback?.action === "check" || c.feedback?.action === "setup");
  useEffect(() => { if (props.open && succeeded) onClose(); }, [props.open, succeeded, onClose]);
  useEffect(() => {
    if (!props.open || !updatesPolicy) return;
    const timer = setInterval(() => { if (!c.locked) void c.start(undefined, c.baseSpec, "check"); }, ACCESS_RECHECK_MS);
    return () => clearInterval(timer);
  }, [props.open, updatesPolicy, c.locked]);
  const retryIntent = failure?.intent === "check" ? "check" : "setup";
  return (
    <AwsDialog
      open={props.open}
      title="Fix AWS access"
      testId="aws-worker-authorization-recovery"
      onClose={onClose}
      description={updatesPolicy
        ? `${ADMIN_COMMAND_TEXT}. It gives this app's AWS user (${failure?.awsPrincipalUserName}) its access back and does not create a new key.`
        : `${ADMIN_COMMAND_TEXT}, then paste its result here. It makes new keys for this app.`}
      note={updatesPolicy ? <AwsWaiting>Waiting for AWS to accept the keys…</AwsWaiting> : undefined}
      actions={updatesPolicy
        ? <Button type="button" variant="outline" size="sm" onClick={onClose}>Close</Button>
        : <>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="button" size="sm" data-testid="aws-worker-apply-authorization" disabled={!c.blob.trim() || c.locked}
            onClick={() => void c.start(undefined, c.baseSpec, retryIntent)}>Apply</Button>
        </>}
    >
      <AwsCommandBox command={c.command} error={c.commandError} label="Copy AWS access command" testId="aws-worker-command" />
      {updatesPolicy ? null : <AwsPasteField value={c.blob} disabled={c.locked} onChange={c.setBlob} />}
      {c.feedback?.failed && c.feedback.action !== "check" ? <div className="gen-row-error" role="alert">{c.feedback.message}</div> : null}
    </AwsDialog>
  );
}
