import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import type { ChatPendingChoice } from "../../../shared/types";
import { ChatChoiceCard } from "./chat-choice-card";
import { formatChatTime } from "./chat-format";

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");

const ASKED: ChatPendingChoice = {
  id: "choice-1",
  title: "Where to keep folds",
  question: "Should a folded card stay folded on every device?",
  options: [
    { id: "o1", label: "Every device", description: "Folded on the computer, folded on the phone." },
    { id: "o2", label: "This device only" }
  ],
  recommendedOptionId: "o1",
  status: "pending"
} as ChatPendingChoice;

function rendered(choice: ChatPendingChoice) {
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(<ChatChoiceCard choice={choice} requesterLabel="@taylor" submitting={false} onConfirm={() => undefined} />);
  });
  const root = renderer!.root;
  const byClass = (className: string) => root.findAll((node) => typeof node.props?.className === "string" && node.props.className.split(" ").includes(className));
  return { root, byClass };
}

test("a used choice is one line: its title, then who asked, the answer and when (the User, 2026-11-16)", () => {
  const at = "2026-11-16T17:14:00.000Z";
  const answered = rendered({ ...ASKED, status: "selected", selectedOptionId: "o1", note: "And old cards too.", selectedAt: at });
  assert.equal(answered.byClass("chat-card-row").length, 1);
  assert.equal(textOf(answered.byClass("chat-card-row-preview")[0]!), "Where to keep folds");
  assert.equal(textOf(answered.byClass("chat-card-row-outcome")[0]!), `@taylor · Every device ${formatChatTime(at)}`);
  assert.equal(answered.byClass("chat-choice-option").length, 0, "no options, no question, no buttons");
  assert.equal(answered.root.findAll((node) => node.type === "button").length, 0, "the line opens nothing");
  assert.doesNotMatch(textOf(answered.root), /Should a folded card|And old cards too|Cancel|Submit/);

  const own = rendered({ ...ASKED, status: "selected", selectedOptionId: "__custom__", customAnswer: "  Only\n the phone ", selectedAt: at });
  assert.equal(textOf(own.byClass("chat-card-row-outcome")[0]!), `@taylor · Only the phone ${formatChatTime(at)}`, "her own words, on one line");

  const cancelled = rendered({ ...ASKED, status: "cancelled", cancelledAt: at });
  assert.equal(textOf(cancelled.byClass("chat-card-row-outcome")[0]!), `@taylor · Cancelled ${formatChatTime(at)}`);

  const expired = rendered({ ...ASKED, status: "cancelled", cancelledAt: at, expiredAt: at });
  assert.equal(textOf(expired.byClass("chat-card-row-outcome")[0]!), `@taylor · Expired ${formatChatTime(at)}`);
});

test("a choice that still asks is the whole card, with its options and buttons", () => {
  const asking = rendered(ASKED);
  assert.equal(asking.byClass("chat-card-row").length, 0);
  assert.equal(textOf(asking.root.find((node) => node.props?.className === "chat-choice-question")), "Should a folded card stay folded on every device?");
  assert.equal(asking.byClass("chat-choice-option").length, 3, "two options and her own answer");
  assert.ok(asking.root.findAll((node) => node.type === "button" && textOf(node) === "Cancel").length === 1);
});

test("her own answer and a note are written in one field with the composer's round button, and Enter sends them", () => {
  const sent: unknown[] = [];
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(<ChatChoiceCard choice={ASKED} requesterLabel="@taylor" submitting={false} onConfirm={(response) => { sent.push(response); }} />);
  });
  const root = renderer!.root;
  const field = () => root.find((node) => node.type === "textarea");
  const round = () => root.find((node) => node.type === "button" && node.props.className === "composer-send-button");
  const type = (value: string): void => act(() => field().props.onChange({ target: { value } }));
  const enter = (init: Record<string, unknown> = {}): void => act(() => field().props.onKeyDown({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: () => undefined, ...init }));
  type("And old cards too.");
  act(() => round().props.onClick());
  assert.deepEqual(sent.splice(0), [{ selectedOptionId: "o1", note: "And old cards too." }]);

  act(() => root.findAll((node) => node.type === "input").at(-1)!.props.onChange());
  assert.equal(field().props["aria-label"], "Your answer");
  assert.equal(round().props.disabled, true, "nothing written yet");
  enter();
  assert.deepEqual(sent.splice(0), []);
  type("Only the phone");
  enter({ shiftKey: true });
  assert.deepEqual(sent.splice(0), [], "Shift+Enter is a new line");
  enter();
  assert.deepEqual(sent.splice(0), [{ selectedOptionId: "__custom__", customAnswer: "Only the phone" }]);
  act(() => root.find((node) => node.type === "button" && textOf(node) === "Cancel").props.onClick());
  assert.deepEqual(sent.splice(0), [{ cancel: true }]);
});
