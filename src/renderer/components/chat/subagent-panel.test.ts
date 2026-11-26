import assert from "node:assert/strict";
import test from "node:test";

import type { SessionsMemberRow } from "../../../shared/mainSessionView";
import type { ChatParticipant, ChatProviderKind } from "../../../shared/types";
import { subagentPanelProviders } from "./subagent-panel";

const row = (id: string, kind: ChatProviderKind, status: SessionsMemberRow["status"]): SessionsMemberRow =>
  ({ participant: { id, handle: id, kind, roleConfigId: "generic" } as ChatParticipant, status });

test("the side panel groups the sessions under the chat's providers and counts the ones at work", () => {
  const current = [row("a", "codex-cli", "running"), row("b", "gemini-cli", "waiting"), row("c", "codex-cli", "done")];
  const cases: Array<[string, Parameters<typeof subagentPanelProviders>[0], Parameters<typeof subagentPanelProviders>[1], Array<[ChatProviderKind, string[], number, number, boolean]>]> = [
    ["a chat from before the list: the providers its sessions run on", undefined, undefined,
      [["codex-cli", ["a", "c"], 1, 0, false], ["gemini-cli", ["b"], 0, 1, false]]],
    ["the chat's list, in its order, with a provider that has no session yet", [{ kind: "claude-code" }, { kind: "codex-cli" }], { entries: [] },
      [["claude-code", [], 0, 0, false], ["codex-cli", ["a", "c"], 1, 0, false], ["gemini-cli", ["b"], 0, 1, true]]],
    ["a new thread with no agents", undefined, { entries: [] }, []]
  ];
  for (const [name, project, thread, expected] of cases) {
    const providers = subagentPanelProviders(project, thread, name === "a new thread with no agents" ? [] : current);
    assert.deepEqual(providers.map((provider) => [provider.kind, provider.rows.map((item) => item.participant.id), provider.running, provider.waiting, provider.offList]), expected, name);
  }
});
