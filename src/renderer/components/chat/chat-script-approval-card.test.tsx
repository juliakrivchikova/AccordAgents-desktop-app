import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import type { ChatScriptChangeRequest } from "../../../shared/scripts";
import type { ChatAppToolApproval } from "../../../shared/types";
import { ChatScriptApprovalCard } from "./chat-script-approval-card";

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");

const REQUEST = {
  op: "create", scriptId: "s1", revisionId: "r1", name: "My PRs auto-review", hostLabel: "This Mac", hostPhrase: "this Mac", scheduleText: "Every minute",
  description: "Reads PR links from new messages and wakes the chat for a review.", reason: "Moved from the old chat.", runtime: "node", fileCount: 2, totalBytes: 13_005,
  timeoutSeconds: 120, secretNames: ["SLACK_TOKEN"], chatLabels: { c1: "Auto-review" }, participantLabels: {},
  permissions: { chatIds: ["c1"], participantIds: [], maxWakeupsPerHour: 30 }
} as unknown as ChatScriptChangeRequest;
const APPROVAL = { id: "a1", status: "pending", requesterParticipantId: "p1", requesterHandle: "gera", createdAt: "2026-11-25T13:15:00.000Z" } as unknown as ChatAppToolApproval;

async function rendered(setScriptSecret: (request: unknown) => Promise<{ savedSecretNames: string[] }>) {
  const answers: unknown[][] = [];
  (window as unknown as { consensus: unknown }).consensus = {
    listScripts: async () => [], onScriptsUpdated: () => () => undefined, setScriptSecret,
    getScriptRevision: async () => ({ entry: "main.mjs", files: [{ path: "main.mjs", content: "run()" }] })
  };
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(<ChatScriptApprovalCard approval={APPROVAL} request={REQUEST} participants={[]} submitting={false}
      onRespond={async (...args) => { answers.push(args); }} />);
  });
  const root = renderer!.root;
  const button = (text: string) => root.find((node) => node.type === "button" && textOf(node).startsWith(text));
  return { root, answers, button, press: (text: string) => act(async () => { button(text).props.onClick(); }) };
}

test("a scheduled task's card says its name and when it runs and asks for its key; everything else is under Details", async () => {
  const card = await rendered(async () => ({ savedSecretNames: [] }));
  const shown = textOf(card.root.findByProps({ className: "chat-script-approval-content" }));
  assert.equal(shown, "My PRs auto-reviewEvery minute on this MacSLACK_TOKENDetails");
  await card.press("Details");
  const details = textOf(card.root.findByProps({ className: "chat-script-approval-details" }));
  for (const part of ["Reads PR links", "Moved from the old chat.", "Auto-review", "120 s per run", "agents never see them", "Show code: node, 2 files, 12.7 KB", "full permissions on this Mac"]) {
    assert.ok(details.includes(part), part);
  }
  await card.press("Show code");
  assert.match(textOf(card.root), /run\(\)/);
});

test("the key is saved as she approves, on the computer that runs the task, and a key that was not saved approves nothing", async () => {
  const saved: unknown[] = [];
  const card = await rendered(async (request) => { saved.push(request); return { savedSecretNames: ["SLACK_TOKEN"] }; });
  assert.equal(card.button("Approve and run").props.disabled, true, "no key yet");
  const type = (value: string) => act(async () => { card.root.find((node) => node.type === "input").props.onChange({ target: { value } }); });
  await type("xoxp-1");
  assert.equal(card.button("Approve and run").props.disabled, false);
  await card.press("Approve and run");
  assert.deepEqual(saved, [{ scriptId: "s1", name: "SLACK_TOKEN", value: "xoxp-1" }]);
  assert.deepEqual(card.answers, [["a1", true, "once"]]);

  const refused = await rendered(async () => { throw new Error("The keychain is locked."); });
  await act(async () => { refused.root.find((node) => node.type === "input").props.onChange({ target: { value: "x" } }); });
  await refused.press("Approve and run");
  assert.deepEqual(refused.answers, []);
  assert.match(textOf(refused.root), /The keychain is locked\./);
  await refused.press("Decline");
  assert.deepEqual(refused.answers, [["a1", false]]);
});
