import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { ArrowLeft, FilePlus2, X } from "lucide-react";

import { ARTIFACT_USER_MEMBER } from "../../../shared/types";
import type {
  ArtifactError,
  ArtifactReadResult,
  ArtifactSummary,
  ArtifactVersionContent
} from "../../../shared/types";
import { IconButton } from "../primitives";
import { ArtifactApprovalBadge } from "./artifact-approval-badge";
import { ArtifactDetailView, formatArtifactTimestamp } from "./artifact-detail";
import type { ArtifactCompareState } from "./artifact-detail";
import { CreateArtifactForm } from "./artifact-forms";
import { useArtifactsPanelResize } from "./use-artifacts-panel-resize";
import { MarkdownText } from "../content/markdown-text";

type PanelMode = "view" | "create" | "revise" | "access";

export function ArtifactsPanel(props: {
  conversationId: string;
  artifacts: ArtifactSummary[];
  selectedId?: string;
  onSelect: (artifactId: string | undefined) => void;
  onClose: () => void;
}): JSX.Element {
  const selectedSummary = props.artifacts.find((artifact) => artifact.id === props.selectedId);
  const panelResize = useArtifactsPanelResize();
  const [mode, setMode] = useState<PanelMode>("view");
  const [detail, setDetail] = useState<ArtifactReadResult | undefined>(undefined);
  const [viewVersion, setViewVersion] = useState<number | undefined>(undefined);
  const [reviseBase, setReviseBase] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ArtifactError | undefined>(undefined);
  const [staleCurrent, setStaleCurrent] = useState<ArtifactVersionContent | undefined>(undefined);
  const [compare, setCompare] = useState<ArtifactCompareState | undefined>(undefined);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const resizeLimits = panelResize.getLimits();

  const clearTransient = useCallback(() => {
    setError(undefined);
    setStaleCurrent(undefined);
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      const { target } = event;
      if (!(target instanceof Node)) {
        return;
      }
      if (panelResize.panelRef.current?.contains(target)) {
        return;
      }
      if (target instanceof Element && target.closest("[data-artifacts-trigger='true']")) {
        return;
      }
      props.onClose();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [panelResize.panelRef, props.onClose]);

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

  function startRevise(): void {
    if (!detail) {
      return;
    }
    // Revisions build on the head; if an older version is on screen, load head first.
    if (detail.version.version !== detail.summary.headVersion) {
      void loadDetail(detail.summary.id).then(() => setMode("revise"));
    }
    setReviseBase(detail.summary.headVersion);
    clearTransient();
    setMode("revise");
  }

  async function submitRevise(content: string, note: string | undefined): Promise<void> {
    if (!detail) {
      return;
    }
    const value = await run(() => window.consensus.reviseArtifact({
      conversationId: props.conversationId,
      artifactId: detail.summary.id,
      baseVersion: reviseBase,
      content,
      note
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

  const me = ARTIFACT_USER_MEMBER;
  const canEdit = detail ? detail.summary.owner === me || detail.summary.contributors.includes(me) : false;

  return (
    <div
      ref={panelResize.panelRef}
      className="artifacts-panel"
      data-resizing={panelResize.resizing ? "true" : undefined}
      data-testid="artifacts-panel"
      style={{ width: `${panelResize.panelWidth}px`, maxWidth: "88%" } as CSSProperties}
    >
      <div
        className="artifacts-panel-resizer"
        role="separator"
        tabIndex={0}
        aria-label="Resize artifacts panel"
        aria-orientation="vertical"
        aria-valuemin={resizeLimits.min}
        aria-valuemax={resizeLimits.max}
        aria-valuenow={panelResize.panelWidth}
        title="Resize artifacts panel"
        onPointerDown={panelResize.startResize}
        onKeyDown={panelResize.resizeWithKeyboard}
        onDoubleClick={panelResize.resetWidth}
      />
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
                  setReviseBase(staleCurrent.version);
                  setError(undefined);
                }}
              >
                Redo on top of v{staleCurrent.version}
              </button>
              <details>
                <summary>Show current v{staleCurrent.version}</summary>
                <div className="artifact-content-markdown">
                  <MarkdownText content={staleCurrent.content} />
                </div>
              </details>
            </div>
          )}
        </div>
      )}

      {mode === "create" ? (
        <CreateArtifactForm
          busy={busy}
          onCancel={() => { setMode("view"); clearTransient(); }}
          onSubmit={(values) => {
            void run(() => window.consensus.createArtifact({ conversationId: props.conversationId, ...values }))
              .then((value) => {
                if (value) {
                  setMode("view");
                  props.onSelect(value.summary.id);
                }
              });
          }}
        />
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
                      <span className="artifact-updated">{formatArtifactTimestamp(artifact.updatedAt)}</span>
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
        <ArtifactDetailView
          detail={detail}
          mode={mode}
          busy={busy}
          canEdit={canEdit}
          canSign={detail.summary.approval.requiredSigners.includes(me)}
          isOwner={detail.summary.owner === me}
          alreadySigned={detail.version.signatures.some((signature) => signature.signer === me)}
          reviseBase={reviseBase}
          compare={compare}
          renaming={renaming}
          renameValue={renameValue}
          onRenameValueChange={setRenameValue}
          onStartRename={() => { setRenameValue(detail.summary.name); setRenaming(true); }}
          onCancelRename={() => setRenaming(false)}
          onSubmitRename={() => void submitRename()}
          onStartRevise={startRevise}
          onSubmitRevise={(content, note) => void submitRevise(content, note)}
          onStartAccess={() => { clearTransient(); setMode("access"); }}
          onSubmitAccess={(values) => {
            void run(() => window.consensus.updateArtifactAccess({
              conversationId: props.conversationId,
              artifactId: detail.summary.id,
              ...values
            })).then((value) => {
              if (value) {
                setMode("view");
                void loadDetail(detail.summary.id, viewVersion);
              }
            });
          }}
          onCancelForm={() => { setMode("view"); clearTransient(); }}
          onSign={() => void submitSign()}
          onShowVersion={(version) => {
            const target = version === detail.summary.headVersion ? undefined : version;
            setViewVersion(target);
            setCompare(undefined);
            void loadDetail(detail.summary.id, target);
          }}
          onCompare={(fromVersion, toVersion) => {
            void run(() => window.consensus.diffArtifactVersions({
              conversationId: props.conversationId,
              artifactId: detail.summary.id,
              fromVersion,
              toVersion
            })).then((value) => {
              setCompare(value ? { fromVersion, toVersion, diff: value.diff } : { fromVersion, toVersion });
            });
          }}
        />
      )}
    </div>
  );
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
