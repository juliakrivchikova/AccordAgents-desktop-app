import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

/** One entry of a POSIX (pax) tar archive, by its path relative to the
 *  archive root with "/" separators; "" is the root itself. */
export type TarEntry =
  | { kind: "directory"; path: string; mode: number; mtimeMs: number }
  /** `scriptToLf`: a script written with CRLF goes with LF, as Linux runs it
   *  ("#!/usr/bin/env bash\r" is no interpreter there). */
  | { kind: "file"; path: string; mode: number; mtimeMs: number; size: number; scriptToLf?: boolean }
  | { kind: "symlink"; path: string; mode: number; mtimeMs: number; linkTarget: string };

const MAX_CONVERTED_SCRIPT_BYTES = 1 << 20;

const BLOCK = 512;
const MAX_OCTAL_SIZE = 0o77777777777;

/**
 * The archive of the files under `root` as a byte stream, each file read only
 * when its turn comes and as it is then, as rsync sends it: a file saved
 * since the walk goes with its new size, one deleted since is left out.
 * Written here rather than by Windows' tar.exe because the modes it carries
 * are decided here (Windows keeps none; a file that starts with "#!" is a
 * script) and its names must reach Linux tar as UTF-8 pax records.
 * `onFileBytes` counts file content as it is read. A file that shrinks while
 * it is read fails the stream: padding it would send other content.
 */
export function tarArchive(root: string, entries: Iterable<TarEntry>, onFileBytes?: (bytes: number) => void): Readable {
  return Readable.from(tarChunks(root, entries, onFileBytes), { objectMode: false });
}

async function* tarChunks(root: string, entries: Iterable<TarEntry>, onFileBytes?: (bytes: number) => void): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    if (entry.kind !== "file") {
      yield* entryHeaders(entry);
      continue;
    }
    const handle = await openForCopy(path.join(root, ...entry.path.split("/")), entry.path);
    if (!handle) continue;
    try {
      const stats = await handle.stat();
      const head = Buffer.alloc(2);
      const script = stats.size >= 2 && (await handle.read(head, 0, 2, 0)).bytesRead === 2 && head.toString("latin1") === "#!";
      const file = { ...entry, size: stats.size, mtimeMs: stats.mtimeMs, mode: script ? entry.mode | 0o111 : entry.mode };
      const converted = script && entry.scriptToLf && stats.size <= MAX_CONVERTED_SCRIPT_BYTES ? lfScript(await handle.readFile()) : undefined;
      if (converted) {
        yield* entryHeaders({ ...file, size: converted.length });
        onFileBytes?.(stats.size);
        yield converted;
        if (converted.length % BLOCK) yield Buffer.alloc(BLOCK - (converted.length % BLOCK));
      } else {
        yield* entryHeaders(file);
        yield* fileContent(handle, file, onFileBytes);
      }
    } finally {
      await handle.close();
    }
  }
  yield Buffer.alloc(BLOCK * 2);
}

/** The script with LF line ends when its first line ends in CRLF; otherwise
 *  nothing, and it goes as it is. */
function lfScript(content: Buffer): Buffer | undefined {
  const firstLineEnd = content.indexOf(0x0a);
  if (firstLineEnd < 1 || content[firstLineEnd - 1] !== 0x0d) return undefined;
  return Buffer.from(content.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
}

/** The file to copy, or nothing for one deleted since the walk. A file that
 *  cannot be read stops the copy with what is in the way. */
async function openForCopy(source: string, relative: string): Promise<FileHandle | undefined> {
  try {
    return await open(source, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    const reason = code === "EBUSY"
      ? "it is open in another program. Close it and copy again"
      : code === "EPERM" || code === "EACCES" ? "this computer does not allow reading it" : (error as Error).message;
    throw new Error(`Could not copy ${relative}: ${reason}.`, { cause: error });
  }
}

async function* fileContent(handle: FileHandle, entry: Extract<TarEntry, { kind: "file" }>, onFileBytes?: (bytes: number) => void): AsyncGenerator<Buffer> {
  let remaining = entry.size;
  if (remaining > 0) {
    // Read exactly the entry's bytes: a buffer sized to the file, and no read past its end.
    const stream = handle.createReadStream({ start: 0, end: remaining - 1, highWaterMark: Math.min(remaining, 1 << 20), autoClose: false });
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        remaining -= piece.length;
        onFileBytes?.(piece.length);
        yield piece;
        if (remaining === 0) break;
      }
    } finally {
      stream.destroy();
    }
  }
  if (remaining > 0) {
    throw new Error(`${entry.path} became shorter while it was being copied. Copy again.`);
  }
  const padding = (BLOCK - (entry.size % BLOCK)) % BLOCK;
  if (padding > 0) yield Buffer.alloc(padding);
}

function entryHeaders(entry: TarEntry): Buffer[] {
  const name = entry.kind === "directory" ? (entry.path ? `./${entry.path}/` : "./") : `./${entry.path}`;
  const size = entry.kind === "file" ? entry.size : 0;
  const linkname = entry.kind === "symlink" ? entry.linkTarget : "";
  const pax: string[] = [];
  if (!fitsUstarField(name)) pax.push(paxRecord("path", name));
  if (!fitsUstarField(linkname)) pax.push(paxRecord("linkpath", linkname));
  if (size > MAX_OCTAL_SIZE) pax.push(paxRecord("size", String(size)));
  const mtime = Math.max(0, Math.floor(entry.mtimeMs / 1000));
  const header = ustarHeader({
    name: asciiFallback(name),
    mode: entry.mode,
    size: size > MAX_OCTAL_SIZE ? 0 : size,
    mtime,
    type: entry.kind === "file" ? "0" : entry.kind === "directory" ? "5" : "2",
    linkname: asciiFallback(linkname)
  });
  if (pax.length === 0) return [header];
  const body = Buffer.from(pax.join(""), "utf8");
  const padding = (BLOCK - (body.length % BLOCK)) % BLOCK;
  return [
    ustarHeader({ name: "./PaxHeader", mode: 0o644, size: body.length, mtime, type: "x", linkname: "" }),
    body,
    ...(padding > 0 ? [Buffer.alloc(padding)] : []),
    header
  ];
}

function fitsUstarField(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value) && value.length <= 100;
}

/** The ustar field when a pax record carries the real value: readers that
 *  know pax use the record, and nothing here relies on the others. */
function asciiFallback(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "_").slice(0, 100);
}

/** "<length> <key>=<value>\n", where the length counts its own digits. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bodyLength = Buffer.byteLength(body, "utf8");
  let length = bodyLength + String(bodyLength).length;
  if (String(length).length + bodyLength !== length) length = String(length).length + bodyLength;
  return `${length}${body}`;
}

function ustarHeader(fields: { name: string; mode: number; size: number; mtime: number; type: string; linkname: string }): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(fields.name, 0, 100, "ascii");
  writeOctal(block, 100, 8, fields.mode & 0o7777);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, fields.size);
  writeOctal(block, 136, 12, fields.mtime);
  block.fill(0x20, 148, 156);
  block.write(fields.type, 156, 1, "ascii");
  block.write(fields.linkname, 157, 100, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

function writeOctal(block: Buffer, offset: number, width: number, value: number): void {
  block.write(`${Math.floor(value).toString(8).padStart(width - 1, "0")}\0`, offset, width, "ascii");
}
