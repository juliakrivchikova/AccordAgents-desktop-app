import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AvatarStudioCandidate,
  AvatarStudioRunner,
  AvatarStudioTurnRequest,
  AvatarStudioTurnResult
} from "../../shared/avatarStudio";
import type { AvatarImageMediaType } from "../../shared/avatarStudio";
import { avatarImageDataUrl, avatarImageExtension, avatarImageMediaType } from "../../shared/avatarStudio";
import type { ParticipantConfig } from "../../shared/types";
import type { CliAgentRunner } from "./cliAgents";
import type { DebugLogService } from "./debugLogs";

export interface AvatarStudioServiceOptions {
  cliRunner: CliAgentRunner;
  /** Where per-session working directories live (under Electron userData). */
  workRoot: string;
  /** Directory holding avatar-studio.md. */
  promptRoot: string;
  debugLogs?: DebugLogService;
}

interface StudioSession {
  /** One CLI session per provider: switching provider starts a fresh one. */
  sessionId?: string;
  workDir: string;
  /** Turns that produced a picture; a failed turn must not count as context. */
  drawnTurns: number;
  /** The starting picture is written once per session, not once per attempt. */
  seeded?: boolean;
  /** The model/effort the live session was started with, to spot a change. */
  runnerSignature?: string;
}

// Deliberately shorter than a chat turn: the user is watching a modal, not
// running a task, and a stuck draw should say so rather than hold the window.
const RUN_TIMEOUT_MS = 10 * 60_000;
// A drawn avatar is a small picture. Anything larger is a runaway file, and it
// would travel base64 over IPC, into React state and into userData.
const MAX_CANDIDATE_BYTES = 4 * 1024 * 1024;
const STUDIO_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

interface CandidateStamp {
  at: number;
  size: number;
}

// One studio window can talk to several providers in turn, so sessions are keyed
// by window and provider. Switching back to a provider resumes its own session.
function sessionKey(studioId: string, runner: AvatarStudioRunner): string {
  return `${studioId}:${runner.kind}`;
}

function runnerSignature(runner: AvatarStudioRunner): string {
  return `${runner.model ?? ""}|${runner.reasoningEffort ?? ""}`;
}

// The studio id comes from the renderer and becomes a directory that is later
// removed recursively, so it never gets to contain a path.
function assertStudioId(studioId: string): void {
  if (!STUDIO_ID_PATTERN.test(studioId)) {
    throw new Error("Bad studio id.");
  }
}

export class AvatarStudioService {
  private readonly sessions = new Map<string, StudioSession>();
  private readonly runs = new Map<string, AbortController>();
  private instructions?: string;

  constructor(private readonly options: AvatarStudioServiceOptions) {}

  async runTurn(request: AvatarStudioTurnRequest): Promise<AvatarStudioTurnResult> {
    const prompt = request.prompt.trim();
    if (!prompt) {
      return { ok: false, error: "Напишите, что нарисовать." };
    }
    assertStudioId(request.studioId);
    const key = sessionKey(request.studioId, request.runner);
    const session = await this.sessionFor(key, request.studioId, request.runner);
    // Codex ignores --model on resume, so a changed model or effort has to start
    // a new session instead of silently answering with the old one.
    const signature = runnerSignature(request.runner);
    if (session.sessionId && session.runnerSignature !== signature) {
      session.sessionId = undefined;
      session.drawnTurns = 0;
    }
    session.runnerSignature = signature;
    const controller = new AbortController();
    this.runs.set(request.studioId, controller);
    if (!session.seeded && request.baseCandidate) {
      await this.writeCandidateFile(session.workDir, request.baseCandidate);
      session.seeded = true;
    }
    const before = await this.candidateStamps(session.workDir);
    try {
      const participant: ParticipantConfig = {
        id: `avatar-studio-${request.runner.kind}`,
        kind: request.runner.kind,
        label: "Avatar studio",
        model: request.runner.model,
        reasoningEffort: request.runner.reasoningEffort
      };
      const result = await this.options.cliRunner.run(
        participant,
        await this.buildPrompt(request, session, before.size),
        session.workDir,
        undefined,
        "chat",
        controller.signal,
        {
          persistSession: true,
          sessionId: session.sessionId,
          timeoutMs: RUN_TIMEOUT_MS,
          allowEmptyContent: true,
          permissions: {
            repoRead: true,
            workspaceWrite: true,
            webAccess: false,
            requestParticipants: "deny",
            shell: { enabled: true, rules: [] }
          },
          agentMode: "default",
          isolated: true,
          onSessionId: (sessionId) => {
            session.sessionId = sessionId;
          }
        }
      );
      // A cancelled run can surface either as a thrown abort or as a failed
      // result, depending on where the CLI was when the signal arrived.
      if (controller.signal.aborted) {
        return { ok: false, error: "Отменено." };
      }
      const candidate = await this.newestCandidate(session.workDir, before, request.runner);
      if (candidate) {
        session.drawnTurns += 1;
      }
      if (!candidate) {
        return {
          ok: false,
          reply: result.content?.trim() || undefined,
          error: result.ok
            ? "Рисующий ответил, но не сохранил картинку. Попробуйте ещё раз или смените провайдера."
            : result.error ?? "Рисующий не смог нарисовать."
        };
      }
      return { ok: true, candidate: { ...candidate, note: result.content?.trim() || undefined }, reply: result.content?.trim() || undefined };
    } catch (error) {
      if (controller.signal.aborted) {
        return { ok: false, error: "Отменено." };
      }
      const message = error instanceof Error ? error.message : String(error);
      void this.options.debugLogs?.write("avatar-studio.error", { studioId: request.studioId, message });
      return { ok: false, error: message };
    } finally {
      if (this.runs.get(request.studioId) === controller) {
        this.runs.delete(request.studioId);
      }
    }
  }

