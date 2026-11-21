// What a new chat's main session can run on, as the New chat composer's
// model chip offers it in the sessions view (the User, 2026-11-21: "как в T3,
// выбираешь просто провайдера и модель"): every ready CLI, and every added
// provider whose CLI is ready and which has its key. The same list on the
// computer and, through the New chat offer, on the phone.

import { CLI_PROVIDER_DISPLAY_ORDER, cliProviderMetadata, readinessForParticipant } from "./cliReadiness";
import type { AgentHealth, ChatProviderKind, CliProviderHost, CliProviderHostVendor, ProviderSettings } from "./types";

export interface MainSessionProviderOption {
  kind: ChatProviderKind;
  /** The added provider it runs through; none for the CLI's own sign-in. */
  hostId?: string;
  hostLabel?: string;
  hostVendor?: CliProviderHostVendor;
  /** Its name: the CLI's ("Claude Code") or the added provider's ("Z.ai GLM"). */
  label: string;
}

/** A provider choice, as the screens keep it. */
export type MainSessionProviderChoice = Pick<MainSessionProviderOption, "kind" | "hostId">;

export function mainSessionProviderKey(option: MainSessionProviderChoice): string {
  return `${option.kind}\u0000${option.hostId ?? ""}`;
}

/** Every ready CLI in the order Settings → Local CLI setup lists them, each
 *  followed by the added providers on it that can run now. */
export function mainSessionProviderOptions(
  agents: AgentHealth[],
  providers: Array<Pick<ProviderSettings, "kind" | "enabled">>,
  hosts: ReadonlyArray<CliProviderHost> = []
): MainSessionProviderOption[] {
  const options: MainSessionProviderOption[] = [];
  for (const kind of CLI_PROVIDER_DISPLAY_ORDER) {
    if (readinessForParticipant({ kind }, agents, providers) === "ready") {
      options.push({ kind, label: cliProviderMetadata(kind).label });
    }
    for (const host of hosts) {
      if (host.cli !== kind || readinessForParticipant({ kind, host }, agents, providers) !== "ready") continue;
      options.push({ kind, hostId: host.id, hostLabel: host.label, hostVendor: host.vendor, label: host.label });
    }
  }
  return options;
}

/**
 * The provider a new chat's main session runs on: the one chosen on the
 * chip for this chat while it can still run, else the CLI Settings → General
 * names (resolveAssistantProviderKind: the saved one, or a ready one). The
 * choice never changes the setting.
 */
export function resolveMainSessionProvider(
  chosen: MainSessionProviderChoice | undefined,
  options: readonly MainSessionProviderOption[],
  fallbackKind: ChatProviderKind | undefined
): MainSessionProviderOption | undefined {
  if (chosen) {
    const key = mainSessionProviderKey(chosen);
    const match = options.find((option) => mainSessionProviderKey(option) === key);
    if (match) return match;
  }
  if (!fallbackKind) return undefined;
  return options.find((option) => option.kind === fallbackKind && !option.hostId)
    ?? { kind: fallbackKind, label: cliProviderMetadata(fallbackKind).label };
}
