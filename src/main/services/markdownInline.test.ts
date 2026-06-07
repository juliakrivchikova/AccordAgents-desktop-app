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

function fileLinks(nodes: MarkdownInlineNode[]): Array<{ path: string; label: string; line?: number; column?: number }> {
  return nodes.flatMap((node): Array<{ path: string; label: string; line?: number; column?: number }> => {
    if (node.type === "fileLink") {
      const link: { path: string; label: string; line?: number; column?: number } = {
        path: node.path,
        label: node.label
      };
      if (node.line !== undefined) {
        link.line = node.line;
      }
      if (node.column !== undefined) {
        link.column = node.column;
      }
      return [link];
    }
    if (node.type === "strong") {
      return fileLinks(node.children);
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

test("parseMarkdownInline links markdown absolute file paths", () => {
  const nodes = parseMarkdownInline("[types.ts](/Users/ysvetlichnaya/IdeaProjects/AccordAgents/src/shared/types.ts): added contracts.");
  assert.deepEqual(fileLinks(nodes), [{
    path: "/Users/ysvetlichnaya/IdeaProjects/AccordAgents/src/shared/types.ts",
    label: "types.ts"
  }]);
  assert.deepEqual(nodes[nodes.length - 1], { type: "text", text: ": added contracts." });
});

test("parseMarkdownInline links relative file paths with line and column", () => {
  const nodes = parseMarkdownInline("See [main.ts](src/main/main.ts:12:4).");
  assert.deepEqual(fileLinks(nodes), [{
    path: "src/main/main.ts",
    label: "main.ts",
    line: 12,
    column: 4
  }]);
});

test("parseMarkdownInline supports angle-bracket file targets with spaces", () => {
  const nodes = parseMarkdownInline("Open [file](<src/main/file with spaces.ts:3>).");
  assert.deepEqual(fileLinks(nodes), [{
    path: "src/main/file with spaces.ts",
    label: "file",
    line: 3
  }]);
});

test("parseMarkdownInline does not treat anchors, URLs, mailto, or plain words as file links", () => {
  const nodes = parseMarkdownInline("[anchor](#section) [site](https://example.com) [mail](mailto:a@example.com) [plain](word)");
  assert.equal(fileLinks(nodes).length, 0);
  assert.deepEqual(externalLinks(nodes), [{ url: "https://example.com", label: "site" }]);
});
