import { homedir } from "node:os";
import type {
  AgentHealth, ChatProviderKind, CliProviderHost, ChatReasoningEffort, ProviderModel, ProviderModelCatalog
} from "../../../../shared/types";
import {
  claudeStartAccess, codexStartAccess, modelNameWithoutId, type CliStartDefaults, type CliStartDefaultsByKind
} from "../../../../shared/cliStartDefaults";
import { GEMINI_API_KEY_SETTINGS, geminiApiKeyEnv } from "../../../../shared/cliProviderHosts";
import { normalizeChatReasoningEffort } from "../../../../shared/reasoningEffort";
import { commandEnvironment, ensureLoginShellEnvPrimed, resolveCommandPath, runCommand, spawnCommand } from "../../command";
import { CLAUDE_CODE_COMMAND_ENV_OPTIONS } from "../claude/commandEnvironment";
import { codexAppServerMessageKind } from "../codex/appServerErrors";
import { codexModelReasoningEfforts } from "../codex/appServerParams";
import { antigravityStartAccess } from "../gemini/runTail";
import {
  claudeAppliedSettings, ClaudeModelListTimeoutError, parseClaudeInitializeModels, runClaudeModelListProbe
} from "./claudeModelList";
import {
  parseClaudeModelPickerOutput, probeClaudeModelsInFolder, resolveClaudeModelProbeCwd, runClaudeModelProbeInPty,
  runClaudeModelProbeWithExpect
} from "./claudeModelProbe";
import { claudeModelProbeExpectScript, dedupeModels, fallbackModelsForKind, withConfiguredModel } from "./modelLists";
import { agyModelsInvocation, cliConfigStamp, parseAgyModelList, textField, withCliStartModel } from "./startDefaults";
import { errorText } from "../runs/outputText";
import { asRecord, stringField } from "../runs/records";
import type { CodexAppServerPendingRequest } from "../types";
import type { CliModules } from "../modules";
import type { CliDependencies } from "../dependencies";

const MODEL_CATALOG_CACHE_MS = 5 * 60_000;
const MODEL_CATALOG_TIMEOUT_MS = 12_000;

/** How long Codex gets to say its config beside its model list. */
const CODEX_CONFIG_READ_TIMEOUT_MS = 4_000;

interface CachedModelCatalog {
  catalog: ProviderModelCatalog;
  expiresAt: number;
  /** The User's CLI config file as it was when the list was read (its start
   *  defaults come from it): another one reads the list again. */
  configStamp?: string;
}

/** listGeminiModelCatalog requestClaudeInitializeAnswer The models and start defaults each CLI offers. */
export class ModelCatalogs {
  private readonly modelCatalogs = new Map<ChatProviderKind, CachedModelCatalog>();
  private readonly modelCatalogRequests = new Map<ChatProviderKind, Promise<ProviderModelCatalog>>();
  /** Antigravity's list on an added provider's Gemini API key, per provider
   *  version (a new key or URL reads it again). */
  private readonly hostModelCatalogs = new Map<string, CachedModelCatalog>();
  private readonly hostModelCatalogRequests = new Map<string, Promise<ProviderModelCatalog>>();

  constructor(
    private readonly cli: Pick<CliModules, "agentReadiness" | "cliRuns">,
    private readonly deps: Pick<
      CliDependencies,
      | "claudeModelProbeDir" | "claudeModelProbeExpectSpawn" | "claudeModelProbePtySpawn" | "debugLogs"
    >
  ) {}

