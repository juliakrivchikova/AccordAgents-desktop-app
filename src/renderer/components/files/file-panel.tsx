import { useEffect, type CSSProperties } from "react";
import { ArrowLeft, Code2, ExternalLink, FolderOpen, X } from "lucide-react";
import { toast } from "sonner";

import type { LocalFileOpenAction, RepoFileExternalOpenAction } from "../../../shared/types";
import type { PanelAttachmentTarget, PanelFileTarget } from "../artifacts/use-artifacts";
import { useArtifactsPanelResize } from "../artifacts/use-artifacts-panel-resize";
import { CopyButton, IconButton } from "../primitives";
import { FilePanelBody } from "./file-panel-body";
import { ImageViewer } from "./image-viewer";
import { useFileDocument, type FileDocument } from "./use-file-document";

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function PanelFrame(props: {
  title: string;
  subtitle?: string;
  copyText?: string;
  status?: string;
  actions?: JSX.Element;
  onBackToThread?: () => void;
  onClose: () => void;
  children: JSX.Element;
}): JSX.Element {
  const panelResize = useArtifactsPanelResize();
  return (
    <div
      ref={panelResize.panelRef}
      className="artifacts-panel file-panel"
      data-resizing={panelResize.resizing ? "true" : undefined}
      data-testid="file-panel"
      style={{ width: `${panelResize.panelWidth}px` } as CSSProperties}
    >
      <div
        className="artifacts-panel-resizer"
        role="separator"
        tabIndex={0}
        aria-label="Resize file panel"
        aria-orientation="vertical"
        aria-valuemin={panelResize.limits.min}
        aria-valuemax={panelResize.limits.max}
        aria-valuenow={panelResize.panelWidth}
        title="Resize file panel"
        onPointerDown={panelResize.startResize}
        onKeyDown={panelResize.resizeWithKeyboard}
        onDoubleClick={panelResize.resetWidth}
      />
      <div data-titlebar className="artifacts-panel-header file-panel-header">
        {props.onBackToThread && (
          <IconButton label="Back to thread" tooltip="Back to thread" icon={ArrowLeft} onClick={props.onBackToThread} />
        )}
        <div className="artifacts-panel-title-block file-panel-title-block">
          <h3 className="artifacts-panel-title" title={props.subtitle ?? props.title}>
            <span>{props.title}</span>
          </h3>
          {props.subtitle && (
            <div className="file-panel-subtitle">
              <span title={props.subtitle}>{props.subtitle}</span>
              {props.copyText && <CopyButton text={props.copyText} label="Copy path" />}
            </div>
          )}
        </div>
        {props.status && <span className="file-panel-status" aria-live="polite">{props.status}</span>}
        {props.actions}
        <IconButton label="Close file" icon={X} onClick={props.onClose} />
      </div>
      <div className="file-panel-body">{props.children}</div>
    </div>
  );
}

function saveStatus(document: FileDocument): string | undefined {
  const buffer = document.buffer;
  if (!buffer || !document.preview?.editable) return undefined;
  if (buffer.conflict) return "Not saved";
  if (document.saving) return "Saving…";
  if (buffer.error) return "Not saved";
  return buffer.dirty ? "Edited" : "Saved";
}

