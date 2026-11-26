/** What the composer's `/compact` and `/goal` say, on the desktop and the
 *  phone alike. They are offered for exactly one member: the one a message
 *  names, or the session it is written in (the main session, a member's
 *  panel), so neither speaks of a "mentioned" member. `/compact` in Claude
 *  Code 2.1.332's own words; its `/goal` line has a dash the app's text does
 *  not use. */
export const COMPACT_COMMAND_DESCRIPTION = "Free up context by summarizing the conversation so far";
export const GOAL_COMMAND_DESCRIPTION = "Set a goal and keep working until it is met";

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

export interface SlashSuggestionMatchFields {
  primary: readonly string[];
  secondary?: readonly string[];
}

export function slashSuggestions<Command, Prompt, Skill, Plugin = never>(
  groups: SlashSuggestionGroups<Command, Prompt, Skill, Plugin>
): SlashSuggestionSelection<Command, Prompt, Skill, Plugin>[] {
  return [
    ...groups.commands.map((item) => ({ kind: "command" as const, item })),
    ...groups.prompts.map((item) => ({ kind: "prompt" as const, item })),
    ...groups.skills.map((item) => ({ kind: "skill" as const, item })),
    ...(groups.plugins ?? []).map((item) => ({ kind: "plugin" as const, item }))
  ];
}

export function rankSlashSuggestions<Command, Prompt, Skill, Plugin = never>(
  groups: SlashSuggestionGroups<Command, Prompt, Skill, Plugin>,
  query: string,
  fieldsFor: (
    selection: SlashSuggestionSelection<Command, Prompt, Skill, Plugin>
  ) => SlashSuggestionMatchFields
): SlashSuggestionSelection<Command, Prompt, Skill, Plugin>[] {
  const options = slashSuggestions(groups);
  const normalizedQuery = normalizeMatchText(query);
  if (!normalizedQuery) {
    return options;
  }
  return options
    .map((option, index) => ({ option, index, rank: slashSuggestionRank(fieldsFor(option), normalizedQuery) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ option }) => option);
}

function slashSuggestionRank(fields: SlashSuggestionMatchFields, query: string): number {
  const primary = fields.primary.map(normalizeMatchText);
  if (primary.some((value) => value === query)) {
    return 0;
  }
  if (primary.some((value) => value.startsWith(query))) {
    return 1;
  }
  if (primary.some((value) => value.includes(query))) {
    return 2;
  }
  const secondary = (fields.secondary ?? []).map(normalizeMatchText);
  return secondary.some((value) => value.includes(query)) ? 3 : 4;
}

function normalizeMatchText(value: string): string {
  return value.trim().replace(/^\/+/, "").toLowerCase();
}
