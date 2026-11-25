/** An action the operating system performs on a file. */
export type LocalFileOpenAction = "open" | "reveal" | "intellij-idea";

/** What a click on a file link does: one of the OS actions, or the side panel.
 *  "panel" is never passed to openLocalFile. */
export type RepoFileOpenAction = LocalFileOpenAction | "panel";

/** What the panel's "Open in…" button does. */
export type RepoFileExternalOpenAction = "open" | "intellij-idea";

export type FilePreviewKind = "text" | "markdown" | "csv" | "image" | "pdf" | "html" | "unsupported";

export interface ReadFilePreviewRequest {
  conversationId: string;
  path: string;
}

export interface FilePreview {
  kind: FilePreviewKind;
  /** The path as the link gave it. */
  path: string;
  absolutePath: string;
  realPath: string;
  insideWorkspace: boolean;
  size: number;
  mtimeMs: number;
  /** SHA-256 of the whole file on disk (hex), the base of every save. */
  hash: string;
  /** Text kinds: the content (the first FILE_PREVIEW_TEXT_EDIT_LIMIT bytes when truncated). */
  text?: string;
  truncated: boolean;
  /** The file is larger than the panel reads at all. */
  tooLarge: boolean;
  /** UTF-8 that decodes cleanly. Only text kinds. */
  utf8: boolean;
  /** The text started with a UTF-8 byte-order mark (stripped from `text`, written back on save). */
  bom: boolean;
  editable: boolean;
  /** Why it is read-only, in words for the User. */
  readOnlyReason?: string;
  /** Image and HTML: a URL the panel loads through the app's own file protocol. */
  url?: string;
  /** PDF: the bytes. */
  data?: Uint8Array;
}

export interface WriteFilePreviewRequest {
  conversationId: string;
  path: string;
  content: string;
  baseHash: string;
  bom?: boolean;
}

export type WriteFilePreviewResult =
  | { ok: true; hash: string; mtimeMs: number; size: number }
  | { ok: false; conflict: true; reason: "changed" | "replaced" | "deleted" }
  | { ok: false; conflict: false; error: string };

export interface FilePreviewChangedEvent {
  realPath: string;
  /** "changed": the content on disk differs from what the panel was told last;
   *  "deleted": the file or its folder is gone. */
  change: "changed" | "deleted";
  hash?: string;
  mtimeMs?: number;
}

/** A copy of unsaved panel edits kept in userData until they are saved or discarded. */
export interface UnsavedFileEdit {
  conversationId: string;
  path: string;
  realPath: string;
  baseHash: string;
  text: string;
  bom?: boolean;
  updatedAt: string;
}

export interface InspectLocalFileRequest {
  conversationId: string;
  path: string;
  line?: number;
  column?: number;
}

export interface InspectLocalFileResult {
  path: string;
  absolutePath: string;
  insideWorkspace: boolean;
  line?: number;
  column?: number;
}

export interface OpenLocalFileRequest {
  conversationId: string;
  path: string;
  line?: number;
  column?: number;
  action?: LocalFileOpenAction;
}

export interface OpenLocalFileResult {
  action: LocalFileOpenAction;
  path: string;
  absolutePath: string;
  insideWorkspace: boolean;
  line?: number;
  column?: number;
  fallbackMessage?: string;
  lineNavigationSupported: boolean;
}
