import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const TITLE_MAX_CHARS = 120;

/** Text on one line within `max` characters: a title from a prompt, a
 *  reason from an error. */
export function oneLine(text: string | undefined, max = TITLE_MAX_CHARS): string {
  const characters = [...(text ?? "").replace(/\s+/g, " ").trim()];
  return characters.length <= max ? characters.join("") : `${characters.slice(0, max - 1).join("").trimEnd()}…`;
}

/** ISO time of a millisecond count; undefined for none. */
export function isoTime(ms: number | null | undefined): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** A file's lines, one at a time: a transcript can be 270 MB, and this runs
 *  in the app's main process. Leaving the loop early closes the file. */
export async function* fileLines(file: string): AsyncGenerator<string> {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
  } finally {
    lines.close();
    input.destroy();
  }
}

// The blocks apps and CLIs put before her words are named with a "-" or "_"
// (`system-reminder`, `environment_context`); a plain HTML tag she typed
// (`<button>`) is her words and stays.
const LEADING_BLOCK = /^\s*<([a-z][a-z0-9]*[-_][\w-]*)[\s>]/;

/** The tag a text opens with (`<system-reminder>` gives "system-reminder"). */
export function leadingBlockName(text: string): string | undefined {
  return LEADING_BLOCK.exec(text)?.[1];
}

/** What follows the tagged blocks an app puts before her words in a message
 *  (a reminder, the context of a page she was looking at), trimmed; empty
 *  when nothing does or a block never closes. */
export function afterLeadingBlocks(text: string): string {
  let rest = text;
  for (let name = leadingBlockName(rest); name; name = leadingBlockName(rest)) {
    const close = new RegExp(`</${name}(?:\\s[^>]*)?>`).exec(rest);
    if (!close) return "";
    rest = rest.slice(close.index + close[0].length);
  }
  return rest.trim();
}
