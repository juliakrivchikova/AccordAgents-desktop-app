import type { AgentDetectionRequest, AgentHealth, ChatProviderKind } from "../../../../shared/types";
import type { CliModules } from "../modules";
import type { CliDependencies } from "../dependencies";

/** Which CLIs are installed and signed in on this device. */
export class AgentReadiness {
  private agentsDetected?: (agents: AgentHealth[]) => void;

  constructor(
    private readonly cli: Pick<CliModules, "geminiRuns">,
    private readonly deps: Pick<CliDependencies, "readiness">
  ) {}

  async detectAgents(request?: AgentDetectionRequest): Promise<AgentHealth[]> {
    return this.afterDetection(await this.deps.readiness.refresh(request));
  }

  /** Readiness with only these CLIs checked (each one's fresh result reused,
   *  CliReadinessService.refreshKinds); every CLI is in the result. */
  async detectAgentKinds(kinds: readonly ChatProviderKind[], request?: AgentDetectionRequest): Promise<AgentHealth[]> {
    return this.afterDetection(await this.deps.readiness.refreshKinds(kinds, request));
  }

  private afterDetection(agents: AgentHealth[]): AgentHealth[] {
    if (agents.some((agent) => agent.kind === "gemini-cli" && agent.installed)) {
      void this.cli.geminiRuns.ensureGeminiMcpConfig().catch(() => undefined);
    }
    try {
      this.agentsDetected?.(agents);
    } catch {
      // An observer never changes what the caller gets.
    }
    return agents;
  }

  /** Told every readiness result, of every CLI or of some (the computer's
   *  usage signals). */
  setAgentsDetectedObserver(observer: ((agents: AgentHealth[]) => void) | undefined): void {
    this.agentsDetected = observer;
  }

  invalidateAgentReadiness(): number {
    return this.deps.readiness.invalidate();
  }
}
