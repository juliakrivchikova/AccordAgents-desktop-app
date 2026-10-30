import type { FilePreviewKind } from "./types";

/** Text up to this size loads whole and can be edited in the panel. */
export const FILE_PREVIEW_TEXT_EDIT_LIMIT = 2 * 1024 * 1024;
/** Text up to this size shows its first FILE_PREVIEW_TEXT_EDIT_LIMIT bytes, read-only. Above it the panel does not read it. */
export const FILE_PREVIEW_TEXT_READ_LIMIT = 20 * 1024 * 1024;
/** PDF bytes travel over IPC up to this size. */
export const FILE_PREVIEW_PDF_LIMIT = 50 * 1024 * 1024;
/** The table view parses at most this many rows; the text view still shows the whole (truncated) text. */
export const FILE_PREVIEW_CSV_ROW_LIMIT = 100_000;
/** The table view shows at most this many columns. */
export const FILE_PREVIEW_CSV_COLUMN_LIMIT = 500;
/** A Markdown file larger than this opens as text: rendering it whole would stall the window. */
export const FILE_PREVIEW_MARKDOWN_RENDER_LIMIT = 256 * 1024;
/** Unsaved panel text kept in userData, at most (a paste may go past what the panel saves). */
export const FILE_PREVIEW_UNSAVED_COPY_LIMIT = 8 * 1024 * 1024;
/** The app's own scheme for images and HTML pages shown in the panel. */
export const FILE_PREVIEW_PROTOCOL = "accord-file";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "ico", "avif"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);
const CSV_EXTENSIONS = new Set(["csv", "tsv"]);
const HTML_EXTENSIONS = new Set(["html", "htm"]);
/** Known binary formats the panel does not show; they open the way they did before. */
const UNSUPPORTED_EXTENSIONS = new Set([
  "xlsx", "xls", "xlsm", "ods", "docx", "doc", "odt", "pptx", "ppt", "key", "numbers", "pages",
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "dmg", "pkg", "app", "exe", "dll", "so", "dylib",
  "bin", "o", "a", "class", "jar", "war", "wasm", "pyc",
  "mp3", "wav", "flac", "aac", "ogg", "m4a", "mp4", "mov", "avi", "mkv", "webm",
  "ttf", "otf", "woff", "woff2", "eot", "psd", "ai", "sketch", "fig", "heic", "tiff", "tif",
  "sqlite", "sqlite3", "db"
]);

export function fileBasename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

export function fileExtension(filePath: string): string {
  const base = fileBasename(filePath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * The panel's kind for a path from its extension alone. "text" for anything not
 * known to be binary: the main process sniffs the bytes before trusting it.
 */
export function filePreviewKindForPath(filePath: string): FilePreviewKind {
  const extension = fileExtension(filePath);
  if (extension === "pdf") return "pdf";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (CSV_EXTENSIONS.has(extension)) return "csv";
  if (HTML_EXTENSIONS.has(extension)) return "html";
  if (UNSUPPORTED_EXTENSIONS.has(extension)) return "unsupported";
  return "text";
}

export function isTextPreviewKind(kind: FilePreviewKind): boolean {
  return kind === "text" || kind === "markdown" || kind === "csv";
}

/** Kinds whose text the panel edits (an HTML page's source is text too). */
export function isEditablePreviewKind(kind: FilePreviewKind): boolean {
  return isTextPreviewKind(kind) || kind === "html";
}

/** Length of the longest prefix of `bytes` (at most `limit`) that does not split a UTF-8 sequence. */
export function utf8SafePrefixLength(bytes: Uint8Array, limit: number): number {
  if (bytes.length <= limit) return bytes.length;
  let end = limit;
  // Step back over continuation bytes (10xxxxxx) to the start of the cut character.
  let back = 0;
  while (end > 0 && back < 4 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
    back += 1;
  }
  return end;
}

export interface ParsedCsv {
  rows: string[][];
  /** More rows exist than were parsed. */
  truncated: boolean;
  columnCount: number;
}

export function csvDelimiterForPath(filePath: string, sample: string): "," | "\t" | ";" {
  if (fileExtension(filePath) === "tsv") return "\t";
  const firstLine = sample.slice(0, sample.indexOf("\n") === -1 ? sample.length : sample.indexOf("\n"));
  const commas = (firstLine.match(/,/g) ?? []).length;
  const semicolons = (firstLine.match(/;/g) ?? []).length;
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  if (tabs > commas && tabs >= semicolons) return "\t";
  if (semicolons > commas) return ";";
  return ",";
}

/** RFC 4180: quoted fields, doubled quotes, delimiters and line breaks inside quotes, CRLF or LF. */
export function parseCsv(text: string, delimiter: string, rowLimit = FILE_PREVIEW_CSV_ROW_LIMIT): ParsedCsv {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let columnCount = 0;
  let index = 0;
  const length = text.length;
  const pushRow = (): boolean => {
    row.push(field);
    field = "";
    columnCount = Math.max(columnCount, row.length);
    rows.push(row);
    row = [];
    return rows.length >= rowLimit;
  };
  while (index < length) {
    const char = text[index];
    if (inQuotes) {
      if (char === "\"") {
        if (text[index + 1] === "\"") {
          field += "\"";
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === "\"" && field === "") {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      index += 1;
      if (pushRow()) {
        return { rows, truncated: index < length, columnCount };
      }
      continue;
    }
    field += char;
    index += 1;
  }
  if (field !== "" || row.length > 0) {
    pushRow();
  }
  return { rows, truncated: false, columnCount };
}