  /** What each CLI installed here starts a new session in with the User's
   *  own config (a machine says it in its hello): read with its model list. */
  async cliStartDefaults(): Promise<CliStartDefaultsByKind | undefined> {
    const agents = await this.cli.agentReadiness.detectAgents().catch(() => [] as AgentHealth[]);
    const result: CliStartDefaultsByKind = {};
    for (const agent of agents) {
      if (!agent.installed || (agent.kind !== "claude-code" && agent.kind !== "codex-cli" && agent.kind !== "gemini-cli")) continue;
      const catalog = await this.listModelCatalog(agent.kind).catch(() => undefined);
      if (catalog?.startDefaults) result[agent.kind] = catalog.startDefaults;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  async listModelCatalog(kind: ChatProviderKind, configuredModel?: string, probeCwd?: string): Promise<ProviderModelCatalog> {
    const cached = this.modelCatalogs.get(kind);
    // Her CLI config changed since the list was read: what a new session
    // starts in (and its model) may have changed with it.
    const configStamp = await cliConfigStamp(kind);
    if (cached && cached.expiresAt > Date.now() && cached.configStamp === configStamp) {
      return kind === "claude-code" && process.platform === "win32"
        ? cached.catalog
        : withConfiguredModel(cached.catalog, configuredModel);
    }

    const fetchedAt = new Date().toISOString();
    const currentRequest = this.modelCatalogRequests.get(kind);
    const request = currentRequest ?? (async (): Promise<ProviderModelCatalog> => {
      const catalog = kind === "codex-cli"
        ? await this.listCodexModelCatalog(fetchedAt)
        : kind === "gemini-cli"
          ? await this.listGeminiModelCatalog(fetchedAt)
          : await this.listClaudeModelCatalog(fetchedAt, probeCwd);
      const normalized = {
        ...catalog,
        models: dedupeModels(catalog.models)
      };
      // A signed-out Claude Code list is provisional (see listClaudeModelCatalog).
      if (!(kind === "claude-code" && !catalog.authoritative)) {
        this.modelCatalogs.set(kind, {
          catalog: normalized,
          expiresAt: Date.now() + MODEL_CATALOG_CACHE_MS,
          configStamp
        });
      }
      return normalized;
    })();
    if (!currentRequest) {
      this.modelCatalogRequests.set(kind, request);
    }

    try {
      const normalized = await request;
      return kind === "claude-code" && process.platform === "win32"
        ? normalized
        : withConfiguredModel(normalized, configuredModel);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.debugLogs?.write("cli.model-catalog.error", { kind, message });
      const failedCatalog: ProviderModelCatalog = {
        kind,
        models: kind === "claude-code" && process.platform === "win32" ? [] : fallbackModelsForKind(kind),
        authoritative: false,
        fetchedAt,
        error: message
      };
      return kind === "claude-code" && process.platform === "win32"
        ? failedCatalog
        : withConfiguredModel(failedCatalog, configuredModel);
    } finally {
      if (this.modelCatalogRequests.get(kind) === request) {
        this.modelCatalogRequests.delete(kind);
      }
    }
  }

  private async listCodexModelCatalog(fetchedAt: string): Promise<ProviderModelCatalog> {
    await ensureLoginShellEnvPrimed();
    const codexExecutable = await this.cli.cliRuns.codexExecutableForRun();
    const child = spawnCommand(codexExecutable, ["app-server", "--listen", "stdio://"], {
      env: commandEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let nextRequestId = 1;
    let stdoutBuffer = "";
    let stderr = "";
    let closed = false;
    const pendingRequests = new Map<number, CodexAppServerPendingRequest>();

    const cleanup = (cause?: Error): void => {
      if (closed) {
        return;
      }
      closed = true;
      const error = cause ?? new Error(`codex app-server model probe ended before receiving a response${stderr.trim() ? `: ${errorText(stderr)}` : ""}`);
      for (const pending of pendingRequests.values()) {
        pending.reject(error);
      }
      pendingRequests.clear();
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGTERM");
      }
    };

    const sendRequest = (method: string, params: unknown): Promise<unknown> => {
      if (closed || child.exitCode !== null || child.killed) {
        return Promise.reject(new Error("codex app-server process is not running"));
      }
      const id = nextRequestId;
      nextRequestId += 1;
      return new Promise<unknown>((resolve, reject) => {
        pendingRequests.set(id, { method, resolve, reject });
        child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
          if (error) {
            pendingRequests.delete(id);
            reject(error);
          }
        });
      });
    };

    const writeServerMessage = (message: Record<string, unknown>): Promise<void> => new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
    });

