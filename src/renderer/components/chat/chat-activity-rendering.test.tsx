import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { ChatAgentActivityEvent } from "../../../shared/types";
import {
  ActivityDisclosureHarness,
  activityContent,
  activityEvent,
  buttonWithLabel,
  NOW,
  openGroups,
  svgClassNames,
  textContent
} from "./chat-activity-test-harness";

test("activity detail masks secrets and independently preserves reveal and length state", async () => {
  const detail = [
    "Authorization: Bearer sk-test-secret",
    "API_KEY=abc123",
    "line",
    "line",
    "line",
    "line",
    "line",
    "x".repeat(650)
  ].join("\n");
  const activityEvent: ChatAgentActivityEvent = {
    id: "activity-1",
    sequence: 1,
    kind: "tool",
    label: "Using MCP tool",
    detail,
    createdAt: NOW
  };
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <ActivityDisclosureHarness activityEvents={[activityEvent]} />
    );
  });
  await openGroups(renderer!);

  const activityToggle = buttonWithLabel(renderer!, "Using MCP tool");
  assert.equal(activityToggle.props["aria-expanded"], false);
  assert.equal(activityContent(renderer!).props.hidden, true);
  await act(async () => {
    activityToggle.props.onClick();
  });

  const pre = () => renderer!.root.findByType("pre");
  assert.match(pre().props.className, /is-collapsed/);
  assert.match(textContent(pre()), /Authorization: Bearer ••••/);
  assert.match(textContent(pre()), /API_KEY=••••/);
  assert.doesNotMatch(textContent(pre()), /sk-test-secret|abc123/);

  const revealButton = buttonWithLabel(renderer!, "Reveal");
  await act(async () => {
    revealButton.props.onClick();
  });
  assert.match(textContent(pre()), /sk-test-secret/);
  assert.match(textContent(pre()), /API_KEY=abc123/);

  const showMoreButton = buttonWithLabel(renderer!, "Show more");
  await act(async () => {
    showMoreButton.props.onClick();
  });
  assert.doesNotMatch(pre().props.className, /is-collapsed/);

  await act(async () => {
    buttonWithLabel(renderer!, "Using MCP tool").props.onClick();
  });
  assert.equal(activityContent(renderer!).props.hidden, true);
  assert.doesNotMatch(textContent(pre()), /sk-test-secret|abc123/, "collapsed rows never keep revealed secrets mounted");
  await act(async () => {
    buttonWithLabel(renderer!, "Using MCP tool").props.onClick();
  });
  buttonWithLabel(renderer!, "Show less");
  assert.match(textContent(pre()), /sk-test-secret/);

  await act(async () => renderer!.unmount());
});

test("every detailed activity kind has one disclosure icon and valid hidden semantics", async () => {
  const activityKinds = ["tool", "command", "file-edit", "web", "approval", "status"] as const;
  for (const [index, kind] of activityKinds.entries()) {
    const label = `Activity ${kind}`;
    const detail = `Detail ${kind}`;
    const activityEvent: ChatAgentActivityEvent = {
      id: `activity-${kind}`,
      sequence: index + 1,
      kind,
      label,
      detail,
      createdAt: NOW
    };
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <ActivityDisclosureHarness activityEvents={[activityEvent]} />
      );
    });
    await openGroups(renderer!);

    const toggle = buttonWithLabel(renderer!, label);
    assert.equal(toggle.props["aria-expanded"], false, `${kind} starts collapsed`);
    assert.equal(toggle.props.title, label, `${kind} keeps its full label tooltip`);
    assert.equal(toggle.props.type, "button", `${kind} uses native keyboard button semantics`);
    assert.equal(toggle.props.role, undefined, `${kind} does not override native button semantics`);
    assert.equal(toggle.props.tabIndex, undefined, `${kind} stays in the normal tab order`);
    const controlledContent = activityContent(renderer!);
    assert.equal(controlledContent.props.id, toggle.props["aria-controls"], `${kind} controls a mounted node`);
    assert.equal(controlledContent.props.hidden, true, `${kind} hides detail semantically`);
    const iconClasses = svgClassNames(toggle);
    assert.equal(iconClasses.length, 1, `${kind} renders only the disclosure icon`);
    assert.match(iconClasses[0] ?? "", /chat-inline-activity-disclosure-icon/, `${kind} has disclosure icon`);
    await act(async () => {
      toggle.props.onClick();
    });
    assert.equal(buttonWithLabel(renderer!, label).props["aria-expanded"], true, `${kind} expands`);
    assert.equal(activityContent(renderer!).props.hidden, false, `${kind} unhides detail`);
    assert.equal(textContent(renderer!.root.findByType("pre")), detail, `${kind} renders its detail`);
    await act(async () => renderer!.unmount());
  }
});

