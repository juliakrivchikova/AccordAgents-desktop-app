import assert from "node:assert/strict";
import test from "node:test";
import { act, create } from "react-test-renderer";

import {
  useChatComposerSuggestions,
  type ChatComposerSuggestion,
  type ChatComposerSuggestionsState
} from "./use-chat-composer-suggestions";

const key = (name: string, modifiers: Partial<Record<"shiftKey" | "altKey" | "ctrlKey" | "metaKey", boolean>> = {}) => ({
  key: name,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...modifiers
});

const taylor: ChatComposerSuggestion = { participantId: "p-taylor", handle: "taylor", text: "run the tests" };
const drew: ChatComposerSuggestion = { participantId: "p-drew", handle: "drew", text: "commit this" };

test("an empty composer offers the newest suggestion, addressed to its member; Tab or → takes it, ↑/↓ switch", () => {
  let state: ChatComposerSuggestionsState | undefined;
  function Harness(props: { suggestions: ChatComposerSuggestion[]; draft: string }): null {
    state = useChatComposerSuggestions(props.suggestions, props.draft);
    return null;
  }
  const current = (): ChatComposerSuggestionsState => {
    assert.ok(state);
    return state;
  };
  const renderer = create(<Harness suggestions={[taylor, drew]} draft="" />);
  assert.equal(current().offered, "@taylor run the tests");
  assert.deepEqual([current().position, current().count], [1, 2]);
  assert.equal(current().handleKey(key("Tab")), "accept");
  assert.equal(current().handleKey(key("ArrowRight")), "accept");
  assert.equal(current().handleKey(key("Tab", { shiftKey: true })), undefined, "Shift+Tab keeps its usual meaning");
  assert.equal(current().handleKey(key("Enter")), undefined, "Enter on an empty composer does not send a suggestion, as in the CLI");

  act(() => { assert.equal(current().handleKey(key("ArrowDown")), "cycle"); });
  assert.equal(current().offered, "@drew commit this");
  act(() => { current().handleKey(key("ArrowDown")); });
  assert.equal(current().offered, "@taylor run the tests", "↓ wraps around");
  act(() => { current().handleKey(key("ArrowUp")); });
  assert.equal(current().offered, "@drew commit this");

  act(() => { renderer.update(<Harness suggestions={[taylor, drew]} draft="r" />); });
  assert.equal(current().offered, undefined, "typing hides the suggestion");
  assert.equal(current().handleKey(key("Tab")), undefined);
  act(() => { renderer.update(<Harness suggestions={[taylor, drew]} draft="" />); });
  assert.equal(current().offered, "@drew commit this", "an emptied composer shows it again");

  act(() => { renderer.update(<Harness suggestions={[drew]} draft="" />); });
  assert.equal(current().offered, "@drew commit this", "a changed list starts from its newest");
  assert.equal(current().handleKey(key("ArrowDown")), undefined, "a single suggestion leaves ↑/↓ alone");
  act(() => { renderer.update(<Harness suggestions={[]} draft="" />); });
  assert.equal(current().offered, undefined);
  renderer.unmount();
});
