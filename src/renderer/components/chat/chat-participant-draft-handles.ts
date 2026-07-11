import type {
  AppSettings,
  ChatProviderKind
} from "../../../shared/types";

const CHAT_NAME_POOL = ["alex", "blake", "casey", "drew", "ellis", "harper", "jamie", "jordan", "morgan", "quinn", "riley", "sam", "taylor"];

export function generatedChatHandle(settings: AppSettings, kind: ChatProviderKind, roleConfigId: string, existingHandles: Set<string> = new Set()): string {
  const roleLabel = settings.chatRoleConfigs.find((role) => role.id === roleConfigId)?.label ?? roleConfigId;
  const name = CHAT_NAME_POOL[Math.floor(Math.random() * CHAT_NAME_POOL.length)] ?? "alex";
  const cli = kind === "claude-code" ? "claude" : kind === "gemini-cli" ? "gemini" : "codex";
  const role = compactRoleSlug(roleLabel);
  const base = truncateHandle(`${name}-${cli}-${role}`, 32);
  let candidate = base;
  let suffix = 2;
  while (existingHandles.has(candidate.toLowerCase())) {
    const suffixText = `-${suffix}`;
    candidate = `${truncateHandle(base, 32 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  return candidate;
}

export function isGeneratedChatHandle(handle: string): boolean {
  const [name, cli] = handle.toLowerCase().split("-");
  return CHAT_NAME_POOL.includes(name) && (cli === "codex" || cli === "claude" || cli === "gemini");
}

function compactRoleSlug(label: string): string {
  const normalized = slugHandle(label);
  if (normalized.includes("synth")) {
    return "synthesizer";
  }
  if (normalized.includes("arbiter")) {
    return "arbiter";
  }
  if (normalized.includes("engineer")) {
    return "engineer";
  }
  return truncateHandle(normalized || "agent", 14);
}

function slugHandle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function truncateHandle(value: string, maxLength: number): string {
  return value.slice(0, maxLength).replace(/-+$/g, "") || "agent";
}
