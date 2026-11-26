import assert from "node:assert/strict";
import test from "node:test";

import { ACCORD_NEEDS_MEMBERS_REASON, accordCandidates, accordLaunch, type AccordChat, type AccordLaunch } from "./accordCandidates";
import type { ChatParticipant, ChatProviderKind } from "./types";

// Reported 2026-11-26: Codex added in the side panel's Agents list, and the
// Accord button still said "Add at least two members", disabled.

type Member = Pick<ChatParticipant, "id" | "kind" | "cloudRun">;
const main = (patch: Partial<Member> = {}): Member => ({ id: "main-id", kind: "claude-code", ...patch });
const member = (id: string, kind: ChatProviderKind): Member => ({ id, kind });

function chat(members: Member[], options: { main?: boolean; removed?: ChatProviderKind[]; view?: "classic" | "sessions"; archived?: boolean } = {}): AccordChat {
  return {
    metadata: {
      participants: members,
      ...(options.main === false ? {} : { mainSessionParticipantId: "main-id" }),
      ...(options.removed ? { subagentProviders: { entries: options.removed.map((kind) => ({ kind, removed: true as const })) } } : {}),
      ...(options.view ? { chatView: options.view } : {}),
      ...(options.archived ? { archived: true } : {})
    }
  };
}

test("who an Accord can include, and what its button does", () => {
  // The Agents list is every ready CLI, less those the chat took out.
  const cases: Array<[string, Member[], Parameters<typeof chat>[1], ChatProviderKind[], ChatProviderKind[], AccordLaunch]> = [
    ["main session and one ready CLI: can start, the CLI joins as it starts", [main()], {}, ["codex-cli"], ["codex-cli"], { kind: "ready" }],
    ["main session and no ready CLI: one more agent, the button opens the Agents list", [main()], {}, [], [], { kind: "add-agent" }],
    ["every CLI taken out of the chat: the same", [main()], { removed: ["codex-cli", "claude-code", "gemini-cli"] }, ["codex-cli", "claude-code", "gemini-cli"], [],
      { kind: "add-agent" }],
    ["classic chat with two members: can start", [member("a", "codex-cli"), member("b", "claude-code")], { main: false }, [], [], { kind: "ready" }],
    ["classic chat with one member: today's reason", [member("a", "codex-cli")], { main: false }, ["codex-cli"], [], { kind: "disabled", reason: ACCORD_NEEDS_MEMBERS_REASON }],
    ["main session alone in the classic view, which has no Agents list: today's reason", [main()], { view: "classic" }, [], [],
      { kind: "disabled", reason: ACCORD_NEEDS_MEMBERS_REASON }],
    ["a CLI that has a member is that member, not a second one", [main(), member("codex-id", "codex-cli")], {}, ["codex-cli"], [], { kind: "ready" }],
    ["the main session's own CLI is another agent", [main()], {}, ["claude-code"], ["claude-code"], { kind: "ready" }],
    ["Antigravity is not offered to a Cloud run main session", [main({ cloudRun: {} })], {}, ["gemini-cli"], [], { kind: "add-agent" }],
    ["a chat from before the list offers every ready CLI too", [main()], {}, ["gemini-cli", "codex-cli"], ["gemini-cli", "codex-cli"], { kind: "ready" }],
    ["an archived chat starts none", [main()], { archived: true }, ["codex-cli"], ["codex-cli"],
      { kind: "disabled", reason: "Archived chats cannot start Accord." }]
  ];
  for (const [name, members, options, ready, providers, launch] of cases) {
    const room = chat(members, options);
    const candidates = accordCandidates(members, room, { ready });
    assert.deepEqual(candidates.providers.map((provider) => provider.kind), providers, name);
    assert.deepEqual(accordLaunch(candidates, room), launch, name);
  }
});

test("a CLI's model and effort come from Settings, or the chat's own", () => {
  const room = chat([main()]);
  room.metadata.subagentProviders = { entries: [{ kind: "claude-code", reasoningEffort: "low" }] };
  const candidates = accordCandidates([main()], room, { ready: ["claude-code", "codex-cli"], defaults: [{ kind: "codex-cli", model: "gpt-6.2-astra" }] });
  assert.deepEqual(candidates.providers.map((provider) => [provider.kind, provider.model, provider.reasoningEffort]),
    [["claude-code", undefined, "low"], ["codex-cli", "gpt-6.2-astra", undefined]]);
});
