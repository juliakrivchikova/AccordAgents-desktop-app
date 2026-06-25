import { createContext, useContext } from "react";
import { Code2, ExternalLink, FolderOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import type { LocalFileOpenAction } from "../../../shared/types";

export interface FileLinkRef {
  path: string;
  absolutePath?: string;
  insideWorkspace?: boolean;
  line?: number;
  column?: number;
}

// Provided by the chat view so file links inside rendered markdown can request an open action.
// When absent (e.g. the review view), file links render as static, non-clickable text.
export const LocalFileLinkContext = createContext<{
  conversationId?: string;
  requestOpenFile?: (ref: FileLinkRef) => void;
}>({});

function fileLinkTitle(ref: FileLinkRef): string {
  if (ref.line && ref.column) {
    return `${ref.path}:${ref.line}:${ref.column}`;
  }
  if (ref.line) {
    return `${ref.path}:${ref.line}`;
  }
  return ref.path;
}

export function FileLink({
  path,
  label,
  line,
  column,
  variant
}: FileLinkRef & { label: string; variant?: "inline-code" }): JSX.Element {
  const { requestOpenFile } = useContext(LocalFileLinkContext);
  const ref: FileLinkRef = { path, line, column };
  const className = variant === "inline-code"
    ? "message-link file-link file-link-inline-code"
    : "message-link file-link";

  if (!requestOpenFile) {
    return (
      <span
        className={variant === "inline-code" ? "file-link file-link-static file-link-inline-code" : "file-link file-link-static"}
        title={fileLinkTitle(ref)}
      >
        {label}
      </span>
    );
  }

  return (
    <a
      className={className}
      role="button"
      tabIndex={0}
      title={fileLinkTitle(ref)}
      onClick={(event) => {
        event.preventDefault();
        requestOpenFile(ref);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          requestOpenFile(ref);
        }
      }}
    >
      {label}
    </a>
  );
}

export function LocalFileOpenChooser(props: {
  fileRef?: FileLinkRef | null;
  open: boolean;
  onChoose: (action: LocalFileOpenAction) => void;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const isOutsideWorkspace = props.fileRef?.insideWorkspace === false;
  const displayPath = isOutsideWorkspace
    ? props.fileRef?.absolutePath ?? props.fileRef?.path ?? ""
    : props.fileRef?.path ?? "";
  const openButton = (
    <Button variant="outline" onClick={() => props.onChoose("open")}>
      <ExternalLink size={16} />
      Open with default app
    </Button>
  );
  const revealButton = (
    <Button variant="outline" onClick={() => props.onChoose("reveal")}>
      <FolderOpen size={16} />
      Reveal in file manager
    </Button>
  );
  const intellijButton = (
    <Button variant="outline" onClick={() => props.onChoose("intellij-idea")}>
      <Code2 size={16} />
      Open in IntelliJ IDEA
    </Button>
  );

  // Always render the Dialog and drive it by `open` so Radix owns the close lifecycle (exit
  // animation + body pointer-events/focus cleanup). Radix skips the portal entirely while
  // closed, so an absent `fileRef` is harmless. Do not unmount this by nulling `fileRef`.
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open file reference</DialogTitle>
          <DialogDescription>
            How should AccordAgents open <code>{displayPath}</code>?
            {isOutsideWorkspace ? " This file is outside the selected workspace." : " You can change this later in Settings."}
          </DialogDescription>
        </DialogHeader>
        <div className="repo-file-open-actions">
          {isOutsideWorkspace ? revealButton : openButton}
          {isOutsideWorkspace ? openButton : revealButton}
          {intellijButton}
        </div>
        <p className="repo-file-open-hint">
          To change the default app for this file type, reveal it in your file manager and update the system Open with setting.
        </p>
      </DialogContent>
    </Dialog>
  );
}
