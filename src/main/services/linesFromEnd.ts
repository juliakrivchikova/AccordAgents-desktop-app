import { open } from "node:fs/promises";

const CHUNK_BYTES = 256 * 1024;
const NEWLINE = 0x0a;

/**
 * Calls `visit` with the lines of a text file, last line first, until it returns
 * true. Only the tail of the file that is needed is read, so finding the newest
 * entry of a CLI session log costs the same for a 1 MB log as for a 120 MB one.
 * A missing or unreadable file visits nothing. Lines are split on "\n" in bytes
 * (which never occurs inside a multi-byte UTF-8 character) and may keep a
 * trailing "\r".
 */
export async function visitLinesFromEnd(filePath: string, visit: (line: string) => boolean): Promise<void> {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return;
  }
  try {
    let position = (await handle.stat()).size;
    let carry = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(chunk, filled, length - filled, position + filled);
        if (bytesRead === 0) {
          break;
        }
        filled += bytesRead;
      }
      const buffer = carry.length > 0 ? Buffer.concat([chunk.subarray(0, filled), carry]) : chunk.subarray(0, filled);
      let end = buffer.length;
      let newline = end > 0 ? buffer.lastIndexOf(NEWLINE, end - 1) : -1;
      while (newline >= 0) {
        if (visit(buffer.toString("utf8", newline + 1, end))) {
          return;
        }
        end = newline;
        newline = end > 0 ? buffer.lastIndexOf(NEWLINE, end - 1) : -1;
      }
      // The start of this chunk may be the end of a line that began earlier.
      carry = Buffer.from(buffer.subarray(0, end));
    }
    if (carry.length > 0) {
      visit(carry.toString("utf8"));
    }
  } catch {
    // An unreadable log has no usage to report.
  } finally {
    await handle.close().catch(() => undefined);
  }
}
