import { createHash, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

import { CLI_PROVIDER_SETUP, isCliSignInKind, isCliSignInRunning } from "../../shared/cliReadiness";
import type { CliSignInKind, CliSignInState } from "../../shared/types";
import { CommandError, lookupCommand, refreshLoginShellEnv, runCommand, type CommandEnvironmentOptions } from "./command";

/** The CLI waits for the browser; a sign-in nobody finishes is stopped then. */
export const CLI_SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_TAIL_CHARS = 32_768;
const MESSAGE_MAX_CHARS = 240;

/** Hosts whose sign-in page the CLI may print; anything else is not shown. */
const SIGN_IN_PAGE_HOSTS: Record<CliSignInKind, readonly string[]> = {
  "claude-code": ["claude.ai", "claude.com", "console.anthropic.com", "platform.claude.com"],
  "codex-cli": ["auth.openai.com"]
};

interface SignInDebugLogger {
  write(event: string, payload: Record<string, unknown>): Promise<void>;
}

export interface LocalCliSignInDependencies {
  refreshEnvironment: typeof refreshLoginShellEnv;
  /** The variables the User set in Settings, as members get them. */
  manualEnvironment: () => Promise<NodeJS.ProcessEnv>;
  /** Per CLI, as its members run it (Claude drops auth keys the login shell lacks). */
  envOptions: Partial<Record<CliSignInKind, CommandEnvironmentOptions>>;
  lookup: typeof lookupCommand;
  run: typeof runCommand;
  timeoutMs: number;
  /** Runs before success is reported, so the readiness check that follows
   *  cannot be answered by one started before the credentials existed. */
  onSignedIn: (kind: CliSignInKind) => void;
}

interface ActiveSignIn {
  state: CliSignInState;
  input: PassThrough;
  abort: AbortController;
  /** Claude's `state`: a pasted code must end with it. */
  codeState?: string;
  submittedHash?: string;
  output: string;
}

/**
 * Starts a CLI's own sign-in on this computer, as the User would in Terminal.
 * The CLI opens the browser, receives the answer and stores the credentials
 * where it always does; this only runs it with the members' environment,
 * shows its fallback page, and passes a pasted code to it.
 */
export class LocalCliSignInService {
  private readonly signIns = new Map<CliSignInKind, ActiveSignIn>();
  private readonly dependencies: LocalCliSignInDependencies;
  private revision = 0;

  constructor(
    private readonly publish: (state: CliSignInState) => void,
    dependencies: Partial<LocalCliSignInDependencies> = {},
    private readonly debugLogs?: SignInDebugLogger
  ) {
    this.dependencies = {
      refreshEnvironment: dependencies.refreshEnvironment ?? refreshLoginShellEnv,
      manualEnvironment: dependencies.manualEnvironment ?? (async () => ({})),
      envOptions: dependencies.envOptions ?? {},
      lookup: dependencies.lookup ?? lookupCommand,
      run: dependencies.run ?? runCommand,
      timeoutMs: dependencies.timeoutMs ?? CLI_SIGN_IN_TIMEOUT_MS,
      onSignedIn: dependencies.onSignedIn ?? (() => undefined)
    };
  }

  list(): CliSignInState[] {
    return [...this.signIns.values()].map((signIn) => ({ ...signIn.state }));
  }

  start(kind: unknown): CliSignInState {
    if (!isCliSignInKind(kind)) {
      throw new Error("This provider has no sign-in AccordAgents can start.");
    }
    const current = this.signIns.get(kind);
    if (current && isCliSignInRunning(current.state.status)) {
      return { ...current.state };
    }
    const signIn: ActiveSignIn = {
      state: { kind, requestId: randomUUID(), status: "starting", revision: this.nextRevision() },
      input: new PassThrough(),
      abort: new AbortController(),
      output: ""
    };
    this.signIns.set(kind, signIn);
    this.emit(signIn);
    void this.run(signIn);
    return { ...signIn.state };
  }

  submitCode(requestId: unknown, value: unknown): void {
    const signIn = this.byRequest(requestId);
    if (!signIn || !isCliSignInRunning(signIn.state.status)) {
      throw new Error("This sign-in has ended. Start sign-in again.");
    }
    if (signIn.state.kind !== "claude-code" || !signIn.state.pageGivesCode) {
      throw new Error("This sign-in does not take a code.");
    }
    const code = typeof value === "string" ? value.trim() : "";
    if (code.length > 4096 || !/^[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$/.test(code)) {
      throw new Error("Paste the complete code from the Claude page, including the part after #.");
    }
    if (!signIn.codeState || code.split("#")[1] !== signIn.codeState) {
      throw new Error("This code belongs to another sign-in. Use the page opened from here.");
    }
    const hash = createHash("sha256").update(code).digest("hex");
    if (signIn.submittedHash === hash) {
      return;
    }
    if (signIn.submittedHash) {
      throw new Error("Claude is already checking a code. Wait for the result.");
    }
    signIn.submittedHash = hash;
    signIn.input.write(`${code}\n`);
    this.update(signIn, { status: "checking-code" });
  }

  cancel(requestId: unknown): void {
    const signIn = this.byRequest(requestId);
    if (signIn && isCliSignInRunning(signIn.state.status)) {
      signIn.abort.abort();
    }
  }

  /** Quitting the app ends every sign-in it started. */
  shutdown(): void {
    for (const signIn of this.signIns.values()) {
      signIn.abort.abort();
    }
  }

  private async run(signIn: ActiveSignIn): Promise<void> {
    const { kind } = signIn.state;
    const metadata = CLI_PROVIDER_SETUP[kind];
    const startedAt = Date.now();
    try {
      const environment = await this.dependencies.refreshEnvironment();
      if (!environment.ok) {
        throw new SignInFailure("Could not read this computer's environment to start the sign-in. Try again.");
      }
      const env = { ...environment.env, ...(await this.dependencies.manualEnvironment()) };
      const lookup = await this.dependencies.lookup(metadata.executable, env);
      if (lookup.status === "not-found") {
        throw new SignInFailure(`${metadata.label} was not found on this computer.`);
      }
      if (lookup.status !== "found" || !lookup.path) {
        throw new SignInFailure(`Could not find ${metadata.label} on this computer just now. Try again.`);
      }
      if (signIn.abort.signal.aborted) {
        throw new SignInCancelled();
      }
      const onOutput = (chunk: string): void => this.observe(signIn, chunk);
      // The same words the Terminal fallback shows, minus the program.
      const args = metadata.loginCommand.split(" ").slice(1);
      await this.dependencies.run(lookup.path, args, {
        env,
        envOptions: this.dependencies.envOptions[kind],
        primeLoginShellEnv: false,
        inputStream: signIn.input,
        signal: signIn.abort.signal,
        timeoutMs: this.dependencies.timeoutMs,
        killProcessGroup: true,
        killGroupOnExit: true,
        maxOutputChars: OUTPUT_TAIL_CHARS,
        onSpawn: () => {
          if (signIn.state.status === "starting") this.update(signIn, { status: "waiting" });
        },
        onStdout: onOutput,
        onStderr: onOutput
      });
      this.succeed(signIn, startedAt);
    } catch (error) {
      const exitCode = error instanceof CommandError ? error.result.exitCode : undefined;
      if (error instanceof CommandError && error.result.exitCode === 0 && !error.result.timedOut) {
        // Cancel arrived after the CLI had already signed in and exited.
        this.succeed(signIn, startedAt);
      } else if (signIn.abort.signal.aborted || error instanceof SignInCancelled) {
        this.finish(signIn, { status: "cancelled" }, startedAt, exitCode);
      } else if (error instanceof SignInFailure) {
        this.finish(signIn, { status: "failed", message: error.message }, startedAt, exitCode);
      } else if (error instanceof CommandError && error.result.timedOut) {
        const minutes = Math.max(1, Math.round(this.dependencies.timeoutMs / 60_000));
        this.finish(signIn, {
          status: "failed",
          message: `The sign-in was not finished within ${minutes} ${minutes === 1 ? "minute" : "minutes"} and was stopped. Start it again.`
        }, startedAt, exitCode);
      } else {
        // The card already names the CLI: show its own last word as it is.
        this.finish(signIn, {
          status: "failed",
          message: lastMeaningfulLine(signIn.output) ?? `${metadata.label} sign-in did not finish. Try again.`
        }, startedAt, exitCode, error instanceof Error ? error.name : typeof error);
      }
    } finally {
      signIn.input.end();
    }
  }

  private succeed(signIn: ActiveSignIn, startedAt: number): void {
    try {
      this.dependencies.onSignedIn(signIn.state.kind);
    } catch {
      // A readiness check that is not reset still runs on the next focus.
    }
    this.finish(signIn, { status: "succeeded" }, startedAt, 0);
  }

  private observe(signIn: ActiveSignIn, chunk: string): void {
    signIn.output = (signIn.output + chunk).slice(-OUTPUT_TAIL_CHARS);
    if (signIn.state.pageUrl) {
      return;
    }
    const page = findSignInPage(signIn.state.kind, signIn.output);
    if (!page) {
      return;
    }
    signIn.codeState = page.givesCode ? page.url.searchParams.get("state") ?? undefined : undefined;
    this.update(signIn, { pageUrl: page.url.href, pageGivesCode: page.givesCode && Boolean(signIn.codeState) });
  }

  private finish(
    signIn: ActiveSignIn,
    change: Partial<CliSignInState>,
    startedAt: number,
    exitCode?: number | null,
    errorKind?: string
  ): void {
    this.update(signIn, change);
    // Never the output itself: it carries the sign-in page and its state.
    void this.debugLogs?.write("cli-sign-in.finished", {
      kind: signIn.state.kind,
      status: signIn.state.status,
      durationMs: Date.now() - startedAt,
      codeSubmitted: Boolean(signIn.submittedHash),
      exitCode: exitCode ?? null,
      errorKind: errorKind ?? null,
      message: signIn.state.message ?? null
    }).catch(() => undefined);
  }

  private update(signIn: ActiveSignIn, change: Partial<CliSignInState>): void {
    // A later sign-in of the same CLI replaced this one: it no longer speaks.
    if (this.signIns.get(signIn.state.kind) !== signIn) {
      return;
    }
    signIn.state = { ...signIn.state, ...change, revision: this.nextRevision() };
    this.emit(signIn);
  }

  private emit(signIn: ActiveSignIn): void {
    try {
      this.publish({ ...signIn.state });
    } catch {
      // A closed window misses the update and reads the list when it opens.
    }
  }

  private byRequest(requestId: unknown): ActiveSignIn | undefined {
    return [...this.signIns.values()].find((signIn) => signIn.state.requestId === requestId);
  }

  private nextRevision(): number {
    this.revision += 1;
    return this.revision;
  }
}

class SignInFailure extends Error {}
class SignInCancelled extends Error {}

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** The page the CLI printed for when the browser did not open. Only a whole
 *  URL counts (output arrives in pieces), and only on the provider's hosts. */
export function findSignInPage(kind: CliSignInKind, output: string): { url: URL; givesCode: boolean } | undefined {
  const visible = output.replace(ANSI_PATTERN, "");
  for (const match of visible.matchAll(/https:\/\/[^\s"'<>]+(?=\s)/g)) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    if (!SIGN_IN_PAGE_HOSTS[kind].includes(url.hostname) || url.username || url.password || (url.port && url.port !== "443")) {
      continue;
    }
    if (!/\/oauth\/authorize$/.test(url.pathname)) {
      continue;
    }
    return { url, givesCode: kind === "claude-code" && !redirectsToThisComputer(url) };
  }
  return undefined;
}

function redirectsToThisComputer(url: URL): boolean {
  const redirect = url.searchParams.get("redirect_uri");
  if (!redirect) return false;
  try {
    const host = new URL(redirect).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** The CLI's own last word, without its URLs and prompts. */
/** What the CLIs print on the way, never the reason a sign-in failed. The
 *  line with the sign-in page (and its state) is one of them. */
const PROGRESS_LINE = /^(Opening browser|If (the|your) browser|Starting local login server|On a remote or headless machine)/i;

/** The CLI's own last word, without its prompts, progress and bare links. An
 *  error that names a URL keeps it: that URL is part of the reason. */
export function lastMeaningfulLine(output: string): string | undefined {
  const lines = output
    .replace(ANSI_PATTERN, "")
    .split(/[\r\n]+/)
    .map((line) => line.replace(/^.*Paste code here if prompted\s*>\s*/i, "").trim())
    .filter((line) => line && !/^https?:\/\/\S+$/.test(line) && !PROGRESS_LINE.test(line));
  const line = lines.at(-1);
  return line ? line.slice(0, MESSAGE_MAX_CHARS) : undefined;
}
