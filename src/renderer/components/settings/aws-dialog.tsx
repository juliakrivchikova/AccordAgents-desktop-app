import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CopyButton } from "../primitives";

/**
 * The one dialog shape of the AWS page: a title, what happens in plain words,
 * the body, and a footer with an optional note on the left. Every action on
 * the page that has consequences opens one of these; nothing expands inline.
 */
export function AwsDialog(props: {
  open: boolean;
  title: string;
  description: ReactNode;
  children?: ReactNode;
  note?: ReactNode;
  actions: ReactNode;
  wide?: boolean;
  busy?: boolean;
  /** False for a dialog only its own buttons may close: Escape and a click
   *  beside it do nothing, so coming back from the browser cannot cancel. */
  dismissible?: boolean;
  testId?: string;
  onClose: () => void;
}): JSX.Element {
  return (
    <Dialog open={props.open} onOpenChange={(next) => { if (!next && !props.busy && props.dismissible !== false) props.onClose(); }}>
      <DialogContent className={`gen-aws-dialog${props.wide ? " gen-aws-dialog-wide" : ""}`} data-testid={props.testId} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        {props.children}
        <DialogFooter>
          {props.note ? <span className="gen-aws-dialog-note">{props.note}</span> : null}
          {props.actions}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Confirms one action with consequences; the confirm button names it. */
export function AwsConfirmDialog(props: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  pending?: boolean;
  error?: string;
  testId?: string;
  onConfirm: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <AwsDialog
      open={props.open}
      title={props.title}
      description={props.description}
      busy={props.pending}
      testId={props.testId}
      onClose={props.onClose}
      actions={<>
        <Button type="button" variant="outline" size="sm" disabled={props.pending} onClick={props.onClose}>Cancel</Button>
        <Button type="button" size="sm" disabled={props.pending} data-testid={props.testId ? `${props.testId}-confirm` : undefined} onClick={props.onConfirm}>
          {props.pending ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}
          {props.confirmLabel}
        </Button>
      </>}
    >
      {props.error ? <div className="gen-row-error" role="alert">{props.error}</div> : null}
    </AwsDialog>
  );
}

/** A command to run in Terminal, on one line with the copy icon beside it. */
export function AwsCommandBox(props: { command: string; error?: string; label: string; testId?: string }): JSX.Element {
  return (
    <>
      <div className="gen-aws-command-box">
        <pre className="gen-aws-command" data-testid={props.testId}>{props.command || (props.error ? "" : "Preparing the command…")}</pre>
        <CopyButton text={props.command || undefined} label={props.label} />
      </div>
      {props.error ? <div className="gen-row-error" role="alert">{props.error}</div> : null}
    </>
  );
}

/** A small spinner with words, for something the page is waiting on. */
export function AwsWaiting(props: { children: ReactNode }): JSX.Element {
  return <span className="gen-aws-waiting"><Loader2 size={13} className="gen-aws-spinner" aria-hidden />{props.children}</span>;
}
