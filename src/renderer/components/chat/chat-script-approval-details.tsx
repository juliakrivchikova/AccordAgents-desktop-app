import { useEffect, useState } from "react";
import { CaretDownIcon, CaretRightIcon, ShieldWarningIcon } from "@phosphor-icons/react";

import { Delayed } from "@/components/ui/delayed";
import type { ChatScriptChangeRequest, ScriptRevisionContent } from "../../../shared/scripts";

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

interface ChatScriptApprovalDetailsProps {
  request: ChatScriptChangeRequest;
  hostId?: string;
  chats: string[];
  members: string[];
  /** The task's code runs and its keys are kept (added or changed). */
  installs: boolean;
}

/** What a scheduled task's card opens to: all the member said of it, where it
 *  runs and what it may do, and its code. */
export const ChatScriptApprovalDetails = ({ request, hostId, chats, members, installs }: ChatScriptApprovalDetailsProps): JSX.Element => (
  <div className="chat-script-approval-details">
    {request.description && <p className="chat-script-approval-description">{request.description}</p>}
    {request.reason && <p className="chat-script-approval-reason">{request.reason}</p>}
    <dl className="chat-script-approval-facts">
      <dt>Runs on</dt>
      <dd>{request.hostLabel}</dd>
      <dt>Schedule</dt>
      <dd>{request.scheduleText}</dd>
      <dt>Posts to</dt>
      <dd>{chats.join(", ")}</dd>
      <dt>May wake</dt>
      <dd>{members.length > 0 ? `${members.join(", ")}, at most ${request.permissions.maxWakeupsPerHour} per hour` : "Nobody; it only posts notes"}</dd>
      {installs && (
        <>
          <dt>Stops after</dt>
          <dd>{request.timeoutSeconds} s per run</dd>
        </>
      )}
      {installs && request.secretNames.length > 0 && (
        <>
          <dt>Keys</dt>
          <dd>Saved only on {request.hostPhrase}. The task reads them from its environment; agents never see them.</dd>
        </>
      )}
    </dl>
    {request.revisionId && <ChatScriptApprovalCode request={request} revisionId={request.revisionId} hostId={hostId} />}
    {installs && (
      <p className="chat-script-approval-warning">
        <ShieldWarningIcon size={13} aria-hidden />
        Runs with your user&apos;s full permissions on {request.hostPhrase}. Read the code before approving.
      </p>
    )}
  </div>
);

interface ChatScriptApprovalCodeProps {
  request: ChatScriptChangeRequest;
  revisionId: string;
  hostId?: string;
}

const ChatScriptApprovalCode = ({ request, revisionId, hostId }: ChatScriptApprovalCodeProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<ScriptRevisionContent | undefined>();
  const [error, setError] = useState<string | undefined>();
  const { scriptId } = request;

  useEffect(() => {
    if (!open || code) return undefined;
    let cancelled = false;
    void window.consensus.getScriptRevision({ scriptId, revisionId, ...(hostId ? { hostId } : {}) })
      .then((content) => {
        if (!cancelled) setCode(content);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [open, code, scriptId, revisionId, hostId]);

  return (
    <div className="chat-script-approval-code">
      <button type="button" className="chat-script-approval-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <CaretDownIcon size={14} aria-hidden /> : <CaretRightIcon size={14} aria-hidden />}
        {open ? "Hide code" : "Show code"}: {request.runtime}, {request.fileCount} {request.fileCount === 1 ? "file" : "files"}, {formatBytes(request.totalBytes)}
      </button>
      {open && (
        <div className="chat-script-approval-files">
          {error && <p className="chat-script-approval-error">{error}</p>}
          {!code && !error && <Delayed><p className="chat-script-approval-hint">Loading…</p></Delayed>}
          {code?.files.map((file) => (
            <div className="chat-script-approval-file" key={file.path}>
              <div className="chat-script-approval-file-name">{file.path}{file.path === code.entry ? " (runs this)" : ""}</div>
              <pre><code>{file.content}</code></pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
