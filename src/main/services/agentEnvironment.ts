import type {
  AgentEnvironmentSnapshot,
  DeleteAgentEnvironmentVariableRequest,
  SaveAgentEnvironmentVariableRequest
} from "../../shared/types";
import { isAutomaticAgentEnvironmentKey } from "../../shared/agentEnvironment";
import { computerEnvironment, computerEnvironmentRead, ensureLoginShellEnvPrimed, refreshLoginShellEnv } from "./command";
import { forwardedDesktopEnvironment } from "./remoteWorkerTarget";
import type { SettingsService } from "./settings";

/** The names and values this computer offers as automatic variables: its
 *  last successful reading, without the app's own and the system's names. */
export function automaticAgentEnvironmentSource(base: NodeJS.ProcessEnv = computerEnvironment()): Record<string, string> {
  const source: Record<string, string> = {};
  for (const [key, value] of Object.entries(forwardedDesktopEnvironment(base))) {
    if (typeof value === "string" && value && isAutomaticAgentEnvironmentKey(key)) {
      source[key] = value;
    }
  }
  return source;
}

/** Settings → Environment: one list of the variables members get. Automatic
 *  ones follow this computer; the User can change or delete any of them. */
export class AgentEnvironmentService {
  private reconciling: Promise<boolean> = Promise.resolve(false);

  constructor(
    private readonly settings: SettingsService,
    private readonly source: () => Record<string, string> = () => automaticAgentEnvironmentSource(),
    private readonly sourceRead: () => boolean = computerEnvironmentRead,
    private readonly onError: (error: unknown) => void = () => undefined
  ) {}

  /** The list as it is, after bringing it in step with the last reading. */
  async snapshot(): Promise<AgentEnvironmentSnapshot> {
    await ensureLoginShellEnvPrimed();
    await this.reconcileQuietly();
    return this.currentSnapshot();
  }

  /** Reads this computer again, then brings the list in step. */
  async refresh(): Promise<AgentEnvironmentSnapshot> {
    await refreshLoginShellEnv();
    await this.reconcileQuietly();
    return this.currentSnapshot();
  }

  async save(request: SaveAgentEnvironmentVariableRequest): Promise<AgentEnvironmentSnapshot> {
    await this.settings.saveAgentEnvironmentVariable(request);
    return this.currentSnapshot();
  }

  async delete(request: DeleteAgentEnvironmentVariableRequest): Promise<AgentEnvironmentSnapshot> {
    await ensureLoginShellEnvPrimed();
    const id = (key: string): string => process.platform === "win32" ? key.toUpperCase() : key;
    const setByThisComputer = Object.keys(this.source()).some((key) => id(key) === id(request.key));
    await this.settings.deleteAgentEnvironmentVariable(request.key, setByThisComputer);
    return this.currentSnapshot();
  }

  /** Passes run one after another, each with the reading current when it
   *  starts. Nothing happens until this computer has been read once; a later
   *  failed reading keeps the last good one. */
  reconcile(): Promise<boolean> {
    const run = this.reconciling.catch(() => false).then(() => this.sourceRead()
      ? this.settings.reconcileAutomaticAgentEnvironment(this.source())
      : false);
    this.reconciling = run;
    return run;
  }

  /** A failed pass must not take the page down: the list is still there. */
  private async reconcileQuietly(): Promise<void> {
    try {
      await this.reconcile();
    } catch (error) {
      this.onError(error);
    }
  }

  private async currentSnapshot(): Promise<AgentEnvironmentSnapshot> {
    const variables = await this.settings.listAgentEnvironmentVariables();
    return {
      variables: variables.sort((left, right) => left.key.localeCompare(right.key))
    };
  }
}
