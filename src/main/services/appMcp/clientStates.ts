import { missingToolNames, publicClientStatus } from "./protocol";
import type { AppMcpActor, AppMcpClientState, AppMcpClientStatus } from "./types";

/** What each member's CLI has loaded of the app tools. */
export class ClientStates {
  readonly states = new Map<string, AppMcpClientState>();

  clientStatus(clientGenerationId: string): AppMcpClientStatus | undefined {
    const state = this.states.get(clientGenerationId);
    return state ? publicClientStatus(state) : undefined;
  }

  ensureClientState(actor: AppMcpActor): AppMcpClientState | undefined {
    const clientGenerationId = actor.clientGenerationId;
    if (!clientGenerationId) {
      return undefined;
    }
    const expectedToolNames = Array.from(new Set(actor.expectedToolNames ?? [])).sort();
    const existing = this.states.get(clientGenerationId);
    if (existing) {
      existing.expectedToolNames = expectedToolNames;
      existing.missingToolNames = missingToolNames(expectedToolNames, existing.listedToolNames);
      existing.requiredToolsPresent = existing.missingToolNames.length === 0;
      existing.updatedAt = new Date().toISOString();
      return existing;
    }
    const state: AppMcpClientState = {
      clientGenerationId,
      expectedToolNames,
      listedToolNames: [],
      initialized: false,
      listedTools: false,
      requiredToolsPresent: expectedToolNames.length === 0,
      missingToolNames: expectedToolNames,
      errored: false,
      updatedAt: new Date().toISOString()
    };
    this.states.set(clientGenerationId, state);
    return state;
  }

  markClientInitialized(actor: AppMcpActor): void {
    const state = this.ensureClientState(actor);
    if (!state) {
      return;
    }
    state.initialized = true;
    state.updatedAt = new Date().toISOString();
  }

  markClientToolsListed(actor: AppMcpActor, tools: unknown[]): void {
    const state = this.ensureClientState(actor);
    if (!state) {
      return;
    }
    const listedToolNames = new Set(tools.flatMap((tool) => {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
        return [];
      }
      const name = (tool as { name?: unknown }).name;
      return typeof name === "string" ? [name] : [];
    }));
    state.listedTools = true;
    state.listedToolNames = Array.from(listedToolNames).sort();
    state.missingToolNames = missingToolNames(state.expectedToolNames, listedToolNames);
    state.requiredToolsPresent = state.missingToolNames.length === 0;
    state.updatedAt = new Date().toISOString();
  }

  markClientError(actor: AppMcpActor, message: string): void {
    const state = this.ensureClientState(actor);
    if (!state) {
      return;
    }
    state.errored = true;
    state.errorMessage = message.slice(0, 240);
    state.updatedAt = new Date().toISOString();
  }
}