    const handleResponse = (record: Record<string, unknown>): void => {
      const id = typeof record.id === "number" ? record.id : undefined;
      if (id === undefined) {
        return;
      }
      const pending = pendingRequests.get(id);
      if (!pending) {
        return;
      }
      pendingRequests.delete(id);
      const error = asRecord(record.error);
      if (error) {
        pending.reject(new Error(stringField(error, "message") ?? `${pending.method} failed`));
        return;
      }
      pending.resolve(record.result);
    };

    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let lineBreak = stdoutBuffer.indexOf("\n");
      while (lineBreak >= 0) {
        const line = stdoutBuffer.slice(0, lineBreak).trim();
        stdoutBuffer = stdoutBuffer.slice(lineBreak + 1);
        if (line) {
          try {
            const event = JSON.parse(line) as unknown;
            const record = asRecord(event);
            if (record) {
              const kind = codexAppServerMessageKind(record);
              if (kind === "server-request") {
                const id = typeof record.id === "string" || typeof record.id === "number" ? record.id : undefined;
                const method = stringField(record, "method");
                if (id !== undefined && method === "currentTime/read") {
                  void writeServerMessage({ id, result: { currentTimeAt: Math.floor(Date.now() / 1_000) } }).catch(cleanup);
                } else if (id !== undefined && method) {
                  const message = method === "account/chatgptAuthTokens/refresh"
                    ? "The model catalog uses Codex CLI-managed authentication and never supplies external ChatGPT tokens. A refresh callback indicates an unsupported authentication contract."
                    : `The model catalog does not support the Codex client request ${method}.`;
                  void writeServerMessage({ id, error: { code: -32601, message } }).catch(cleanup);
                }
              } else if (kind === "response") {
                handleResponse(record);
              }
            }
          } catch {
            // Ignore non-JSON status output.
          }
        }
        lineBreak = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("exit", (code) => {
      cleanup(new Error(`codex app-server model probe exited with code ${code ?? "unknown"}${stderr.trim() ? `: ${errorText(stderr)}` : ""}`));
    });

    const timeout = setTimeout(() => {
      cleanup(new Error(`codex app-server model probe timed out${stderr.trim() ? `: ${errorText(stderr)}` : ""}`));
    }, MODEL_CATALOG_TIMEOUT_MS);
    try {
      await sendRequest("initialize", {
        clientInfo: {
          name: "accordagents",
          title: "AccordAgents",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: []
        }
      });
      const models: ProviderModel[] = [];
      let cursor: string | undefined;
      do {
        const result = asRecord(await sendRequest("model/list", { cursor: cursor ?? null, includeHidden: false, limit: 100 }));
        const data = Array.isArray(result?.data) ? result.data : [];
        for (const item of data) {
          const record = asRecord(item);
          const id = stringField(record ?? {}, "id") ?? stringField(record ?? {}, "model");
          if (!id) {
            continue;
          }
          const displayName = stringField(record ?? {}, "displayName") ?? id;
          const description = stringField(record ?? {}, "description");
          const supportedReasoningEfforts = codexModelReasoningEfforts(record);
          const defaultReasoningEffort = normalizeChatReasoningEffort(stringField(record ?? {}, "defaultReasoningEffort"), "codex-cli");
          models.push({
            id,
            label: displayName === id ? id : `${displayName} (${id})`,
            description,
            source: "cli",
            recommended: record?.isDefault === true,
            hidden: record?.hidden === true,
            supportedReasoningEfforts: supportedReasoningEfforts.length > 0 ? supportedReasoningEfforts : undefined,
            defaultReasoningEffort
          });
        }
        cursor = stringField(result ?? {}, "nextCursor");
      } while (cursor);

      if (models.length === 0) {
        throw new Error(`codex app-server returned no models${stderr.trim() ? `: ${errorText(stderr)}` : ""}`);
      }
      // What Codex starts a session in with the User's own config: a member
      // without a model of its own runs the one config.toml names, not the
      // one model/list marks default (GPT-6-Luna listed default while her
      // config ran gpt-5.6-luna, 2026-11-22).
      const config = await this.readCodexStartConfig(sendRequest);
      const listed = withCliStartModel(models, config ? textField(config.model) : undefined);
      const startModel = listed.find((model) => model.recommended);
      const reasoningEffort = config ? normalizeChatReasoningEffort(textField(config.model_reasoning_effort) as ChatReasoningEffort | undefined, "codex-cli") : undefined;
      const access = codexStartAccess(config);
      const startDefaults: CliStartDefaults | undefined = config ? {
        ...(access ? { access } : {}),
        ...(startModel ? { model: startModel.id, modelLabel: modelNameWithoutId(startModel.label, startModel.id) } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {})
      } : undefined;
      return {
        kind: "codex-cli",
        models: listed,
        authoritative: true,
        fetchedAt,
        ...(startDefaults ? { startDefaults } : {})
      };
    } finally {
      clearTimeout(timeout);
      cleanup();
    }
  }

