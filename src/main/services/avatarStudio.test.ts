import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AvatarStudioService } from "./avatarStudio";
import type { CliAgentRunner } from "./cliAgents";
import type { ParticipantConfig } from "../../shared/types";

interface RecordedRun {
  participant: ParticipantConfig;
  prompt: string;
  repoPath: string | undefined;
  signal: AbortSignal | undefined;
  options: Record<string, unknown>;
}

async function studio(draw: (workDir: string, run: RecordedRun) => Promise<{ ok: boolean; content?: string; error?: string }>): Promise<{
  service: AvatarStudioService;
  runs: RecordedRun[];
  workRoot: string;
}> {
  const workRoot = await mkdtemp(path.join(tmpdir(), "avatar-studio-test-"));
  const promptRoot = await mkdtemp(path.join(tmpdir(), "avatar-studio-prompt-"));
  await writeFile(path.join(promptRoot, "avatar-studio.md"), "<!-- internal -->\n\n# Avatar Studio\n\nHouse style.\n");
  const runs: RecordedRun[] = [];
  const cliRunner = {
    async run(
      participant: ParticipantConfig,
      prompt: string,
      repoPath: string | undefined,
      _diffMode: unknown,
      _kind: unknown,
      signal: AbortSignal | undefined,
      options: Record<string, unknown>
    ) {
      const run = { participant, prompt, repoPath, signal, options };
      runs.push(run);
      (options.onSessionId as ((id: string) => void) | undefined)?.(`session-${runs.length}`);
      const outcome = await draw(repoPath as string, run);
      return { participant, ok: outcome.ok, content: outcome.content ?? "", error: outcome.error };
    }
  } as unknown as CliAgentRunner;
  return { service: new AvatarStudioService({ cliRunner, workRoot, promptRoot }), runs, workRoot };
}

const SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\"><circle cx=\"128\" cy=\"128\" r=\"100\"/></svg>";

const REQUEST = {
  studioId: "studio-1",
  prompt: "нарисуй лису",
  runner: { kind: "claude-code" } as const,
  member: { handle: "gera", roleLabel: "Software Engineer" }
};

test("a saved picture becomes the candidate the studio shows", async () => {
  const { service, runs } = await studio(async (workDir) => {
    await writeFile(path.join(workDir, "candidate-1.svg"), SVG);
    return { ok: true, content: "Рыжая лиса." };
  });
  const result = await service.runTurn(REQUEST);
  assert.equal(result.ok, true);
  assert.equal(result.candidate?.mediaType, "image/svg+xml");
  assert.match(result.candidate?.dataUrl ?? "", /^data:image\/svg\+xml;base64,/);
  assert.equal(result.reply, "Рыжая лиса.");
  assert.equal(result.candidate?.drawnBy.kind, "claude-code");
  // The agent is told where to save and which number to use.
  assert.match(runs[0].prompt, /candidate-1\.svg/);
  assert.match(runs[0].prompt, /@gera — Software Engineer/);
  assert.match(runs[0].prompt, /House style\./);
  assert.doesNotMatch(runs[0].prompt, /internal/);
});

test("a run that writes nothing is a failure the user can act on", async () => {
  const { service } = await studio(async () => ({ ok: true, content: "Готово!" }));
  const result = await service.runTurn(REQUEST);
  assert.equal(result.ok, false);
  assert.equal(result.candidate, undefined);
  assert.match(result.error ?? "", /saved no picture/);
  // The runner's own words still reach the studio chat.
  assert.equal(result.reply, "Готово!");
});

test("a failed run reports the provider's error, not a missing picture", async () => {
  const { service } = await studio(async () => ({ ok: false, error: "claude: not logged in" }));
  const result = await service.runTurn(REQUEST);
  assert.equal(result.ok, false);
  assert.equal(result.error, "claude: not logged in");
});

