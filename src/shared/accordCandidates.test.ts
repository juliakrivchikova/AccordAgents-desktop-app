import assert from "node:assert/strict";
import test from "node:test";

import { ACCORD_NEEDS_MEMBERS_REASON, accordCandidates, accordLaunch, type AccordChat, type AccordLaunch } from "./accordCandidates";
import type { ChatParticipant, ChatProviderKind, SubagentProviderEntry } from "./types";

// Reported 2026-11-26: Codex added in the side panel's Agents list, and the
// Accord button still said "Add at least two members", disabled.

const REPO = "/work/app";
type Member = Pick<ChatParticipant, "id" | "kind" | "cloudRun">;
const main = (patch: Partial<Member> = {}): Member => ({ id: "main-id", kind: "claude-code", ...patch });
const member = (id: string, kind: ChatProviderKind): Member => ({ id, kind });

function chat(members: Member[], options: { main?: boolean; agents?: ChatProviderKind[]; view?: "classic" | "sessions"; archived?: boolean } = {}): AccordChat {
  return {
    repoPath: REPO,
    metadata: {
      participants: members,
      ...(options.main === false ? {} : { mainSessionParticipantId: "main-id" }),
      ...(options.agents ? { subagentProviders: { entries: options.agents.map((kind) => ({ kind })) } } : {}),
      ...(options.view ? { chatView: options.view } : {}),
      ...(options.archived ? { archived: true } : {})
    }
  };
}

test("who an Accord can include, and what its button does", () => {
  const project: Record<string, SubagentProviderEntry[]> = { [REPO]: [{ kind: "codex-cli" }] };
  const cases: Array<[string, Member[], Parameters<typeof chat>[1], Record<string, SubagentProviderEntry[]> | undefined, ChatProviderKind[], AccordLaunch]> = [
    ["main session and one Agents CLI: can start, the CLI joins as it starts", [main()], { agents: ["codex-cli"] }, undefined, ["codex-cli"], { kind: "ready" }],
    ["main session alone: one more agent, the button opens the Agents list", [main()], { agents: [] }, undefined, [], { kind: "add-agent" }],
    ["classic chat with two members: can start", [member("a", "codex-cli"), member("b", "claude-code")], { main: false }, undefined, [], { kind: "ready" }],
    ["classic chat with one member: today's reason", [member("a", "codex-cli")], { main: false }, undefined, [], { kind: "disabled", reason: ACCORD_NEEDS_MEMBERS_REASON }],
    ["main session alone in the classic view, which has no Agents list: today's reason", [main()], { agents: [], view: "classic" }, undefined, [],
      { kind: "disabled", reason: ACCORD_NEEDS_MEMBERS_REASON }],
    ["a CLI that has a member is that member, not a second one", [main(), member("codex-id", "codex-cli")], { agents: ["codex-cli"] }, undefined, [], { kind: "ready" }],
    ["the main session's own CLI in the list is another agent", [main()], { agents: ["claude-code"] }, undefined, ["claude-code"], { kind: "ready" }],
    ["the project's list counts as the chat's", [main()], { agents: [] }, project, ["codex-cli"], { kind: "ready" }],
    ["Antigravity is not offered to a Cloud run main session", [main({ cloudRun: {} })], { agents: ["gemini-cli"] }, undefined, [],
      { kind: "add-agent" }],
    ["a chat from before the list offers none until one is added", [main()], {}, project, [], { kind: "add-agent" }],
    ["an archived chat starts none", [main()], { agents: ["codex-cli"], archived: true }, undefined, ["codex-cli"],
      { kind: "disabled", reason: "Archived chats cannot start Accord." }]
  ];
  for (const [name, members, options, projectLists, providers, launch] of cases) {
    const room = chat(members, options);
    const candidates = accordCandidates(members, room, projectLists);
    assert.deepEqual(candidates.providers.map((provider) => provider.kind), providers, name);
    assert.deepEqual(accordLaunch(candidates, room), launch, name);
  }
});
