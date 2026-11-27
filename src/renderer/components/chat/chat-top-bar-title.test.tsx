import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatTopBarTitle } from "./chat-top-bar-title";

const click = { defaultPrevented: false, preventDefault: () => {} };
const byTestId = (root: ReactTestInstance, id: string): ReactTestInstance =>
  root.find((node) => typeof node.type === "string" && node.props["data-testid"] === id);

test("the chat name can be edited and saved at any moment: nothing about members running holds it back", async () => {
  // The editor focuses its input on the next frame (window.requestAnimationFrame).
  (globalThis as { window?: unknown }).window ??= globalThis;
  globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(0), 0) as unknown as number;
  const asked: string[] = [];
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <TooltipProvider>
        <ChatTopBarTitle
          conversation={{ id: "chat-1", title: "Old name" }}
          onRenameTitle={async (title) => { asked.push(title); return true; }}
        />
      </TooltipProvider>
    );
  });
  const edit = byTestId(renderer.root, "chat-title-edit");
  assert.notEqual(edit.props.disabled, true, "the pencil is enabled");
  assert.equal(edit.props["aria-label"], "Edit chat name");
  await act(async () => { edit.props.onClick(click); });
  const input = byTestId(renderer.root, "chat-title-input");
  await act(async () => { input.props.onChange({ target: { value: "New name" } }); });
  const save = byTestId(renderer.root, "chat-title-save");
  assert.notEqual(save.props.disabled, true, "Save is enabled once the name differs");
  await act(async () => { save.props.onClick(click); });
  assert.deepEqual(asked, ["New name"]);
  await act(async () => { renderer.unmount(); });
});
