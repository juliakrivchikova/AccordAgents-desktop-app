import { claudeProjectsDir } from "../../memberSessionFiles";
import { readCliHelpText } from "../../cliHelpText";
import type { ClaudeChromeSetting, ConversationKind, ParticipantConfig } from "../../../../shared/types";
import { filterAllowedAgentEnvironment } from "../../../../shared/agentEnvironment";
import { CommandError, commandEnvironment, ensureLoginShellEnvPrimed, resolveCommandPath, runCommand } from "../../command";
import {
  claudeChromeEditEnvironment, claudeChromeEnvironmentDecides, claudeChromeLaunchFlag, claudeChromeSettingsEdit,
  readClaudeChromeSetting
} from "../../claudeChrome";
import type { ParticipantRunResult } from "../../providers";
import { CLAUDE_CODE_COMMAND_ENV_OPTIONS } from "./commandEnvironment";
import { claudeToolListArg, redactedClaudeArgs, stableToolInventoryHash } from "./launch";
import { claudeDenialLayerLabel, claudePermissionDenials } from "./output";
import type { ClaudePermissionDenialDiagnostic, ClaudeToolConfig } from "./types";
import { CLAUDE_MODEL_PROBE_TIMEOUT_MS } from "../models/claudeModelProbe";
import { agentModeForRun, agentRunEnv } from "../runs/runEnvironment";
import type { ClaudePermissionDenialLayer, CliAgentRunOptions } from "../types";
import { warmAgentKey, warmAgentScopeKey, warmKeyClaudeChrome } from "../warm/warmKeys";
import type { CliModules } from "../modules";
import type { CliDependencies } from "../dependencies";

/** Claude Code's own settings, version and launch on this device. */
export class ClaudeSettings {
  private claudeVersionRequest?: Promise<string | undefined>;
  /** Per Claude executable: whether its CLI has `--prompt-suggestions`. An
   *  older CLI rejects the unknown flag and would fail every turn. */
  private readonly claudePromptSuggestionsSupport = new Map<string, Promise<boolean>>();

  constructor(
    private readonly cli: Pick<CliModules, "cliRuns" | "warmAgents">,
    private readonly deps: Pick<CliDependencies, "debugLogs" | "manualReadinessEnvironment">
  ) {}

  /** The environment members on this computer get (Settings → Environment
   *  included), for the CLI's Chrome setting read and written from Settings. */
  private async claudeSettingsEnvironment(): Promise<NodeJS.ProcessEnv> {
    await ensureLoginShellEnvPrimed();
    const manual = filterAllowedAgentEnvironment((await this.deps.manualReadinessEnvironment?.().catch(() => undefined))?.env);
    return commandEnvironment(Object.keys(manual).length > 0 ? manual : undefined, CLAUDE_CODE_COMMAND_ENV_OPTIONS);
  }

  /** Where this device's Claude Code keeps its members' sessions (the
   *  environment members get decides it: CLAUDE_CONFIG_DIR on a machine). */
  async claudeProjectsDirectory(): Promise<string> {
    return claudeProjectsDir(await this.claudeSettingsEnvironment());
  }

  /** Claude in Chrome as this computer's Claude Code has it (`/chrome`). */
  async claudeChromeSetting(): Promise<ClaudeChromeSetting> {
    const env = await this.claudeSettingsEnvironment();
    const setting = await readClaudeChromeSetting(env);
    return claudeChromeEnvironmentDecides(env) ? { ...setting, environmentDecides: true } : setting;
  }

