import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdownInline, type MarkdownInlineNode } from "../../shared/markdownInline";

function externalLinks(nodes: MarkdownInlineNode[]): Array<{ url: string; label: string }> {
  return nodes.flatMap((node): Array<{ url: string; label: string }> => {
    if (node.type === "externalLink") {
      return [{ url: node.url, label: node.label }];
    }
    if (node.type === "strong") {
      return externalLinks(node.children);
    }
    return [];
  });
}

test("parseMarkdownInline links bare URLs and trims trailing punctuation", () => {
  const nodes = parseMarkdownInline("Visit https://example.com.");
  assert.deepEqual(externalLinks(nodes), [{ url: "https://example.com", label: "https://example.com" }]);
  assert.deepEqual(nodes[nodes.length - 1], { type: "text", text: "." });
});

test("parseMarkdownInline links markdown external URLs", () => {
  const nodes = parseMarkdownInline("Read [Example](https://example.com/docs).");
  assert.deepEqual(externalLinks(nodes), [{ url: "https://example.com/docs", label: "Example" }]);
});

test("parseMarkdownInline keeps message links out of external link parsing", () => {
  const nodes = parseMarkdownInline("See [the message](#msg:abc123).");
  assert.equal(externalLinks(nodes).length, 0);
  assert.deepEqual(nodes[1], { type: "messageLink", messageId: "abc123", label: "the message" });
});

test("parseMarkdownInline finds URLs after bold and code tokens", () => {
  const nodes = parseMarkdownInline("**bold** https://one.example `https://skip.example` https://two.example");
  assert.deepEqual(externalLinks(nodes), [
    { url: "https://one.example", label: "https://one.example" },
    { url: "https://two.example", label: "https://two.example" }
  ]);
});

test("parseMarkdownInline does not link URLs inside inline code", () => {
  const nodes = parseMarkdownInline("`https://example.com`");
  assert.equal(externalLinks(nodes).length, 0);
  assert.deepEqual(nodes, [{ type: "code", text: "https://example.com" }]);
});

test("parseMarkdownInline trims angle-bracket autolink suffixes", () => {
  const nodes = parseMarkdownInline("<https://example.com>");
  assert.deepEqual(externalLinks(nodes), [{ url: "https://example.com", label: "https://example.com" }]);
  assert.deepEqual(nodes[0], { type: "text", text: "<" });
  assert.deepEqual(nodes[nodes.length - 1], { type: "text", text: ">" });
});
