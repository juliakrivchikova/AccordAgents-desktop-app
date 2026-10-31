import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import {
  ActivityDisclosureHarness,
  activityEvent,
  activityRowLabels,
  buttonWithLabel,
  groupLines,
  textContent
} from "./chat-activity-test-harness";

test("a live run shows only its current activity on one shimmering line", async () => {
  const events = [
    activityEvent("tool", 1, "Reading file"),
    activityEvent("command", 2, "Using Bash"),
    activityEvent("command", 3, "Using Bash again")
  ];
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ActivityDisclosureHarness activityEvents={events} mode="stream-empty" />);
  });
  assert.deepEqual(groupLines(renderer!), ["Using Bash again~live"]);
  assert.deepEqual(activityRowLabels(renderer!), [], "earlier activities are not listed");
  assert.doesNotMatch(textContent(renderer!.root), /commands?/);

  const next = [...events, activityEvent("web", 4, "Using web search")];
  await act(async () => {
    renderer!.update(<ActivityDisclosureHarness activityEvents={next} mode="stream-empty" />);
  });
  assert.deepEqual(groupLines(renderer!), ["Using web search~live"], "the next activity replaces the line");
  await act(async () => renderer!.unmount());
});

test("opening the live line lists the run so far and keeps an opened detail while it grows", async () => {
  const events = [
    activityEvent("command", 1, "Using Bash", "npm test"),
    activityEvent("tool", 2, "Reading file", "src/app.tsx")
  ];
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ActivityDisclosureHarness activityEvents={events} mode="stream-empty" />);
  });
  await act(async () => buttonWithLabel(renderer!, "Reading file").props.onClick());
  assert.deepEqual(groupLines(renderer!), ["2 commands"]);
  assert.deepEqual(activityRowLabels(renderer!), ["Using Bash", "Reading file~live"]);
  await act(async () => buttonWithLabel(renderer!, "Using Bash").props.onClick());

  const next = [...events, activityEvent("command", 3, "Using Bash again", "npm run build")];
  await act(async () => {
    renderer!.update(<ActivityDisclosureHarness activityEvents={next} mode="stream-empty" />);
  });
  assert.deepEqual(groupLines(renderer!), ["3 commands"]);
  assert.deepEqual(activityRowLabels(renderer!), ["Using Bash", "Reading file", "Using Bash again~live"]);
  assert.equal(buttonWithLabel(renderer!, "Using Bash").props["aria-expanded"], true, "the opened detail stays open");

  await act(async () => buttonWithLabel(renderer!, "3 commands").props.onClick());
  assert.deepEqual(groupLines(renderer!), ["Using Bash again~live"], "closing the list returns to the one line");
  await act(async () => renderer!.unmount());
});

test("activities the member moved past become a count that expands to the full list", async () => {
  const events = [
    activityEvent("tool", 1, "Reading file"),
    activityEvent("command", 2, "Using Bash")
  ];
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ActivityDisclosureHarness activityEvents={events} mode="stream-tail" />);
  });
  const group = buttonWithLabel(renderer!, "2 commands");
  assert.equal(group.props["aria-expanded"], false);
  assert.equal(group.props["aria-controls"], undefined, "a collapsed group does not point at an unmounted list");
  assert.deepEqual(groupLines(renderer!), ["2 commands"]);
  assert.deepEqual(activityRowLabels(renderer!), []);

  await act(async () => group.props.onClick());
  assert.equal(buttonWithLabel(renderer!, "2 commands").props["aria-expanded"], true);
  const list = renderer!.root.findByProps({ className: "chat-inline-activity-group-list" });
  assert.equal(list.props.id, buttonWithLabel(renderer!, "2 commands").props["aria-controls"]);
  assert.deepEqual(activityRowLabels(renderer!), ["Reading file", "Using Bash"]);
  await act(async () => renderer!.unmount());
});

test("the live line becomes a count when the member starts the next paragraph", async () => {
  const offset = "First paragraph.".length;
  const events = [
    { ...activityEvent("command", 1, "Using Bash"), afterContentLength: offset },
    { ...activityEvent("tool", 2, "Reading file"), afterContentLength: offset }
  ];
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ActivityDisclosureHarness activityEvents={events} mode="stream-tail" />);
  });
  assert.deepEqual(groupLines(renderer!), ["Reading file~live"], "activities after the streamed text are live");

  await act(async () => {
    renderer!.update(<ActivityDisclosureHarness activityEvents={events} mode="stream-completed" />);
  });
  assert.deepEqual(groupLines(renderer!), ["2 commands"], "the next paragraph ends the run");

  await act(async () => {
    renderer!.update(<ActivityDisclosureHarness activityEvents={[{ ...events[0], afterContentLength: 0 }]} mode="finished" />);
  });
  await act(async () => buttonWithLabel(renderer!, "Show full stream").props.onClick());
  assert.deepEqual(groupLines(renderer!), ["1 command"]);
  await act(async () => renderer!.unmount());
});

