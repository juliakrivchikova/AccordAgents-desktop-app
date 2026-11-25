import { lstat, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ProviderModel } from "../../../../shared/types";
import { CommandError, runCommand, spawnCommand } from "../../command";
import { CLAUDE_CODE_FORCE_SESSION_PERSISTENCE_ENV, CLAUDE_CODE_SKIP_PROMPT_HISTORY_ENV } from "../claude/commandEnvironment";
import { MAX_CLI_ERROR_CHARS } from "../constants";
import { CLAUDE_EXECUTABLE_ENV } from "./constants";

export const CLAUDE_MODEL_PROBE_TIMEOUT_MS = 8_000;
const CLAUDE_WINDOWS_MODEL_PROBE_TIMEOUT_MS = 12_000;
const CLAUDE_MODEL_PROBE_MAX_OUTPUT_BYTES = 256 * 1024;

/** The app's own empty folder for the Windows model picker when no project
 *  folder is known or Claude Code does not trust it. Not the folder the app
 *  was started in: that is its install folder, which changes with every
 *  update and which Claude Code does not trust. */
export const CLAUDE_MODEL_PROBE_DIR = "claude-model-probe";

const CLAUDE_FOLDER_TRUST_PROMPT = /Quick\s+safety\s+check|Yes,?\s+I\s+trust\s+this\s+folder/i;
const CLAUDE_FOLDER_TRUST_CHOICE = /[❯›>]\s*(?:\d+\.\s*)?(No,?\s*exit|Yes,?\s*I\s*trust\s*this\s*folder)/gi;
const CLAUDE_FOLDER_TRUST_MAX_KEYS = 3;
const CLAUDE_FOLDER_TRUST_KEY_INTERVAL_MS = 1_000;

// eslint-disable-next-line no-control-regex
export const ANSI_ESCAPE_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

