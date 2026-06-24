export type SlashSuggestionKind = "command" | "prompt" | "skill";

export interface SlashSuggestionGroups<Command, Prompt, Skill> {
  commands: readonly Command[];
  prompts: readonly Prompt[];
  skills: readonly Skill[];
}

export type SlashSuggestionSelection<Command, Prompt, Skill> =
  | { kind: "command"; item: Command }
  | { kind: "prompt"; item: Prompt }
  | { kind: "skill"; item: Skill };

export function slashSuggestionCount<Command, Prompt, Skill>(
  groups: SlashSuggestionGroups<Command, Prompt, Skill>
): number {
  return groups.commands.length + groups.prompts.length + groups.skills.length;
}

export function slashSuggestionAtIndex<Command, Prompt, Skill>(
  groups: SlashSuggestionGroups<Command, Prompt, Skill>,
  index: number
): SlashSuggestionSelection<Command, Prompt, Skill> | undefined {
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
  const skill = groups.skills[skillIndex];
  return skill === undefined ? undefined : { kind: "skill", item: skill };
}
