import assert from "node:assert/strict";
import test from "node:test";

import {
  createExternalOpenLimiter,
  createFileEditFlusher,
  filePreviewNavigationDecision,
  shouldFlushBeforeClose
} from "./filePanelWindow";

test("a flush waits for the window's answer", async () => {
  const sent: string[] = [];
  const flusher = createFileEditFlusher({ send: (id) => { sent.push(id); return true; }, log: () => undefined });
  let done = false;
  const flushing = flusher.flush(10_000).then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(done, false);
  flusher.acknowledge("not-this-one");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(done, false, "an unknown answer is ignored");
  flusher.acknowledge(sent[0]);
  await flushing;
  assert.equal(done, true);
});

test("a window that never answers, cannot be asked, or throws does not hold anything up", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const logged: string[] = [];
  const silent = createFileEditFlusher({ send: () => true, log: (event) => logged.push(event) });
  const waiting = silent.flush(2_000);
  t.mock.timers.tick(2_000);
  await waiting;
  assert.deepEqual(logged, ["files.flush-timeout"]);

  await createFileEditFlusher({ send: () => false, log: () => undefined }).flush(2_000);
  await createFileEditFlusher({ send: () => { throw new Error("gone"); }, log: () => undefined }).flush(2_000);
});

test("closing the window saves first only for a plain close, never while quitting or updating", () => {
  const plain = { alreadyFlushed: false, quittingForUpdate: false, quitCleanupStarted: false, isMainWindow: true };
  assert.equal(shouldFlushBeforeClose(plain), true);
  assert.equal(shouldFlushBeforeClose({ ...plain, alreadyFlushed: true }), false);
  assert.equal(shouldFlushBeforeClose({ ...plain, quittingForUpdate: true }), false);
  assert.equal(shouldFlushBeforeClose({ ...plain, quitCleanupStarted: true }), false);
  assert.equal(shouldFlushBeforeClose({ ...plain, isMainWindow: false }), false);
});

test("a panel page stays inside its grant; its own web links open outside, rate-limited; nothing else gets out", () => {
  const always = () => true;
  const never = () => false;
  const main = { isMainFrame: true, isPanelFrame: false, granted: false };
  assert.equal(filePreviewNavigationDecision({ ...main, url: "accord-file://t/x.html" }, always), "block");
  assert.equal(filePreviewNavigationDecision({ ...main, url: "http://localhost:5173/" }, always), "allow");

  const panel = { isMainFrame: false, isPanelFrame: true, granted: false };
  assert.equal(filePreviewNavigationDecision({ ...panel, url: "accord-file://t/next.html", granted: true }, always), "allow");
  assert.equal(filePreviewNavigationDecision({ ...panel, url: "https://example.com/" }, always), "open-outside");
  assert.equal(filePreviewNavigationDecision({ ...panel, url: "https://example.com/" }, never), "block");
  assert.equal(filePreviewNavigationDecision({ ...panel, url: "mailto:a@b.c" }, always), "block");
  assert.equal(filePreviewNavigationDecision({ ...panel, url: "accord-file://other/secret" }, always), "block");

  const embedded = { isMainFrame: false, isPanelFrame: false, granted: false };
  assert.equal(filePreviewNavigationDecision({ ...embedded, url: "https://www.youtube.com/embed/x" }, always), "block");
});

test("outside opens are limited to one per interval", () => {
  let now = 0;
  const allow = createExternalOpenLimiter(() => now, 3_000);
  assert.equal(allow(), true);
  now = 1_000;
  assert.equal(allow(), false);
  now = 3_000;
  assert.equal(allow(), true);
});
