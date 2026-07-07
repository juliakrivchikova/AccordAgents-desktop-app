export type SlashSuggestionKind = "command" | "prompt" | "skill" | "plugin";

export interface SlashSuggestionGroups<Command, Prompt, Skill, Plugin = never> {
  commands: readonly Command[];
  prompts: readonly Prompt[];
  skills: readonly Skill[];
  plugins?: readonly Plugin[];
}

export type SlashSuggestionSelection<Command, Prompt, Skill, Plugin = never> =
  | { kind: "command"; item: Command }
  | { kind: "prompt"; item: Prompt }
  | { kind: "skill"; item: Skill }
  | { kind: "plugin"; item: Plugin };

export function slashSuggestionCount<Command, Prompt, Skill, Plugin = never>(
  groups: SlashSuggestionGroups<Command, Prompt, Skill, Plugin>
): number {
  return groups.commands.length + groups.prompts.length + groups.skills.length + (groups.plugins?.length ?? 0);
}

export function slashSuggestionAtIndex<Command, Prompt, Skill, Plugin = never>(
  groups: SlashSuggestionGroups<Command, Prompt, Skill, Plugin>,
  index: number
): SlashSuggestionSelection<Command, Prompt, Skill, Plugin> | undefined {
  if (index < 0) {
    return undefined;
  }
  if (index < groups.commands.length) {
    return { kind: "command", item: groups.commands[index] };
  }
  const promptIndex = index - groups.commands.length;
  if (promptIndex < groups.prompts.length) {
    return { kind: "prompt", item: groups.prompts[promptIndex] };
  }
  const skillIndex = promptIndex - groups.prompts.length;
  if (skillIndex < groups.skills.length) {
    const skill = groups.skills[skillIndex];
    return skill === undefined ? undefined : { kind: "skill", item: skill };
  }
  const pluginIndex = skillIndex - groups.skills.length;
  const plugin = groups.plugins?.[pluginIndex];
  return plugin === undefined ? undefined : { kind: "plugin", item: plugin };
}
