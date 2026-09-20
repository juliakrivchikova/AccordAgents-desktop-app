import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { create } from "react-test-renderer";

import { markdownBlocks } from "./markdown-blocks";
import { MarkdownText } from "./markdown-text";

test("markdown headings keep their level", () => {
  const blocks = markdownBlocks(["# Plan", "## Goals", "### Risks", "#### Not a heading"].join("\n"));

  assert.deepEqual(
    blocks.map((block) => (block.type === "heading" ? [block.level, block.text] : [block.type])),
    [[1, "Plan"], [2, "Goals"], [3, "Risks"], ["paragraph"]]
  );
});

test("rendered headings expose their level", () => {
  const renderer = create(<MarkdownText content={["# Plan", "", "## Goals", "", "### Risks", "", "Body"].join("\n")} />);
  const headings = renderer.root.findAllByType("h4");

  assert.deepEqual(
    headings.map((heading) => heading.props.className),
    ["markdown-heading markdown-heading-1", "markdown-heading markdown-heading-2", "markdown-heading markdown-heading-3"]
  );
  assert.equal(renderer.root.findAllByType("p").length, 1);
});

test("artifact content styles every heading level and fits tables to the panel", () => {
  const css = readFileSync(resolve("src/renderer/styles/views/artifacts.css"), "utf8");

  for (const level of [1, 2, 3]) {
    assert.match(css, new RegExp(`\\.artifact-content-markdown \\.markdown-heading-${level} \\{`));
  }
  assert.match(css, /\.artifact-content-markdown \.markdown-heading \{[^}]*font-family: var\(--font-body\)/);
  assert.doesNotMatch(css, /--font-display/);
  assert.match(css, /\.artifact-content-markdown \.markdown-table \{[^}]*min-width: 0;/);
});
