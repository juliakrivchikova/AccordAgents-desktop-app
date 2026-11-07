import { copyFile, link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { PortableMemberSession } from "../../shared/memberSessionMove";
import type { ChatParticipantSession } from "../../shared/types";

/**
 * A Claude Code member's session on disk, and how it travels.
 *
 * Claude keeps a session as `<config>/projects/<folder>/<sessionId>.jsonl`,
 * where `<config>` is CLAUDE_CONFIG_DIR (or `~/.claude`) and `<folder>` is the
 * folder the CLI ran in with every character that is not a letter or a digit
 * written as "-". `--resume <sessionId>` looks for it in the folder of the
 * directory it runs in, so a session taken on another computer is put under
 * the folder the member runs in there.
 */

/** Longer folder names are shortened by the CLI with a hash of its own. */
const CLAUDE_PROJECT_FOLDER_MAX = 200;

const PACK_FORMAT = "accordagents.member-session";
const PACK_VERSION = 1;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Where Claude keeps its sessions for an environment like a member's. */
export function claudeProjectsDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  const home = platform === "win32" ? homedir() : env.HOME?.trim() || homedir();
  return path.join(configDir || path.join(home, ".claude"), "projects");
}

/** The CLI's folder name for a working directory, when it is short enough to
 *  be written without the CLI's own hash; undefined otherwise. */
export function claudeProjectFolderName(cwd: string): string | undefined {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return name.length <= CLAUDE_PROJECT_FOLDER_MAX ? name : undefined;
}

/** The transcript of a session, wherever the CLI put it. */
export async function findClaudeTranscript(projectsDir: string, sessionId: string): Promise<string | undefined> {
  if (!isSafeSessionId(sessionId)) return undefined;
  let folders: string[];
  try {
    folders = await readdir(projectsDir);
  } catch {
    return undefined;
  }
  let newest: { file: string; mtimeMs: number } | undefined;
  for (const folder of folders) {
    const file = path.join(projectsDir, folder, `${sessionId}.jsonl`);
    const info = await stat(file).catch(() => undefined);
    if (info?.isFile() && (!newest || info.mtimeMs > newest.mtimeMs)) newest = { file, mtimeMs: info.mtimeMs };
  }
  return newest?.file;
}

/** Puts a session's transcript where the CLI looks for it when it runs in
 *  `cwd` (the first folder), replacing an older copy there; written whole or
 *  not at all. Further folders it may run in get the same file as a hard
 *  link, so a large session takes its space once and stays one session. */
export async function placeClaudeTranscript(projectsDir: string, cwd: string | readonly string[], sessionId: string, transcript: Buffer): Promise<string> {
  if (!isSafeSessionId(sessionId)) throw new Error("the session's id is not one Claude Code writes");
  const [first, ...others] = typeof cwd === "string" ? [cwd] : [...new Set(cwd)];
  if (!first) throw new Error("there is no folder it runs in");
  const file = await transcriptPathFor(projectsDir, first, sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${sessionId}.${randomUUID()}.moving`);
  try {
    await writeFile(temporary, transcript, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  for (const other of others) {
    const target = await transcriptPathFor(projectsDir, other, sessionId).catch(() => undefined);
    if (!target || target === file) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await rm(target, { force: true });
    await link(file, target).catch(() => copyFile(file, target));
  }
  return file;
}

async function transcriptPathFor(projectsDir: string, cwd: string, sessionId: string): Promise<string> {
  const folder = claudeProjectFolderName(cwd) ?? await existingLongFolder(projectsDir, cwd);
  if (!folder) throw new Error("the folder it runs in has a path too long for Claude Code to find a moved session there");
  return path.join(projectsDir, folder, `${sessionId}.jsonl`);
}

/** A long folder the CLI already made for this directory (its hash is its
 *  own): the one whose name starts like the directory's. */
async function existingLongFolder(projectsDir: string, cwd: string): Promise<string | undefined> {
  const prefix = `${cwd.replace(/[^a-zA-Z0-9]/g, "-").slice(0, CLAUDE_PROJECT_FOLDER_MAX)}-`;
  const folders = await readdir(projectsDir).catch(() => [] as string[]);
  const matches = folders.filter((folder) => folder.startsWith(prefix));
  return matches.length === 1 ? matches[0] : undefined;
}

export async function readClaudeTranscript(file: string): Promise<Buffer> {
  return readFile(file);
}

/** The app's record of a session, without what only the device it left
 *  means (a legacy worker handle, the handoff it was itself taken from). */
export function portableMemberSession(session: ChatParticipantSession): PortableMemberSession {
  const { remoteSession: _remote, invalidatedRemoteSessionId: _invalidated, invalidatedRemoteSessionAt: _invalidatedAt, importedHandoff: _imported, ...portable } = session;
  return portable;
}

interface PackHeader {
  format: typeof PACK_FORMAT;
  version: number;
  provider: "claude-code";
  session: PortableMemberSession;
  /** How far the chat reached the session (the member's prompt context
   *  pointers on the device it left). */
  promptContextPointers?: unknown;
  transcriptBytes: number;
}

/** One body for the User's server: a line naming what it is and the app's
 *  record of the session, then the CLI's transcript as it is on disk; all of
 *  it gzipped off the main thread (a long session is tens of megabytes). */
export async function packMemberSession(session: PortableMemberSession, transcript: Buffer, extra: { promptContextPointers?: unknown } = {}): Promise<Buffer> {
  const header: PackHeader = { format: PACK_FORMAT, version: PACK_VERSION, provider: "claude-code", session,
    ...(extra.promptContextPointers !== undefined ? { promptContextPointers: extra.promptContextPointers } : {}), transcriptBytes: transcript.length };
  return gzipAsync(Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, "utf8"), transcript]));
}

export async function unpackMemberSession(packed: Buffer): Promise<{ provider: "claude-code"; session: PortableMemberSession; transcript: Buffer; promptContextPointers?: unknown }> {
  let bytes: Buffer;
  try {
    bytes = await gunzipAsync(packed);
  } catch {
    throw new Error("the moved session is not one this app packed");
  }
  const end = bytes.indexOf(0x0a);
  if (end < 0) throw new Error("the moved session is not one this app packed");
  let header: Partial<PackHeader>;
  try {
    header = JSON.parse(bytes.subarray(0, end).toString("utf8")) as Partial<PackHeader>;
  } catch {
    throw new Error("the moved session is not one this app packed");
  }
  if (header.format !== PACK_FORMAT || header.provider !== "claude-code") throw new Error("the moved session is not one this app packed");
  if (header.version !== PACK_VERSION) throw new Error("the moved session was packed by a newer version of AccordAgents");
  const session = header.session;
  if (!session || typeof session !== "object" || typeof session.sessionId !== "string" || !isSafeSessionId(session.sessionId)) {
    throw new Error("the moved session names no session");
  }
  const transcript = bytes.subarray(end + 1);
  if (transcript.length !== header.transcriptBytes) throw new Error("the moved session arrived incomplete");
  return { provider: "claude-code", session, transcript, ...(header.promptContextPointers !== undefined ? { promptContextPointers: header.promptContextPointers } : {}) };
}

/** A session id is a file name here: nothing that could leave its folder. */
function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId);
}
