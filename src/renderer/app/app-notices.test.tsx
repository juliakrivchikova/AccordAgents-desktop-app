import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { MachineInactivityQuestion } from "../../shared/machineLink";
import { AppNotices } from "./app-notices";
import type { DismissedWarningMap } from "./storage";

function harness(options: { error?: string; warnings: string[]; dismissFails?: boolean; questions?: MachineInactivityQuestion[] }) {
  const calls: string[] = [];
  let error = options.error;
  let warnings = [...options.warnings];
  let dismissed: DismissedWarningMap = {};
  let questions = [...(options.questions ?? [])];
  window.consensus = {
    dismissConversationWarnings: async (request: { warnings: string[] }) => {
      calls.push(`dismiss:${request.warnings.join("|")}`);
      if (options.dismissFails) throw new Error("could not save");
    },
    listMachineInactivityQuestions: async () => questions,
    answerMachineInactivity: async (request: { machineId: string; answer: string }) => {
      calls.push(`answer:${request.machineId}:${request.answer}`);
      questions = questions.filter((question) => question.machineId !== request.machineId);
      return questions;
    },
    onMachineInactivityQuestions: () => () => undefined
  } as unknown as typeof window.consensus;
  let renderer!: ReactTestRenderer;
  const render = (): void => {
    const element = (
      <AppNotices
        error={error}
        warnings={warnings.map((text) => ({ key: text, text }))}
        warningScope="chat:c1"
        conversationId="c1"
        setError={(value) => { error = value; calls.push(`error:${value ?? "-"}`); }}
        setWarnings={(update) => { warnings = typeof update === "function" ? update(warnings) : update; }}
        setDismissedWarningKeysByScope={(update) => { dismissed = typeof update === "function" ? update(dismissed) : update; }}
      />
    );
    if (renderer) renderer.update(element); else renderer = create(element);
  };
  act(() => render());
  const button = (label: string) => renderer.root.findAll((node) => node.type === "button" && (node.props["aria-label"] === label || node.props.children === label))[0];
  const click = async (label: string): Promise<void> => {
    await act(async () => { button(label).props.onClick(); });
    act(() => render());
  };
  return { calls, click, button, renderer: () => renderer, state: () => ({ error, warnings, dismissed }) };
}

test("an empty stack renders nothing, and a lone notice has no Dismiss all", () => {
  assert.equal(harness({ warnings: [] }).renderer().toJSON(), null);
  const lone = harness({ warnings: ["Run was interrupted."] });
  assert.equal(lone.button("Dismiss all"), undefined);
  assert.ok(lone.button("Dismiss warning"));
});

test("the error is the first card, above the warnings, and dismisses on its own", async () => {
  const h = harness({ error: "Send failed.", warnings: ["Run was interrupted."] });
  const cards = h.renderer().root.findAll((node) => node.props.className === "app-notice-card");
  const tone = (card: (typeof cards)[number]) => card.findAll((node) => Boolean(node.props.tone))[0]?.props.tone;
  assert.deepEqual(cards.map(tone), ["error", "warning"], "the error card leads the stack");
  await h.click("Dismiss error");
  assert.equal(h.state().error, undefined);
  assert.deepEqual(h.state().warnings, ["Run was interrupted."], "warnings stay until dismissed");
});

test("Dismiss all clears the error and every warning, and remembers the warnings as dismissed", async () => {
  const h = harness({ error: "Send failed.", warnings: ["Run was interrupted.", "Model fell back."] });
  await h.click("Dismiss all");
  assert.equal(h.state().error, undefined);
  assert.deepEqual(h.state().warnings, []);
  assert.deepEqual(h.state().dismissed["chat:c1"], ["Run was interrupted.", "Model fell back."]);
  assert.ok(h.calls.includes("dismiss:Run was interrupted.|Model fell back."));
  assert.equal(h.renderer().toJSON(), null);
});

test("a dismissal that cannot be saved surfaces as an error", async () => {
  const h = harness({ warnings: ["Run was interrupted.", "Model fell back."], dismissFails: true });
  await h.click("Dismiss all");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(h.state().error, "could not save");
});

test("a machine that stopped being used is asked about, survives Dismiss all, and its answer goes to the desktop", async () => {
  const h = harness({ warnings: ["Run was interrupted.", "Model fell back."], questions: [{ machineId: "m1", name: "cloud-box", inactiveDays: 12 }] });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const question = () => h.renderer().root.findAll((node) => node.props["data-testid"] === "machine-inactivity-question")[0];
  const text = (node: ReturnType<typeof question>): string => node.findAll((child) => typeof child.children?.[0] === "string")
    .map((child) => child.children.join("")).join(" ");
  assert.ok(question(), "the question is shown");
  assert.match(text(question()), /Is cloud-box still in use\?/);
  assert.match(text(question()), /12 days/);
  await h.click("Dismiss all");
  assert.ok(question(), "a question waits for an answer; Dismiss all leaves it");
  await h.click("Keep");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.ok(h.calls.includes("answer:m1:keep"));
  assert.equal(question(), undefined);
});

test("Remove is the other answer", async () => {
  const h = harness({ warnings: [], questions: [{ machineId: "m2", name: "old-box", inactiveDays: 30 }] });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await h.click("Remove");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.ok(h.calls.includes("answer:m2:remove"));
  assert.equal(h.renderer().toJSON(), null);
});
