import { useEffect, useState } from "react";
import { CalendarDotsIcon, CheckIcon, CaretDownIcon, CaretRightIcon, KeyIcon, ShieldWarningIcon } from "@phosphor-icons/react";

import type { ChatAppToolApproval, ChatAppToolApprovalScope, ChatParticipant } from "../../../shared/types";
import type { ChatScriptChangeRequest, ScriptRevisionContent } from "../../../shared/scripts";
import { avatarForParticipant } from "../avatar/avatar";
import { chatParticipantDisplayName, chatParticipantReference } from "../conversation/conversation-display";
import { avatarForChatParticipant } from "./chat-avatars";
import { ChatMemberMark } from "./chat-member-mark";
import { formatChatTime } from "./chat-format";
import { ChatAppToolReviewFooter } from "./chat-app-tool-approval-review";
import { ChatUsedApprovalLine } from "./chat-used-card-row";
import { useSessionsViewLabel, useSessionsViewText } from "./chat-sessions-links";
import { Delayed } from "@/components/ui/delayed";

function scriptApprovalTitle(handle: string, request: ChatScriptChangeRequest): string {
  const who = chatParticipantReference(handle);
  switch (request.op) {
    case "create": return `${who} wants to add a scheduled task`;
    case "update": return `${who} wants to change a scheduled task`;
    case "delete": return `${who} wants to delete a scheduled task`;
    case "enable": return `${who} wants to switch on a scheduled task`;
    case "disable": return `${who} wants to switch off a scheduled task`;
  }
}

function scriptApprovedEnding(request: ChatScriptChangeRequest, schedule: string | undefined, withoutCard: boolean): string {
  const done = withoutCard ? "Created" : request.op === "delete" ? "Deleted" : request.op === "disable" ? "Switched off" : request.op === "enable" ? "Switched on" : "Approved";
  return schedule ? `${done} · ${schedule}` : done;
}

