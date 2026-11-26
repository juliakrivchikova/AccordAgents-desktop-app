import assert from "node:assert/strict";
import test from "node:test";

import type { SessionsMemberRow } from "../../../shared/mainSessionView";
import type { ChatParticipant, ChatProviderKind } from "../../../shared/types";
import { subagentPanelProviders } from "./subagent-panel";

const row = (id: string, kind: ChatProviderKind, status: SessionsMemberRow["status"]): SessionsMemberRow =>
  ({ participant: { id, handle: id, kind, roleConfigId: "generic" } as ChatParticipant, status });

test("the side panel lists the ready CLIs, groups the sessions under them and counts the ones at work", () => {
  const current = [row("a", "codex-cli", "running"), row("b", "gemini-cli", "waiting"), row("c", "codex-cli", "done")];
  const cases: Array<[string, Parameters<typeof subagentPanelProviders>[0], SessionsMemberRow[], Array<[ChatProviderKind, string[], number, number, boolean]>]> = [
    ["a new chat: every ready CLI, with no session yet", { ready: ["claude-code", "codex-cli"] }, [],
      [["claude-code", [], 0, 0, false], ["codex-cli", [], 0, 0, false]]],
    ["sessions under their CLI; one taken out of the chat stays while it has sessions", { ready: ["gemini-cli", "claude-code", "codex-cli"], thread: { entries: [{ kind: "gemini-cli", removed: true }] } }, current,
      [["claude-code", [], 0, 0, false], ["codex-cli", ["a", "c"], 1, 0, false], ["gemini-cli", ["b"], 0, 1, true]]],
    ["none ready and no sessions", { ready: [] }, [], []]
  ];
  for (const [name, list, rows, expected] of cases) {
    const providers = subagentPanelProviders(list, rows);
    assert.deepEqual(providers.map((provider) => [provider.kind, provider.rows.map((item) => item.participant.id), provider.running, provider.waiting, provider.offList]), expected, name);
  }
});
