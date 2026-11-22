import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import type { ChatAppToolApproval, ChatClaudePlanDecision, ChatParticipant } from "../../../shared/types";
import { ChatAppToolApprovalCard } from "./chat-app-tool-approval-card";

const participants = [{ id: "p-drew", handle: "drew", roleConfigId: "software-engineer", kind: "claude-code" }] as unknown as ChatParticipant[];
const textOf = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(textOf).join("");

function planCard(planApproval: Record<string, unknown>, patch: Partial<ChatAppToolApproval> = {}): ChatAppToolApproval {
  return {
    id: "plan-1", conversationId: "chat-1", requesterParticipantId: "p-drew", requesterHandle: "drew", requesterRoleConfigId: "software-engineer",
    toolName: "app_tool_permission", capability: "permissions.request", status: "pending", summary: "Ready to code?",
    request: { kind: "toolPermission", agentMode: "plan", toolName: "ExitPlanMode", planApproval },
    createdAt: "2026-11-22T09:00:00.000Z", updatedAt: "2026-11-22T09:00:00.000Z", ...patch
  } as ChatAppToolApproval;
}

function render(approval: ChatAppToolApproval) {
  const answers: Array<{ approve: boolean; planDecision?: ChatClaudePlanDecision; codexDecisionId?: string }> = [];
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <ChatAppToolApprovalCard approval={approval} participants={participants} savedParticipants={[]} roles={[]} submitting={false}
        onRespond={async (_id, approve, _scope, _draft, codexDecisionId, planDecision) => { answers.push({ approve, planDecision, codexDecisionId }); }} />
    );
  });
  const root = renderer.root;
  const option = (id: string) => root.find((node) => node.type === "button" && node.props["data-plan-option-id"] === id);
  const submit = () => act(() => { root.find((node) => node.type === "button" && String(node.props.className).includes("chat-approval-submit")).props.onClick(); });
  return { root, answers, option, submit, text: () => textOf(root), unmount: () => renderer.unmount() };
}

test("Claude Code's plan approval card is the CLI's dialog: its words around the plan and its rows, in its order", () => {
  const card = render(planCard({ plan: "# Plan\n\n1. Write **hello.txt**" }));
  const text = card.text();
  for (const words of ["Ready to code?", "Here is Claude's plan:", "Claude has written up a plan and is ready to execute. Would you like to proceed?"]) {
    assert.ok(text.includes(words), words);
  }
  assert.match(text, /hello\.txt/, "the plan itself");
  const rows = card.root.findAll((node) => node.type === "button" && node.props["data-plan-option-id"] !== undefined).map((node) => textOf(node));
  assert.deepEqual(rows, ["1.Yes, auto-accept edits", "2.Yes, manually approve edits", "3.No, keep planning"]);
  assert.doesNotMatch(text, /Allow once|for this chat|Tool request|Input/, "not a tool permission card");
  card.unmount();

  const auto = render(planCard({ plan: "x", autoModeAvailable: true }));
  assert.equal(textOf(auto.option("yes-resume-auto-mode")), "1.Yes, and use auto mode");
  auto.unmount();
  const empty = render(planCard({ plan: "" }));
  assert.match(empty.text(), /No plan found\. Please write your plan to the plan file first\./);
  empty.unmount();
  const withheld = render(planCard({ withheld: true }));
  assert.match(withheld.text(), /\(the plan is too large to be shown in full, so it can only be declined\)/);
  assert.equal(withheld.root.findAll((node) => node.type === "button" && node.props["data-plan-option-id"] !== undefined).length, 1);
  withheld.unmount();
});

test("a Yes answers with the row the CLI names; No, keep planning sends her words", () => {
  const yes = render(planCard({ plan: "x" }));
  yes.submit();
  assert.deepEqual(yes.answers, [{ approve: true, planDecision: { optionId: "yes-accept-edits-keep-context" }, codexDecisionId: undefined }]);
  act(() => { yes.option("yes-default-keep-context").props.onClick(); });
  yes.submit();
  assert.deepEqual(yes.answers[1], { approve: true, planDecision: { optionId: "yes-default-keep-context" }, codexDecisionId: undefined });
  yes.unmount();

  const no = render(planCard({ plan: "x" }));
  assert.equal(no.root.findAll((node) => node.type === "textarea").length, 0, "the field is the row's own");
  act(() => { no.option("no").props.onClick(); });
  const field = no.root.find((node) => node.type === "textarea");
  assert.equal(field.props.placeholder, "Tell Claude what to change");
  act(() => { field.props.onChange({ target: { value: "  Smaller steps, please.  " } }); });
  no.submit();
  assert.deepEqual(no.answers, [{ approve: false, planDecision: { optionId: "no", feedback: "Smaller steps, please." }, codexDecisionId: undefined }]);
  no.unmount();
});

test("an answered plan approval is one line naming the row she picked", () => {
  const card = render(planCard({}, { status: "approved", planDecision: { optionId: "yes-accept-edits-keep-context" } }));
  const row = card.root.find((node) => node.props?.className === "chat-card-row");
  assert.match(textOf(row), /Ready to code\?/);
  assert.match(textOf(row), /Yes, auto-accept edits/);
  card.unmount();
});
