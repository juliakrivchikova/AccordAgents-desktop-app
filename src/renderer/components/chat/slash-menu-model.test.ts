import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSlashMenu,
  resolveSlashActive,
  slashMoreKey,
  slashNavKey,
  stepSlashActive,
  withSlashKind,
  type SlashKind,
  type SlashMenu,
  type SlashMenuItem
} from "./slash-menu-model";

// A real user's set (the mockup's): 2 commands, 6 prompts, 80 skills, 5 plugins.
const SKILL_NAMES = [
  "implement-change", "renderer-ui-code", "electron-desktop-qa", "fix-with-e2e-repro", "release-beta",
  "oleg-codex-gemini-review", "oleg-codex-review", "oleg-gemini-review", "review", "qa",
  ...Array.from({ length: 70 }, (_, index) => `extra-skill-${index}`)
];
const ITEMS: SlashMenuItem<string>[] = [
  item("command", "goal", "Run the mentioned member until the goal is finished"),
  item("command", "compact", "Compact the mentioned member context"),
  ...["standup", "pr", "explain", "tests", "release-notes", "triage"].map((name) => item("prompt", name, `Prompt ${name}`)),
  ...SKILL_NAMES.map((name) => item("skill", name, name === "release-beta" ? "Issue and verify a macOS beta release" : `Skill ${name}`)),
  item("skill", "codex-only", "A skill the target cannot run", true),
  ...["remotion", "anthropic-skills", "figma", "linear", "github"].map((name) => item("plugin", name, `Plugin ${name}`))
];
const NONE: ReadonlySet<SlashKind> = new Set();

test("the empty query shows every group in kind order, long ones folded with a Show all row", () => {
  assert.deepEqual(outline(buildSlashMenu(ITEMS, "", NONE)), [
    "# command 2", "goal", "compact",
    "# prompt 6", "standup", "pr", "+ prompt 6",
    "# skill 81", "implement-change", "renderer-ui-code", "electron-desktop-qa", "fix-with-e2e-repro", "+ skill 81",
    "# plugin 5", "remotion", "anthropic-skills", "+ plugin 5"
  ]);
});

test("a group folds only when that hides at least two rows", () => {
  const three = ["a", "b", "c"].map((name) => item("prompt", name, ""));
  const four = [...three, item("prompt", "d", "")];
  assert.deepEqual(outline(buildSlashMenu(three, "", NONE)), ["# prompt 3", "a", "b", "c"]);
  assert.deepEqual(outline(buildSlashMenu(four, "", NONE)), ["# prompt 4", "a", "b", "+ prompt 4"]);
});

const FILTER_CASES: Array<{ query: string; expected: string[]; why: string }> = [
  { query: "ocgr", expected: ["# skill 1", "oleg-codex-gemini-review"], why: "initials across words" },
  { query: "/OCGR", expected: ["# skill 1", "oleg-codex-gemini-review"], why: "a leading slash and case are ignored" },
  { query: "oc", expected: [], why: "two letters are too few for initials" },
  {
    query: "review",
    expected: ["# skill 4", "review", "oleg-codex-review", "oleg-gemini-review", "oleg-codex-gemini-review"],
    why: "exact before word start, nearer and shorter first"
  },
  {
    query: "re",
    expected: [
      "# skill 7", "review", "release-beta", "renderer-ui-code", "oleg-codex-review", "oleg-gemini-review", "+ skill 7",
      "# plugin 1", "remotion",
      "# prompt 1", "release-notes"
    ],
    why: "groups ordered by their best match, five rows each while filtering"
  },
  { query: "macos", expected: ["# skill 1", "release-beta"], why: "a description matches at a word start" },
  { query: "acos", expected: [], why: "a description does not match inside a word" }
];

for (const { query, expected, why } of FILTER_CASES) {
  test(`filtering "${query}": ${why}`, () => {
    assert.deepEqual(outline(buildSlashMenu(ITEMS, query, NONE)), expected);
  });
}

test("name matches outrank description matches; shorter names and earlier words first", () => {
  const items = [
    item("skill", "design-html", "Design and build production HTML"),
    item("skill", "document-release", "Build release documentation"),
    item("plugin", "build-macos-apps", "Build native apps"),
    item("plugin", "build-web-apps", "Build frontend apps")
  ];
  assert.deepEqual(outline(buildSlashMenu(items, "build", NONE)), [
    "# plugin 2", "build-web-apps", "build-macos-apps",
    "# skill 2", "document-release", "design-html"
  ]);
});

