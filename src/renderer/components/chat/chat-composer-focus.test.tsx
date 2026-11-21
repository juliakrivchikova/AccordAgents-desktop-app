// The chat composer's field takes the keyboard when its chat asked for it
// (Fork to new chat opens its chat with the composer focused). That goes
// through a ref to the field, which the shared Textarea must hand on (React
// 18 gives a function component no `ref` prop).
import assert from "node:assert/strict";
import test from "node:test";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";

import { Textarea } from "@/components/ui/textarea";
import { TooltipProvider } from "@/components/ui/tooltip";
import { requestComposerFocus, takeComposerFocusRequest } from "../../app/composer-focus-request";
import { ResizableTextarea } from "../primitives";
import { ChatComposer, type ChatComposerProps } from "./chat-composer";

const noop = (): void => undefined;
// The bridge answers nothing; its subscriptions hand back a way to stop.
(window as unknown as { consensus: unknown }).consensus = new Proxy({}, {
  get: (_target, name) => (String(name).startsWith("on") ? () => noop : async () => undefined)
});

function composerProps(overrides: Partial<ChatComposerProps>): ChatComposerProps {
  return {
    participants: [],
    savedPrompts: [],
    draft: "",
    placeholder: "Message",
    isRunning: false,
    renderParticipantAvatar: () => null,
    participantRoleLabel: () => "Member",
    onDraftChange: noop,
    onSend: () => true,
    ...overrides
  };
}

function mount(): { render: (props: ChatComposerProps) => Promise<void>; field: () => HTMLTextAreaElement; unmount: () => Promise<void> } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  return {
    render: async (props) => {
      await act(async () => { root.render(<TooltipProvider><ChatComposer {...props} /></TooltipProvider>); });
    },
    field: () => host.querySelector("textarea")!,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      host.remove();
    }
  };
}

test("the shared text fields hand their ref to the textarea", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const plain = createRef<HTMLTextAreaElement>();
  const resizable = createRef<HTMLTextAreaElement>();
  await act(async () => {
    root.render(<><Textarea ref={plain} /><ResizableTextarea ref={resizable} maxHeight={200} /></>);
  });
  assert.ok(plain.current instanceof HTMLTextAreaElement, "Textarea");
  assert.ok(resizable.current instanceof HTMLTextAreaElement, "ResizableTextarea, through Textarea");
  await act(async () => { root.unmount(); });
  host.remove();
});

test("the chat's main composer takes the keyboard once its chat asked for it, and at no other time", async () => {
  const elsewhere = document.createElement("input");
  document.body.append(elsewhere);
  const composer = mount();
  try {
    await composer.render(composerProps({ conversationId: "chat-a", takesFocusRequests: true }));
    assert.notEqual(document.activeElement, composer.field(), "a chat opened as usual leaves the keyboard where it was");

    // Fork to new chat asks before its chat opens; the chat's composer takes it.
    requestComposerFocus("chat-b");
    await composer.render(composerProps({ conversationId: "chat-b", takesFocusRequests: true }));
    assert.equal(document.activeElement, composer.field(), "the new chat's composer is focused");

    // Asked once: typing in another field is never interrupted afterwards.
    elsewhere.focus();
    await composer.render(composerProps({ conversationId: "chat-b", takesFocusRequests: true, draft: "typed" }));
    assert.equal(document.activeElement, elsewhere, "a later render does not take the keyboard back");
    await composer.render(composerProps({ conversationId: "chat-a", takesFocusRequests: true }));
    await composer.render(composerProps({ conversationId: "chat-b", takesFocusRequests: true }));
    assert.equal(document.activeElement, elsewhere, "nor does opening the chat again");
  } finally {
    await composer.unmount();
    elsewhere.remove();
  }
});

test("a composer that does not take a chat's request (a member's) leaves it for the chat's main composer", async () => {
  const member = mount();
  const main = mount();
  try {
    requestComposerFocus("chat-c");
    await member.render(composerProps({ conversationId: "chat-c" }));
    assert.notEqual(document.activeElement, member.field());
    await main.render(composerProps({ conversationId: "chat-c", takesFocusRequests: true }));
    assert.equal(document.activeElement, main.field(), "the main composer still gets it");
  } finally {
    await member.unmount();
    await main.unmount();
  }
});

test("a request for the chat already on screen is taken at once, by its main composer only", async () => {
  const elsewhere = document.createElement("input");
  document.body.append(elsewhere);
  const member = mount();
  const main = mount();
  try {
    await member.render(composerProps({ conversationId: "chat-d" }));
    await main.render(composerProps({ conversationId: "chat-d", takesFocusRequests: true }));
    elsewhere.focus();
    // Its fork's notice, Open, while the fork is already open.
    await act(async () => { requestComposerFocus("chat-d"); });
    assert.equal(document.activeElement, main.field(), "the main composer takes the keyboard at once");
    // A request for another chat leaves this one alone.
    elsewhere.focus();
    await act(async () => { requestComposerFocus("chat-e"); });
    assert.equal(document.activeElement, elsewhere);
    assert.equal(takeComposerFocusRequest("chat-e"), true, "kept for chat-e's own composer");
  } finally {
    await member.unmount();
    await main.unmount();
    elsewhere.remove();
  }
});
