import assert from "node:assert/strict";
import test from "node:test";
import { MEMORY_SEARCH_MAX_STEMS, MEMORY_SNIPPET_MAX_CHARS, rankByWords, searchStems, snippetOf } from "./memoryWordSearch";

const note = (title: string, body: string, tags: string[] = []) => ({ title, tags, body });

test("a word counts in any of its forms, the same way for every language; one-letter words are left out", () => {
  assert.deepEqual(searchStems("Декларация декларации, deploy deployment и a QA"), ["декла", "deplo", "qa"]);
  assert.deepEqual(searchStems("   "), []);
  assert.deepEqual(searchStems("a и ?"), []);
  assert.equal(searchStems(Array.from({ length: 50 }, (_, index) => `${index}qwerty`).join(" ")).length, MEMORY_SEARCH_MAX_STEMS);
});

test("a note with any of the words is found, the best match first", () => {
  const notes = [
    note("Lunch places", "Where we eat."),
    note("How to deploy the bot", "Steps for a release."),
    note("Release notes", "What went out in the beta; the deployment ran fine."),
    note("Other", "Deploying is mentioned once here among many other words about something else entirely, and more words, and more.")
  ];
  const ranked = rankByWords(notes, searchStems("deploy releases"), { total: 4, averageLength: 80 });
  // Both words, one in the title: first; one word once in a long body: last; no word: not found.
  assert.deepEqual(ranked.slice(0, 2).map((item) => item.note.title).sort(), ["How to deploy the bot", "Release notes"]);
  assert.equal(ranked[2]?.note.title, "Other");
  assert.equal(ranked.length, 3);
  assert.ok(ranked.every((item, index) => index === 0 || item.score <= ranked[index - 1].score));
  assert.deepEqual(rankByWords(notes, [], { total: 4, averageLength: 80 }), []);
  assert.deepEqual(rankByWords(notes, searchStems("nothing matches"), { total: 4, averageLength: 80 }), []);
});

test("a word in the title weighs more than the same word in the body", () => {
  const notes = [note("Plain", "This note says deploy once."), note("Deploy", "This note says nothing else.")];
  assert.deepEqual(rankByWords(notes, searchStems("deploy"), { total: 2, averageLength: 30 }).map((item) => item.note.title), ["Deploy", "Plain"]);
});

test("a note holding only a common word is left out under a strong match", () => {
  const notes = [
    note("Phone call on an urgent alert", "Telegram first, then the phone rings."),
    ...Array.from({ length: 20 }, (_, index) => note(`Note ${index}`, "Something on the side, on and on."))
  ];
  const ranked = rankByWords(notes, searchStems("on urgent phone call"), { total: 21, averageLength: 40 });
  assert.equal(ranked[0].note.title, "Phone call on an urgent alert");
  assert.equal(ranked.length, 1);
});

test("the passage is where most words asked are close together, cut at word edges, within the limit", () => {
  const filler = "Lorem ipsum dolor sit amet consectetur. ".repeat(20);
  const body = `${filler}The release went out to the beta. ${filler}To deploy the release, run the Release workflow on beta and wait. ${filler}`;
  const snippet = snippetOf(body, searchStems("deploy release workflow"));
  assert.match(snippet, /deploy the release, run the Release workflow/);
  assert.ok(snippet.startsWith("…") && snippet.endsWith("…"));
  assert.ok(snippet.length <= MEMORY_SNIPPET_MAX_CHARS + 2);
  // Starts at a word's start: what follows "…" comes after a space in the body.
  const flat = body.replace(/\s+/g, " ");
  assert.ok(flat.includes(` ${snippet.slice(1, 20)}`));
  // Only the title matched: the body's start.
  assert.equal(snippetOf("Short body.\nSecond line.", searchStems("unrelated")), "Short body. Second line.");
  assert.equal(snippetOf("   ", searchStems("x y")), "");
  // A body that ends in the middle of a word never loops.
  assert.match(snippetOf(`${"word ".repeat(100)}deploy`, searchStems("deploy")), /deploy$/);
});