interface ClaudeModelProbePty {
  write(data: string): void;
  kill(): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export type ClaudeModelProbePtySpawn = (
  executable: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
) => ClaudeModelProbePty;

export type ClaudeModelProbeExpectSpawn = typeof spawnCommand;

interface ClaudeModelProbePtyOptions {
  executable: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  spawnPty: ClaudeModelProbePtySpawn;
  /** The app's own empty probe folder. Claude Code's folder trust question is
   *  answered with Yes only when `cwd` is this folder: a project folder's
   *  trust is the User's to give. */
  ownFolder?: string;
  trustKeyIntervalMs?: number;
  timeoutMs?: number;
  initialDelayMs?: number;
  pickerSettleDelayMs?: number;
  exitDelayMs?: number;
  maxOutputBytes?: number;
}

interface ClaudeModelProbeExpectOptions {
  executable: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  expectScript: string;
  spawnExpect?: ClaudeModelProbeExpectSpawn;
  expectCommand?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export class ClaudeFolderNotTrustedError extends Error {
  constructor(readonly folder: string) {
    super(`Claude Code requires this folder to be trusted: ${folder}. Open Claude Code there and complete its trust prompt, then refresh models.`);
    this.name = "ClaudeFolderNotTrustedError";
  }
}

export function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[\d+(?:;\d+)?G/g, " ")
    .replace(/\u001b\[\d+C/g, " ")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[0-9=>]/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "");
}

export function parseClaudeModelPickerOutput(output: string): ProviderModel[] {
  const text = stripAnsi(output)
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "\n");
  const footerMarker = "Enter to set";
  const footerIndexes = [...text.matchAll(/Enter to set/g)].map((match) => match.index ?? -1).filter((index) => index >= 0);
  const pickerFooter = footerIndexes.at(-1) ?? -1;
  let pickerHeading = -1;
  for (const match of text.matchAll(/Select\s*m\s*odel/ig)) {
    const index = match.index ?? -1;
    if (index >= 0) {
      pickerHeading = index;
    }
  }
  const lastFooterEnd = pickerFooter >= 0 ? pickerFooter + footerMarker.length : 0;
  const trailingText = text.slice(lastFooterEnd);
  const trailingRows = [...trailingText.matchAll(/\d+\.\s+[A-Za-z]/g)];
  const trailingRowsStart = trailingRows.length >= 2
    && /Default\s*\(recommended\)/i.test(trailingText)
    && /Esc\s+to\s+cancel/i.test(trailingText)
    ? lastFooterEnd + (trailingRows[0].index ?? 0)
    : -1;
  // ConPTY exposes terminal redraws as a linear transcript. Read only the
  // latest identifiable frame. A redraw may fragment either boundary, so the
  // preceding complete footer or guarded picker rows are also safe boundaries.
  if (pickerHeading < 0 && pickerFooter < 0 && trailingRowsStart < 0) {
    return [];
  }
  const precedingFooterEnd = footerIndexes.length > 1
    ? footerIndexes[footerIndexes.length - 2] + footerMarker.length
    : 0;
  const start = Math.max(pickerHeading, precedingFooterEnd, trailingRowsStart, 0);
  const end = pickerFooter >= start ? pickerFooter : -1;
  const body = text.slice(start, end > start ? end : undefined);
  const models: ProviderModel[] = [];
  let defaultAlias: string | undefined;
  // ConPTY reports cursor-positioned redraws as a linear byte stream, so the
  // end of one description can touch the next numbered item ("tasks2.").
  // Numbered picker rows are still authoritative boundaries even without
  // intervening whitespace.
  const itemPattern = /(?:[❯›>]\s*)?(\d+)\.\s+([A-Za-z][A-Za-z0-9_-]*)(?:\s+|(?=\())([\s\S]*?)(?=(?:[❯›>]\s*)?\d+\.\s+[A-Za-z]|●\s+|Enter\s+to|$)/g;

  for (const match of body.matchAll(itemPattern)) {
    const alias = match[2]?.trim();
    const details = match[3]?.replace(/\s+/g, " ").trim() ?? "";
    if (!alias) {
      continue;
    }
    const id = alias.toLowerCase();
    if (id === "default") {
      const defaultMatch = details.match(/(?:✔\s*)?([A-Za-z][A-Za-z0-9_-]*)\s+\d/);
      defaultAlias = defaultMatch?.[1]?.toLowerCase();
      continue;
    }
    const leadingSonnetVersion = id === "sonnet" ? details.match(/^(\d+(?:\.\d+)?)\s*(?=\()/)?.[1] : undefined;
    const normalizedDetails = leadingSonnetVersion ? details.slice(leadingSonnetVersion.length).trim() : details;
    const titleDetail = normalizedDetails.match(/^\(([^)]+)\)\s*(.*)$/);
    const collapsedSonnetVersion = alias.match(/^Sonnet(\d+(?:\.\d+)?)$/i)?.[1];
    const displayAlias = leadingSonnetVersion || collapsedSonnetVersion
      ? `Sonnet ${leadingSonnetVersion ?? collapsedSonnetVersion}`
      : alias;
    const contextLabel = titleDetail?.[1].replace(/^1Mcontext$/i, "1M context");
    const displayName = titleDetail ? `${displayAlias} (${contextLabel})` : displayAlias;
    const description = titleDetail ? titleDetail[2].trim() : details;
    const modelId = claudeModelIdFromPickerItem(id, displayName, description);
    models.push({
      id: modelId,
      label: description ? `${displayName} (${description})` : displayName,
      description: description || undefined,
      source: "cli",
      recommended: defaultAlias === id || defaultAlias === modelId
    });
  }

  return dedupeProviderModels(models);
}

export function claudeModelProbeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const probeEnv: NodeJS.ProcessEnv = {
    ...env,
    [CLAUDE_CODE_SKIP_PROMPT_HISTORY_ENV]: "1"
  };
  delete probeEnv[CLAUDE_CODE_FORCE_SESSION_PERSISTENCE_ENV];
  return probeEnv;
}

export async function resolveClaudeModelProbeCwd(probeCwd?: string, fallback = process.cwd()): Promise<string> {
  const candidate = probeCwd?.trim();
  if (!candidate) {
    return fallback;
  }
  const info = await stat(candidate).catch(() => undefined);
  return info?.isDirectory() ? candidate : fallback;
}

/** Reads the model picker in `cwd`, or in the app's own folder when `cwd` is
 *  that folder or a project folder Claude Code does not trust. Only the app's
 *  own folder ever gets its trust question answered. */
export async function probeClaudeModelsInFolder(
  cwd: string,
  ownFolder: string | undefined,
  probe: (folder: string) => Promise<string>
): Promise<string> {
  if (!ownFolder) {
    return probe(cwd);
  }
  if (cwd !== ownFolder) {
    try {
      return await probe(cwd);
    } catch (error) {
      if (!(error instanceof ClaudeFolderNotTrustedError)) throw error;
    }
  }
  await prepareOwnProbeFolder(ownFolder);
  return probe(ownFolder);
}

/** Claude Code records a folder's trust for the git work tree around it, so
 *  the app's own folder is made its own work tree: otherwise answering Yes in
 *  a userData that sits inside a repository (a home folder kept in git) would
 *  trust that whole repository. A link is refused for the same reason. */
