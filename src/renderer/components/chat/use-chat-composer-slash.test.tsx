import assert from "node:assert/strict";
import test from "node:test";
import { useMemo, useState } from "react";
import { act, create } from "react-test-renderer";

import type { ChatSavedPromptConfig, UserSkillSearchResult } from "../../../shared/types";
import { useChatComposerMentions, type ChatComposerSearchSource } from "./use-chat-composer-mentions";

type Mentions = ReturnType<typeof useChatComposerMentions>;

const SOURCE: ChatComposerSearchSource = { type: "pre-chat", participants: [] };
const PROMPTS: ChatSavedPromptConfig[] = ["standup", "pr"].map((trigger) => ({
  id: trigger,
  label: `Prompt ${trigger}`,
  trigger,
  body: `Body of ${trigger}`,
  version: 1,
  updatedAt: "2026-11-26T00:00:00.000Z"
}));
const ONE_TARGET: UserSkillSearchResult = {
  target: { participantIds: ["assistant-preview"], providerKinds: ["codex-cli"], hasClearTargets: true },
  skills: []
};

test("a search reply keeps the row the user moved to, though rows arrive above it", async () => {
  let answer!: (result: UserSkillSearchResult) => void;
  installBridge(() => new Promise((resolve) => { answer = resolve; }));
  const view = mount();
  await act(async () => view.current().updateDraft("/"));
  await act(async () => view.current().moveSlashActive(1));
  assert.equal(activeName(view.current()), "pr");

  await act(async () => {
    await wait(250);
    answer(ONE_TARGET);
    await wait(0);
  });
  // The reply brought /goal above the prompts; the highlight stays on /pr.
  assert.deepEqual(view.current().slashMenu?.menu.nav.map((entry) => entry.type === "item" && entry.item.name), ["goal", "standup", "pr"]);
  assert.equal(activeName(view.current()), "pr");
  view.unmount();
});

test("reopening after Esc shows nothing until the search answers, not a stale No matches", async () => {
  let answer!: (result: UserSkillSearchResult) => void;
  installBridge(() => new Promise((resolve) => { answer = resolve; }));
  const view = mount();
  await act(async () => {
    view.current().updateDraft("/");
    await wait(250);
    answer(ONE_TARGET);
    await wait(0);
  });
  assert.ok(view.current().slashMenu);
  await act(async () => view.current().setSkillQuery(undefined));
  await act(async () => view.current().updateDraft("/oc"));
  assert.equal(view.current().slashMenu, undefined);
  view.unmount();
});

test("a reply that lands after Esc does not reopen the menu on stale results", async () => {
  let answer!: (result: UserSkillSearchResult) => void;
  installBridge(() => new Promise((resolve) => { answer = resolve; }));
  const view = mount();
  await act(async () => {
    view.current().updateDraft("/");
    await wait(250);
  });
  await act(async () => view.current().setSkillQuery(undefined));
  await act(async () => {
    answer(ONE_TARGET);
    await wait(0);
  });
  await act(async () => view.current().updateDraft("/oc"));
  assert.equal(view.current().slashMenu, undefined);
  view.unmount();
});

test("after the member before the /query changes, the last member's results are not live", async () => {
  const answers: Array<(result: UserSkillSearchResult) => void> = [];
  installBridge(() => new Promise((resolve) => { answers.push(resolve); }));
  const view = mount();
  await act(async () => {
    view.current().updateDraft("@claude /");
    await wait(250);
    answers[0](ONE_TARGET);
    await wait(0);
  });
  assert.equal(activeName(view.current()), "goal");
  await act(async () => view.current().updateDraft("@codex /"));
  // Until the new answer: saved prompts only, and Enter is held back.
  assert.deepEqual(view.current().slashMenu?.menu.nav.map((entry) => entry.type === "item" && entry.item.name), ["standup", "pr"]);
  assert.equal(view.current().slashSearching, true);
  view.unmount();
});

test("typing the query filters the list without searching again", async () => {
  let searches = 0;
  installBridge(async () => {
    searches += 1;
    return ONE_TARGET;
  });
  const view = mount();
  await act(async () => {
    view.current().updateDraft("/");
    await wait(250);
  });
  await act(async () => {
    view.current().updateDraft("/s");
    view.current().updateDraft("/st");
    await wait(250);
  });
  assert.equal(searches, 1);
  assert.deepEqual(view.current().slashMenu?.menu.nav.map((entry) => entry.type === "item" && entry.item.name), ["standup"]);
  view.unmount();
});

function mount(): { current: () => Mentions; unmount: () => void } {
  let latest!: Mentions;
  const Harness = () => {
    const [draft, setDraft] = useState("");
    // A new source object on every keystroke, as New chat builds it.
    const searchSource = useMemo(() => ({ ...SOURCE }), [draft]);
    latest = useChatComposerMentions({ draft, searchSource, onDraftChange: setDraft, participants: [], savedPrompts: PROMPTS });
    return null;
  };
  let renderer!: ReturnType<typeof create>;
  void act(() => {
    renderer = create(<Harness />);
  });
  return { current: () => latest, unmount: () => renderer.unmount() };
}

function activeName(mentions: Mentions): string | undefined {
  const entry = mentions.slashMenu?.menu.nav[mentions.slashActiveIndex];
  return entry?.type === "item" ? entry.item.name : entry?.type;
}

function installBridge(searchUserSkills: () => Promise<UserSkillSearchResult>): void {
  (globalThis as { window?: unknown }).window = {
    consensus: {
      searchUserSkills,
      listPlugins: async () => ({ plugins: [], diagnostics: { checkedSources: [], errors: [], updatedAt: "" } }),
      searchRepoFiles: async () => []
    },
    setTimeout,
    clearTimeout
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
