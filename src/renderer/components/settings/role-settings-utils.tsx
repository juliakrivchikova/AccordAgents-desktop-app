import type { ChatParticipantConfig, ChatRoleConfig, ChatRoleParticipantDefaults } from "../../../shared/types";

export const CHAT_ROLE_LABEL_MAX_CHARS = 80;
export const CHAT_ROLE_INSTRUCTIONS_MAX_CHARS = 40_000;

export type RoleEditorState =
  | {
      type: "new";
      initialLabel?: string;
      initialDescription?: string;
      initialInstructions?: string;
      initialParticipantDefaults?: ChatRoleParticipantDefaults;
    }
  | { type: "edit"; roleId: string };

export interface RoleInstructionParts {
  frontmatterName?: string;
  description: string;
  body: string;
  hadFrontmatter: boolean;
}

export function RoleKindBadge({ builtIn }: { builtIn: boolean }): JSX.Element {
  return <span className={`roles-kind-badge ${builtIn ? "is-built-in" : "is-custom"}`}>{builtIn ? "Built-in" : "Custom"}</span>;
}

export function savedParticipantPresetCountByRole(participants: ChatParticipantConfig[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const participant of participants) {
    counts.set(participant.roleConfigId, (counts.get(participant.roleConfigId) ?? 0) + 1);
  }
  return counts;
}

export function savedParticipantPresetsForRole(participants: ChatParticipantConfig[], roleId: string): ChatParticipantConfig[] {
  return participants.filter((participant) => participant.roleConfigId === roleId);
}

export function duplicateRoleLabel(label: string, roles: ChatRoleConfig[]): string {
  const used = new Set(roles.map((role) => role.label.trim().toLowerCase()));
  const base = `${label} (copy)`;
  if (!used.has(base.toLowerCase())) {
    return base;
  }
  let suffix = 2;
  while (used.has(`${base} ${suffix}`.toLowerCase())) {
    suffix += 1;
  }
  return `${base} ${suffix}`;
}

export function roleSummary(role: ChatRoleConfig): string {
  const parts = parseRoleInstructions(role.instructions);
  if (parts.description) {
    return stripMarkdownLine(parts.description);
  }
  const line = parts.body.split(/\r?\n/).map((item) => item.trim()).find((item) =>
    item &&
    !item.startsWith("```") &&
    !/^#{1,6}\s*$/.test(item) &&
    !/^[-*_]{3,}$/.test(item)
  );
  return stripMarkdownLine(line ?? "") || "No instructions yet.";
}

function stripMarkdownLine(value: string): string {
  return value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .slice(0, 180);
}

export function roleWordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

export function parseRoleInstructions(instructions: string): RoleInstructionParts {
  const normalized = instructions.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { description: "", body: normalized.trim(), hadFrontmatter: false };
  }
  const closeIndex = normalized.indexOf("\n---", 4);
  if (closeIndex < 0) {
    return { description: "", body: normalized.trim(), hadFrontmatter: false };
  }
  const frontmatter = normalized.slice(4, closeIndex).split("\n");
  const body = normalized.slice(closeIndex + 4).trim();
  let frontmatterName: string | undefined;
  let description = "";
  for (const line of frontmatter) {
    const nameMatch = line.match(/^name:\s*(.*)$/i);
    if (nameMatch) {
      frontmatterName = nameMatch[1].trim();
      continue;
    }
    const descriptionMatch = line.match(/^description:\s*(.*)$/i);
    if (descriptionMatch) {
      description = descriptionMatch[1].trim();
    }
  }
  return { frontmatterName, description, body, hadFrontmatter: true };
}

export function composeRoleInstructions(parts: {
  name: string;
  description: string;
  body: string;
  includeFrontmatter: boolean;
}): string {
  if (!parts.includeFrontmatter) {
    return parts.body;
  }
  const frontmatter = [
    "---",
    `name: ${parts.name || "custom-role"}`,
    ...(parts.description ? [`description: ${parts.description}`] : []),
    "---"
  ].join("\n");
  return `${frontmatter}\n\n${parts.body}`.trim();
}

export function slugFromRoleLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "custom-role";
}