test("the same provider keeps its session and numbers the next candidate", async () => {
  const { service, runs } = await studio(async (workDir, run) => {
    const index = runs.length;
    await writeFile(path.join(workDir, `candidate-${index}.svg`), SVG);
    return { ok: true, content: run.prompt };
  });
  await service.runTurn(REQUEST);
  const second = await service.runTurn({ ...REQUEST, prompt: "теплее фон" });
  assert.equal(second.ok, true);
  assert.equal(runs.length, 2);
  assert.equal(runs[1].options.sessionId, "session-1");
  assert.match(runs[1].prompt, /candidate-2\.svg/);
  // A resumed session already knows the picture, so nothing is re-seeded.
  assert.doesNotMatch(runs[1].prompt, /Start from the current candidate/);
});

test("switching provider starts a new session seeded with the picture on screen", async () => {
  const { service, runs, workRoot } = await studio(async (workDir) => {
    const existing = (await readdir(workDir)).filter((entry) => entry.endsWith(".svg") || entry.endsWith(".png"));
    await writeFile(path.join(workDir, `candidate-${existing.length + 1}.svg`), SVG);
    return { ok: true };
  });
  const first = await service.runTurn(REQUEST);
  const switched = await service.runTurn({
    ...REQUEST,
    prompt: "то же, но кот",
    runner: { kind: "codex-cli" },
    baseCandidate: { mediaType: first.candidate!.mediaType, dataUrl: first.candidate!.dataUrl }
  });
  assert.equal(switched.ok, true);
  assert.equal(switched.candidate?.drawnBy.kind, "codex-cli");
  // A separate directory, seeded with the previous picture as candidate-1.
  assert.notEqual(runs[1].repoPath, runs[0].repoPath);
  assert.equal(runs[1].options.sessionId, undefined);
  assert.match(runs[1].prompt, /Start from the current candidate/);
  const seeded = await readFile(path.join(workRoot, "studio-1", "codex-cli", "candidate-1.svg"), "utf8");
  assert.equal(seeded, SVG);
  // The new candidate is the one this run drew, not the seed.
  assert.match(runs[1].prompt, /candidate-2\.svg/);
});

test("a candidate a provider left from an earlier turn is not reported twice", async () => {
  let drew = 0;
  const { service } = await studio(async (workDir) => {
    drew += 1;
    if (drew === 1) {
      await writeFile(path.join(workDir, "candidate-1.svg"), SVG);
    }
    // The second turn writes nothing: the picture from turn one must not count.
    return { ok: true };
  });
  await service.runTurn(REQUEST);
  const second = await service.runTurn({ ...REQUEST, prompt: "ещё раз" });
  assert.equal(second.ok, false);
  assert.equal(second.candidate, undefined);
});

test("an empty file is not a picture", async () => {
  const { service } = await studio(async (workDir) => {
    await writeFile(path.join(workDir, "candidate-1.svg"), "");
    return { ok: true };
  });
  const result = await service.runTurn(REQUEST);
  assert.equal(result.ok, false);
  assert.equal(result.candidate, undefined);
});

test("closing the studio drops its sessions and scratch files", async () => {
  const { service, runs, workRoot } = await studio(async (workDir) => {
    const existing = (await readdir(workDir)).length;
    await writeFile(path.join(workDir, `candidate-${existing + 1}.svg`), SVG);
    return { ok: true };
  });
  await service.runTurn(REQUEST);
  await service.closeStudio("studio-1");
  assert.deepEqual(await readdir(workRoot), []);
  await service.runTurn(REQUEST);
  // A reopened studio starts clean: no resumed session, numbering from one.
  assert.equal(runs[1].options.sessionId, undefined);
  assert.match(runs[1].prompt, /candidate-1\.svg/);
});

test("an empty request never reaches the provider", async () => {
  const { service, runs } = await studio(async () => ({ ok: true }));
  const result = await service.runTurn({ ...REQUEST, prompt: "   " });
  assert.equal(result.ok, false);
  assert.equal(runs.length, 0);
});