function scriptApprovalPrimaryLabel(request: ChatScriptChangeRequest): string {
  switch (request.op) {
    case "create": return "Approve and run";
    case "update": return "Approve change";
    case "delete": return "Delete task";
    case "enable": return "Switch on";
    case "disable": return "Switch off";
  }
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** The approval card for a scheduled-script proposal. It always approves
 *  this one proposal: no "for this chat", no editing. Keys are typed here and
 *  saved straight to the computer that runs the script (this one, or the
 *  member's machine); they never travel with the decision. */
export function ChatScriptApprovalCard(props: {
  approval: ChatAppToolApproval;
  request: ChatScriptChangeRequest;
  participants: ChatParticipant[];
  submitting: boolean;
  embedded?: boolean;
  onRespond: (approvalId: string, approve: boolean, scope?: ChatAppToolApprovalScope) => Promise<void>;
}): JSX.Element {
  const { approval, request } = props;
  const requester = props.participants.find((participant) => participant.id === approval.requesterParticipantId);
  const requesterLabel = requester ? chatParticipantDisplayName(requester) : chatParticipantReference(approval.requesterHandle);
  const requesterAvatar = requester
    ? avatarForChatParticipant(requester, requesterLabel)
    : avatarForParticipant(requesterLabel, approval.requesterParticipantId);
  // The sessions view names members by their task, the main session by
  // nothing (it is "this chat" where a list must name it).
  const appText = useSessionsViewText();
  const nameOf = useSessionsViewLabel();
  const requesterName = nameOf(requesterLabel);
  const pending = approval.status === "pending";
  // A member on a machine proposed it: the script, its code and its keys
  // live on that machine.
  const hostId = approval.homeMachineId;
  const needsKeys = request.op === "create" || request.op === "update";
  const [savedNames, setSavedNames] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [keyError, setKeyError] = useState<string | undefined>();
  const [savingKey, setSavingKey] = useState<string | undefined>();
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState<ScriptRevisionContent | undefined>();
  const [codeError, setCodeError] = useState<string | undefined>();

  useEffect(() => {
    if (!pending || !needsKeys || typeof window.consensus?.listScripts !== "function") return undefined;
    let cancelled = false;
    const apply = (scripts: Array<{ id: string; savedSecretNames: string[] }>) => {
      const summary = scripts.find((item) => item.id === request.scriptId);
      if (!cancelled && summary) setSavedNames(summary.savedSecretNames);
    };
    void window.consensus.listScripts().then(apply).catch(() => undefined);
    const off = window.consensus.onScriptsUpdated((event) => apply(event.scripts));
    return () => {
      cancelled = true;
      off();
    };
  }, [pending, needsKeys, request.scriptId]);

  useEffect(() => {
    if (!codeOpen || code || !request.revisionId) return;
    let cancelled = false;
    void window.consensus.getScriptRevision({ scriptId: request.scriptId, revisionId: request.revisionId, ...(hostId ? { hostId } : {}) })
      .then((content) => {
        if (!cancelled) setCode(content);
      })
      .catch((error: unknown) => {
        if (!cancelled) setCodeError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [codeOpen, code, request.scriptId, request.revisionId, hostId]);

  const missing = needsKeys ? request.secretNames.filter((name) => !savedNames.includes(name)) : [];

  async function saveKey(name: string): Promise<void> {
    const value = drafts[name] ?? "";
    if (!value.trim()) return;
    setSavingKey(name);
    setKeyError(undefined);
    try {
      const summary = await window.consensus.setScriptSecret({ scriptId: request.scriptId, ...(hostId ? { hostId } : {}), name, value });
      setSavedNames(summary.savedSecretNames);
      setDrafts((current) => ({ ...current, [name]: "" }));
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingKey(undefined);
    }
  }

  const chats = request.permissions.chatIds.map((chatId) => request.chatLabels[chatId] ?? chatId);
  const members = request.permissions.participantIds.map((participantId) => {
    const label = request.participantLabels[participantId] ?? participantId;
    return nameOf(label) || (label.startsWith("@") ? "this chat" : label);
  });
  const title = appText(scriptApprovalTitle(approval.requesterHandle, request));

  // A task created without a card has nothing to wait for.
  const queuedDecision = approval.status === "auto-applied" ? undefined : approval.machineDecisionPending;
  if (queuedDecision) {
    return (
      <section className="chat-app-tool-approval-card is-compact-result" aria-label={title}
        data-app-tool-approval-id={approval.id} tabIndex={-1}>
        <ChatMemberMark className="message-avatar chat-app-tool-approval-avatar" markClassName="is-large" avatar={requesterAvatar} member={requester} />
        <div className="chat-app-tool-approval-body">
          <strong>{queuedDecision.approve ? "Approval saved" : "Refusal saved"}</strong>
          <p>Waiting for machine {queuedDecision.machineName} to confirm the decision.</p>
        </div>
      </section>
    );
  }

  // Used: one line, like a folded urgent alert (the User, 2026-11-18).
  if (!pending) {
    // Approved, it ends as the button she pressed says (created without a
    // card: that it was); a task that will run ends with its schedule, not a
    // second time.
    const withoutCard = approval.status === "auto-applied";
    const applied = approval.status === "approved" || withoutCard;
    const runs = applied && request.op !== "delete" && request.op !== "disable";
    const schedule = runs && request.scheduleText ? request.scheduleText : undefined;
    const ended = applied ? scriptApprovedEnding(request, schedule, withoutCard)
      : approval.status === "denied" ? "Declined" : approval.status === "cancelled" ? "Cancelled" : "Expired";
    return (
      <ChatUsedApprovalLine approval={approval} kind="Scheduled task" icon={CalendarDotsIcon} preview={request.name} ended={ended}
        withoutTime={Boolean(schedule)} detail={approval.error} />
    );
  }

  return (
    <section
      className={`chat-app-tool-approval-card is-review-change chat-script-approval-card ${props.embedded ? "is-embedded" : ""} is-${approval.status}`}
      aria-label={title}
      data-app-tool-approval-id={approval.id}
      tabIndex={-1}
    >
      <ChatMemberMark className="message-avatar chat-app-tool-approval-avatar" markClassName="is-large" avatar={requesterAvatar} member={requester} />
      <div className="chat-app-tool-approval-body">
        <div className="chat-app-tool-approval-meta">
          {requesterName && <strong>{requesterName}</strong>}
          <span className="message-provider">Proposes a scheduled task</span>
          <span className="message-when">{formatChatTime(approval.createdAt)}</span>
        </div>
        <div className="chat-app-tool-approval-panel is-review-change">
          <div className="chat-app-tool-review-header">
            <div className="chat-app-tool-review-chip">
              <CalendarDotsIcon size={13} aria-hidden />
              Scheduled task
            </div>
          </div>
          <div className="chat-script-approval-content">
            <h3 className="chat-script-approval-title">{title}</h3>
            {approval.cardRefusals?.length ? (
              <p className="chat-script-approval-error">Your earlier answer was not applied: {appText(approval.cardRefusals[approval.cardRefusals.length - 1].reason)}</p>
            ) : null}
            <div className="chat-script-approval-name">{request.name}</div>
            {request.description && <p className="chat-script-approval-description">{request.description}</p>}
            <dl className="chat-script-approval-facts">
              <dt>Runs on</dt>
              <dd>{request.hostLabel}</dd>
              <dt>Schedule</dt>
              <dd>{request.scheduleText}</dd>
              <dt>Posts to</dt>
              <dd>{chats.join(", ")}</dd>
              <dt>May wake</dt>
              <dd>{members.length > 0 ? `${members.join(", ")} · at most ${request.permissions.maxWakeupsPerHour} per hour` : "Nobody; it only posts notes"}</dd>
              {needsKeys && (
                <>
                  <dt>Stops after</dt>
                  <dd>{request.timeoutSeconds} s per run</dd>
                </>
              )}
            </dl>
            {request.reason && <p className="chat-script-approval-reason">{request.reason}</p>}
            {needsKeys && request.secretNames.length > 0 && (
              <div className="chat-script-approval-keys">
                <div className="chat-script-approval-section-title">
                  <KeyIcon size={13} aria-hidden />
                  Keys
                </div>
                <p className="chat-script-approval-hint">Saved only on {request.hostPhrase}. The task reads them from its environment; agents never see them.</p>
                {request.secretNames.map((name) => {
                  const saved = savedNames.includes(name);
                  return (
                    <div className="chat-script-approval-key" key={name}>
                      <code>{name}</code>
                      {saved && !(name in drafts && drafts[name] !== "") ? (
                        <span className="chat-script-approval-key-saved">
                          <CheckIcon size={13} aria-hidden /> Saved
                          <button type="button" className="chat-script-approval-link" onClick={() => setDrafts((current) => ({ ...current, [name]: " " }))}>
                            Replace
                          </button>
                        </span>
                      ) : (
                        <span className="chat-script-approval-key-entry">
                          <input
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            aria-label={`Value for ${name}`}
                            placeholder="Paste value"
                            value={(drafts[name] ?? "").trimStart()}
                            onChange={(event) => setDrafts((current) => ({ ...current, [name]: event.target.value }))}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void saveKey(name);
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="chat-script-approval-save-key"
                            disabled={savingKey === name || !(drafts[name] ?? "").trim()}
                            onClick={() => void saveKey(name)}
                          >
                            Save
                          </button>
                        </span>
                      )}
                    </div>
                  );
                })}
                {keyError && <p className="chat-script-approval-error">{keyError}</p>}
              </div>
            )}
            {request.revisionId && (
              <div className="chat-script-approval-code">
                <button type="button" className="chat-script-approval-code-toggle" aria-expanded={codeOpen} onClick={() => setCodeOpen((open) => !open)}>
                  {codeOpen ? <CaretDownIcon size={14} aria-hidden /> : <CaretRightIcon size={14} aria-hidden />}
                  {codeOpen ? "Hide code" : "Show code"} · {request.runtime} · {request.fileCount} {request.fileCount === 1 ? "file" : "files"}, {formatBytes(request.totalBytes)}
                </button>
                {codeOpen && (
                  <div className="chat-script-approval-files">
                    {codeError && <p className="chat-script-approval-error">{codeError}</p>}
                    {!code && !codeError && <Delayed><p className="chat-script-approval-hint">Loading…</p></Delayed>}
                    {code?.files.map((file) => (
                      <div className="chat-script-approval-file" key={file.path}>
                        <div className="chat-script-approval-file-name">{file.path}{file.path === code.entry ? " (runs this)" : ""}</div>
                        <pre><code>{file.content}</code></pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {needsKeys && (
              <p className="chat-script-approval-warning">
                <ShieldWarningIcon size={13} aria-hidden />
                Runs with your user&apos;s full permissions on {request.hostPhrase}. Read the code before approving.
              </p>
            )}
            {missing.length > 0 && (
              <p className="chat-script-approval-hint">Save {missing.length === 1 ? "the key" : "every key"} above to approve.</p>
            )}
          </div>
          <ChatAppToolReviewFooter
            primaryLabel={scriptApprovalPrimaryLabel(request)}
            submitting={props.submitting}
            approveDisabled={missing.length > 0}
            cancelLabel="Decline"
            onCancel={() => void props.onRespond(approval.id, false)}
            onApprove={() => void props.onRespond(approval.id, true, "once")}
          />
        </div>
      </div>
    </section>
  );
}
