import type {
  ChatParticipant,
  ChatProviderKind,
  ChatSavedPromptConfig,
  PluginCatalogItem,
  UserSkillSummary,
  UserSkillTargetSummary
} from "../../../shared/types";
import type { ChatSlashSuggestion, SlashCommandOption } from "./chat-composer-draft-utils";
import { pluginSlashProviderKinds } from "./chat-plugin-options";
import { SLASH_KINDS, type SlashKind, type SlashMenuItem } from "./slash-menu-model";

export type ChatSlashItem = SlashMenuItem<ChatSlashSuggestion>;

/** Why a skill cannot be inserted: `short` sits on its row, `reason` in the
 *  footer and the tooltip. A reason that holds for every skill (no member to
 *  run it) has no `short`: the rows only dim and the footer says it once. */
export interface ChatSlashUnavailable {
  short?: string;
  reason: string;
}

/** Who the inserted item goes to, for the footer: "For @claude". */
export interface ChatSlashTarget {
  handles: string[];
  providerKinds: ChatProviderKind[];
}

export const CHAT_SLASH_NO_TARGET = "Mention a member to select a skill";

export function chatSlashItems(source: {
  commands: readonly SlashCommandOption[];
  prompts: readonly ChatSavedPromptConfig[];
  skills: readonly UserSkillSummary[];
  plugins: readonly PluginCatalogItem[];
}): ChatSlashItem[] {
  return [
    ...source.commands.map((item): ChatSlashItem => ({
      kind: "command",
      key: `command:${item.id}`,
      name: item.id,
      description: item.description,
      disabled: false,
      value: { kind: "command", item }
    })),
    ...source.prompts.map((item): ChatSlashItem => ({
      kind: "prompt",
      key: `prompt:${item.id}`,
      name: item.trigger,
      description: item.label,
      disabled: false,
      value: { kind: "prompt", item }
    })),
    ...source.skills.map((item): ChatSlashItem => ({
      kind: "skill",
      key: `skill:${item.skillId}`,
      name: item.frontmatterName,
      aliases: item.displayName === item.frontmatterName ? [] : [item.displayName],
      description: item.description ?? "",
      disabled: !isInsertableSkill(item),
      value: { kind: "skill", item }
    })),
    ...source.plugins.map((item): ChatSlashItem => {
      // The row shows the token Enter inserts; a token that does not read as
      // the plugin's name ("app-69ef...", Context7) puts the name in front.
      const name = item.invocation.kind === "skill-mention" ? item.invocation.skill.frontmatterName : item.name;
      const description = item.description ?? item.statusMessage ?? "";
      const label = readsAs(name, item.displayName) ? "" : item.displayName;
      return {
        kind: "plugin",
        key: `plugin:${item.id}`,
        name,
        // Only names the row shows: a hidden category would match with no visible reason.
        aliases: [item.name, item.displayName],
        description: label && description ? `${label}: ${description}` : label || description,
        disabled: false,
        value: { kind: "plugin", item }
      };
    })
  ];
}

function readsAs(token: string, displayName: string): boolean {
  return displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") === token.toLowerCase();
}

export function isInsertableSkill(skill: UserSkillSummary): boolean {
  return skill.capabilityState === "invocable" && !skill.ambiguous;
}

export function chatSlashUnavailable(skill: UserSkillSummary, hasTarget: boolean): ChatSlashUnavailable | undefined {
  if (isInsertableSkill(skill)) {
    return undefined;
  }
  if (skill.ambiguous) {
    return { short: "Ambiguous", reason: skill.statusMessage ?? "Duplicate skill variants are ambiguous." };
  }
  if (!hasTarget) {
    return { reason: skill.statusMessage ?? "Mention a member before selecting a skill." };
  }
  return { short: "Unavailable", reason: skill.statusMessage ?? "This skill is not selectable for the current target." };
}

export function chatSlashTarget(target: UserSkillTargetSummary | undefined, participants: readonly ChatParticipant[]): ChatSlashTarget | undefined {
  if (!target?.hasClearTargets || target.providerKinds.length === 0) {
    return undefined;
  }
  const handles = target.participantIds
    .map((id) => participants.find((participant) => participant.id === id)?.handle)
    .filter((handle): handle is string => Boolean(handle));
  return { handles, providerKinds: target.providerKinds };
}

/** The providers whose mark a row shows, in the fixed column order. */
export function chatSlashProviderKinds(option: ChatSlashSuggestion): ChatProviderKind[] {
  if (option.kind === "skill") {
    return option.item.providerKinds;
  }
  return option.kind === "plugin" ? pluginSlashProviderKinds(option.item) : [];
}

const KIND_WORDS: Record<SlashKind, [string, string]> = {
  command: ["command", "commands"],
  prompt: ["prompt", "prompts"],
  skill: ["skill", "skills"],
  plugin: ["plugin", "plugins"]
};

export const SLASH_KIND_TITLES: Record<SlashKind, string> = {
  command: "Commands",
  prompt: "Prompts",
  skill: "Skills",
  plugin: "Plugins"
};

export function slashKindCount(kind: SlashKind, count: number): string {
  return `${count} ${KIND_WORDS[kind][count === 1 ? 0 : 1]}`;
}

/** "2 commands, 6 prompts and 80 skills": what an empty search looked through. */
export function slashSearchedSummary(items: readonly ChatSlashItem[]): string {
  const parts = SLASH_KINDS
    .map((kind) => ({ kind, count: items.filter((item) => item.kind === kind).length }))
    .filter((entry) => entry.count > 0)
    .map((entry) => slashKindCount(entry.kind, entry.count));
  if (parts.length < 2) {
    return parts[0] ?? "";
  }
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
