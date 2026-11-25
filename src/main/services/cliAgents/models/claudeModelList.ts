import { randomUUID } from "node:crypto";
import type { ProviderModel } from "../../../../shared/types";
import { spawnCommand } from "../../command";
import { terminateProcess } from "../../processTermination";
import { MAX_CLI_ERROR_CHARS } from "../constants";
import { claudeModelProbeEnv, dedupeProviderModels } from "./claudeModelProbe";
import { textField, withCliStartModel } from "./startDefaults";

/** How long Claude Code gets to say its settings after its model list. */
const CLAUDE_SETTINGS_READ_TIMEOUT_MS = 4_000;

const CLAUDE_MODEL_LIST_TIMEOUT_MS = 12_000;

/** How long the CLI gets to exit by itself after its stdin closes (it takes
 *  under a second), and then after a polite stop, before it is killed. */
const CLAUDE_MODEL_LIST_EXIT_GRACE_MS = 3_000;

const CLAUDE_MODEL_LIST_KILL_GRACE_MS = 1_500;

/** The initialize answer also lists every command and skill, so it is larger
 *  than the picker screen. */
const CLAUDE_MODEL_LIST_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Claude Code's own model list, as its `/model` picker shows it (including
 *  "More models"), from the `models` field of its answer to an SDK
 *  `initialize` request. "Default" is the inherited setting, so it is not a
 *  model to pick; the model it resolves to is marked recommended. */
export function parseClaudeInitializeModels(value: unknown, appliedModel?: string): ProviderModel[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const records = value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  const text = (record: Record<string, unknown>, key: string): string | undefined => {
    const field = record[key];
    return typeof field === "string" && field.trim() ? field.trim() : undefined;
  };
  const defaultModel = records.find((record) => text(record, "value") === "default");
  const recommendedModel = defaultModel ? text(defaultModel, "resolvedModel") : undefined;
  let recommendedMarked = false;
  const models: ProviderModel[] = [];
  const resolved = new Map<string, string>();
  for (const record of records) {
    const id = text(record, "value");
    if (!id || id === "default") {
      continue;
    }
    const resolvedModel = text(record, "resolvedModel");
    if (resolvedModel && !resolved.has(id)) resolved.set(id, resolvedModel);
    const recommended: boolean = !recommendedMarked && recommendedModel !== undefined && resolvedModel === recommendedModel;
    recommendedMarked ||= recommended;
    models.push({
      id,
      label: text(record, "displayName") ?? id,
      description: text(record, "description"),
      source: "cli",
      recommended
    });
  }
  const listed = dedupeProviderModels(models);
  // The model Claude Code says it applies (her settings' `model`, or
  // ANTHROPIC_MODEL), by the first entry that resolves to it: what a member
  // without a model of its own runs.
  const applied = appliedModel?.trim();
  return applied ? withCliStartModel(listed, applied, (model) => model.id === applied || resolved.get(model.id) === applied) : listed;
}

/** The model and effort Claude Code says it applies (its `get_settings`
 *  answer's `applied`), from the settings it read. */
