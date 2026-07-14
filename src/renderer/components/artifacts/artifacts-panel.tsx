import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, FilePlus2, X } from "lucide-react";
import { ARTIFACT_USER_MEMBER } from "../../../shared/types";
import type {
  ArtifactError,
  ArtifactDraftView,
  ArtifactReadResult,
  ArtifactSummary,
  ArtifactVersionContent
} from "../../../shared/types";
import { IconButton } from "../primitives";
import { ArtifactDetailView, type ArtifactCompareState } from "./artifact-detail";
import { CreateArtifactForm } from "./artifact-forms";
import { useArtifactsPanelResize } from "./use-artifacts-panel-resize";
import { MarkdownText } from "../content/markdown-text";
import { loadArtifactDetail } from "./artifact-detail-loader";
import { loadArtifactDiff } from "./artifact-diff-loader";
import { ArtifactDraftInbox } from "./draft-inbox";
import { ArtifactsList } from "./artifacts-list";
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
  const [drafts, setDrafts] = useState<ArtifactDraftView[]>([]);
  const [draftError, setDraftError] = useState<ArtifactError | undefined>(undefined);
  const [viewVersion, setViewVersion] = useState<number | undefined>(undefined);
  const [reviseBase, setReviseBase] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ArtifactError | undefined>(undefined);
  const [staleCurrent, setStaleCurrent] = useState<ArtifactVersionContent | undefined>(undefined);
  const [compare, setCompare] = useState<ArtifactCompareState | undefined>(undefined);
  const [showDiff, setShowDiff] = useState(false);
  const [diffBusy, setDiffBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const loadGeneration = useRef(0);
  const compareGeneration = useRef(0);
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
  const loadDetail = useCallback(async (artifactId: string, version?: number): Promise<ArtifactReadResult | undefined> => {
    const generation = ++loadGeneration.current;
    return loadArtifactDetail({
      bridge: window.consensus,
      conversationId: props.conversationId,
      artifactId,
      version,
      isCurrent: () => generation === loadGeneration.current,
      callbacks: {
        onReadError: (nextError) => {
          setDetail(undefined);
          setDrafts([]);
          setDraftError(undefined);
          setError(nextError);
        },
        onDetail: setDetail,
        onDrafts: (nextDrafts, nextError) => {
          setDrafts(nextDrafts);
          setDraftError(nextError);
        }
      }
    });
  }, [props.conversationId]);
  useEffect(() => () => { loadGeneration.current += 1; }, []);
  useEffect(() => {
    setMode("view");
    setViewVersion(undefined);
    setShowDiff(false);
    setCompare(undefined);
    compareGeneration.current += 1;
    setDiffBusy(false);
    setRenaming(false);
    setDrafts([]);
    setDraftError(undefined);
    clearTransient();
    if (props.selectedId) {
      void loadDetail(props.selectedId);
    } else {
      loadGeneration.current += 1;
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
  async function startRevise(): Promise<void> {
    if (!detail || detail.lifecycle !== "published") {
      return;
    }
    // Revisions build on the head; if an older version is on screen, load head first.
    if (detail.version.version !== detail.summary.headVersion) {
      const head = await loadDetail(detail.summary.id);
      if (!head || head.lifecycle !== "published" || head.summary.id !== detail.summary.id) {
        return;
      }
      setViewVersion(undefined);
      setReviseBase(head.summary.headVersion);
      clearTransient();
      setMode("revise");
      return;
    }
    setReviseBase(detail.summary.headVersion);
    clearTransient();
    setMode("revise");
  }
  async function submitRevise(content: string, note: string | undefined): Promise<void> {
    if (!detail || detail.lifecycle !== "published") {
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
      setShowDiff(false);
      setCompare(undefined);
      compareGeneration.current += 1;
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
    if (!detail || detail.lifecycle !== "published") {
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
    <div ref={panelResize.panelRef} className="artifacts-panel" data-resizing={panelResize.resizing ? "true" : undefined}
      data-testid="artifacts-panel" style={{ width: `${panelResize.panelWidth}px`, maxWidth: "88%" } as CSSProperties}>
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
          <ArtifactsList artifacts={props.artifacts} onSelect={props.onSelect} />
        </div>
      ) : !detail ? (
        <div className="artifacts-panel-body artifacts-empty">Loading artifact…</div>
      ) : detail.lifecycle === "collecting_drafts" ? (
        <ArtifactDraftInbox
          detail={detail}
          busy={busy}
          canRename={canEdit}
          renaming={renaming}
          renameValue={renameValue}
          onRenameValueChange={setRenameValue}
          onStartRename={() => { setRenameValue(detail.summary.name); setRenaming(true); }}
          onCancelRename={() => setRenaming(false)}
          onSubmitRename={() => void submitRename()}
        />
      ) : (
        <ArtifactDetailView
          detail={detail}
          drafts={drafts}
          draftError={draftError}
          mode={mode}
          busy={busy || diffBusy}
          canEdit={canEdit}
          canSign={detail.summary.approval.requiredSigners.includes(me)}
          isOwner={detail.summary.owner === me}
          alreadySigned={detail.version.signatures.some((signature) => signature.signer === me)}
          reviseBase={reviseBase}
          compare={compare}
          showDiff={showDiff}
          renaming={renaming}
          renameValue={renameValue}
          onRenameValueChange={setRenameValue}
          onStartRename={() => { setRenameValue(detail.summary.name); setRenaming(true); }}
          onCancelRename={() => setRenaming(false)}
          onSubmitRename={() => void submitRename()}
          onStartRevise={() => void startRevise()}
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
            setShowDiff(false);
            setCompare(undefined);
            compareGeneration.current += 1;
            setDiffBusy(false);
            void loadDetail(detail.summary.id, target);
          }}
          onShowDiffChange={(nextShowDiff) => {
            const generation = ++compareGeneration.current;
            setShowDiff(nextShowDiff);
            setCompare(undefined);
            if (!nextShowDiff || detail.version.version <= 1) {
              setDiffBusy(false);
              return;
            }
            const fromVersion = detail.version.version - 1;
            const toVersion = detail.version.version;
            setDiffBusy(true);
            void loadArtifactDiff({
              bridge: window.consensus,
              conversationId: props.conversationId,
              artifactId: detail.summary.id,
              fromVersion,
              toVersion,
              isCurrent: () => generation === compareGeneration.current
            }).then((result) => {
              if (generation !== compareGeneration.current || !result) {
                return;
              }
              setDiffBusy(false);
              if (!result.ok) {
                setError(result.error);
                setCompare({ fromVersion, toVersion });
                return;
              }
              setCompare({ fromVersion, toVersion, diff: result.value.diff });
            });
          }}
          onRetryDrafts={() => void loadDetail(detail.summary.id, viewVersion)}
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
