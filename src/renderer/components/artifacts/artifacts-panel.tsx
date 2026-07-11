import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, FilePlus2, Pencil, X } from "lucide-react";

import { ARTIFACT_USER_MEMBER } from "../../../shared/types";
import type {
  ArtifactError,
  ArtifactReadResult,
  ArtifactSummary,
  ArtifactVersionContent
} from "../../../shared/types";
import { artifactMemberLabel } from "../../../shared/artifacts";
import { IconButton } from "../primitives";
import { ArtifactApprovalBadge } from "./artifact-approval-badge";

type PanelMode = "view" | "create" | "revise" | "access";

interface CompareState {
  fromVersion: number;
  toVersion: number;
  diff?: string;
}

export function ArtifactsPanel(props: {
  conversationId: string;
  artifacts: ArtifactSummary[];
  selectedId?: string;
  onSelect: (artifactId: string | undefined) => void;
  onClose: () => void;
}): JSX.Element {
  const selectedSummary = props.artifacts.find((artifact) => artifact.id === props.selectedId);
  const [mode, setMode] = useState<PanelMode>("view");
  const [detail, setDetail] = useState<ArtifactReadResult | undefined>(undefined);
  const [viewVersion, setViewVersion] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ArtifactError | undefined>(undefined);
  const [staleCurrent, setStaleCurrent] = useState<ArtifactVersionContent | undefined>(undefined);
  const [compare, setCompare] = useState<CompareState | undefined>(undefined);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  // Create form
  const [createName, setCreateName] = useState("");
  const [createContent, setCreateContent] = useState("");
  const [createContributors, setCreateContributors] = useState("");
  const [createSigners, setCreateSigners] = useState("");
  const [createLabels, setCreateLabels] = useState("");
  // Revise form
  const [reviseContent, setReviseContent] = useState("");
  const [reviseNote, setReviseNote] = useState("");
  const [reviseBaseVersion, setReviseBaseVersion] = useState(1);
  // Access form
  const [accessOwner, setAccessOwner] = useState("");
  const [accessContributors, setAccessContributors] = useState("");
  const [accessSigners, setAccessSigners] = useState("");
  const [accessLabels, setAccessLabels] = useState("");

  const clearTransient = useCallback(() => {
    setError(undefined);
    setStaleCurrent(undefined);
  }, []);

  const loadDetail = useCallback(async (artifactId: string, version?: number) => {
    const result = await window.consensus.readArtifact({
      conversationId: props.conversationId,
      artifactId,
      version,
      includeHistory: true
    });
    if (result.ok) {
      setDetail(result.value);
    } else {
      setDetail(undefined);
      setError(result.error);
    }
  }, [props.conversationId]);

  useEffect(() => {
    setMode("view");
    setViewVersion(undefined);
    setCompare(undefined);
    setRenaming(false);
    clearTransient();
    if (props.selectedId) {
      void loadDetail(props.selectedId);
    } else {
      setDetail(undefined);
    }
  }, [props.selectedId, clearTransient, loadDetail]);

  // Keep the open detail in sync when the list refreshes after a change.
  useEffect(() => {
    if (props.selectedId && selectedSummary && detail && detail.summary.id === props.selectedId) {
      if (selectedSummary.updatedAt !== detail.summary.updatedAt || selectedSummary.name !== detail.summary.name) {
        void loadDetail(props.selectedId, viewVersion);
      }
    }
  }, [selectedSummary, detail, props.selectedId, viewVersion, loadDetail]);

  async function run<T>(action: () => Promise<{ ok: true; value: T } | { ok: false; error: ArtifactError }>): Promise<T | undefined> {
    setBusy(true);
    clearTransient();
    try {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        if (result.error.code === "stale_version") {
          setStaleCurrent(result.error.current);
        }
        return undefined;
      }
      return result.value;
    } catch (caught) {
      setError({ code: "invalid_request", message: caught instanceof Error ? caught.message : String(caught) });
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function submitCreate(): Promise<void> {
    const value = await run(() => window.consensus.createArtifact({
      conversationId: props.conversationId,
      name: createName,
      content: createContent,
      contributors: splitMembers(createContributors),
      requiredSigners: splitMembers(createSigners),
      labels: splitList(createLabels)
    }));
    if (value) {
      setCreateName("");
      setCreateContent("");
      setCreateContributors("");
      setCreateSigners("");
      setCreateLabels("");
      setMode("view");
      props.onSelect(value.summary.id);
    }
  }

  function startRevise(): void {
    if (!detail) {
      return;
    }
    // Revisions build on the head; if an older version is on screen, fetch head first.
    if (detail.version.version !== detail.summary.headVersion) {
      void loadDetail(detail.summary.id).then(() => setMode("revise"));
    }
    setReviseContent(detail.version.version === detail.summary.headVersion ? detail.version.content : "");
    setReviseBaseVersion(detail.summary.headVersion);
    setReviseNote("");
    clearTransient();
    setMode("revise");
  }

  useEffect(() => {
    if (mode === "revise" && !reviseContent && detail && detail.version.version === detail.summary.headVersion) {
      setReviseContent(detail.version.content);
      setReviseBaseVersion(detail.version.version);
    }
  }, [mode, reviseContent, detail]);

  async function submitRevise(): Promise<void> {
    if (!detail) {
      return;
    }
    const value = await run(() => window.consensus.reviseArtifact({
      conversationId: props.conversationId,
      artifactId: detail.summary.id,
      baseVersion: reviseBaseVersion,
      content: reviseContent,
      note: reviseNote.trim() ? reviseNote : undefined
    }));
    if (value) {
      setMode("view");
      setViewVersion(undefined);
      setDetail(value);
    }
  }

  async function submitRename(): Promise<void> {
    if (!detail) {
      return;
    }
    const value = await run(() => window.consensus.renameArtifact({
      conversationId: props.conversationId,
      artifactId: detail.summary.id,
      newName: renameValue
    }));
    if (value) {
      setRenaming(false);
      void loadDetail(detail.summary.id, viewVersion);
    }
  }

  async function submitSign(): Promise<void> {
    if (!detail) {
      return;
    }
    const value = await run(() => window.consensus.signArtifact({
      conversationId: props.conversationId,
      artifactId: detail.summary.id,
      version: detail.version.version
    }));
    if (value) {
      void loadDetail(detail.summary.id, viewVersion);
    }
  }

  function startAccess(): void {
    if (!detail) {
      return;
    }
    setAccessOwner(detail.summary.owner);
    setAccessContributors(detail.summary.contributors.join(", "));
    setAccessSigners(detail.summary.approval.requiredSigners.join(", "));
    setAccessLabels(detail.summary.labels.join(", "));
    clearTransient();
    setMode("access");
  }

  async function submitAccess(): Promise<void> {
    if (!detail) {
      return;
    }
    const value = await run(() => window.consensus.updateArtifactAccess({
      conversationId: props.conversationId,
      artifactId: detail.summary.id,
      owner: accessOwner.trim() || undefined,
      contributors: splitMembers(accessContributors),
      requiredSigners: splitMembers(accessSigners),
      labels: splitList(accessLabels)
    }));
    if (value) {
      setMode("view");
      void loadDetail(detail.summary.id, viewVersion);
    }
  }

  async function runCompare(fromVersion: number, toVersion: number): Promise<void> {
    if (!detail) {
      return;
    }
    const value = await run(() => window.consensus.diffArtifactVersions({
      conversationId: props.conversationId,
      artifactId: detail.summary.id,
      fromVersion,
      toVersion
    }));
    setCompare(value ? { fromVersion, toVersion, diff: value.diff } : { fromVersion, toVersion });
  }

  const me = ARTIFACT_USER_MEMBER;
  const canEdit = detail ? detail.summary.owner === me || detail.summary.contributors.includes(me) : false;
  const isOwner = detail?.summary.owner === me;
  const canSign = detail ? detail.summary.approval.requiredSigners.includes(me) : false;
  const alreadySignedShown = detail
    ? detail.version.signatures.some((signature) => signature.signer === me)
    : false;

  return (
    <div className="artifacts-panel" data-testid="artifacts-panel">
      <div className="artifacts-panel-header">
        {props.selectedId || mode === "create" ? (
          <IconButton
            label="Back to artifact list"
            icon={ArrowLeft}
            onClick={() => {
              setMode("view");
              clearTransient();
              props.onSelect(undefined);
            }}
          />
        ) : null}
        <h3 className="artifacts-panel-title">
          {mode === "create" ? "New artifact" : detail && props.selectedId ? "Artifact" : "Artifacts"}
        </h3>
        {!props.selectedId && mode !== "create" && (
          <button type="button" className="artifact-primary-action" onClick={() => { clearTransient(); setMode("create"); }}>
            <FilePlus2 size={14} aria-hidden /> New
          </button>
        )}
        <IconButton label="Close artifacts" icon={X} onClick={props.onClose} />
      </div>

      {error && (
        <div className="artifact-error" role="alert">
          <strong>{errorTitle(error)}:</strong> {error.message}
          {error.code === "stale_version" && staleCurrent && (
            <div className="artifact-stale-actions">
              <button
                type="button"
                className="artifact-secondary-action"
                onClick={() => {
                  setReviseBaseVersion(staleCurrent.version);
                  setError(undefined);
                }}
              >
                Redo on top of v{staleCurrent.version}
              </button>
              <details>
                <summary>Show current v{staleCurrent.version}</summary>
                <pre className="artifact-content-pre">{staleCurrent.content}</pre>
              </details>
            </div>
          )}
        </div>
      )}

      {mode === "create" ? (
        <div className="artifacts-panel-body artifact-form">
          <label>Name<input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="Release plan, QA cases, Todo list — any name" /></label>
          <label>Content<textarea rows={12} value={createContent} onChange={(event) => setCreateContent(event.target.value)} placeholder="Free-form text" /></label>
          <label>Contributors <span className="artifact-hint">comma-separated members; you own it either way</span>
            <input value={createContributors} onChange={(event) => setCreateContributors(event.target.value)} placeholder="gera, codex" />
          </label>
          <label>Required signers <span className="artifact-hint">only they can sign; all must sign the current version for full approval</span>
            <input value={createSigners} onChange={(event) => setCreateSigners(event.target.value)} placeholder="user, gera" />
          </label>
          <label>Labels <span className="artifact-hint">optional, free-form</span>
            <input value={createLabels} onChange={(event) => setCreateLabels(event.target.value)} placeholder="plan, v1" />
          </label>
          <div className="artifact-form-actions">
            <button type="button" className="artifact-secondary-action" onClick={() => { setMode("view"); clearTransient(); }}>Cancel</button>
            <button type="button" className="artifact-primary-action" disabled={busy || !createName.trim() || !createContent} onClick={() => void submitCreate()}>Create</button>
          </div>
        </div>
      ) : !props.selectedId ? (
        <div className="artifacts-panel-body">
          {props.artifacts.length === 0 ? (
            <div className="artifacts-empty">
              No artifacts in this chat yet. Members and agents can create durable, versioned, signable documents here — plans, QA case lists, decisions, todo lists, anything.
            </div>
          ) : (
            <ul className="artifact-list">
              {props.artifacts.map((artifact) => (
                <li key={artifact.id}>
                  <button type="button" className="artifact-list-item" onClick={() => props.onSelect(artifact.id)}>
                    <span className="artifact-list-name">{artifact.name}</span>
                    <span className="artifact-list-meta">
                      <span className="artifact-version-chip">v{artifact.headVersion}</span>
                      <ArtifactApprovalBadge approval={artifact.approval} />
                      <span className="artifact-updated">{formatTimestamp(artifact.updatedAt)}</span>
                    </span>
                    {artifact.labels.length > 0 && (
                      <span className="artifact-labels">{artifact.labels.map((label) => <span key={label} className="artifact-label">{label}</span>)}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : !detail ? (
        <div className="artifacts-panel-body artifacts-empty">Loading artifact…</div>
      ) : (
        <div className="artifacts-panel-body artifact-detail">
          <div className="artifact-detail-head">
            {renaming ? (
              <div className="artifact-rename-row">
                <input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} aria-label="New artifact name" />
                <button type="button" className="artifact-primary-action" disabled={busy || !renameValue.trim()} onClick={() => void submitRename()}>Save</button>
                <button type="button" className="artifact-secondary-action" onClick={() => setRenaming(false)}>Cancel</button>
              </div>
            ) : (
              <h4 className="artifact-name">
                {detail.summary.name}
                {canEdit && (
                  <IconButton
                    label="Rename artifact"
                    icon={Pencil}
                    size="xs"
                    tooltip="Rename (label only; references and versions keep working)"
                    onClick={() => { setRenameValue(detail.summary.name); setRenaming(true); }}
                  />
                )}
              </h4>
            )}
            <div className="artifact-detail-meta">
              <span className="artifact-version-chip">v{detail.version.version}{detail.version.version !== detail.summary.headVersion ? ` of ${detail.summary.headVersion}` : ""}</span>
              <ArtifactApprovalBadge approval={detail.summary.approval} />
            </div>
            <div className="artifact-people">
              <span>Owner {artifactMemberLabel(detail.summary.owner)}</span>
              {detail.summary.contributors.length > 0 && (
                <span> · Contributors {detail.summary.contributors.map(artifactMemberLabel).join(", ")}</span>
              )}
              {detail.summary.approval.requiredSigners.length > 0 && (
                <span> · Signers {detail.summary.approval.requiredSigners.map((signer) => `${artifactMemberLabel(signer)}${detail.summary.approval.signedCurrent.includes(signer) ? " ✓" : ""}`).join(", ")}</span>
              )}
            </div>
            {detail.summary.labels.length > 0 && (
              <div className="artifact-labels">{detail.summary.labels.map((label) => <span key={label} className="artifact-label">{label}</span>)}</div>
            )}
          </div>

          {mode === "revise" ? (
            <div className="artifact-form">
              <label>Content (v{reviseBaseVersion} → v{reviseBaseVersion + 1})
                <textarea rows={14} value={reviseContent} onChange={(event) => setReviseContent(event.target.value)} />
              </label>
              <label>Revision note <span className="artifact-hint">optional, shown in history and the chat note</span>
                <input value={reviseNote} onChange={(event) => setReviseNote(event.target.value)} />
              </label>
              <div className="artifact-form-actions">
                <button type="button" className="artifact-secondary-action" onClick={() => { setMode("view"); clearTransient(); }}>Cancel</button>
                <button type="button" className="artifact-primary-action" disabled={busy || !reviseContent} onClick={() => void submitRevise()}>Save as v{reviseBaseVersion + 1}</button>
              </div>
            </div>
          ) : mode === "access" ? (
            <div className="artifact-form">
              <label>Owner<input value={accessOwner} onChange={(event) => setAccessOwner(event.target.value)} /></label>
              <label>Contributors<input value={accessContributors} onChange={(event) => setAccessContributors(event.target.value)} /></label>
              <label>Required signers<input value={accessSigners} onChange={(event) => setAccessSigners(event.target.value)} /></label>
              <label>Labels<input value={accessLabels} onChange={(event) => setAccessLabels(event.target.value)} /></label>
              <div className="artifact-form-actions">
                <button type="button" className="artifact-secondary-action" onClick={() => { setMode("view"); clearTransient(); }}>Cancel</button>
                <button type="button" className="artifact-primary-action" disabled={busy} onClick={() => void submitAccess()}>Save access</button>
              </div>
            </div>
          ) : (
            <>
              <div className="artifact-actions-row">
                {canEdit && <button type="button" className="artifact-primary-action" disabled={busy} onClick={startRevise}>Revise</button>}
                {canSign && (
                  <button
                    type="button"
                    className="artifact-secondary-action"
                    disabled={busy || alreadySignedShown}
                    title={alreadySignedShown ? "You already signed this version" : `Sign v${detail.version.version}`}
                    onClick={() => void submitSign()}
                  >
                    {alreadySignedShown ? "Signed ✓" : `Sign v${detail.version.version}`}
                  </button>
                )}
                {isOwner && <button type="button" className="artifact-secondary-action" disabled={busy} onClick={startAccess}>Access…</button>}
              </div>
              {detail.version.note && <div className="artifact-version-note">Note: {detail.version.note}</div>}
              <pre className="artifact-content-pre">{detail.version.content}</pre>
              <div className="artifact-history">
                <h5>History</h5>
                <ul>
                  {[...(detail.history ?? [])].reverse().map((meta) => (
                    <li key={meta.version} className={meta.version === detail.version.version ? "artifact-history-current" : undefined}>
                      <button
                        type="button"
                        className="artifact-history-version"
                        onClick={() => {
                          setViewVersion(meta.version === detail.summary.headVersion ? undefined : meta.version);
                          setCompare(undefined);
                          void loadDetail(detail.summary.id, meta.version === detail.summary.headVersion ? undefined : meta.version);
                        }}
                      >
                        v{meta.version}
                      </button>
                      <span className="artifact-history-meta">
                        {artifactMemberLabel(meta.author)} · {formatTimestamp(meta.createdAt)}
                        {meta.note ? ` · ${meta.note}` : ""}
                        {meta.signatures.length > 0 ? ` · signed by ${meta.signatures.map((signature) => artifactMemberLabel(signature.signer)).join(", ")}` : ""}
                      </span>
                      {meta.version > 1 && (
                        <button type="button" className="artifact-diff-action" disabled={busy} onClick={() => void runCompare(meta.version - 1, meta.version)}>
                          diff v{meta.version - 1}→v{meta.version}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
              {compare?.diff !== undefined && (
                <div className="artifact-compare">
                  <h5>Comparison v{compare.fromVersion} → v{compare.toVersion}</h5>
                  <pre className="artifact-diff-pre">
                    {compare.diff.split("\n").map((line, index) => (
                      <span key={index} className={diffLineClass(line)}>{line || " "}{"\n"}</span>
                    ))}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function splitMembers(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function splitList(value: string): string[] {
  return splitMembers(value);
}

function formatTimestamp(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    return value;
  }
  return new Date(time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function errorTitle(error: ArtifactError): string {
  switch (error.code) {
    case "stale_version": return "Out-of-date edit";
    case "access_denied": return "Not allowed";
    case "name_taken": return "Name taken";
    case "not_found": return "Not found";
    default: return "Invalid request";
  }
}

function diffLineClass(line: string): string {
  if (line.startsWith("+")) {
    return "artifact-diff-add";
  }
  if (line.startsWith("-")) {
    return "artifact-diff-del";
  }
  if (line.startsWith("@@")) {
    return "artifact-diff-hunk";
  }
  return "artifact-diff-context";
}
