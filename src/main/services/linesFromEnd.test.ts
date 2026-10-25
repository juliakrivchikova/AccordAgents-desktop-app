import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { visitLinesFromEnd } from "./linesFromEnd";

async function linesOf(content: string | Buffer): Promise<string[]> {
  const dir = await mkdtemp(path.join(tmpdir(), "accordagents-lines-from-end-"));
  try {
    const file = path.join(dir, "log.jsonl");
    await writeFile(file, content);
    const lines: string[] = [];
    await visitLinesFromEnd(file, (line) => {
      lines.push(line);
      return false;
    });
    return lines;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("visits every line, last first, across chunk boundaries and multi-byte characters", async () => {
  // Lines longer than a 256 KB chunk, Cyrillic text cut by chunk edges, CRLF, a final newline.
  const long = "я".repeat(200_000);
  const original = ["first", long, "второй\r", "", "x".repeat(300_000), "last"];
  const visited = await linesOf(`${original.join("\n")}\n`);
  assert.deepEqual(visited, ["", ...original.slice().reverse()]);
});

test("stops as soon as the visitor says so", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accordagents-lines-from-end-"));
  try {
    const file = path.join(dir, "log.jsonl");
    await writeFile(file, Array.from({ length: 50_000 }, (_, index) => `line ${index}`).join("\n"));
    const seen: string[] = [];
    await visitLinesFromEnd(file, (line) => {
      seen.push(line);
      return seen.length === 3;
    });
    assert.deepEqual(seen, ["line 49999", "line 49998", "line 49997"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing file or an empty one visits nothing", async () => {
  const visited: string[] = [];
  await visitLinesFromEnd(path.join(tmpdir(), "accordagents-no-such-log.jsonl"), (line) => {
    visited.push(line);
    return false;
  });
  assert.deepEqual(visited, []);
  assert.deepEqual(await linesOf(""), []);
});
