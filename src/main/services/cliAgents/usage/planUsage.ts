import { tmpdir } from "node:os";
import type { PlanUsageProvider, PlanUsageSnapshot } from "../../../../shared/types";
import { CommandError, commandEnvironment, ensureLoginShellEnvPrimed, resolveCommandPath, runCommand } from "../../command";
import {
  ANTIGRAVITY_NO_PLAN_EXIT_CODE, CLAUDE_GET_USAGE_CAPABILITY, antigravityPlanUsage, claudePlanUsage, codexPlanUsage,
  mergeClaudeRateLimitEvent, mergeCodexRateLimitsUpdate, noPlanLimits, type ClaudeUsageReading
} from "../../cliPlanUsage";
import { withCodexAppServerOneOff } from "../codex/appServerOneOff";
import { errorText } from "../runs/outputText";
import { asRecord } from "../runs/records";
import type { CliModules } from "../modules";
import type { CliDependencies } from "../dependencies";

/** A card opened, a member's process started, a Gemini turn ended: read
 *  again only when the last read is older than this. */
const READ_AGAIN_AFTER_MS = 60_000;
/** The User pressed Refresh (Antigravity's three-second `/usage` keeps the
 *  minute). */
const FORCED_READ_AFTER_MS = 10_000;
const CLAUDE_GET_USAGE_TIMEOUT_MS = 15_000;
const CODEX_READ_TIMEOUT_MS = 30_000;
const AGY_USAGE_TIMEOUT_MS = 30_000;
/**
 * The plan usage of this device's CLI accounts (cliPlanUsage.ts reads each
 * CLI's shape): one snapshot per CLI, since every member of a CLI on a device
 * runs on its one sign-in (a member on an added provider has no plan and is
 * never read). Claude Code is asked through a member's live process only
 * (a fresh one would run the User's SessionStart hooks); Codex through a
 * short-lived `codex app-server` that runs no turn, as its model list is
 * read; Antigravity by its `/usage` command, one at a time.
 */
export class PlanUsage {
  private readonly snapshots = new Map<PlanUsageProvider, PlanUsageSnapshot>();
  private claude: ClaudeUsageReading = {};
  private codexRead?: Record<string, unknown>;
  private codexAccount?: unknown;
  private readonly lastReadAt = new Map<PlanUsageProvider, number>();
  private readonly reading = new Map<PlanUsageProvider, Promise<void>>();
  private readonly listeners = new Set<(snapshots: PlanUsageSnapshot[]) => void>();
  /** What the listeners were last told of each CLI (without its time), and when. */
  private readonly told = new Map<PlanUsageProvider, { figures: string; at: number }>();

  constructor(
    private readonly cli: Pick<CliModules, "cliRuns" | "warmAgents">,
    private readonly deps: Pick<CliDependencies, "manualReadinessEnvironment">
  ) {}

  list(): PlanUsageSnapshot[] {
    return [...this.snapshots.values()];
  }