test("detail-less activity kinds are noninteractive and never use disclosure chevrons", async () => {
  const activityKinds = ["tool", "command", "file-edit", "web", "approval", "status"] as const;
  for (const [index, kind] of activityKinds.entries()) {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <ActivityDisclosureHarness activityEvents={[activityEvent(kind, index + 1)]} />
      );
    });
    await openGroups(renderer!);
    const row = renderer!.root.find((node) => typeof node.type === "string" && String(node.props.className ?? "").startsWith(`chat-inline-activity-event is-${kind}`));
    assert.equal(row.findAllByType("button").length, 0, `${kind} has no disclosure button`);
    assert.equal(row.findAllByType("svg").length, 1, `${kind} renders one semantic icon`);
    assert.doesNotMatch(svgClassNames(row)[0] ?? "", /chevron|disclosure/, `${kind} does not impersonate a disclosure`);
    await act(async () => renderer!.unmount());
  }
});

test("long activity detail uses a six-line preview and keeps Show more at the far right", async () => {
  const detail = [
    "/bin/zsh -lc 'npm run typecheck'",
    "",
    "Output tail:",
    "line 1",
    "line 2",
    "line 3",
    "line 4",
    "line 5"
  ].join("\n");
  const activityEvent: ChatAgentActivityEvent = {
    id: "activity-command",
    sequence: 1,
    kind: "command",
    label: "Running command",
    detail,
    createdAt: NOW
  };
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <ActivityDisclosureHarness activityEvents={[activityEvent]} />
    );
  });
  await openGroups(renderer!);

  const toggle = buttonWithLabel(renderer!, "Running command");
  assert.equal(toggle.props["aria-expanded"], false);
  assert.equal(activityContent(renderer!).props.hidden, true);

  await act(async () => {
    toggle.props.onClick();
  });
  assert.equal(buttonWithLabel(renderer!, "Running command").props["aria-expanded"], true);
  assert.equal(textContent(renderer!.root.findByType("pre")), detail);
  assert.match(renderer!.root.findByType("pre").props.className, /is-collapsed/);

  const showMoreButton = buttonWithLabel(renderer!, "Show more");
  assert.match(showMoreButton.props.className, /is-detail-length-toggle/);
  await act(async () => {
    showMoreButton.props.onClick();
  });
  assert.doesNotMatch(renderer!.root.findByType("pre").props.className, /is-collapsed/);
  buttonWithLabel(renderer!, "Show less");

  await act(async () => {
    buttonWithLabel(renderer!, "Running command").props.onClick();
  });
  assert.equal(activityContent(renderer!).props.hidden, true);

  const actions = renderer!.root.findByProps({ className: "chat-inline-activity-actions" });
  assert.deepEqual(actions.findAllByType("button").map(textContent), ["Show less"]);

  const css = readFileSync("src/renderer/styles/views/chat-conversation.css", "utf8");
  assert.match(css, /chat-inline-activity-detail\.is-collapsed\s*{[^}]*max-height:\s*calc\(6 \* 1\.4em\)/s);
  assert.match(css, /chat-inline-activity-actions\s*{[^}]*justify-content:\s*flex-end/s);
  assert.match(css, /chat-inline-activity-action\s*{[^}]*border:\s*0[^}]*background:\s*transparent/s);
  assert.match(css, /chat-inline-activity-detail\s*{[^}]*background:\s*transparent[^}]*color:\s*var\(--app-muted-subtle\)/s);

  await act(async () => renderer!.unmount());
});

