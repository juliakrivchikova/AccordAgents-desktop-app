import type {
  ChatProviderKind,
  PluginCatalogItem,
  UserSkillTargetSummary
} from "../../../shared/types";

export function isSlashInvocablePlugin(plugin: PluginCatalogItem, target?: UserSkillTargetSummary): boolean {
  if (plugin.invocation.kind === "prompt-insert") {
    return Boolean(plugin.invocation.prompt.trim()) && matchingInstalledProviderKinds(plugin, target).length > 0;
  }
  if (plugin.invocation.kind === "mcp-passive") {
    return matchingInstalledProviderKinds(plugin, target).length > 0;
  }
  const skill = plugin.invocation.skill;
  return skill.capabilityState === "invocable" && !skill.ambiguous;
}

/** The providers a slash-menu plugin runs in, for its row's marks. */
export function pluginSlashProviderKinds(plugin: PluginCatalogItem): ChatProviderKind[] {
  if (plugin.invocation.kind === "prompt-insert") {
    return [plugin.providerKind];
  }
  if (plugin.invocation.kind === "mcp-passive") {
    return plugin.installedProviderKinds;
  }
  return plugin.providerAvailability
    .filter((provider) => provider.status === "available" || provider.status === "invocable")
    .map((provider) => provider.providerKind);
}

function matchingInstalledProviderKinds(plugin: PluginCatalogItem, target?: UserSkillTargetSummary): ChatProviderKind[] {
  const installed = plugin.installedProviderKinds;
  if (!target?.hasClearTargets || target.providerKinds.length === 0) {
    return installed;
  }
  return installed.filter((providerKind) => target.providerKinds.includes(providerKind));
}