  cancel(studioId: string): void {
    if (!STUDIO_ID_PATTERN.test(studioId)) {
      return;
    }
    this.runs.get(studioId)?.abort();
    this.runs.delete(studioId);
  }

  /** Closing the window ends its sessions and removes their scratch files. */
  async closeStudio(studioId: string): Promise<void> {
    if (!STUDIO_ID_PATTERN.test(studioId)) {
      return;
    }
    this.cancel(studioId);
    const prefix = `${studioId}:`;
    for (const [key, session] of [...this.sessions.entries()]) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      this.sessions.delete(key);
      await rm(session.workDir, { recursive: true, force: true }).catch(() => {});
    }
    // Drop the studio's own directory, not just each provider's subdirectory.
    const studioDir = path.join(this.options.workRoot, studioId);
    if (studioDir.startsWith(`${this.options.workRoot}${path.sep}`)) {
      await rm(studioDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Cancels every run and clears the scratch root: quit, and once at startup. */
  async shutdown(): Promise<void> {
    for (const controller of this.runs.values()) {
      controller.abort();
    }
    this.runs.clear();
    this.sessions.clear();
    await rm(this.options.workRoot, { recursive: true, force: true }).catch(() => {});
  }

  private async sessionFor(key: string, studioId: string, runner: AvatarStudioRunner): Promise<StudioSession> {
    const existing = this.sessions.get(key);
    if (existing) {
      return existing;
    }
    const workDir = path.join(this.options.workRoot, studioId, runner.kind);
    await mkdir(workDir, { recursive: true });
    const session: StudioSession = { workDir, drawnTurns: 0 };
    this.sessions.set(key, session);
    return session;
  }

  private async buildPrompt(request: AvatarStudioTurnRequest, session: StudioSession, existingCandidates: number): Promise<string> {
    const instructions = await this.loadInstructions();
    const next = existingCandidates + 1;
    const lines = [
      `Working directory for this session: ${session.workDir}`,
      `Save this turn's picture as candidate-${next}.svg (drawn with code) or candidate-${next}.png (image tool) in that directory.`,
      `Member: @${request.member.handle}${request.member.roleLabel ? ` — ${request.member.roleLabel}` : ""}`,
      "",
      "Request:",
      request.prompt.trim()
    ];
    // A fresh session (first turn, or the user switched provider) has no memory of
    // the picture on screen, so the starting point travels in the prompt.
    if (session.drawnTurns === 0 && request.baseCandidate) {
      lines.splice(3, 0, "Start from the current candidate already saved in that directory, and change only what the request asks for.");
    }
    return `${instructions}\n\n---\n\n${lines.join("\n")}`;
  }

  private async loadInstructions(): Promise<string> {
    if (this.instructions) {
      return this.instructions;
    }
    const file = path.join(this.options.promptRoot, "avatar-studio.md");
    const raw = await readFile(file, "utf8");
    // Strip the maintainer comment; the agent only needs the guidelines.
    this.instructions = raw.replace(/^<!--[\s\S]*?-->\s*/, "").trim();
    return this.instructions;
  }

  // Only real files count. A symlink the agent dropped in would otherwise let it
  // hand the app any file on disk as "the avatar it drew".
  private async candidateStamps(workDir: string): Promise<Map<string, CandidateStamp>> {
    const entries = await readdir(workDir, { withFileTypes: true }).catch(() => []);
    const names = entries
      .filter((entry) => entry.isFile() && avatarImageMediaType(entry.name) !== undefined)
      .map((entry) => entry.name)
      .sort();
    const stamps = new Map<string, CandidateStamp>();
    for (const name of names) {
      const info = await lstat(path.join(workDir, name)).catch(() => undefined);
      stamps.set(name, { at: info?.mtimeMs ?? 0, size: info?.isFile() ? info.size : 0 });
    }
    return stamps;
  }

  private async newestCandidate(
    workDir: string,
    before: Map<string, CandidateStamp>,
    runner: AvatarStudioRunner
  ): Promise<AvatarStudioCandidate | undefined> {
    const after = await this.candidateStamps(workDir);
    // A new name is the normal case; an agent that overwrites the name it was
    // given counts too, but only when the file actually changed. Anything left
    // untouched from an earlier turn belongs to that turn, not this one.
    const newest = [...after.entries()]
      .filter(([, stamp]) => stamp.size > 0 && stamp.size <= MAX_CANDIDATE_BYTES)
      .filter(([entry, stamp]) => {
        const previous = before.get(entry);
        return !previous || previous.at !== stamp.at || previous.size !== stamp.size;
      })
      .map(([entry, stamp]) => ({ entry, ...stamp }))
      .sort((left, right) => right.at - left.at)[0];
    if (!newest) {
      return undefined;
    }
    const mediaType = avatarImageMediaType(newest.entry);
    if (!mediaType) {
      return undefined;
    }
    const bytes = await readFile(path.join(workDir, newest.entry));
    return {
      id: randomUUID(),
      mediaType,
      dataUrl: avatarImageDataUrl(mediaType, bytes.toString("base64")),
      drawnBy: runner,
      createdAt: new Date().toISOString()
    };
  }

  /** Puts a picture into the session directory so a fresh session can start from it. */
  private async writeCandidateFile(
    workDir: string,
    candidate: { mediaType: AvatarImageMediaType; dataUrl: string }
  ): Promise<void> {
    const existing = await this.candidateStamps(workDir);
    const name = `candidate-${existing.size + 1}.${avatarImageExtension(candidate.mediaType)}`;
    const base64 = candidate.dataUrl.slice(candidate.dataUrl.indexOf(",") + 1);
    await writeFile(path.join(workDir, name), Buffer.from(base64, "base64"));
  }
}