  /** Changes "Enabled by default" through the CLI's own command. Members
   *  pick it up with their next turn once their process is idle. */
  async setClaudeChromeEnabledByDefault(enabled: boolean): Promise<ClaudeChromeSetting> {
    const env = claudeChromeEditEnvironment(await this.claudeSettingsEnvironment());
    try {
      const executable = await resolveCommandPath("claude", env);
      // The whole environment, so the session markers removed above are not
      // merged back from this process's own.
      await runCommand(executable, ["edit-chrome-settings", "--json"], { env, exactEnv: true, input: claudeChromeSettingsEdit(enabled), timeoutMs: 30_000 });
    } catch (error) {
      const result = error instanceof CommandError ? error.result : undefined;
      const said = (result?.stderr || result?.stdout || (error instanceof Error ? error.message : "")).trim().split("\n").pop();
      throw new Error(`Claude Code did not change the setting${said ? `: ${said}` : "."}`);
    }
    void this.cli.cliRuns.writeDebugLog("cli.claude.chrome-setting", { enabledByDefault: enabled });
    return this.claudeChromeSetting();
  }

  /** The run's `--chrome`, decided from the CLI's setting in the environment
   *  the member's CLI gets (a member on a machine: that machine's Claude
   *  Code). Only chat members get it: the app's own runs (an avatar, say)
   *  start without the User's connectors at all. While the member's process
   *  is busy (answering, or carrying background tasks) a change waits for it:
   *  like the dedicated CLI, a session already running keeps what it started
   *  with, and nothing waits. A run that would not use that process anyway (a
   *  goal, or other settings changed too) gets the setting as it is now. */
  async withClaudeChrome(
    participant: ParticipantConfig,
    repoPath: string | undefined,
    kind: ConversationKind,
    options: CliAgentRunOptions
  ): Promise<CliAgentRunOptions> {
    if (options.claudeChrome !== undefined || options.isolated || kind !== "chat") return options;
    await ensureLoginShellEnvPrimed();
    const env = commandEnvironment(agentRunEnv(options), CLAUDE_CODE_COMMAND_ENV_OPTIONS);
    const setting = await readClaudeChromeSetting(env).catch(() => ({ enabledByDefault: false }));
    const wanted = claudeChromeLaunchFlag(setting, env);
    if (options.warm && !options.nativeGoal) {
      const scopeKey = warmAgentScopeKey(options.warm);
      const busy = Array.from(this.cli.warmAgents.entries.values()).find((entry) => entry.scopeKey === scopeKey && !entry.closed && entry.isIdle?.() === false);
      const running = busy ? warmKeyClaudeChrome(busy.key) : undefined;
      if (running !== undefined && running !== wanted &&
        busy!.key === warmAgentKey(participant, repoPath, kind, { ...options, claudeChrome: running })) {
        void this.cli.cliRuns.writeDebugLog("cli.claude.chrome-change-deferred", { participantId: options.warm.participantId, wanted });
        return { ...options, claudeChrome: running };
      }
    }
    return { ...options, claudeChrome: wanted };
  }

  logClaudeLaunch(
    participant: ParticipantConfig,
    repoPath: string | undefined,
    kind: ConversationKind,
    options: CliAgentRunOptions,
    args: string[],
    toolConfig: ClaudeToolConfig,
    extraReadableDirs: string[],
    transport: "one-shot" | "one-shot-stream" | "warm"
  ): void {
    if (!this.deps.debugLogs) {
      return;
    }
    const allowedTools = claudeToolListArg(args, "--allowedTools");
    const disallowedTools = claudeToolListArg(args, "--disallowedTools");
    void this.claudeVersionForDiagnostics().then((providerVersion) => this.cli.cliRuns.writeDebugLog("cli.claude.launch", {
      layer: "app-launch-argv-policy",
      providerKind: participant.kind,
      providerVersion: providerVersion ?? "unknown",
      participantId: participant.id,
      model: participant.model ?? null,
      mode: agentModeForRun(kind, options),
      permissionMode: toolConfig.permissionMode,
      cwd: repoPath ?? null,
      transport,
      sessionKind: options.sessionId ? "resume" : options.forkFromSessionId ? "fork" : "cold",
      argv: redactedClaudeArgs(args),
      allowedTools: {
        count: allowedTools.length,
        hash: stableToolInventoryHash(allowedTools)
      },
      disallowedTools: {
        count: disallowedTools.length,
        hash: stableToolInventoryHash(disallowedTools)
      },
      autoPreauthorizedAppTools: {
        count: options.appMcp?.autoPreauthorizedToolNames?.length ?? 0,
        hash: stableToolInventoryHash(options.appMcp?.autoPreauthorizedToolNames ?? [])
      },
      addDirs: extraReadableDirs
    })).catch(() => undefined);
  }

