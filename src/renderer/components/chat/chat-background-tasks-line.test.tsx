import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import type { ChatBackgroundTask } from "../../../shared/types";
import { ChatBackgroundTaskRow, ChatBackgroundTasksLine } from "./chat-background-tasks-line";
import { ChatBackgroundTasksContext } from "./chat-roster-status";
import { ChatEnvironmentPendingContext, ENVIRONMENT_PENDING_TITLE, environmentPendingText } from "./chat-environment-pending";

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");

const render = (element: JSX.Element): string => {
  let renderer: ReturnType<typeof create> | undefined;
  act(() => { renderer = create(element); });
  const json = renderer!.toJSON();
  const text = json ? renderer!.root.children.map((child) => textOf(child as ReactTestInstance)).join("") : "";
  act(() => renderer!.unmount());
  return json ? text : "<nothing>";
};

const line = (tasks: ChatBackgroundTask[]): string => render(
  <ChatBackgroundTasksContext.Provider value={new Map([["main", tasks]])}>
    <ChatBackgroundTasksLine participantId="main" />
  </ChatBackgroundTasksContext.Provider>
);

test("the main session's background tasks line says only how many run; the names stay in its hover card (the User, 2026-11-26)", () => {
  const started = new Date(Date.now() - 14 * 60_000).toISOString();
  assert.equal(line([{ label: "Serve the docs preview", startedAt: started }, { label: "Watch the build output" }]), "2 background tasks");
  assert.equal(line([{ label: "Serve the docs preview" }]), "1 background task");
  assert.equal(line([]), "<nothing>", "no line while none runs");
  assert.equal(render(<ChatBackgroundTasksLine participantId="main" />), "<nothing>", "nor for a chat with no list");
});

test("a background task in the hover card says how long it runs, and only \"running\" when a machine on an older runtime sent no start", () => {
  const started = new Date(Date.now() - 14 * 60_000 - 5_000).toISOString();
  assert.equal(render(<ChatBackgroundTaskRow task={{ label: "Serve the docs preview", startedAt: started }} />), "Serve the docs previewrunning 14m");
  assert.equal(render(<ChatBackgroundTaskRow task={{ label: "Watch the build output" }} />), "Watch the build outputrunning");
});

test("new environment variables waiting: the pending dot after the background tasks line, only for that member, explaining in its card", () => {
  const tasks = [{ label: "Serve the docs preview" }];
  let renderer: ReturnType<typeof create> | undefined;
  const tree = (pending: ReadonlySet<string>): JSX.Element => (
    <ChatBackgroundTasksContext.Provider value={new Map([["main", tasks]])}>
      <ChatEnvironmentPendingContext.Provider value={pending}>
        <ChatBackgroundTasksLine participantId="main" />
      </ChatEnvironmentPendingContext.Provider>
    </ChatBackgroundTasksContext.Provider>
  );
  act(() => { renderer = create(tree(new Set(["main"]))); });
  const dot = renderer!.root.findAll((node) => node.props["data-testid"] === "chat-environment-pending" && typeof node.type === "string");
  assert.equal(dot.length, 1);
  assert.equal(dot[0]!.props.className, "chat-rt-status is-pending chat-environment-pending", "the pending status dot itself, no colour of its own");
  assert.equal(dot[0]!.props.tabIndex, 0, "reachable from the keyboard");
  assert.equal(dot[0]!.props["aria-label"], ENVIRONMENT_PENDING_TITLE);
  act(() => { renderer!.update(tree(new Set(["someone-else"]))); });
  assert.equal(renderer!.root.findAll((node) => node.props["data-testid"] === "chat-environment-pending").length, 0, "another member's waiting values are not this one's");
  act(() => renderer!.unmount());
  assert.equal(environmentPendingText(1), "This member still runs with the variables it started with. When its background task finishes, it restarts with the new ones and carries on the same conversation.");
  assert.match(environmentPendingText(2), /When its background tasks finish, it restarts/);
});
