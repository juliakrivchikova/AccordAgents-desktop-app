import type { ChatSkillMention, PluginCatalogItem } from "../../shared/types";
import type { DraftPluginMention } from "../components/chat/chat-composer-draft-utils";

export function pluginNewChatDraft(plugin: PluginCatalogItem): string {
  const prompt = plugin.invocation.kind === "prompt-insert" ? plugin.invocation.prompt.trim() : "";
  const tokenName = plugin.invocation.kind === "skill-mention"
    ? plugin.invocation.skill.frontmatterName
    : plugin.name;
  const includeToken = plugin.invocation.kind !== "prompt-insert" || plugin.installedProviderKinds.length > 0;
  if (!includeToken) {
    return prompt;
  }
  return `/${tokenName}${prompt ? ` ${prompt}` : " "}`;
}

export function pluginNewChatMentions(
  plugin: PluginCatalogItem,
  draft: string
): { pluginMentions: DraftPluginMention[]; skillMentions: ChatSkillMention[] } {
  if (plugin.invocation.kind === "skill-mention" && draftHasSlashToken(draft, plugin.invocation.skill.frontmatterName)) {
    const skill = plugin.invocation.skill;
    const mention: ChatSkillMention = {
      skillId: skill.skillId,
      displayName: skill.displayName,
      frontmatterName: skill.frontmatterName,
      description: skill.description,
      contentHash: skill.contentHash,
      capabilityState: skill.capabilityState,
      variants: skill.variants
    };
    return { pluginMentions: [], skillMentions: [mention] };
  }
  if (draftHasSlashToken(draft, plugin.name)) {
    return {
      pluginMentions: [{ name: plugin.name, displayName: plugin.displayName, iconUrl: plugin.iconUrl }],
      skillMentions: []
    };
  }
  return { pluginMentions: [], skillMentions: [] };
}

function draftHasSlashToken(draft: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)/${escaped}(?=\\s|$)`).test(draft);
}
