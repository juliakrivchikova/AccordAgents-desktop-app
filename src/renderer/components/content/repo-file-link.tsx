import { createContext, useContext } from "react";
import { ExternalLink, FolderOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import type { RepoFileOpenAction } from "../../../shared/types";

export interface FileLinkRef {
  path: string;
  line?: number;
  column?: number;
}

// Provided by the chat view so file links inside rendered markdown can request an open action.
// When absent (e.g. the review view), file links render as static, non-clickable text.
export const RepoFileLinkContext = createContext<{
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

export function FileLink({ path, label, line, column }: FileLinkRef & { label: string }): JSX.Element {
  const { requestOpenFile } = useContext(RepoFileLinkContext);
  const ref: FileLinkRef = { path, line, column };

  if (!requestOpenFile) {
    return (
      <span className="file-link file-link-static" title={fileLinkTitle(ref)}>
        {label}
      </span>
    );
  }

  return (
    <a
      className="message-link file-link"
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

export function RepoFileOpenChooser(props: {
  fileRef?: FileLinkRef | null;
  open: boolean;
  onChoose: (action: RepoFileOpenAction) => void;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  // Always render the Dialog and drive it by `open` so Radix owns the close lifecycle (exit
  // animation + body pointer-events/focus cleanup). Radix skips the portal entirely while
  // closed, so an absent `fileRef` is harmless. Do not unmount this by nulling `fileRef`.
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open file reference</DialogTitle>
          <DialogDescription>
            How should AccordAgents open <code>{props.fileRef?.path ?? ""}</code>? You can change this later in Settings.
          </DialogDescription>
        </DialogHeader>
        <div className="repo-file-open-actions">
          <Button variant="outline" onClick={() => props.onChoose("open")}>
            <ExternalLink size={16} />
            Open with default app
          </Button>
          <Button variant="outline" onClick={() => props.onChoose("reveal")}>
            <FolderOpen size={16} />
            Reveal in Finder
          </Button>
        </div>
        <p className="repo-file-open-hint">
          To change the default app for this file type, reveal it in Finder, open Get Info, choose Open with, then
          Change All.
        </p>
      </DialogContent>
    </Dialog>
  );
}
