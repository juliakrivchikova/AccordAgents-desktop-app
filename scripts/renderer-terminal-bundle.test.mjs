// The terminal screen as the built renderer ships it: xterm.js through the
// same esbuild minification and target as `vite build`. Built for 2020
// browsers (Vite's default), xterm's requestMode assigned a variable the
// minifier had dropped: the first program that asked for a mode stopped its
// terminal for good ("i is not defined", Sentry ACCORDAGENTS-DESKTOP-E).
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolveConfig, transformWithEsbuild } from "vite";

const require = createRequire(import.meta.url);

test("a terminal in the built renderer answers a program's mode requests and goes on showing its output", async () => {
  const { build } = await resolveConfig({ root: path.resolve(import.meta.dirname, "..") }, "build");
  assert.equal(build.minify, "esbuild", "this test minifies as the build does");
  const entry = path.join(path.dirname(require.resolve("@xterm/xterm/package.json")), "lib", "xterm.mjs");
  const { code } = await transformWithEsbuild(await readFile(entry, "utf8"), "xterm.mjs", { target: build.target, minify: true, format: "esm" });
  const directory = await mkdtemp(path.join(tmpdir(), "accord-xterm-bundle-"));
  try {
    const bundle = path.join(directory, "xterm.mjs");
    await writeFile(bundle, code);
    // xterm takes its window from globalThis; the jsdom setup gives it only the window's own properties.
    globalThis.addEventListener ??= window.addEventListener.bind(window);
    const { Terminal } = await import(pathToFileURL(bundle).href);
    const terminal = new Terminal({ allowProposedApi: true, cols: 40, rows: 5 });
    const answers = [];
    terminal.onData((data) => answers.push(data));
    // Synchronized output and bracketed paste, then insert mode (not private).
    await new Promise((resolve) => terminal.write("A\u001b[?2026$pB\u001b[?2004$pC\u001b[4$pD", resolve));
    await new Promise((resolve) => terminal.write("\r\nnext line", resolve));
    assert.deepEqual(answers, ["\u001b[?2026;2$y", "\u001b[?2004;2$y", "\u001b[4;2$y"]);
    assert.equal(terminal.buffer.active.getLine(0).translateToString(true), "ABCD");
    assert.equal(terminal.buffer.active.getLine(1).translateToString(true), "next line");
    terminal.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