  claudeSupportsPromptSuggestions(claudeExecutable: string): Promise<boolean> {
    let request = this.claudePromptSuggestionsSupport.get(claudeExecutable);
    if (!request) {
      request = readCliHelpText(
        claudeExecutable,
        commandEnvironment({}, CLAUDE_CODE_COMMAND_ENV_OPTIONS),
        CLAUDE_MODEL_PROBE_TIMEOUT_MS
      )
        .then((help) => {
          const supported = /(^|\s)--prompt-suggestions\b/m.test(help);
          void this.cli.cliRuns.writeDebugLog("cli.claude.prompt-suggestions-probe", {
            executable: claudeExecutable,
            supported,
            helpChars: help.length
          });
          return supported;
        })
        .catch((error: unknown) => {
          void this.cli.cliRuns.writeDebugLog("cli.claude.prompt-suggestions-probe-failed", {
            executable: claudeExecutable,
            message: error instanceof Error ? error.message.slice(0, 300) : String(error)
          });
          // Ask again next time rather than keep suggestions off for the session.
          this.claudePromptSuggestionsSupport.delete(claudeExecutable);
          return false;
        });
      this.claudePromptSuggestionsSupport.set(claudeExecutable, request);
    }
    return request;
  }

  private claudeVersionForDiagnostics(): Promise<string | undefined> {
    if (!this.claudeVersionRequest) {
      this.claudeVersionRequest = this.cli.cliRuns.providerExecutableForRun("claude", {}, CLAUDE_CODE_COMMAND_ENV_OPTIONS)
        .then((claudeExecutable) => runCommand(claudeExecutable, ["--version"], {
          timeoutMs: CLAUDE_MODEL_PROBE_TIMEOUT_MS,
          envOptions: CLAUDE_CODE_COMMAND_ENV_OPTIONS
        }))
        .then((result) => result.stdout.trim() || undefined)
        .catch(() => undefined);
    }
    return this.claudeVersionRequest;
  }

  withClaudePermissionDenialWarning(
    result: ParticipantRunResult,
    raw: unknown,
    participant: ParticipantConfig,
    transport: "one-shot" | "one-shot-stream" | "warm"
  ): ParticipantRunResult {
    const denials = claudePermissionDenials(raw);
    if (denials.length === 0) {
      return result;
    }
    const byLayer = new Map<ClaudePermissionDenialLayer, ClaudePermissionDenialDiagnostic[]>();
    for (const denial of denials) {
      byLayer.set(denial.layer, [...(byLayer.get(denial.layer) ?? []), denial]);
    }
    for (const [layer, layerDenials] of byLayer) {
      void this.cli.cliRuns.writeDebugLog("cli.claude.permission-denial", {
        providerKind: participant.kind,
        participantId: participant.id,
        transport,
        layer,
        count: layerDenials.length,
        toolNames: Array.from(new Set(layerDenials.map((denial) => denial.toolName))).sort(),
        decisionCodes: Array.from(new Set(layerDenials.map((denial) => denial.decisionCode))).sort(),
        missingEvidence: Array.from(new Set(layerDenials.flatMap((denial) => denial.missingEvidence ?? []))).sort()
      });
    }
    if (result.ok) {
      return result;
    }
    const toolNames = Array.from(new Set(denials.map((denial) => denial.toolName))).sort();
    const layers = Array.from(byLayer.keys()).map((layer) => claudeDenialLayerLabel(layer));
    return {
      ...result,
      warnings: [
        ...(result.warnings ?? []),
        `${participant.label}: Claude failed after ${denials.length} denied action${denials.length === 1 ? "" : "s"} at ${layers.join(" and ")}${toolNames.length > 0 ? ` (${toolNames.join(", ")})` : ""}.`
      ]
    };
  }
}