test("an alias ranks the row; the shown name keeps its own highlight", () => {
  const hidden = buildSlashMenu([{ ...item("plugin", "build-web-apps", ""), aliases: ["Web Toolkit"] }], "toolkit", NONE).nav[0];
  assert.equal(hidden?.type === "item" && hidden.item.name, "build-web-apps");
  assert.deepEqual(hidden?.type === "item" && hidden.match.name, []);
  // A plugin "remotion" shown by its skill's token: the alias is exact, the token a prefix.
  const shown = buildSlashMenu([{ ...item("plugin", "remotion-best-practices", ""), aliases: ["remotion"] }], "remotion", NONE).nav[0];
  assert.deepEqual(shown?.type === "item" && shown.match.name, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("matched letters and description spans are reported for highlighting", () => {
  const menu = buildSlashMenu(ITEMS, "ocgr", NONE);
  const row = menu.nav[0];
  assert.deepEqual(row?.type === "item" && row.match.name, [0, 5, 11, 18]);
  const described = buildSlashMenu(ITEMS, "macos", NONE).nav[0];
  assert.deepEqual(described?.type === "item" && described.match.description, [19, 24]);
});

test("Show all expands a group in place; Show fewer folds it back onto its Show all row", () => {
  const folded = buildSlashMenu(ITEMS, "", NONE);
  const more = resolveSlashActive(folded.nav, slashMoreKey("skill"));
  assert.equal(label(folded.nav[more]), "+ skill 81");
  const expanded = buildSlashMenu(ITEMS, "", withSlashKind(NONE, "skill", true));
  const skills = expanded.nav.filter((entry) => entry.type === "item" && entry.item.kind === "skill");
  assert.equal(skills.length, 81);
  // The first row the expansion showed takes the Show all row's place.
  assert.equal(label(expanded.nav[more]), "release-beta");
  assert.equal(expanded.nav[more + 77]?.type, "less");
  const collapsed = buildSlashMenu(ITEMS, "", withSlashKind(withSlashKind(NONE, "skill", true), "skill", false));
  assert.equal(resolveSlashActive(collapsed.nav, slashMoreKey("skill")), more);
});

test("the highlight stays on the chosen row when rows arrive above it", () => {
  const prompts = ITEMS.filter((entry) => entry.kind === "prompt");
  const before = buildSlashMenu(prompts, "", NONE);
  const chosen = slashNavKey(before.nav[1]);
  const after = buildSlashMenu(ITEMS, "", NONE);
  assert.equal(label(after.nav[resolveSlashActive(after.nav, chosen)]), "pr");
});

test("arrows walk every row across groups and wrap at both ends", () => {
  const nav = buildSlashMenu(ITEMS, "", NONE).nav;
  const walk = (start: number, step: number, times: number): number => {
    let index = start;
    for (let count = 0; count < times; count += 1) {
      index = stepSlashActive(nav.length, index, step);
    }
    return index;
  };
  assert.equal(nav.length, 13);
  assert.deepEqual([1, 2, 3, 4, 5].map((times) => label(nav[walk(0, 1, times)])), ["compact", "standup", "pr", "+ prompt 6", "implement-change"]);
  assert.equal(label(nav[walk(0, -1, 1)]), "+ plugin 5");
  assert.equal(walk(nav.length - 1, 1, 1), 0);
  assert.equal(stepSlashActive(0, 0, 1), 0);
});

test("the highlight starts on the first row that can be inserted", () => {
  const items = [item("skill", "blocked", "", true), item("skill", "open", "")];
  const nav = buildSlashMenu(items, "", NONE).nav;
  const cases: Array<[string | undefined, string]> = [[undefined, "open"], ["skill:blocked", "blocked"], ["skill:gone", "open"]];
  for (const [key, expected] of cases) {
    assert.equal(label(nav[resolveSlashActive(nav, key)]), expected, `key ${key}`);
  }
  assert.equal(resolveSlashActive(buildSlashMenu([item("skill", "blocked", "", true)], "", NONE).nav, undefined), 0);
});

function item(kind: SlashKind, itemName: string, description: string, disabled = false): SlashMenuItem<string> {
  return { kind, key: `${kind}:${itemName}`, name: itemName, description, disabled, value: itemName };
}

function outline(menu: SlashMenu<string>): string[] {
  return menu.rows.map((row) => row.type === "header" ? `# ${row.kind} ${row.count}` : label(row));
}

function label(entry: SlashMenu<string>["nav"][number] | undefined): string {
  if (!entry) {
    return "(none)";
  }
  if (entry.type === "more") {
    return `+ ${entry.kind} ${entry.count}`;
  }
  return entry.type === "less" ? `- ${entry.kind}` : entry.item.name;
}
