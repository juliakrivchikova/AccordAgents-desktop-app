import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { parseMarkdownInline, type MarkdownInlineNode } from "../../../shared/markdownInline";

function commands(nodes: MarkdownInlineNode[]): string[] {
  return nodes.flatMap((node): string[] => {
    if (node.type === "command") {
      return [node.command];
    }
    return node.type === "strong" ? commands(node.children) : [];
  });
}

test("posted goal styling requires recognized User command metadata", () => {
  assert.deepEqual(commands(parseMarkdownInline("participant says /goal now")), []);
  assert.deepEqual(
    commands(parseMarkdownInline("@codex finish it /goal", { recognizedCommand: "goal" })),
    ["goal"]
  );

  const messageItem = readFileSync(resolve("src/renderer/components/chat/chat-message-item.tsx"), "utf8");
  assert.match(messageItem, /message\.role === "user" \? message\.metadata\?\.nativeCommand\?\.name : undefined/);
});

test("posted goal token uses neutral text styling", () => {
  const styles = readFileSync(resolve("src/renderer/styles/views/content-markdown.css"), "utf8");
  const rule = styles.match(/\.chat-command-token\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(rule, /color:\s*var\(--app-muted\)/);
  assert.doesNotMatch(rule, /background:|--accent|border:/);
});
