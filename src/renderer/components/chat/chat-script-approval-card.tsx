import { useEffect, useState } from "react";
import { CalendarClock, Check, ChevronDown, ChevronRight, KeyRound, ShieldAlert } from "lucide-react";

import type { ChatAppToolApproval, ChatAppToolApprovalScope, ChatParticipant } from "../../../shared/types";
import type { ChatScriptChangeRequest, ScriptRevisionContent } from "../../../shared/scripts";
import { Avatar, avatarForParticipant } from "../avatar/avatar";
import { chatParticipantDisplayName, chatParticipantReference } from "../conversation/conversation-display";
import { avatarForChatParticipant } from "./chat-avatars";
import { formatChatTime } from "./chat-format";
import { ChatAppToolReviewFooter } from "./chat-app-tool-approval-review";

function scriptApprovalTitle(handle: string, request: ChatScriptChangeRequest): string {
  const who = chatParticipantReference(handle);
  switch (request.op) {
    case "create": return `${who} wants to add a scheduled script`;
    case "update": return `${who} wants to change a scheduled script`;
    case "delete": return `${who} wants to delete a scheduled script`;
    case "enable": return `${who} wants to switch on a scheduled script`;
    case "disable": return `${who} wants to switch off a scheduled script`;
  }
}

function scriptApprovalPrimaryLabel(request: ChatScriptChangeRequest): string {
  switch (request.op) {
    case "create": return "Approve and run";
    case "update": return "Approve change";
    case "delete": return "Delete script";
    case "enable": return "Switch on";
    case "disable": return "Switch off";
  }
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** The approval card for a scheduled-script proposal. It always approves
 *  this one proposal: no "for this chat", no editing. Keys are typed here and
 *  saved straight to this computer; they never travel with the decision. */
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
  const pending = approval.status === "pending";
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
    void window.consensus.getScriptRevision({ scriptId: request.scriptId, revisionId: request.revisionId })
      .then((content) => {
        if (!cancelled) setCode(content);
      })
      .catch((error: unknown) => {
        if (!cancelled) setCodeError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [codeOpen, code, request.scriptId, request.revisionId]);

  const missing = needsKeys ? request.secretNames.filter((name) => !savedNames.includes(name)) : [];

  async function saveKey(name: string): Promise<void> {
    const value = drafts[name] ?? "";
    if (!value.trim()) return;
    setSavingKey(name);
    setKeyError(undefined);
    try {
      const summary = await window.consensus.setScriptSecret({ scriptId: request.scriptId, name, value });
      setSavedNames(summary.savedSecretNames);
      setDrafts((current) => ({ ...current, [name]: "" }));
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingKey(undefined);
    }
  }

  const chats = request.permissions.chatIds.map((chatId) => request.chatLabels[chatId] ?? chatId);
  const members = request.permissions.participantIds.map((participantId) => request.participantLabels[participantId] ?? participantId);
  const title = scriptApprovalTitle(approval.requesterHandle, request);

  return (
    <section
      className={`chat-app-tool-approval-card is-review-change chat-script-approval-card ${props.embedded ? "is-embedded" : ""} ${pending ? "" : "is-compact-result"} is-${approval.status}`}
      aria-label={title}
      data-app-tool-approval-id={approval.id}
      tabIndex={-1}
    >
      <Avatar className="message-avatar chat-app-tool-approval-avatar" spec={requesterAvatar} />
      <div className="chat-app-tool-approval-body">
        <div className="chat-app-tool-approval-meta">
          <strong>{requesterLabel}</strong>
          <span className="message-provider">{pending ? "Proposes a scheduled script" : "Scheduled script"}</span>
          <span className="message-when">{formatChatTime(approval.createdAt)}</span>
        </div>
        <div className="chat-app-tool-approval-panel is-review-change">
          <div className="chat-app-tool-review-header">
            <div className="chat-app-tool-review-chip">
              <CalendarClock size={13} aria-hidden />
              Scheduled script
            </div>
          </div>
          {pending ? (
            <div className="chat-script-approval-content">
              <h3 className="chat-script-approval-title">{title}</h3>
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
                    <KeyRound size={13} aria-hidden />
                    Keys
                  </div>
                  <p className="chat-script-approval-hint">Saved only on {request.hostPhrase}. The script reads them from its environment; agents never see them.</p>
                  {request.secretNames.map((name) => {
                    const saved = savedNames.includes(name);
                    return (
                      <div className="chat-script-approval-key" key={name}>
                        <code>{name}</code>
                        {saved && !(name in drafts && drafts[name] !== "") ? (
                          <span className="chat-script-approval-key-saved">
                            <Check size={13} aria-hidden /> Saved
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
                    {codeOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                    {codeOpen ? "Hide code" : "Show code"} · {request.runtime} · {request.fileCount} {request.fileCount === 1 ? "file" : "files"}, {formatBytes(request.totalBytes)}
                  </button>
                  {codeOpen && (
                    <div className="chat-script-approval-files">
                      {codeError && <p className="chat-script-approval-error">{codeError}</p>}
                      {!code && !codeError && <p className="chat-script-approval-hint">Loading…</p>}
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
                  <ShieldAlert size={13} aria-hidden />
                  Runs with your user&apos;s full permissions on {request.hostPhrase}. Read the code before approving.
                </p>
              )}
              {missing.length > 0 && (
                <p className="chat-script-approval-hint">Save {missing.length === 1 ? "the key" : "every key"} above to approve.</p>
              )}
            </div>
          ) : (
            <div className="chat-script-approval-content">
              <h3 className="chat-script-approval-title">{request.name}</h3>
              <p className="chat-script-approval-hint">
                {approval.status === "approved" ? `Approved · ${request.scheduleText}` : approval.status === "denied" ? "Declined" : approval.status === "cancelled" ? "Cancelled" : "Expired"}
              </p>
            </div>
          )}
          {pending && (
            <ChatAppToolReviewFooter
              primaryLabel={scriptApprovalPrimaryLabel(request)}
              submitting={props.submitting}
              approveDisabled={missing.length > 0}
              cancelLabel="Decline"
              onCancel={() => void props.onRespond(approval.id, false)}
              onApprove={() => void props.onRespond(approval.id, true, "once")}
            />
          )}
        </div>
      </div>
    </section>
  );
}