  /** Told every change, with all of this device's snapshots. */
  onChanged(listener: (snapshots: PlanUsageSnapshot[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A `rate_limit_event` of a member on the CLI's own sign-in. */
  noteClaudeRateLimitEvent(event: Record<string, unknown>): void {
    this.claude = mergeClaudeRateLimitEvent(this.claude, event, new Date().toISOString());
    this.take("claude-code", claudePlanUsage(this.claude));
  }

  /** A member's Claude Code process that answers `get_usage` started. */
  claudeProcessStarted(): void {
    void this.refresh("claude-code");
  }

  /** `account/rateLimits/updated` from a member's app-server: merged into
   *  the last read, which is read first when there is none. */
  noteCodexRateLimitsUpdated(params: unknown): void {
    if (!this.codexRead) {
      void this.refresh("codex-cli");
      return;
    }
    this.codexRead = mergeCodexRateLimitsUpdate(this.codexRead, params);
    this.take("codex-cli", codexPlanUsage(this.codexRead, this.codexAccount, new Date().toISOString()));
  }

  geminiTurnEnded(): void {
    void this.refresh("gemini-cli");
  }

  /** Reads one CLI's account now, unless it was read a moment ago or is
   *  being read (that read is waited for). */
  refresh(provider: PlanUsageProvider, force = false): Promise<void> {
    // Nothing is read for nobody (a runner in a test, a device that shows
    // and publishes no usage).
    if (this.listeners.size === 0) return Promise.resolve();
    const running = this.reading.get(provider);
    if (running) return running;
    const wait = force && provider !== "gemini-cli" ? FORCED_READ_AFTER_MS : READ_AGAIN_AFTER_MS;
    if (Date.now() - (this.lastReadAt.get(provider) ?? 0) < wait) return Promise.resolve();
    const read = this.readNow(provider, force)
      .catch((error: unknown) => {
        void this.cli.cliRuns.writeDebugLog("cli.plan-usage.read-failed", { provider, error: errorText(error) });
      })
      .finally(() => this.reading.delete(provider));
    this.reading.set(provider, read);
    return read;
  }

  /** `force`: the User pressed Refresh, so the read is told even when its
   *  figures did not change (the card's age moves, a machine puts it). */
  private async readNow(provider: PlanUsageProvider, force: boolean): Promise<void> {
    if (provider === "claude-code") return this.readClaude(force);
    if (provider === "codex-cli") return this.readCodex(force);
    return this.readAntigravity(force);
  }

  private async readClaude(force: boolean): Promise<void> {
    const entry = [...this.cli.warmAgents.entries.values()].find((candidate) => candidate.providerKind === "claude-code" &&
      !candidate.closed && candidate.ownSignIn && candidate.control && candidate.cliCapabilities?.().has(CLAUDE_GET_USAGE_CAPABILITY));
    // No member's Claude Code runs here: it reports with the next reply.
    if (!entry?.control) return;
    this.lastReadAt.set("claude-code", Date.now());
    const answer = await entry.control({ subtype: "get_usage", skip_behaviors: true, detached: true }, CLAUDE_GET_USAGE_TIMEOUT_MS);
    // A full read replaces what the stream said before it.
    this.claude = { usage: { value: answer, at: new Date().toISOString() } };
    this.take("claude-code", claudePlanUsage(this.claude), force);
  }

  private async readCodex(force: boolean): Promise<void> {
    this.lastReadAt.set("codex-cli", Date.now());
    await ensureLoginShellEnvPrimed();
    const executable = await this.cli.cliRuns.codexExecutableForRun();
    const env = commandEnvironment((await this.deps.manualReadinessEnvironment?.())?.env ?? {});
    const { read, account } = await withCodexAppServerOneOff({ executable, env, purpose: "plan usage read", timeoutMs: CODEX_READ_TIMEOUT_MS },
      async ({ request }) => {
        const account = await request("account/read", {});
        const type = asRecord(asRecord(account)?.account)?.type;
        // Signed in with an API key (or not at all): no plan to read.
        if (type !== "chatgpt") return { account, read: undefined };
        return { account, read: await request("account/rateLimits/read", { excludeResetCreditDetails: true }) };
      });
    this.codexAccount = account;
    this.codexRead = asRecord(read);
    this.take("codex-cli", codexPlanUsage(this.codexRead, account, new Date().toISOString()), force);
  }

  private async readAntigravity(force: boolean): Promise<void> {
    this.lastReadAt.set("gemini-cli", Date.now());
    // The login shell's PATH first (as for Codex): right after the packaged
    // app starts, agy is found only through it.
    await ensureLoginShellEnvPrimed();
    const env = commandEnvironment((await this.deps.manualReadinessEnvironment?.())?.env ?? {});
    const executable = await resolveCommandPath("agy", env);
    let stdout: string;
    try {
      stdout = (await runCommand(executable, ["-p", "/usage", "--output-format", "json"], {
        cwd: tmpdir(), env, timeoutMs: AGY_USAGE_TIMEOUT_MS, killProcessGroup: true
      })).stdout;
    } catch (error) {
      // On a Gemini API key `/usage` exits with 2: no plan, no ring.
      if (error instanceof CommandError && error.result.exitCode === ANTIGRAVITY_NO_PLAN_EXIT_CODE) {
        this.take("gemini-cli", noPlanLimits("gemini-cli", new Date().toISOString()), force);
        return;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      throw new Error("agy /usage printed no JSON.");
    }
    this.take("gemini-cli", antigravityPlanUsage(parsed, new Date().toISOString()), force);
  }

  private take(provider: PlanUsageProvider, snapshot: PlanUsageSnapshot | undefined, force = false): void {
    if (!snapshot) return;
    this.snapshots.set(provider, snapshot);
    // The same figures are told again only a minute after they were last
    // told (a stream of unchanged events never holds them back longer), or
    // at once when the User asked.
    const figures = JSON.stringify({ ...snapshot, observedAt: "" });
    const last = this.told.get(provider);
    if (!force && last && last.figures === figures && Date.now() - last.at < READ_AGAIN_AFTER_MS) return;
    this.told.set(provider, { figures, at: Date.now() });
    const all = this.list();
    for (const listener of this.listeners) {
      try {
        listener(all);
      } catch {
        // A listener's failure must not stop the others.
      }
    }
  }
}