export function claudeAppliedSettings(value: unknown): { model?: string; effort?: string } {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const applied = record?.applied && typeof record.applied === "object" && !Array.isArray(record.applied) ? record.applied as Record<string, unknown> : undefined;
  const model = textField(applied?.model);
  const effort = textField(applied?.effort);
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

export class ClaudeModelListTimeoutError extends Error {
  constructor(detail: string) {
    super(`Claude Code did not list its models in time${detail ? `: ${detail}` : "."}`);
    this.name = "ClaudeModelListTimeoutError";
  }
}

/** Asks Claude Code for its models the way its SDK does: one `initialize`
 *  control request in stream-json mode. No prompt is sent, so no model is
 *  called and no session is written. Resolves with the whole answer (its
 *  `models` and `account`). Once answered, stdin is closed so the CLI exits on
 *  its own; a CLI still running after a grace period is stopped with its
 *  children. */
export function runClaudeModelListProbe({
  executable,
  env,
  cwd,
  spawnClaude = spawnCommand,
  timeoutMs = CLAUDE_MODEL_LIST_TIMEOUT_MS,
  maxOutputBytes = CLAUDE_MODEL_LIST_MAX_OUTPUT_BYTES,
  exitGraceMs = CLAUDE_MODEL_LIST_EXIT_GRACE_MS,
  killGraceMs = CLAUDE_MODEL_LIST_KILL_GRACE_MS,
  settingsTimeoutMs = CLAUDE_SETTINGS_READ_TIMEOUT_MS
}: {
  executable: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  spawnClaude?: typeof spawnCommand;
  timeoutMs?: number;
  maxOutputBytes?: number;
  exitGraceMs?: number;
  killGraceMs?: number;
  /** How long the CLI gets to answer `get_settings` once its models are in. */
  settingsTimeoutMs?: number;
}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const requestId = `accordagents-models-${randomUUID()}`;
    const settingsRequestId = `accordagents-settings-${randomUUID()}`;
    // The initialize answer, once in: then its settings are asked (the model
    // and effort it applies), and a CLI that does not say gives the answer
    // alone.
    let initialized: Record<string, unknown> | undefined;
    let settingsTimer: NodeJS.Timeout | undefined;
    const child = spawnClaude(
      executable,
      ["-p", "--safe-mode", "--no-chrome", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
      {
        cwd,
        env: claudeModelProbeEnv(env),
        stdio: ["pipe", "pipe", "pipe"],
        // Its own process group, so a stop reaches what it started; no console window on Windows.
        detached: process.platform !== "win32",
        windowsHide: true
      }
    );
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    let pending = "";
    let stderr = "";
    let capturedBytes = 0;
    let finished = false;
    const running = (): boolean => child.exitCode === null && child.signalCode === null;
    const retire = (): void => {
      child.stdin?.end();
      if (!running()) {
        return;
      }
      const stop = setTimeout(() => {
        if (!running()) {
          return;
        }
        terminateProcess(child, "SIGTERM", true);
        const kill = setTimeout(() => {
          if (running()) {
            terminateProcess(child, "SIGKILL", true);
          }
        }, killGraceMs);
        kill.unref();
      }, exitGraceMs);
      stop.unref();
    };
    const finish = (error?: Error, answer?: Record<string, unknown>): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      if (settingsTimer) clearTimeout(settingsTimer);
      retire();
      if (error) {
        reject(error);
        return;
      }
      resolve(answer ?? {});
    };
    const stderrDetail = (): string => stderr.trim().slice(0, MAX_CLI_ERROR_CHARS);
    const readLine = (line: string): void => {
      let message: Record<string, unknown> | undefined;
      try {
        const parsed: unknown = JSON.parse(line);
        message = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
      } catch {
        return;
      }
      const response = message?.type === "control_response" && message.response && typeof message.response === "object"
        ? message.response as Record<string, unknown>
        : undefined;
      if (!response) {
        return;
      }
      if (initialized && response.request_id === settingsRequestId) {
        const settings = response.subtype === "success" && response.response && typeof response.response === "object" ? response.response as Record<string, unknown> : undefined;
        finish(undefined, settings ? { ...initialized, appliedSettings: settings } : initialized);
        return;
      }
      if (response.request_id !== requestId || initialized) {
        return;
      }
      if (response.subtype !== "success") {
        finish(new Error(`Claude Code did not list its models: ${typeof response.error === "string" ? response.error : "initialize failed"}.`));
        return;
      }
      initialized = response.response && typeof response.response === "object" ? response.response as Record<string, unknown> : {};
      clearTimeout(timeout);
      settingsTimer = setTimeout(() => finish(undefined, initialized), settingsTimeoutMs);
      settingsTimer.unref?.();
      child.stdin?.write(`${JSON.stringify({ type: "control_request", request_id: settingsRequestId, request: { subtype: "get_settings" } })}\n`);
    };
    const timeout = setTimeout(() => finish(new ClaudeModelListTimeoutError(stderrDetail())), timeoutMs);
    timeout.unref();
    child.stdout?.on("data", (chunk: string | Buffer) => {
      const value = String(chunk);
      capturedBytes += Buffer.byteLength(value);
      if (capturedBytes > maxOutputBytes) {
        finish(new Error(`Claude Code's model list exceeded ${maxOutputBytes} bytes of output.`));
        return;
      }
      pending += value;
      let newline = pending.indexOf("\n");
      while (newline >= 0 && !finished) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) {
          readLine(line);
        }
        newline = pending.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk: string | Buffer) => {
      if (stderr.length < MAX_CLI_ERROR_CHARS * 4) {
        stderr += String(chunk);
      }
    });
    child.stdin?.on("error", () => undefined);
    child.once("error", (error) => finish(error));
    // "close", not "exit": the answer may still be in the stdout pipe at exit.
    child.once("close", (code) => {
      if (pending.trim()) {
        readLine(pending.trim());
        pending = "";
      }
      if (initialized) {
        finish(undefined, initialized);
        return;
      }
      const detail = stderrDetail();
      finish(new Error(`Claude Code exited with code ${code ?? "unknown"} before listing its models${detail ? `: ${detail}` : "."}`));
    });
    child.stdin?.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } })}\n`);
  });
}