  /** The User's effective Codex config as Codex reads it (`config/read`:
   *  config.toml and what overrides it), or none when this Codex cannot say
   *  in time (an older one, a config it refuses). */
  private async readCodexStartConfig(sendRequest: (method: string, params: unknown) => Promise<unknown>): Promise<Record<string, unknown> | undefined> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const late = Symbol("late");
      const answer = await Promise.race([
        sendRequest("config/read", {}),
        new Promise<typeof late>((resolve) => { timer = setTimeout(() => resolve(late), CODEX_CONFIG_READ_TIMEOUT_MS); })
      ]);
      if (answer === late) {
        await this.deps.debugLogs?.write("cli.model-catalog.codex-config-timeout", { timeoutMs: CODEX_CONFIG_READ_TIMEOUT_MS });
        return undefined;
      }
      return asRecord(asRecord(answer)?.config);
    } catch (error) {
      await this.deps.debugLogs?.write("cli.model-catalog.codex-config-unread", { message: error instanceof Error ? error.message : String(error) });
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async listClaudeModelCatalog(fetchedAt: string, probeCwd?: string): Promise<ProviderModelCatalog> {
    let models: ProviderModel[] = [];
    let signedOut = false;
    let listError: unknown;
    let startDefaults: CliStartDefaults | undefined;
    try {
      const answer = await this.requestClaudeInitializeAnswer();
      // The model and effort it applies with the User's settings, and the
      // mode it starts in (`permissions.defaultMode`).
      const applied = claudeAppliedSettings(answer.appliedSettings);
      models = parseClaudeInitializeModels(answer.models, applied.model);
      const account = answer.account && typeof answer.account === "object" ? answer.account as Record<string, unknown> : undefined;
      signedOut = account?.tokenSource === "none";
      const startModel = models.length > 0 && (applied.model || answer.appliedSettings) ? models.find((model) => model.recommended) : undefined;
      const access = claudeStartAccess(answer.current_permission_mode);
      const reasoningEffort = normalizeChatReasoningEffort(applied.effort as ChatReasoningEffort | undefined, "claude-code");
      const known: CliStartDefaults = {
        ...(access ? { access } : {}),
        ...(startModel ? { model: startModel.id, modelLabel: startModel.label } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {})
      };
      startDefaults = Object.keys(known).length > 0 ? known : undefined;
    } catch (error) {
      listError = error;
      await this.deps.debugLogs?.write("cli.model-catalog.initialize-error", { message: error instanceof Error ? error.message : String(error) });
      // The /model picker runs the same CLI; one that did not answer in time will not open it either.
      if (error instanceof ClaudeModelListTimeoutError) {
        throw error;
      }
    }
    if (models.length === 0) {
      // A Claude Code build that does not list models on initialize: read its /model picker.
      models = parseClaudeModelPickerOutput(await this.runClaudeModelProbe(probeCwd));
    }
    if (models.length === 0) {
      const reason = listError instanceof Error ? ` ${listError.message}` : "";
      throw new Error(`Claude Code did not list any models.${reason}`);
    }
    return {
      kind: "claude-code",
      models,
      // Signed out, Claude Code lists only its generic models: show them, but
      // read again next time so signing in brings the account's own list.
      authoritative: !signedOut,
      fetchedAt,
      ...(startDefaults ? { startDefaults } : {})
    };
  }

  /** Always in the home folder, never a project folder: without the trust
   *  question `claude -p` would run that project's own settings commands
   *  (an `apiKeyHelper`, say) just because a Model menu was opened. */
  private async requestClaudeInitializeAnswer(): Promise<Record<string, unknown>> {
    await ensureLoginShellEnvPrimed();
    const env = commandEnvironment(undefined, CLAUDE_CODE_COMMAND_ENV_OPTIONS);
    return runClaudeModelListProbe({
      executable: await resolveCommandPath("claude", env),
      env,
      cwd: homedir()
    });
  }

  private async runClaudeModelProbe(probeCwd?: string): Promise<string> {
    await ensureLoginShellEnvPrimed();
    const env = commandEnvironment(undefined, CLAUDE_CODE_COMMAND_ENV_OPTIONS);
    const claudeExecutable = await resolveCommandPath("claude", env);
    const ownFolder = process.platform === "win32" ? this.deps.claudeModelProbeDir : undefined;
    const cwd = await resolveClaudeModelProbeCwd(probeCwd, ownFolder);
    if (process.platform === "win32") {
      const spawnPty = this.deps.claudeModelProbePtySpawn ?? (await import("node-pty")).spawn;
      return probeClaudeModelsInFolder(cwd, ownFolder, (folder) =>
        runClaudeModelProbeInPty({ executable: claudeExecutable, env, cwd: folder, spawnPty, ownFolder }));
    }
    return runClaudeModelProbeWithExpect({
      executable: claudeExecutable,
      env,
      cwd,
      expectScript: claudeModelProbeExpectScript(),
      spawnExpect: this.deps.claudeModelProbeExpectSpawn
    });
  }

  /** The models an Antigravity member on a Gemini API key provider can pick:
   *  agy lists other models on a key than on its sign-in. `undefined` = the
   *  provider is gone. */
  async listHostModelCatalog(
    provider: { host: Pick<CliProviderHost, "id" | "label" | "baseUrl" | "updatedAt">; apiKey: string | undefined } | undefined
  ): Promise<ProviderModelCatalog> {
    // No guessed list: the signed-in one would offer models the key cannot use.
    const unavailable = (error: string): ProviderModelCatalog => ({ kind: "gemini-cli", models: [], authoritative: false, fetchedAt: new Date().toISOString(), error });
    if (!provider) {
      return unavailable("That provider was removed from Settings");
    }
    const { host, apiKey } = provider;
    if (!apiKey?.trim()) {
      return unavailable(`${host.label} has no API key`);
    }
    const cacheKey = `${host.id}|${host.updatedAt}`;
    const cached = this.hostModelCatalogs.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.catalog;
    }
    // Every open model picker for the member asks at once; one agy run answers them.
    let request = this.hostModelCatalogRequests.get(cacheKey);
    if (!request) {
      request = this.fetchHostModelCatalog(host, apiKey, cacheKey);
      this.hostModelCatalogRequests.set(cacheKey, request);
      void request.finally(() => {
        if (this.hostModelCatalogRequests.get(cacheKey) === request) {
          this.hostModelCatalogRequests.delete(cacheKey);
        }
      });
    }
    return request;
  }

  private async fetchHostModelCatalog(
    host: Pick<CliProviderHost, "id" | "baseUrl">,
    apiKey: string,
    cacheKey: string
  ): Promise<ProviderModelCatalog> {
    const fetchedAt = new Date().toISOString();
    try {
      const catalog = await this.listGeminiModelCatalog(fetchedAt, {
        env: geminiApiKeyEnv(host.baseUrl, apiKey),
        settings: GEMINI_API_KEY_SETTINGS
      });
      // On a key agy's own default is not the first model it lists (it ran
      // Gemini 3.1 Pro with Carbon listed first), so none is marked; the
      // picker's "Antigravity setting" entry is that default.
      const normalized = { ...catalog, models: dedupeModels(catalog.models).map((model) => ({ ...model, recommended: false })) };
      for (const key of this.hostModelCatalogs.keys()) {
        if (key.startsWith(`${host.id}|`)) {
          this.hostModelCatalogs.delete(key);
        }
      }
      this.hostModelCatalogs.set(cacheKey, { catalog: normalized, expiresAt: Date.now() + MODEL_CATALOG_CACHE_MS });
      return normalized;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.debugLogs?.write("cli.model-catalog.error", { kind: "gemini-cli", hostId: host.id, message });
      return { kind: "gemini-cli", models: [], authoritative: false, fetchedAt, error: message };
    }
  }

  private async listGeminiModelCatalog(
    fetchedAt: string,
    apiKey?: { env: Record<string, string>; settings: Readonly<Record<string, unknown>> }
  ): Promise<ProviderModelCatalog> {
    await ensureLoginShellEnvPrimed();
    const invocation = agyModelsInvocation(apiKey);
    const env = commandEnvironment(invocation.env);
    const agyExecutable = await resolveCommandPath("agy", env);
    const result = await runCommand(agyExecutable, invocation.args, { timeoutMs: MODEL_CATALOG_TIMEOUT_MS, env });
    const models: ProviderModel[] = parseAgyModelList(result.stdout);
    if (models.length === 0) {
      throw new Error("`agy models` returned no models.");
    }
    // `agy models` lists the selected default first; the mode it starts in
    // is its settings.json `agentMode`.
    const access = await antigravityStartAccess();
    const first = models[0];
    const startDefaults: CliStartDefaults = { ...(access ? { access } : {}), ...(first && !apiKey ? { model: first.id, modelLabel: first.label } : {}) };
    return { kind: "gemini-cli", models, authoritative: true, fetchedAt, ...(Object.keys(startDefaults).length > 0 ? { startDefaults } : {}) };
  }

  /** The effort the User's own config.toml sets, as Codex said it with its
   *  model list here (none until that list was read). */
  codexConfigEffort(): ChatReasoningEffort | undefined {
    return this.modelCatalogs.get("codex-cli")?.catalog.startDefaults?.reasoningEffort;
  }
}
