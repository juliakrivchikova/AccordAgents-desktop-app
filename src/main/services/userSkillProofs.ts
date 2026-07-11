import type { ChatProviderKind } from "../../shared/types";

// App-owned fixture skill used only for manual/QA verification that a provider can actually invoke
// a discovered skill under AccordAgents' real CLI launch modes. V1 does not run this from the app:
// runtime skill capability is deterministic (discovery + effective run root), and provider-native
// invocation is confirmed as a release-time QA check, not by app runtime or UI logic.
export const ACCORDAGENTS_SKILL_PROOF_NAME = "accordagents-skill-proof";
export const ACCORDAGENTS_SKILL_PROOF_OK = "ACCORDAGENTS_BODY_TOKEN_6B37D91E";

export function appOwnedSkillProofMarkdown(providerKind: ChatProviderKind): string {
  const provider = providerKind === "codex-cli" ? "Codex" : providerKind === "gemini-cli" ? "Gemini" : "Claude";
  return [
    "---",
    `name: ${ACCORDAGENTS_SKILL_PROOF_NAME}`,
    `description: AccordAgents internal ${provider} skill invocation proof. Responds with a fixed harmless marker.`,
    "---",
    "",
    `When this skill is invoked, respond with exactly \`${ACCORDAGENTS_SKILL_PROOF_OK}\` and no other text.`
  ].join("\n");
}
