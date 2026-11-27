import { MEMORY_BODY_MAX_BYTES, MEMORY_TITLE_MAX_CHARS } from "../../../shared/memory";
import { withoutSecretLines } from "../../../shared/secretPatterns";

/** A Markdown file's YAML front matter, read as flat `key: value` lines
 *  (nested keys such as `metadata.type` keep their last part), and the rest. */
export function splitFrontMatter(text: string): { fields: Record<string, string>; content: string } {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) return { fields: {}, content: normalized };
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const field = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!field) continue;
    const value = unquote(field[2].trim());
    // A top-level key wins over a nested one of the same name.
    const nested = /^\s/.test(line);
    if (!value || (nested && fields[field[1]] !== undefined)) continue;
    fields[field[1]] = value;
  }
  return { fields, content: normalized.slice(match[0].length) };
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
    const inner = value.slice(1, -1);
    return value.startsWith("\"") ? inner.replace(/\\"/g, "\"").replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
  }
  return value;
}

/** A title as a note keeps it: one line, at most the note's limit. */
export function noteTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > MEMORY_TITLE_MAX_CHARS ? `${chars.slice(0, MEMORY_TITLE_MAX_CHARS - 1).join("")}…` : flat;
}

/**
 * A body as a note keeps it: without the lines that look like they hold a
 * secret, and cut at a line under the note's size limit (saying where the
 * rest is). `dropped`: how many lines were left out as secrets.
 */
export function noteBody(text: string, file: string): { body: string; dropped: number } {
  const clean = withoutSecretLines(text);
  const body = clean.text.replace(/\n{3,}/g, "\n\n").trim();
  if (Buffer.byteLength(body) <= MEMORY_BODY_MAX_BYTES) return { body, dropped: clean.dropped };
  const tail = `\n\n…(cut here; the whole entry is ${file} on its device)`;
  const room = MEMORY_BODY_MAX_BYTES - Buffer.byteLength(tail);
  const kept: string[] = [];
  let size = 0;
  for (const line of body.split("\n")) {
    const lineSize = Buffer.byteLength(line) + 1;
    if (size + lineSize > room) break;
    kept.push(line);
    size += lineSize;
  }
  // A single line longer than the limit: cut inside it, never inside a character.
  if (!kept.length) {
    let cut = "";
    let bytes = 0;
    for (const char of body) {
      bytes += Buffer.byteLength(char);
      if (bytes > room) break;
      cut += char;
    }
    kept.push(cut);
  }
  return { body: `${kept.join("\n").trimEnd()}${tail}`, dropped: clean.dropped };
}

/** A file name shown with `~` for the home folder. */
export function displayPath(file: string, home: string): string {
  return home && (file === home || file.startsWith(`${home}/`) || file.startsWith(`${home}\\`)) ? `~${file.slice(home.length)}` : file;
}