test("one run stays one line across a paragraph break", async () => {
  const first = "First paragraph.";
  const events = [
    { ...activityEvent("command", 1, "Using Bash"), afterContentLength: first.length },
    { ...activityEvent("tool", 2, "Reading file"), afterContentLength: `${first}\n\n`.length }
  ];
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ActivityDisclosureHarness activityEvents={events} mode="stream-break" />);
  });
  assert.deepEqual(groupLines(renderer!), ["Reading file~live"], "an activity right after the break is the current one");

  await act(async () => {
    renderer!.update(<ActivityDisclosureHarness activityEvents={events} mode="stream-break" content={`${first}\n\n `} />);
  });
  assert.deepEqual(groupLines(renderer!), ["Reading file~live"], "whitespace is not the next sentence");

  await act(async () => {
    renderer!.update(<ActivityDisclosureHarness activityEvents={events} mode="stream-break" content={`${first}\n\nNext`} />);
  });
  assert.deepEqual(groupLines(renderer!), ["2 commands"], "text after the break ends the run as one count");
  await act(async () => renderer!.unmount());
});

test("an open group stays open when its oldest activities are trimmed", async () => {
  const events = [1, 2, 3].map((sequence) => activityEvent("command", sequence, `Command ${sequence}`));
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ActivityDisclosureHarness activityEvents={events} mode="stream-empty" />);
  });
  await act(async () => buttonWithLabel(renderer!, "Command 3").props.onClick());
  assert.deepEqual(groupLines(renderer!), ["3 commands"]);

  const trimmed = [...events.slice(1), activityEvent("command", 4, "Command 4")];
  await act(async () => {
    renderer!.update(<ActivityDisclosureHarness activityEvents={trimmed} mode="stream-empty" />);
  });
  assert.deepEqual(groupLines(renderer!), ["3 commands"]);
  assert.deepEqual(activityRowLabels(renderer!), ["Command 2", "Command 3", "Command 4~live"]);

  await act(async () => buttonWithLabel(renderer!, "3 commands").props.onClick());
  assert.deepEqual(groupLines(renderer!), ["Command 4~live"], "closing clears every open mark in the group");
  await act(async () => renderer!.unmount());
});

test("notices about the run stay visible as their own rows", async () => {
  const events = [
    activityEvent("command", 1, "Using Bash"),
    activityEvent("status", 2, "No provider output for 5 minutes"),
    activityEvent("command", 3, "Using Bash again")
  ];
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ActivityDisclosureHarness activityEvents={events} mode="stream-empty" />);
  });
  assert.deepEqual(groupLines(renderer!), ["1 command", "Using Bash again~live"]);
  assert.deepEqual(activityRowLabels(renderer!), ["No provider output for 5 minutes"]);
  await act(async () => renderer!.unmount());
});

test("the status line shows until the member's first text, and a cloud run's own status stays", async () => {
  const statusLine = (renderer: ReactTestRenderer) => renderer.root
    .findAll((node) => typeof node.type === "string" && /streaming-message-thinking/.test(String(node.props.className ?? "")))
    .map((node) => textContent(node));
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ActivityDisclosureHarness activityEvents={[]} mode="stream-empty" />);
  });
  assert.deepEqual(statusLine(renderer!).map((text) => text.replace(/\d+:\d+/, "")), ["Thinking"]);

  await act(async () => {
    renderer!.update(<ActivityDisclosureHarness activityEvents={[]} mode="stream-tail" />);
  });
  assert.deepEqual(statusLine(renderer!), [], "no Responding line once text appears");
  assert.doesNotMatch(textContent(renderer!.root), /Responding/);

  await act(async () => {
    renderer!.update(<ActivityDisclosureHarness activityEvents={[]} mode="stream-tail" statusLabel="Preparing machine" />);
  });
  assert.deepEqual(statusLine(renderer!).map((text) => text.replace(/\d+:\d+/, "")), ["Preparing machine"]);
  await act(async () => renderer!.unmount());
});
