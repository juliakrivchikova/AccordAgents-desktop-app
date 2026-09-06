import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AvatarStudioCandidate,
  AvatarStudioRunner,
  AvatarStudioTurnRequest,
  AvatarStudioTurnResult
} from "../../shared/avatarStudio";
import { avatarImageDataUrl, avatarImageMediaType } from "../../shared/avatarStudio";
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
  turns: number;
}

const RUN_TIMEOUT_MS = 10 * 60_000;

// One studio window can talk to several providers in turn, so sessions are keyed
// by window and provider. Switching back to a provider resumes its own session.
function sessionKey(studioId: string, runner: AvatarStudioRunner): string {
  return `${studioId}:${runner.kind}`;
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
    const key = sessionKey(request.studioId, request.runner);
    const session = await this.sessionFor(key, request.studioId, request.runner);
    const controller = new AbortController();
    this.runs.set(request.studioId, controller);
    const before = await this.candidateFiles(session.workDir);
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
        await this.buildPrompt(request, session, before.length),
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
          onSessionId: (sessionId) => {
            session.sessionId = sessionId;
          }
        }
      );
      session.turns += 1;
      const candidate = await this.newestCandidate(session.workDir, before, request.runner);
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
    this.runs.get(studioId)?.abort();
    this.runs.delete(studioId);
  }

  /** Closing the window ends its sessions and removes their scratch files. */
  async closeStudio(studioId: string): Promise<void> {
    this.cancel(studioId);
    const prefix = `${studioId}:`;
    for (const [key, session] of [...this.sessions.entries()]) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      this.sessions.delete(key);
      await rm(session.workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async sessionFor(key: string, studioId: string, runner: AvatarStudioRunner): Promise<StudioSession> {
    const existing = this.sessions.get(key);
    if (existing) {
      return existing;
    }
    const workDir = path.join(this.options.workRoot, studioId, runner.kind);
    await mkdir(workDir, { recursive: true });
    const session: StudioSession = { workDir, turns: 0 };
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
    if (session.turns === 0 && request.baseCandidateId) {
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

  private async candidateFiles(workDir: string): Promise<string[]> {
    const entries = await readdir(workDir).catch(() => [] as string[]);
    return entries.filter((entry) => avatarImageMediaType(entry) !== undefined).sort();
  }

  private async newestCandidate(
    workDir: string,
    before: string[],
    runner: AvatarStudioRunner
  ): Promise<AvatarStudioCandidate | undefined> {
    const after = await this.candidateFiles(workDir);
    const added = after.filter((entry) => !before.includes(entry));
    const pool = added.length > 0 ? added : [];
    if (pool.length === 0) {
      return undefined;
    }
    const withTimes = await Promise.all(
      pool.map(async (entry) => {
        const info = await stat(path.join(workDir, entry)).catch(() => undefined);
        return { entry, at: info?.mtimeMs ?? 0, size: info?.size ?? 0 };
      })
    );
    const newest = withTimes.filter((item) => item.size > 0).sort((left, right) => right.at - left.at)[0];
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
      dataUrl: avatarImageDataUrl(mediaType, bytes),
      drawnBy: runner,
      createdAt: new Date().toISOString()
    };
  }

  /** Writes a candidate back into the session directory so a new provider can start from it. */
  async seedCandidate(studioId: string, runner: AvatarStudioRunner, candidate: AvatarStudioCandidate): Promise<void> {
    const key = sessionKey(studioId, runner);
    const session = await this.sessionFor(key, studioId, runner);
    const existing = await this.candidateFiles(session.workDir);
    const extension = candidate.mediaType === "image/png" ? "png" : "svg";
    const name = `candidate-${existing.length + 1}.${extension}`;
    const base64 = candidate.dataUrl.slice(candidate.dataUrl.indexOf(",") + 1);
    await writeFile(path.join(session.workDir, name), Buffer.from(base64, "base64"));
  }
}