test("activity disclosure survives no-content to first text and tail to completed streaming moves", async () => {
  const event = activityEvent("tool", 1, "Tool usage", "Tool detail");
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ActivityDisclosureHarness activityEvents={[event]} mode="stream-empty" />);
  });
  await openGroups(renderer!);
  await act(async () => buttonWithLabel(renderer!, event.label).props.onClick());

  await act(async () => {
    renderer!.update(<ActivityDisclosureHarness activityEvents={[event]} mode="stream-tail" />);
  });
  assert.equal(buttonWithLabel(renderer!, "1 command").props["aria-expanded"], true, "the open group stays open once the member moves on");
  assert.equal(buttonWithLabel(renderer!, event.label).props["aria-expanded"], true, "first text keeps activity open");
  assert.equal(activityContent(renderer!).props.hidden, false);

  await act(async () => {
    renderer!.update(<ActivityDisclosureHarness activityEvents={[event]} mode="stream-completed" />);
  });
  assert.equal(buttonWithLabel(renderer!, event.label).props["aria-expanded"], true, "completed segment keeps activity open");
  assert.equal(activityContent(renderer!).props.hidden, false);
  await act(async () => renderer!.unmount());
});

test("activity disclosure survives streaming to finished renderer and virtualized remount", async () => {
  const event = activityEvent("command", 1, "Running command", "npm run typecheck");
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ActivityDisclosureHarness activityEvents={[event]} mode="stream-empty" />);
  });
  await openGroups(renderer!);
  await act(async () => buttonWithLabel(renderer!, event.label).props.onClick());

  await act(async () => {
    renderer!.update(<ActivityDisclosureHarness activityEvents={[event]} mode="finished" />);
  });
  assert.equal(buttonWithLabel(renderer!, "Show full stream").props["aria-expanded"], false);
  await act(async () => buttonWithLabel(renderer!, "Show full stream").props.onClick());
  assert.equal(buttonWithLabel(renderer!, "1 command").props["aria-expanded"], true, "the group opened while live stays open");
  assert.equal(buttonWithLabel(renderer!, event.label).props["aria-expanded"], true, "finished renderer keeps activity open");

  await act(async () => {
    renderer!.update(<ActivityDisclosureHarness activityEvents={[event]} mode="unmounted" />);
  });
  assert.equal(renderer!.root.findAllByType("button").length, 0);
  await act(async () => {
    renderer!.update(<ActivityDisclosureHarness activityEvents={[event]} mode="finished" />);
  });
  assert.equal(buttonWithLabel(renderer!, event.label).props["aria-expanded"], true, "virtualized remount keeps activity open");
  await act(async () => renderer!.unmount());
});

test("timeline and thread copies share disclosure state across thread close and reopen", async () => {
  const event = activityEvent("file-edit", 1, "Edited file", "src/app.tsx");
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ActivityDisclosureHarness activityEvents={[event]} mode="timeline-and-thread" />);
  });
  const groups = renderer!.root.findAllByType("button");
  assert.deepEqual(groups.map(textContent), ["1 command", "1 command"]);
  await act(async () => groups[0].props.onClick());
  const copies = renderer!.root.findAllByType("button").filter((button) => textContent(button).includes(event.label));
  assert.equal(copies.length, 2);
  await act(async () => copies[0].props.onClick());
  assert.deepEqual(renderer!.root.findAllByType("button").map((button) => button.props["aria-expanded"]), [true, true, true, true]);

  await act(async () => {
    renderer!.update(<ActivityDisclosureHarness activityEvents={[event]} mode="timeline-only" />);
  });
  assert.equal(buttonWithLabel(renderer!, event.label).props["aria-expanded"], true);
  await act(async () => {
    renderer!.update(<ActivityDisclosureHarness activityEvents={[event]} mode="timeline-and-thread" />);
  });
  assert.deepEqual(renderer!.root.findAllByType("button").map((button) => button.props["aria-expanded"]), [true, true, true, true]);
  await act(async () => renderer!.unmount());
});

test("activity disclosure state clears synchronously when the conversation changes", async () => {
  const event = activityEvent("web", 1, "Searched web", "query");
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ActivityDisclosureHarness activityEvents={[event]} conversationId="conversation-1" mode="timeline-only" />);
  });
  await openGroups(renderer!);
  await act(async () => buttonWithLabel(renderer!, event.label).props.onClick());
  assert.equal(buttonWithLabel(renderer!, event.label).props["aria-expanded"], true);

  await act(async () => {
    renderer!.update(<ActivityDisclosureHarness activityEvents={[event]} conversationId="conversation-2" mode="timeline-only" />);
  });
  assert.equal(buttonWithLabel(renderer!, "1 command").props["aria-expanded"], false);
  await openGroups(renderer!);
  assert.equal(buttonWithLabel(renderer!, event.label).props["aria-expanded"], false);
  await act(async () => renderer!.unmount());
});