function FileNotices(props: { document: FileDocument }): JSX.Element | null {
  const { document } = props;
  const buffer = document.buffer;
  const preview = document.preview;
  const notices: JSX.Element[] = [];
  if (buffer?.conflict === "deleted" || (document.deleted && buffer?.dirty)) {
    notices.push(
      <div key="deleted" className="file-panel-banner" role="alert">
        <span>This file was deleted on disk. Your text is still here.</span>
        <CopyButton text={buffer?.text ?? ""} label="Copy text" />
      </div>
    );
  } else if (buffer?.conflict) {
    notices.push(
      <div key="conflict" className="file-panel-banner" role="alert" data-testid="file-conflict-banner">
        <span>This file changed on disk while you were editing it.</span>
        <button type="button" className="file-viewer-text-button" onClick={() => void document.keepMine()}>Keep mine</button>
        <button type="button" className="file-viewer-text-button" onClick={() => void document.takeDiskVersion()}>Use the file on disk</button>
      </div>
    );
  } else if (document.deleted) {
    notices.push(<p key="gone" className="file-panel-note" role="status">This file was deleted on disk.</p>);
  }
  if (buffer?.restored && !buffer.conflict) {
    notices.push(
      <div key="restored" className="file-panel-banner" role="status">
        <span>Unsaved edits from your last session.</span>
        <button type="button" className="file-viewer-text-button" onClick={document.saveNow}>Save</button>
        <button type="button" className="file-viewer-text-button" onClick={() => void document.takeDiskVersion()}>Discard</button>
      </div>
    );
  }
  if (buffer?.error && !buffer.conflict) {
    notices.push(<p key="error" className="file-panel-note" role="alert">Could not save: {buffer.error}</p>);
  }
  if (preview && !preview.editable && preview.readOnlyReason && !preview.tooLarge) {
    notices.push(<p key="readonly" className="file-panel-note">{preview.readOnlyReason}</p>);
  }
  return notices.length ? <div className="file-panel-notices">{notices}</div> : null;
}

/** A local file in the side panel. */
export function FilePanel(props: {
  conversationId: string;
  target: PanelFileTarget;
  externalAction: RepoFileExternalOpenAction;
  onClose: () => void;
  onBackToThread?: () => void;
  /** The file turned out to be a kind the panel does not show: open it the OS way instead. */
  onUnsupported: (target: PanelFileTarget) => void;
}): JSX.Element {
  const document = useFileDocument(props.conversationId, props.target.path);
  const preview = document.preview;

  useEffect(() => {
    if (document.status === "ready" && preview?.kind === "unsupported") props.onUnsupported(props.target);
    // Only when the file's kind becomes known.
  }, [document.status, preview?.kind]);

  const openOutside = (action: LocalFileOpenAction): void => {
    void window.consensus.openLocalFile({
      conversationId: props.conversationId,
      path: preview?.absolutePath ?? props.target.path,
      line: props.target.line,
      column: props.target.column,
      action
    }).then((result) => {
      if (result.fallbackMessage) toast.info(result.fallbackMessage);
    }).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Could not open the file.");
    });
  };

  const externalLabel = props.externalAction === "intellij-idea" ? "Open in IntelliJ IDEA" : "Open with default app";
  return (
    <PanelFrame
      title={basename(preview?.realPath ?? props.target.path)}
      subtitle={preview?.absolutePath ?? props.target.path}
      copyText={preview?.absolutePath ?? props.target.path}
      status={saveStatus(document)}
      onBackToThread={props.onBackToThread}
      onClose={props.onClose}
      actions={(
        <>
          <IconButton
            label={externalLabel}
            tooltip={externalLabel}
            icon={props.externalAction === "intellij-idea" ? Code2 : ExternalLink}
            onClick={() => openOutside(props.externalAction)}
          />
          <IconButton label="Reveal in Finder" tooltip="Reveal in Finder" icon={FolderOpen} onClick={() => openOutside("reveal")} />
        </>
      )}
    >
      <div className="file-panel-content">
        <FileNotices document={document} />
        <FilePanelBody document={document} line={props.target.line} column={props.target.column} />
      </div>
    </PanelFrame>
  );
}

/** An image attached to a message, in the side panel. */
export function AttachmentPanel(props: {
  target: PanelAttachmentTarget;
  onClose: () => void;
  onBackToThread?: () => void;
}): JSX.Element {
  return (
    <PanelFrame
      title={props.target.filename}
      subtitle={props.target.description}
      onBackToThread={props.onBackToThread}
      onClose={props.onClose}
    >
      <ImageViewer src={props.target.dataUrl} alt={props.target.filename} />
    </PanelFrame>
  );
}
