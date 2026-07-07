import type {
  ChatProviderKind,
  PluginCatalogItem,
  UserSkillTargetSummary
} from "../../../shared/types";

export function isSlashInvocablePlugin(plugin: PluginCatalogItem, target?: UserSkillTargetSummary): boolean {
  if (plugin.invocation.kind === "prompt-insert") {
    return Boolean(plugin.invocation.prompt.trim()) && matchesTargetProvider(plugin.providerKind, target);
  }
  if (plugin.invocation.kind === "mcp-passive") {
    return matchingInstalledProviderKinds(plugin, target).length > 0;
  }
  const skill = plugin.invocation.skill;
  return skill.capabilityState === "invocable" && !skill.ambiguous;
}

export function pluginSlashProviderLabels(plugin: PluginCatalogItem, providerLabel: (providerKind: ChatProviderKind) => string): string[] {
  if (plugin.invocation.kind === "prompt-insert") {
    return [providerLabel(plugin.providerKind)];
  }
  if (plugin.invocation.kind === "mcp-passive") {
    return plugin.installedProviderKinds.map(providerLabel);
  }
  return plugin.providerAvailability
    .filter((provider) => provider.status === "available" || provider.status === "invocable")
    .map((provider) => providerLabel(provider.providerKind));
}

function matchingInstalledProviderKinds(plugin: PluginCatalogItem, target?: UserSkillTargetSummary): ChatProviderKind[] {
  const installed = plugin.installedProviderKinds;
  if (!target?.hasClearTargets || target.providerKinds.length === 0) {
    return installed;
  }
  return installed.filter((providerKind) => target.providerKinds.includes(providerKind));
}

function matchesTargetProvider(providerKind: ChatProviderKind, target?: UserSkillTargetSummary): boolean {
  return !target?.hasClearTargets || target.providerKinds.length === 0 || target.providerKinds.includes(providerKind);
}