test("cancelling a turn reports it as cancelled, not as an error", async () => {
  const { service } = await studio(async (_workDir, run) => {
    // Stay in flight until the studio cancels, the way a real CLI run does.
    await new Promise<void>((resolve) => {
      run.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new Error("aborted");
  });
  const request = { ...REQUEST, studioId: "studio-cancel" };
  const pending = service.runTurn(request);
  await new Promise((resolve) => setTimeout(resolve, 10));
  service.cancel("studio-cancel");
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error, "Stopped.");
});

test("the drawing run gets its own directory, not the user's repository", async () => {
  const { service, runs, workRoot } = await studio(async (workDir) => {
    await mkdir(workDir, { recursive: true });
    await writeFile(path.join(workDir, "candidate-1.svg"), SVG);
    return { ok: true };
  });
  await service.runTurn(REQUEST);
  assert.equal(runs[0].repoPath, path.join(workRoot, "studio-1", "claude-code"));
  const permissions = runs[0].options.permissions as { workspaceWrite: boolean; webAccess: boolean };
  assert.equal(permissions.workspaceWrite, true);
  assert.equal(permissions.webAccess, false);
});

test("a studio id that is a path is refused before anything is created or removed", async () => {
  const { service, runs, workRoot } = await studio(async () => ({ ok: true }));
  await assert.rejects(() => service.runTurn({ ...REQUEST, studioId: "../escape" }), /Bad studio id/);
  assert.equal(runs.length, 0);
  await service.closeStudio("../escape");
  assert.deepEqual(await readdir(workRoot), []);
});

test("a symlink is not a drawn picture", async () => {
  const secret = path.join(await mkdtemp(path.join(tmpdir(), "avatar-studio-secret-")), "secret.txt");
  await writeFile(secret, "SECRET");
  const { service } = await studio(async (workDir) => {
    await symlink(secret, path.join(workDir, "candidate-1.png"));
    return { ok: true };
  });
  const result = await service.runTurn(REQUEST);
  assert.equal(result.ok, false);
  assert.equal(result.candidate, undefined);
});

test("a runaway file is refused instead of travelling into the app", async () => {
  const { service } = await studio(async (workDir) => {
    await writeFile(path.join(workDir, "candidate-1.png"), Buffer.alloc(5 * 1024 * 1024, 1));
    return { ok: true };
  });
  const result = await service.runTurn(REQUEST);
  assert.equal(result.ok, false);
  assert.equal(result.candidate, undefined);
});

test("a failed turn keeps the picture on screen as the starting point", async () => {
  let attempt = 0;
  const { service, runs } = await studio(async (workDir) => {
    attempt += 1;
    if (attempt === 1) {
      return { ok: false, error: "claude: not logged in" };
    }
    await writeFile(path.join(workDir, "candidate-2.svg"), SVG);
    return { ok: true };
  });
  const base = { mediaType: "image/svg+xml" as const, dataUrl: `data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}` };
  const failed = await service.runTurn({ ...REQUEST, baseCandidate: base });
  assert.equal(failed.ok, false);
  const retried = await service.runTurn({ ...REQUEST, prompt: "ещё раз", baseCandidate: base });
  assert.equal(retried.ok, true);
  // The retry still tells the agent where to start from.
  assert.match(runs[1].prompt, /Start from the current candidate/);
});

test("changing the model starts a new session instead of answering with the old one", async () => {
  const { service, runs } = await studio(async (workDir) => {
    const existing = (await readdir(workDir)).length;
    await writeFile(path.join(workDir, `candidate-${existing + 1}.svg`), SVG);
    return { ok: true };
  });
  await service.runTurn({ ...REQUEST, runner: { kind: "claude-code", model: "sonnet" } });
  await service.runTurn({ ...REQUEST, prompt: "теплее", runner: { kind: "claude-code", model: "opus" } });
  assert.equal(runs[1].options.sessionId, undefined);
  // Same model keeps the session.
  await service.runTurn({ ...REQUEST, prompt: "ещё", runner: { kind: "claude-code", model: "opus" } });
  assert.equal(runs[2].options.sessionId, "session-2");
});

test("shutdown cancels runs and clears the scratch root", async () => {
  const { service, workRoot } = await studio(async (workDir) => {
    await writeFile(path.join(workDir, "candidate-1.svg"), SVG);
    return { ok: true };
  });
  await service.runTurn(REQUEST);
  await service.shutdown();
  assert.equal(await readdir(workRoot).then(() => "exists").catch(() => "gone"), "gone");
});