async function prepareOwnProbeFolder(ownFolder: string): Promise<void> {
  await mkdir(ownFolder, { recursive: true });
  if ((await lstat(ownFolder)).isSymbolicLink()) {
    throw new Error(`${ownFolder} is a link, so the app does not answer Claude Code's trust question there.`);
  }
  if (!(await stat(path.join(ownFolder, ".git")).catch(() => undefined))) {
    try {
      await runCommand("git", ["init", "--quiet"], { cwd: ownFolder, timeoutMs: 10_000 });
    } catch (error) {
      const detail = error instanceof CommandError ? error.result.stderr.trim() || error.message : error instanceof Error ? error.message : String(error);
      throw new Error(`Could not prepare ${ownFolder} for reading Claude Code's models: git init failed (${detail}).`);
    }
  }
}

export function runClaudeModelProbeWithExpect({
  executable,
  env,
  cwd,
  expectScript,
  spawnExpect = spawnCommand,
  expectCommand = "expect",
  timeoutMs = CLAUDE_MODEL_PROBE_TIMEOUT_MS,
  maxOutputBytes = CLAUDE_MODEL_PROBE_MAX_OUTPUT_BYTES
}: ClaudeModelProbeExpectOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawnExpect(expectCommand, ["-c", expectScript], {
      cwd,
      env: {
        ...claudeModelProbeEnv(env),
        [CLAUDE_EXECUTABLE_ENV]: executable
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let output = "";
    let stderr = "";
    let capturedBytes = 0;
    let finished = false;

    const finish = (error?: Error): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGTERM");
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(output);
    };

    const capture = (chunk: unknown, destination: "output" | "stderr"): void => {
      const value = String(chunk);
      capturedBytes += Buffer.byteLength(value);
      if (capturedBytes > maxOutputBytes) {
        finish(new Error(`Claude model picker probe exceeded ${maxOutputBytes} bytes of output.`));
        return;
      }
      if (destination === "output") {
        output += value;
      } else {
        stderr += value;
      }
    };

    const timeout = setTimeout(() => {
      if (parseClaudeModelPickerOutput(output).length > 0) {
        finish();
        return;
      }
      finish(new Error(`Claude model picker probe timed out${stderr.trim() ? `: ${stderr.trim().slice(0, MAX_CLI_ERROR_CHARS)}` : ""}`));
    }, timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk) => capture(chunk, "output"));
    child.stderr.on("data", (chunk) => capture(chunk, "stderr"));
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (finished) {
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      finish(new Error(`Claude model picker probe exited with code ${code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim().slice(0, MAX_CLI_ERROR_CHARS)}` : ""}`));
    });
  });
}

export function runClaudeModelProbeInPty({
  executable,
  env,
  cwd,
  spawnPty,
  ownFolder,
  trustKeyIntervalMs = CLAUDE_FOLDER_TRUST_KEY_INTERVAL_MS,
  timeoutMs = CLAUDE_WINDOWS_MODEL_PROBE_TIMEOUT_MS,
  initialDelayMs = 1_500,
  pickerSettleDelayMs = 750,
  exitDelayMs = 250,
  maxOutputBytes = CLAUDE_MODEL_PROBE_MAX_OUTPUT_BYTES
}: ClaudeModelProbePtyOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output = "";
    let capturedBytes = 0;
    let trustAnswering = false;
    let trustAccepted = false;
    let trustKeys = 0;
    let trustFrameStart = 0;
    let modelCommandAt = -1;
    let modelCommandScheduled = false;
    let pickerObserved = false;
    let pickerClosed = false;
    let exitRequested = false;
    let finished = false;
    let exited = false;
    const timers = new Set<NodeJS.Timeout>();
    const schedule = (callback: () => void, delayMs: number): void => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback();
      }, delayMs);
      timers.add(timer);
    };

    let terminal: ClaudeModelProbePty;
    try {
      // A color terminal, whatever the app inherited: with NO_COLOR (or no
      // TERM) Claude Code redraws only the moved marker of the trust
      // question, not the highlighted choice the probe reads.
      const probeEnv: NodeJS.ProcessEnv = { ...claudeModelProbeEnv(env), TERM: "xterm-256color" };
      delete probeEnv.NO_COLOR;
      terminal = spawnPty(executable, ["--safe-mode", "--no-chrome"], {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd,
        env: Object.fromEntries(Object.entries(probeEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      });
    } catch (error) {
      reject(error);
      return;
    }

    let dataSubscription: { dispose(): void } | undefined;
    let exitSubscription: { dispose(): void } | undefined;
    let pickerCloseTimer: NodeJS.Timeout | undefined;
    const finish = (error?: Error): void => {
      if (finished) {
        return;
      }
      finished = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      dataSubscription?.dispose();
      exitSubscription?.dispose();
      if (!exited) {
        try {
          terminal.kill();
        } catch {
          // The short-lived picker process may have exited between the check and kill.
        }
      }
      if (error) {
        reject(error);
      } else {
        resolve(output);
      }
    };

    const armTimeout = (): void => schedule(() => finish(new Error("Claude model picker probe timed out.")), timeoutMs);
    armTimeout();

    // Claude Code 2.1.316 highlights "No, exit" first. Enter goes only once a
    // frame drawn since the last key shows Yes highlighted; Down otherwise,
    // and again when a key drew nothing (it was lost).
    const answerTrust = (): void => {
      if (finished || trustAccepted) {
        return;
      }
      const drawn = output.slice(trustFrameStart);
      const choice = [...stripAnsi(drawn).matchAll(CLAUDE_FOLDER_TRUST_CHOICE)].at(-1)?.[1];
      if (choice && /^Yes/i.test(choice)) {
        trustAccepted = true;
        terminal.write("\r");
        // The picker gets its own full time, as on every later run.
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        armTimeout();
        return;
      }
      if (choice || !drawn) {
        if (trustKeys >= CLAUDE_FOLDER_TRUST_MAX_KEYS) {
          finish(new Error(`Claude Code's trust question for ${cwd} could not be answered.`));
          return;
        }
        trustKeys += 1;
        trustFrameStart = output.length;
        terminal.write("\u001b[B");
      }
      schedule(answerTrust, trustKeyIntervalMs);
    };

    dataSubscription = terminal.onData((data) => {
      capturedBytes += Buffer.byteLength(data);
      if (capturedBytes > maxOutputBytes) {
        finish(new Error(`Claude model picker probe exceeded ${maxOutputBytes} bytes of output.`));
        return;
      }
      output += data;
      const plainOutput = stripAnsi(output);
      if (!trustAccepted && CLAUDE_FOLDER_TRUST_PROMPT.test(plainOutput)) {
        if (cwd !== ownFolder) {
          finish(new ClaudeFolderNotTrustedError(cwd));
        } else if (!trustAnswering) {
          trustAnswering = true;
          schedule(answerTrust, trustKeyIntervalMs);
        }
        return;
      }
      const mainPromptReady = /Safe\s+mode:/i.test(plainOutput)
        && /Transcript\s+saving\s+is\s+off/i.test(plainOutput);
      if (!modelCommandScheduled && mainPromptReady) {
        modelCommandScheduled = true;
        schedule(() => {
          modelCommandAt = output.length;
          terminal.write("/model\r");
        }, initialDelayMs);
      }
      // Only the picker /model opens counts: the trust question has its own
      // "Esc to cancel", which may arrive after Yes was chosen.
      if (modelCommandAt >= 0 && /(?:Esc\s*to\s*cancel|\bcancel\b)/i.test(stripAnsi(output.slice(modelCommandAt)))) {
        pickerObserved = true;
      }
      if (pickerObserved && !pickerClosed) {
        if (pickerCloseTimer) {
          clearTimeout(pickerCloseTimer);
          timers.delete(pickerCloseTimer);
        }
        pickerCloseTimer = setTimeout(() => {
          timers.delete(pickerCloseTimer!);
          pickerCloseTimer = undefined;
          if (finished || pickerClosed) {
            return;
          }
          pickerClosed = true;
          terminal.write("\u001b");
          schedule(() => {
            exitRequested = true;
            terminal.write("/exit\r");
            // Match the existing macOS expect probe: once the authoritative
            // picker was captured, a slow CLI exit must not turn discovery into
            // a hard-coded fallback or leave a process behind.
            schedule(() => finish(), 2_000);
          }, exitDelayMs);
        }, pickerSettleDelayMs);
        timers.add(pickerCloseTimer);
      }
    });
    exitSubscription = terminal.onExit(({ exitCode }) => {
      exited = true;
      if (pickerClosed && (exitRequested || exitCode === 0)) {
        finish();
      } else {
        finish(new Error(`Claude model picker probe exited with code ${exitCode}.`));
      }
    });
  });
}

function claudeModelIdFromPickerItem(alias: string, displayName: string, description: string): string {
  const oneMillionContext = /\b1M\s*context\b/i.test(`${displayName} ${description}`);
  const collapsedSonnetVersion = alias.match(/^sonnet(\d+(?:\.\d+)?)$/i)?.[1];
  if ((alias === "sonnet" || collapsedSonnetVersion) && oneMillionContext) {
    const version = `${displayName} ${description}`.match(/\bSonnet\s*(\d+(?:\.\d+)?)/i)?.[1]
      ?? description.match(/^(\d+(?:\.\d+)?)/)?.[1]
      ?? collapsedSonnetVersion;
    if (version) {
      return `claude-sonnet-${version.replace(/\./g, "-")}[1m]`;
    }
  }
  return alias;
}

export function dedupeProviderModels(models: ProviderModel[]): ProviderModel[] {
  const seen = new Set<string>();
  const deduped: ProviderModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    deduped.push({ ...model, id });
  }
  return deduped;
}
